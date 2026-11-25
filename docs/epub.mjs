const FILE_LIMIT = 96 * 1024 * 1024;
const MEMBER_LIMIT = 20 * 1024 * 1024;
const decoder = new TextDecoder();
const DOCUMENT = "application/xhtml+xml";

export function resolveBookLink(base, href) {
  const [raw, fragment = ""] = String(href || "").split("#", 2);
  if (/^[a-z][a-z\d+.-]*:|^\/|\\|\?/iu.test(raw)) return null;
  let path, anchor;
  try {
    path = decodeURIComponent(raw);
    anchor = decodeURIComponent(fragment);
  } catch { return null; }
  if (/^[a-z][a-z\d+.-]*:|^\/|[\\\x00-\x1f]/iu.test(path)) return null;
  if (!path) return { path: base, anchor };
  const pieces = base.split("/").slice(0, -1);
  for (const component of path.split("/")) {
    if (!component || component === ".") continue;
    if (component === "..") {
      if (!pieces.length) return null;
      pieces.pop();
    } else {
      pieces.push(component);
    }
  }
  return { path: pieces.join("/"), anchor };
}

export class EpubArchive {
  constructor(buffer) {
    if (buffer.byteLength > FILE_LIMIT) throw new Error("请选择 96 MB 以内的 EPUB。");
    this.buffer = buffer;
    this.view = new DataView(buffer);
    const {view} = this;
    let end = buffer.byteLength - 22;
    while (end >= Math.max(0, buffer.byteLength - 65557)) {
      if (view.getUint32(end,true) === 0x06054b50 && end + 22 + view.getUint16(end+20,true) === buffer.byteLength) break;
      end--;
    }
    if (end < 0 || end < buffer.byteLength - 65557 || view.getUint16(end+4,true) || view.getUint16(end+6,true)) {
      throw new Error("无法读取这个 EPUB 压缩包。");
    }
    const count = view.getUint16(end+10,true);
    let at = view.getUint32(end+16,true);
    const centralEnd = at + view.getUint32(end+12,true);
    if (!count || count > 14000 || centralEnd > end) throw new Error("EPUB 文件目录无效。");
    this.files = new Map();
    let expanded = 0;
    for (let i=0; i<count; i++) {
      if (at + 46 > centralEnd || view.getUint32(at,true) !== 0x02014b50) throw new Error("EPUB 文件目录已损坏。");
      const size = view.getUint32(at+24,true);
      const nameLength = view.getUint16(at+28,true);
      const next = at + 46 + nameLength + view.getUint16(at+30,true) + view.getUint16(at+32,true);
      if (next > centralEnd || (expanded += size) > 300 * 1024 * 1024) throw new Error("EPUB 解压后的内容太大或不完整。");
      const name = decoder.decode(new Uint8Array(buffer,at+46,nameLength));
      const entry = { size, compressed:view.getUint32(at+20,true), offset:view.getUint32(at+42,true),
        method:view.getUint16(at+10,true), flags:view.getUint16(at+8,true) };
      if (!name.endsWith("/") && !this.files.has(name)) this.files.set(name,entry);
      at = next;
    }
  }

