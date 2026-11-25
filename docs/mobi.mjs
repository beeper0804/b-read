import { cleanChapter } from "./epub.mjs";
import { fileLimit, identify } from "./book-formats.mjs";

const badMobi = () => new Error("MOBI 文件的索引或正文无法读取。");
const ascii = (bytes,start,end) => String.fromCharCode(...bytes.subarray(start,end));

export function expandPalmDoc(record,limit=8192) {
  const output=new Uint8Array(limit);
  let pos=0;
  const append=byte=>{
    if (pos>=limit) throw badMobi();
    output[pos++]=byte;
  };
  for (let i=0;i<record.length;i++){
    const code=record[i];
    if (code===0 || (code>=9 && code<=127)) append(code);
    else if (code<=8) {
      if (i+code>=record.length) throw badMobi();
      const end=i+code;
      while (i<end) append(record[++i]);
    } else if (code>=192) {
      append(32);
      append(code ^ 128);
    } else {
      if (++i>=record.length) throw badMobi();
      const pair=(code<<8)|record[i];
      const distance=(pair>>3)&2047;
      if (!distance || distance>pos) throw badMobi();
      for (let count=(pair&7)+3;count;count--) append(output[pos-distance]);
    }
  }
  return output.subarray(0,pos);
}

function trimRecord(record,flags) {
  let end=record.length;
  for (let bits=flags>>>1;bits;bits>>>=1) {
    if (!(bits&1)) continue;
    let bytes=0, size=0, byte=0;
    do {
      if (bytes===4 || bytes>=end) throw badMobi();
      byte=record[end-1-bytes];
      size|=(byte&127)<<(7*bytes++);
    } while (!(byte&128));
    if (size<bytes || size>end) throw badMobi();
    end-=size;
  }
  if ((flags&1) && end) end-=(record[end-1]&3)+1;
  if (end<0) throw badMobi();
  return record.subarray(0,end);
}

function metadata(header,view,headerSize,decoder,fileName) {
  const titleOffset=view.getUint32(84);
  const titleSize=view.getUint32(88);
  const title=titleOffset+titleSize<=header.length ? decoder.decode(header.subarray(titleOffset,titleOffset+titleSize)).replace(/\0/gu,"").trim() : "";
  const authors=[];
  let offset=16+headerSize;
  if (offset+12<=header.length && ascii(header,offset,offset+4)==="EXTH") {
    const end=Math.min(header.length,offset+view.getUint32(offset+4));
    offset+=12;
    while (offset+8<=end) {
      const kind=view.getUint32(offset);
      const size=view.getUint32(offset+4);
      if (size<8 || offset+size>end) break;
      if (kind===100) authors.push(decoder.decode(header.subarray(offset+8,offset+size)).trim());
      offset+=size;
    }
  }
  return {title:title || fileName.replace(/\.mobi$/iu,""),author:authors.filter(Boolean).join(" · ")};
}

export function decodeMobi(buffer,fileName) {
  const bytes=new Uint8Array(buffer);
  const view=new DataView(buffer);
  if (bytes.length<94 || ascii(bytes,60,68)!=="BOOKMOBI") throw badMobi();
  const count=view.getUint16(76);
  const tableEnd=78+count*8;
  if (count<2 || tableEnd>bytes.length) throw badMobi();
  const offsets=Array.from({length:count},(_,i)=>view.getUint32(78+i*8));
  if (offsets.some((offset,i)=>offset<(i ? offsets[i-1] : tableEnd) || offset>=bytes.length)) throw badMobi();
  offsets.push(bytes.length);
  const record=i=>i>=0 && i<count ? bytes.subarray(offsets[i],offsets[i+1]) : new Uint8Array();
  const header=record(0);
  if (header.length<112 || ascii(header,16,20)!=="MOBI") throw badMobi();
  const info=new DataView(buffer,offsets[0],header.length);
  if (info.getUint16(12)!==0) throw new Error("此 MOBI 有 DRM 保护。请选择可自由阅读的版本。");
  if (info.getUint32(36)>=8) throw new Error("此文件只包含 KF8 版正文。请使用兼容的 MOBI 或 EPUB 版本。");
  const headerSize=info.getUint32(20);
  if (headerSize<96 || headerSize+16>header.length) throw badMobi();
  const compression=info.getUint16(0);
  if (![1,2].includes(compression)) throw new Error("此 MOBI 使用当前不支持的压缩方式，请使用普通 MOBI 或 EPUB。");
  const textLength=info.getUint32(4);
  const records=info.getUint16(8);
  if (!textLength || textLength>fileLimit || !records || records>=count) throw badMobi();
  const maxBlock=Math.max(4096,info.getUint16(10));
  const flags=headerSize>=228 ? info.getUint16(242) : 0;
  const decoder=new TextDecoder(info.getUint32(28)===65001 ? "utf-8" : "windows-1252");
  const fragments=[];
  let left=textLength;
  for (let i=1;i<=records && left;i++) {
    const payload=trimRecord(record(i),flags);
    const chunk=compression===2 ? expandPalmDoc(payload,maxBlock) : payload;
    const used=chunk.subarray(0,left);
    fragments.push(decoder.decode(used,{stream:true}));
    left-=used.length;
  }
  if (left) throw badMobi();
  const html=(fragments.join("")+decoder.decode()).replace(/\0/gu,"");
  const images=info.getUint32(108);
  return {html,record,images,...metadata(header,info,headerSize,decoder,fileName)};
}

function embeddedImage(bytes) {
  if (bytes.length<8) return;
  const kind=bytes[0]===255 && bytes[1]===216 ? "jpeg"
    : bytes[0]===137 && ascii(bytes,1,4)==="PNG" ? "png"
    : ascii(bytes,0,3)==="GIF" ? "gif" : "";
  if (kind) return new Blob([bytes],{type:`image/${kind}`});
}

export async function readMobi(file) {
  const buffer=await file.arrayBuffer();
  const {html,title,author,images,record}=decodeMobi(buffer,file.name);
  const content=/<body\b[^>]*>([\s\S]*?)<\/body\s*>/iu.exec(html)?.[1]
    ?? html.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/giu,"");
  const hasContent=part=>/<img\b/iu.test(part) || part.replace(/<!--[\s\S]*?-->|<[^>]*>/gu,"").trim();
  const pieces=content.split(/<(?:mbp:)?pagebreak\b[^>]*>/giu).filter(hasContent);
  const sections=pieces.length>1 ? pieces : content.split(/(?=<h[12]\b)/iu).filter(hasContent);
  if (!sections.length || sections.length>12000) throw badMobi();
  const spine=sections.map((_,i)=>String(i));
  function render(path,urls) {
    const template=document.createElement("template");
    template.innerHTML=sections[Number(path)];
    const body=template.content.querySelector("body") || template.content;
    return cleanChapter(body,href=>href?.startsWith("#") ? {path,anchor:href.slice(1)} : null,element=>{
      const index=Number.parseInt(element.getAttribute("recindex"),10);
      if (index>=1) return embeddedImage(record(images+index-1));
    },urls);
  }
  return {identifier:await identify(buffer),title,author,spine,contents:[],render};
}
