import { getDocument, GlobalWorkerOptions, TextLayer } from "./vendor/pdfjs/pdf.vector.mjs";
import { identify } from "./book-formats.mjs";
import { createVectorSurface } from "./pdf-vector.mjs";

const asset = name => new URL(`./vendor/pdfjs/${name}`,import.meta.url).href;
GlobalWorkerOptions.workerSrc = asset("pdf.worker.min.mjs");

export async function readPdf(file) {
  const data=await file.arrayBuffer();
  const identifier=await identify(data);
  const task=getDocument({
    data, cMapUrl:asset("cmaps/"), cMapPacked:true, standardFontDataUrl:asset("standard_fonts/"),
    iccUrl:asset("iccs/"), wasmUrl:asset("decoders/"),
    isEvalSupported:false, useWasm:false, enableXfa:false, maxImageSize:24000000, disableFontFace:true,
  });
  let pdf;
  try { pdf=await task.promise; }
  catch(error) {
    await task.destroy().catch(()=>{});
    if (error.name==="PasswordException") throw new Error("此 PDF 需要密码，请打开已解锁的副本。");
    throw new Error("无法读取这份 PDF。");
  }
  const {info}=await pdf.getMetadata().catch(()=>({}));
  const title=(typeof info?.Title==="string" && info.Title.trim()) || file.name.replace(/\.pdf$/iu,"");
  const author=(typeof info?.Author==="string" && info.Author.trim()) || "";
  const spine=Array.from({length:pdf.numPages},(_,i)=>String(i+1));
  return {
    identifier,title,author,spine,contents:[],format:"pdf",
    render:async path=>renderPage(await pdf.getPage(Number(path)),path),
    draw:async (path,signal)=>drawPage(await pdf.getPage(Number(path)),signal),
    dispose:()=>void task.destroy().catch(()=>{}),
  };
}

async function renderPage(page,path) {
  const view=page.getViewport({scale:1});
  const unrotated=page.getViewport({scale:1,rotation:0});
  const wrapper=document.createElement("div");
  wrapper.className="pdf-page";
  wrapper.setAttribute("aria-label",`PDF 第 ${path} 页原版式`);
  wrapper.style.setProperty("--pdf-page-width",view.width);
  wrapper.style.setProperty("--pdf-page-height",view.height);
  wrapper.dataset.textWidth=view.rotation%180 ? unrotated.rawDims.pageHeight : unrotated.rawDims.pageWidth;
  const artwork=document.createElement("div");
  artwork.className="pdf-artwork";
  wrapper.append(artwork);
  const text=document.createElement("div");
  text.className="pdf-text-layer";
  text.dataset.rotation=view.rotation;
  try {
    const source=await page.getTextContent();
    if (!source.items.some(item=>item.str?.trim())) return pageFragment(wrapper);
    const layer=new TextLayer({textContentSource:source,container:text,viewport:unrotated});
    await layer.render();
    for (const line of text.querySelectorAll("br")) line.append(document.createTextNode(" "));
    wrapper.append(text);
  } catch {
    // Pages with a damaged or missing text layer can still be painted.
  }
  return pageFragment(wrapper);
}

function pageFragment(wrapper) {
  const fragment=document.createDocumentFragment();
  fragment.append(wrapper);
  return fragment;
}

async function drawPage(page,signal) {
  signal.throwIfAborted();
  const viewport=page.getViewport({scale:1});
  const {context}=createVectorSurface(viewport.width,viewport.height);
  const task=page.render({canvasContext:context,canvas:null,viewport,background:"transparent"});
  const cancel=()=>task.cancel();
  signal.addEventListener("abort",cancel,{once:true});
  try { await task.promise; }
  finally { signal.removeEventListener("abort",cancel); }
  context.svg.setAttribute("aria-hidden","true");
  return context.svg;
}