  async bytes(name) {
    const entry = this.files.get(name);
    if (!entry) throw new Error(`EPUB 缺少文件 ${name}`);
    const {view,buffer} = this;
    const {offset, method, flags, compressed, size} = entry;
    if (size > MEMBER_LIMIT || flags & 1 || offset + 30 > buffer.byteLength
        || view.getUint32(offset,true) !== 0x04034b50) throw new Error("EPUB 包含受保护或超限的内容。");
    const start = offset + 30 + view.getUint16(offset+26,true) + view.getUint16(offset+28,true);
    if (start + compressed > buffer.byteLength) throw new Error("EPUB 内容不完整。");
    const data = new Uint8Array(buffer,start,compressed);
    if (method === 0 && compressed === size) return data;
    if (method !== 8) throw new Error("EPUB 使用了当前阅读器不支持的压缩方式。");
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const result = new Uint8Array(size);
    let position = 0;
    try {
      for (;;) {
        const {done,value} = await reader.read();
        if (done) break;
        if (position + value.length > size) throw new Error("EPUB 压缩记录的长度不一致。");
        result.set(value,position);
        position += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (position !== size) throw new Error("EPUB 压缩记录的长度不一致。");
    return result;
  }

  async text(name) { return decoder.decode(await this.bytes(name)); }
}

const nodes = (root, name) => Array.from(root.getElementsByTagNameNS("*",name));
const entities = {nbsp:"&#160;",ensp:"&#8194;",emsp:"&#8195;",mdash:"&#8212;",ndash:"&#8211;",hellip:"&#8230;",lsquo:"&#8216;",rsquo:"&#8217;",ldquo:"&#8220;",rdquo:"&#8221;",copy:"&#169;"};
function xml(text, mime="application/xml") {
  if (/<!DOCTYPE[^>]*\[/iu.test(text) || /<!ENTITY\b/iu.test(text)) throw new Error("此 EPUB 包含无法安全读取的 XML 实体。");
  text = text.replace(/<!DOCTYPE[^>]*>/giu,"").replace(/&([a-z]+);/giu,(entity,name) => Object.hasOwn(entities,name) ? entities[name] : entity);
  const result = new DOMParser().parseFromString(text,mime);
  if (nodes(result,"parsererror").length) throw new Error("EPUB 中有无法读取的排版文件。");
  return result;
}

export async function readBook(file) {
  if (file.size > FILE_LIMIT) throw new Error("请选择 96 MB 以内的 EPUB。");
  const buffer = await file.arrayBuffer();
  const archive = new EpubArchive(buffer);
  if ((await archive.text("mimetype")).trim() !== "application/epub+zip") throw new Error("请打开 EPUB 文件。");
  const container = xml(await archive.text("META-INF/container.xml"));
  const packagePath = nodes(container,"rootfile")[0]?.getAttribute("full-path");
  if (!packagePath) throw new Error("EPUB 缺少内容目录。");
  const opf = xml(await archive.text(packagePath));
  const title = nodes(opf,"title")[0]?.textContent.trim() || file.name;
  const author = nodes(opf,"creator").map(node=>node.textContent.trim()).filter(Boolean).join(" · ");
  const items = new Map(nodes(opf,"item").map(element => {
    const link=resolveBookLink(packagePath,element.getAttribute("href"));
    return [element.getAttribute("id"), { path:link?.path, type:element.getAttribute("media-type"),
      properties:(element.getAttribute("properties") || "").split(/\s+/u) }];
  }));
  const spine = nodes(opf,"itemref").map(n=>items.get(n.getAttribute("idref")))
    .filter(n=>n?.path && n.type===DOCUMENT).map(n=>n.path);
  if (!spine.length) throw new Error("此版本支持包含文字章节的 EPUB。");
  let contents=[];
  try {
    const nav = [...items.values()].find(n=>n.properties.includes("nav"));
    const ncx = [...items.values()].find(n=>n.type==="application/x-dtbncx+xml");
    if (nav?.path) {
      const doc=xml(await archive.text(nav.path),DOCUMENT);
      const toc=nodes(doc,"nav").find(n=>n.getAttributeNS("http://www.idpf.org/2007/ops","type")==="toc");
      if (toc) contents=nodes(toc,"a").map(a => ({ label:a.textContent.trim(), ...resolveBookLink(nav.path,a.getAttribute("href")) }));
    } else if (ncx?.path) {
      const doc=xml(await archive.text(ncx.path));
      contents=nodes(doc,"navPoint").map(n=>({
        label:nodes(n,"navLabel")[0]?.textContent.trim(), ...resolveBookLink(ncx.path,nodes(n,"content")[0]?.getAttribute("src")),
      }));
    }
  } catch { /* The spine can still be read if a publisher's navigation file is malformed. */ }
  contents=contents.filter(n=>n.label && spine.includes(n.path));
  const identifier = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",buffer))).map(n=>n.toString(16).padStart(2,"0")).join("");
  return {archive,title,author,spine,contents,identifier};
}

const allowed = new Set("a abbr article aside b blockquote br caption cite code dd del div dl dt em figure figcaption h1 h2 h3 h4 h5 h6 hr i img kbd li mark ol p pre q ruby rp rt s section small span strong sub sup table tbody td th thead tfoot tr u ul".split(" "));
const drop = new Set("base audio iframe embed head link math meta noscript object script style svg template video form input button select textarea".split(" "));
const imageTypes = {"jpg":"image/jpeg","jpeg":"image/jpeg","png":"image/png","webp":"image/webp","avif":"image/avif","gif":"image/gif"};

export async function chapterFragment(book,path,urls) {
  const xmlDocument = xml(await book.archive.text(path),DOCUMENT);
  const body = nodes(xmlDocument,"body")[0];
  if (!body) throw new Error("当前章节没有正文。");
  return cleanChapter(body,href=>{
    const link=resolveBookLink(path,href);
    return link && book.spine.includes(link.path) ? link : null;
  },async source=>{
    const link=resolveBookLink(path,source.getAttribute("src"));
    const ext=link?.path.split(".").at(-1).toLowerCase();
    if (Object.hasOwn(imageTypes,ext) && book.archive.files.has(link.path)) {
      return new Blob([await book.archive.bytes(link.path)],{type:imageTypes[ext]});
    }
  },urls);
}

export async function cleanChapter(body, resolveLink, imageBlob, urls) {
  const images = [];
  function clean(source) {
    if (source.nodeType === 3) return document.createTextNode(source.nodeValue);
    if (source.nodeType !== 1) return document.createDocumentFragment();
    const tag=source.localName.toLowerCase();
    if (drop.has(tag)) return document.createDocumentFragment();
    const result=allowed.has(tag) ? document.createElement(tag) : document.createDocumentFragment();
    if (result.nodeType===1) {
      const id=source.getAttribute("id");
      if (id) result.dataset.bookId=id;
      const lang=source.getAttribute("lang") || source.getAttribute("xml:lang");
      if (lang) result.lang=lang;
      if (tag==="a") {
        const link=resolveLink(source.getAttribute("href"));
        if (link) {
          result.href="#";
          result.dataset.bookPath=link.path;
          result.dataset.bookAnchor=link.anchor;
        }
      }
      if (tag==="img") {
        result.alt=source.getAttribute("alt") || "";
        images.push(Promise.resolve(imageBlob(source)).then(blob => {
            if (!blob) return;
            const url=URL.createObjectURL(blob);
            urls.push(url);
            result.src=url;
        }).catch(()=>{}));
      }
      if (tag==="td" || tag==="th") for (const attribute of ["rowspan","colspan"]) {
        const value=source.getAttribute(attribute);
        if (/^\d{1,2}$/u.test(value || "")) result.setAttribute(attribute,value);
      }
    }
    for (const child of source.childNodes) result.append(clean(child));
    return result;
  }
  const fragment=document.createDocumentFragment();
  for (const child of body.childNodes) fragment.append(clean(child));
  await Promise.all(images);
  return fragment;
}
