import { storage } from "./web-platform.mjs";
import { bookmarkRange, captureBookmark, mountBookmarks } from "./bookmarks.mjs";
import { readBook, chapterFragment } from "./book-formats.mjs";
import { excerpt } from "./translation.mjs";
import { mountWorkspace, selectionMode } from "./workspace.mjs";
import { mountDrawer } from "./drawer.mjs";
import { listBooks, loadBook, progressKey, recentBook, removeBook, saveBook } from "./bookshelf.mjs";
import { mountPdfFlow } from "./pdf-flow.mjs";
import { getWord } from "./wordbook.mjs";
import { findTerm, highlightRange, passageMatch, sentenceQuote } from "./passage.mjs";
import { folderPicker, mountFolders, moveItem, readFolders, visibleIn, watchFolders } from "./collections.mjs";

const at = id => document.getElementById(id);
const body=at("book-text");
const status=at("book-status");
const tools=mountWorkspace(at("reader-workspace"),{jumpToSource});
const drawer=mountDrawer({
  root:document.documentElement,bar:at("reader-bar"),panel:at("reader-tools"),
  toggle:at("toggle-reader-tools"),handle:at("reader-splitter"),
});
const menu=at("selection-menu");
const file=at("epub-file");
const shelf=at("bookshelf");
const shelfStatus=at("shelf-status");
const shelfList=at("shelf-books");
const saveStatus=at("shelf-save-status");
const shelves=mountFolders(at("shelf-folders"),"books","书架",openShelf,{removable:true});
watchFolders("books",()=>{ if (shelf.open) void openShelf(); });
let current, renderedBook, chapter=0, urls=[], revision=0, opening=0, shelfRevision=0;
let popup, timer, readingTimer, pointerDown=false;
let textSize=21;
let pdfFlow, pdfSeeking, scrollFrame;
const pdfZoomLevels=[.6,.8,1,1.25,1.5,2,2.5,3,4,5,6];
let pdfZoom=1;

const bookmarks=mountBookmarks(at("bookmarks"),{jump:jumpToBookmark,activeBook:()=>renderedBook?.identifier});
at("open-bookmarks").addEventListener("click",()=>void bookmarks.open());

const blocks = (root=body) => root.querySelectorAll("p,li,h1,h2,h3,h4,pre,tr,blockquote,figure,img,.pdf-page");
const sourceSelector = "p:not(.pdf-render-error),li,blockquote,td,th,h1,h2,h3,h4,h5,h6,pre,figcaption,.pdf-text-layer";
const sourceBlocks = root => [...root.querySelectorAll(sourceSelector)];
const readingEdge = () => at("reader-bar").offsetHeight + 24;

function currentLocation(root=body) {
  const edge = readingEdge();
  for (const [block,element] of blocks(root).entries()) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= edge || !rect.height) continue;
    const fraction = Math.max(0,Math.min(1,(edge - rect.top) / rect.height));
    return window.scrollY ? {block,fraction} : undefined;
  }
}

function savePosition() {
  if (!current || renderedBook !== current || pdfSeeking) return;
  if (pdfFlow) syncPdfChapter();
  const page=pdfFlow?.element(chapter);
  const label = at("chapter-select").selectedOptions[0]?.textContent.trim() || `部分 ${chapter+1}`;
  const position = {chapter,label,y:page ? 0 : window.scrollY,location:currentLocation(page),updated:Date.now()};
  if (page) {
    position.pdfOffset=Math.max(0,readingEdge()-page.getBoundingClientRect().top);
    position.pdfLayout="original";
  }
  if (!position.location) delete position.location;
  void storage.local.set({[progressKey(current.identifier)]:position}).catch(()=>{});
}

function hideMenu(){ menu.hidden=true; popup=undefined; }

function clearBookmarkHighlight() {
  globalThis.CSS?.highlights?.delete("bookmark-origin");
  globalThis.CSS?.highlights?.delete("bookmark-origin-pdf");
}

function syncPdfChapter() {
  if (!pdfFlow || pdfSeeking || renderedBook!==current) return;
  chapter=pdfFlow.active();
  at("chapter-select").value=String(chapter);
}

function buildContents(book){
  const selector=at("chapter-select");
  selector.labels[0].textContent=book.format==="pdf" ? "页码" : "章节";
  selector.disabled=false;
  selector.replaceChildren();
  for(const [i,path] of book.spine.entries()){
    const label=book.contents.find(item=>item.path===path && !item.anchor)?.label;
    selector.add(new Option(label || (book.format==="pdf" ? `第 ${i+1} 页` : `部分 ${i+1}`),String(i)));
    for(const linked of book.contents.filter(item=>item.path===path && item.anchor)) {
      selector.add(new Option("　"+linked.label,`${i}#${linked.anchor}`));
    }
  }
  selector.hidden=false;
}

async function move(index,anchor="",position={}){
  const book=current;
  if (!book || index<0 || index>=book.spine.length) return;
  const sequence=++revision;
  hideMenu();
  clearBookmarkHighlight();
  if (book.format==="pdf") return movePdf(book,index,position,sequence);
  status.textContent="正在打开章节…";
  const nextUrls=[];
  try {
    const fragment=await chapterFragment(book,book.spine[index],nextUrls);
    if (sequence!==revision || book!==current) { nextUrls.forEach(URL.revokeObjectURL); return; }
    urls.forEach(URL.revokeObjectURL);
    urls=nextUrls;
    globalThis.CSS?.highlights?.delete("word-origin");
    pdfFlow?.dispose();
    pdfFlow=pdfSeeking=undefined;
    body.replaceChildren(fragment);
    if (renderedBook && renderedBook!==book) renderedBook.dispose?.();
    chapter=index;
    renderedBook=book;
    updateSizeButtons();
    at("chapter-select").value=anchor ? `${index}#${anchor}` : String(index);
    if(at("chapter-select").selectedIndex<0) at("chapter-select").value=String(index);
    at("chapter-buttons").hidden=false;
    at("previous").disabled=index===0;
    at("next").disabled=index===book.spine.length-1;
    status.textContent="";
    const target=anchor ? [...body.querySelectorAll("[data-book-id]")].find(n=>n.dataset.bookId===anchor) : null;
    const location=position.location;
    const block=Number.isInteger(location?.block) ? blocks()[location.block] : null;
    if (target) target.scrollIntoView({block:"start"});
    else if (block && Number.isFinite(location.fraction)) {
      const rect=block.getBoundingClientRect();
      window.scrollTo(0,window.scrollY + rect.top + rect.height * location.fraction - readingEdge());
    } else window.scrollTo(0,position.y || 0);
    savePosition();
    return true;
  } catch(error) {
    nextUrls.forEach(URL.revokeObjectURL);
    if(sequence===revision) status.textContent=error.message || "无法打开章节。";
  }
}

async function movePdf(book,index,position,sequence) {
  const selector=at("chapter-select");
  if (renderedBook!==book) {
    pdfFlow?.dispose();
    renderedBook?.dispose?.();
    urls.forEach(URL.revokeObjectURL);
    urls=[];
    pdfFlow=mountPdfFlow(body,book,readingEdge);
    pdfZoom=1;
    body.scrollLeft=0;
    renderedBook=book;
    updateSizeButtons();
    selector.disabled=true;
    at("chapter-buttons").hidden=true;
  }
  const flow=pdfFlow;
  pdfSeeking=sequence;
  selector.value=String(index);
  status.textContent="";
  globalThis.CSS?.highlights?.delete("word-origin");
  body.querySelector(".origin-passage")?.classList.remove("origin-passage");
  await flow.prepare(index);
  if (sequence!==revision || current!==book) {
    if (pdfSeeking===sequence) {
      pdfSeeking=undefined;
      selector.disabled=false;
    }
    return;
  }
  const page=flow.element(index);
  const location=position.location;
  const block=Number.isInteger(location?.block) && position.pdfLayout==="original" ? blocks(page)[location.block] : null;
  const pageRect=page.getBoundingClientRect();
  const offset=Math.min(Math.max(0,position.pdfOffset ?? position.y ?? 0),Math.max(0,pageRect.height-2));
  const blockRect=block?.getBoundingClientRect();
  const target=blockRect?.height && Number.isFinite(location.fraction)
    ? blockRect.top+blockRect.height*location.fraction
    : pageRect.top+offset;
  window.scrollTo(0,index===0 && !offset && !blockRect ? 0 : window.scrollY+target-readingEdge());
  chapter=index;
  pdfSeeking=undefined;
  selector.disabled=false;
  savePosition();
  return true;
}

function chapterRoot(book,index) {
  if (renderedBook!==book) return null;
  if (!pdfFlow) return chapter===index ? body : null;
  const page=pdfFlow.element(index);
  return page?.querySelector(sourceSelector) ? page : null;
}

function locatePassage(root,record,chapterIndex) {
  const candidates=sourceBlocks(root);
  const location=record.location;
  const exact=location?.chapter===chapterIndex && candidates[location.block];
  if (exact && (!exact.matches(".pdf-text-layer") || location.pdfTextLayer)) {
    const match=passageMatch(exact.textContent,record,true);
    if (match) return {element:exact,match};
  }
  for (const element of candidates) {
    const match=passageMatch(element.textContent,record);
    if (match) return {element,match};
  }
  const layer=candidates.find(element=>element.matches(".pdf-text-layer"));
  if (layer && location?.bookId && location.chapter===chapterIndex) {
    const term=record.selection || record.word;
    const text=layer.textContent;
    const match=findTerm(text,term);
    if (match && !findTerm(text.slice(match.start+match.length),term)) return {element:layer,match};
  }
}

async function jumpToSource(record) {
  const task=++opening;
  const {location}=record;
  if (!record.quote) record={...record,quote:sentenceQuote(record.context,record.selection || record.word)};
  const shelfBooks=await listBooks();
  const sameBook=book=>location?.bookId ? book.identifier===location.bookId : book.title===record.source;
  const books=shelfBooks.filter(book=>location?.bookId ? book.id===location.bookId : book.title===record.source);
  if (current && sameBook(current) && !books.some(book=>book.id===current.identifier)) {
    books.unshift({id:current.identifier});
  }
  if (!books.length) throw new Error("请先把对应的电子书导入「我的书库」，再跳转原文。");
  for (const saved of books) {
    const book=current?.identifier===saved.id ? current : await readBook(await loadBook(saved.id));
    if (task!==opening) return;
    const chapters=Number.isInteger(location?.chapter) ? [location.chapter] : book.spine.map((_,i)=>i);
    for (const index of chapters) {
      if (!book.spine[index]) continue;
      const temporaryUrls=[];
      let found;
      try {
        const section=chapterRoot(book,index) || await chapterFragment(book,book.spine[index],temporaryUrls);
        found=locatePassage(section,record,index);
      } finally { temporaryUrls.forEach(URL.revokeObjectURL); }
      if (task!==opening) return;
      if (!found) continue;
      if (renderedBook!==book || chapter!==index || !chapterRoot(book,index)) {
        clearTimeout(readingTimer);
        savePosition();
        current=book;
        const title=at("book-title");
        title.textContent=book.title; title.hidden=false;
        document.title=book.title+" • B-read";
        buildContents(book);
        if (!await move(index) || task!==opening) {
          if (renderedBook!==book) book.dispose?.();
          if (current===book && renderedBook!==book) current=renderedBook;
          return;
        }
        const root=chapterRoot(book,index);
        found=root && locatePassage(root,record,index);
      }
      if (!found) break;
      drawer.close();
      body.querySelector(".origin-passage")?.classList.remove("origin-passage");
      found.element.classList.add("origin-passage");
      const range=highlightRange(found.element,found.match);
      if (range && globalThis.Highlight && CSS.highlights) CSS.highlights.set("word-origin",new Highlight(range));
      if (range && found.element.matches(".pdf-text-layer")) {
        const rect=range.getBoundingClientRect();
        window.scrollTo(0,window.scrollY+rect.top-(innerHeight-rect.height)/2);
        const clip=body.getBoundingClientRect();
        if (rect.left<clip.left || rect.right>clip.right) body.scrollLeft+=rect.left-(clip.left+clip.right-rect.width)/2;
      } else found.element.scrollIntoView({block:"center"});
      savePosition();
      return;
    }
    if (book!==current) book.dispose?.();
  }
  throw new Error("书库里未找到匹配的原句。请确认导入的是保存单词时用的电子书。");
}

async function jumpToBookmark(record) {
  const task=++opening;
  const first=record.segments[0];
  let book=current?.identifier===record.bookId ? current : undefined;
  if (!book) {
    const saved=await loadBook(record.bookId);
    if (!saved) throw new Error("请先把对应电子书重新导入「我的书库」。");
    book=await readBook(saved);
  }
  if (task!==opening || !book.spine[first.chapter]) {
    if (book!==current) book.dispose?.();
    throw new Error("暂时无法打开书签所在的章节。");
  }
  if (!chapterRoot(book,first.chapter) || chapter!==first.chapter) {
    clearTimeout(readingTimer);
    savePosition();
    current=book;
    const title=at("book-title");
    title.textContent=book.title;
    title.hidden=false;
    document.title=book.title+" • B-read";
    buildContents(book);
    if (!await move(first.chapter) || task!==opening) {
      if (renderedBook!==book) book.dispose?.();
      if (current===book && renderedBook!==book) current=renderedBook;
      throw new Error("暂时无法打开书签所在的章节。");
    }
  }
  const ranges=record.segments.flatMap(segment=>{
    const section=chapterRoot(book,segment.chapter);
    const root=pdfFlow ? section?.querySelector(".pdf-text-layer") : section;
    const range=root && bookmarkRange(root,segment);
    return range ? [range] : [];
  });
  if (!ranges.length) throw new Error("已打开书签所在的章节，但找不到对应摘录。");
  drawer.close();
  body.querySelector(".origin-passage")?.classList.remove("origin-passage");
  globalThis.CSS?.highlights?.delete("word-origin");
  clearBookmarkHighlight();
  if (globalThis.Highlight && CSS.highlights) {
    CSS.highlights.set(pdfFlow ? "bookmark-origin-pdf" : "bookmark-origin",new Highlight(...ranges));
  }
  const rect=[...ranges[0].getClientRects()].find(item=>item.width && item.height);
  if (rect) {
    window.scrollTo(0,window.scrollY+rect.top-(innerHeight-rect.height)/2);
    if (pdfFlow) {
      const clip=body.getBoundingClientRect();
      if (rect.left<clip.left || rect.right>clip.right) body.scrollLeft+=rect.left-(clip.left+clip.right-rect.width)/2;
    }
  }
  savePosition();
}

async function useFile(chosen,save=true,folder=""){
  const task=++opening;
  clearTimeout(readingTimer);
  savePosition();
  saveStatus.hidden=true;
  status.textContent="正在读取电子书…";
  try {
    const book=await readBook(chosen);
    if(task!==opening) { book.dispose?.(); return; }
    const key=progressKey(book.identifier);
    const position=(await storage.local.get(key).catch(()=>({})))[key];
    if(task!==opening) { book.dispose?.(); return; }
    current=book;
    const bookTitle=at("book-title");
    bookTitle.textContent=book.title;bookTitle.hidden=false;
    document.title=book.title+" • B-read";
    buildContents(book);
    const lastChapter=Number.isInteger(position?.chapter) && book.spine[position.chapter] ? position.chapter : 0;
    if (!await move(lastChapter,"",position)) {
      if (renderedBook!==book) book.dispose?.();
      if (current===book) current=renderedBook;
      return;
    }
    if (task!==opening || !save || renderedBook!==book) return;
    try {
      await saveBook(book,chosen);
      if (folder && folder!=="all") await moveItem("books",book.identifier,folder);
      if (task===opening && shelf.open) void openShelf();
    } catch {
      if (task===opening) {
        saveStatus.textContent="这本书已打开，但未能保存到书库。可重新导入再试。";
        saveStatus.hidden=false;
      }
    }
  } catch(error) {
    if(task===opening) status.textContent=error.message || "无法打开这本电子书。";
  }
}

function shelfItem(book,position,{folders,assignments}) {
  const item=document.createElement("li");
  const details=document.createElement("div");
  const title=document.createElement("h3");
  title.textContent=book.title;
  const progress=document.createElement("p");
  const label=position?.label || (Number.isInteger(position?.chapter) ? `第 ${position.chapter+1} 部分` : "尚未记录进度");
  progress.textContent=[book.author,label].filter(Boolean).join(" · ");
  details.append(title,progress);
  const open=document.createElement("button");
  open.type="button";
  open.textContent=position ? "继续阅读" : "打开";
  open.setAttribute("aria-label",`${open.textContent}《${book.title}》`);
  open.addEventListener("click",async()=>{
    open.disabled=true;
    try {
      const saved=await loadBook(book.id);
      if (!saved) throw new Error("书籍文件不可用，请重新导入。");
      if (!shelf.open) return;
      shelf.close();
      await useFile(saved);
    } catch (error) {
      shelfStatus.textContent=error.message || "无法打开书库里的这本书。";
    } finally { open.disabled=false; }
  });
  const actions=document.createElement("div");
  actions.className="shelf-item-actions";
  actions.append(open);
  if (folders.length) actions.append(folderPicker("books",book.id,folders,assignments.get(book.id),book.title,openShelf));
  const remove=document.createElement("button");
  remove.type="button";
  remove.className="secondary shelf-delete";
  remove.textContent="删除";
  remove.setAttribute("aria-label",`从书库删除《${book.title}》`);
  remove.addEventListener("click",async()=>{
    if (!window.confirm(`从书库删除《${book.title}》？这会移除书库里的副本和阅读进度，你原来导入的文件仍可使用。`)) return;
    remove.disabled=open.disabled=true;
    try {
      await removeBook(book.id);
      if (current?.identifier===book.id) closeBook();
      await Promise.all([moveItem("books",book.id,""),storage.local.remove(progressKey(book.id))]);
      if (shelf.open) await openShelf();
    } catch {
      shelfStatus.textContent="无法完成删除，请重试。";
    } finally { remove.disabled=open.disabled=false; }
  });
  actions.append(remove);
  item.append(details,actions);
  return item;
}

function closeBook() {
  ++opening;
  ++revision;
  clearTimeout(readingTimer);
  hideMenu();
  pdfFlow?.dispose();
  pdfFlow=pdfSeeking=undefined;
  if (current!==renderedBook) current?.dispose?.();
  renderedBook?.dispose?.();
  current=renderedBook=undefined;
  updateSizeButtons();
  urls.forEach(URL.revokeObjectURL);
  urls=[];
  body.replaceChildren();
  globalThis.CSS?.highlights?.delete("word-origin");
  clearBookmarkHighlight();
  at("chapter-select").hidden=true;
  at("chapter-buttons").hidden=true;
  at("book-title").hidden=true;
  document.title="电子书阅读器 • B-read";
  status.textContent="打开电子书，或从「我的书库」继续阅读。";
  window.scrollTo(0,0);
}

async function openShelf() {
  clearTimeout(readingTimer);
  savePosition();
  const task=++shelfRevision;
  shelfList.replaceChildren();
  shelfStatus.textContent="正在读取书库…";
  if (!shelf.open) shelf.showModal();
  try {
    const [books,collections]=await Promise.all([listBooks(),readFolders("books")]);
    const stored=await storage.local.get(books.map(book=>progressKey(book.id)));
    if (task!==shelfRevision || !shelf.open) return;
    books.sort((a,b)=>b.opened-a.opened);
    shelves.update(collections.folders);
    const listed=books.filter(book=>visibleIn(shelves.current(),collections.assignments.get(book.id)));
    shelfList.replaceChildren(...listed.map(book=>shelfItem(book,stored[progressKey(book.id)],collections)));
    shelfStatus.textContent=listed.length ? "" : books.length ? "这个书架里还没有书。" : "导入电子书后，这里会显示书名和阅读进度。";
  } catch {
    if (task===shelfRevision) shelfStatus.textContent="暂时无法读取书库，请重新打开再试。";
  }
}

at("open-bookshelf").addEventListener("click",()=>void openShelf());
at("open-support").addEventListener("click",()=>{
  hideMenu();
  at("support-dialog").showModal();
});
at("open-epub").addEventListener("click",()=>file.click());
at("shelf-import").addEventListener("click",()=>file.click());
file.addEventListener("change",()=>{
  const chosen=file.files[0];file.value="";
  if (chosen) {
    const folder=shelf.open ? shelves.current() : "";
    if (shelf.open) shelf.close();
    void useFile(chosen,true,folder);
  }
});
at("chapter-select").addEventListener("change",event=>{
  const [i,...parts]=event.target.value.split("#");
  void move(Number(i),parts.join("#"));
});
at("previous").addEventListener("click",()=>void move(chapter-1));
at("next").addEventListener("click",()=>void move(chapter+1));
body.addEventListener("click",event=>{
  const link=event.target.closest("a[data-book-path]");
  if(link && current){
    event.preventDefault();
    void move(current.spine.indexOf(link.dataset.bookPath),link.dataset.bookAnchor);
  }
});

function setFont(size){
  textSize=Math.max(14,Math.min(34,size));
  body.style.fontSize=`${textSize}px`;
}

function updateSizeButtons() {
  const isPdf=Boolean(pdfFlow);
  for (const [id,zoom,label] of [["font-minus","缩小","减小字号"],["font-plus","放大","增大字号"]]) {
    const button=at(id);
    const description=isPdf ? `PDF ${zoom}（${Math.round(pdfZoom*100)}%）` : label;
    button.title=description;
    button.setAttribute("aria-label",description);
  }
  at("font-minus").disabled=isPdf && pdfZoom===pdfZoomLevels[0];
  at("font-plus").disabled=isPdf && pdfZoom===pdfZoomLevels.at(-1);
  body.tabIndex=isPdf ? 0 : -1;
}

function changePdfZoom(direction) {
  const page=pdfFlow.element(pdfFlow.active());
  const layout=page.querySelector(".pdf-page");
  const before=layout?.getBoundingClientRect();
  const offset=before ? Math.max(0,readingEdge()-before.top)/before.height : 0;
  const center=(body.scrollLeft+body.clientWidth/2)/pdfZoom;
  const initialLeft=body.scrollLeft;
  pdfZoom=pdfZoomLevels[pdfZoomLevels.indexOf(pdfZoom)+direction] ?? pdfZoom;
  pdfFlow.zoom(pdfZoom);
  body.scrollLeft=initialLeft || direction>0 ? center*pdfZoom-body.clientWidth/2 : 0;
  const after=layout?.getBoundingClientRect();
  if (after && offset) window.scrollTo(0,window.scrollY+after.top+after.height*offset-readingEdge());
  updateSizeButtons();
}

for (const [id,direction] of [["font-minus",-1],["font-plus",1]]) at(id).addEventListener("click",()=>{
  if (pdfFlow) { changePdfZoom(direction); return; }
  setFont(textSize+direction);
  storage.local.set({"reader-font-size":textSize}).catch(()=>{});
});
storage.local.get("reader-font-size").then(data=>setFont(Number(data["reader-font-size"]) || 21)).catch(()=>{});
at("open-wordbook").addEventListener("click",()=>{ tools.select("book"); drawer.open(); });

function positionMenu(){
  const selection=document.getSelection();
  const text=excerpt(selection?.toString());
  if(!selection?.rangeCount || selection.isCollapsed || !text
    || !body.contains(selection.anchorNode) || !body.contains(selection.focusNode)) return hideMenu();
  const range=selection.getRangeAt(0);
  const rect=[...range.getClientRects()].find(rect=>rect.width && rect.height && rect.bottom>=0 && rect.top<=innerHeight);
  if (!rect) return hideMenu();
  const english=/[a-z]/iu.test(text);
  const bookmark=current && renderedBook===current && captureBookmark(selection,range,body,current,chapter);
  if (!english && !bookmark) return hideMenu();
  if (bookmark) {
    const index=bookmark.segments[0].chapter;
    const option=[...at("chapter-select").options].find(item=>item.value===String(index));
    bookmark.chapterLabel=option?.textContent.trim() || `部分 ${index+1}`;
  }
  const start=range.startContainer;
  const block=(start.nodeType===1 ? start : start.parentElement)?.closest(sourceSelector);
  let context=excerpt(block?.textContent);
  const source={title:current?.title};
  if (block && renderedBook===current && current && block.contains(range.endContainer)) {
    const prefix=range.cloneRange();
    prefix.selectNodeContents(block);
    prefix.setEnd(range.startContainer,range.startOffset);
    const offset=prefix.toString().length;
    source.quote=sentenceQuote(block.textContent,text,offset);
    const pdfPage=block.closest("[data-pdf-index]");
    source.location={
      bookId:current.identifier,chapter:pdfPage ? Number(pdfPage.dataset.pdfIndex) : chapter,
      block:sourceBlocks(pdfPage || body).indexOf(block),offset,
    };
    if (pdfPage) source.location.pdfTextLayer=true;
  }
  const match=source.location ? excerpt(block.textContent.slice(0,source.location.offset)).length : context.indexOf(text);
  if(context.length>1000) context=match>=0 ? context.slice(Math.max(0,match-400),match+text.length+400).slice(0,1000) : context.slice(0,1000);
  popup={text:text.slice(0,8000),source:{...source,context},bookmark};
  at("selection-word").hidden=!english || text.length>120 || text.split(" ").length>6;
  at("selection-translation").hidden=!english;
  at("selection-bookmark").hidden=!bookmark;
  const mode=selectionMode(text);
  at("selection-word").classList.toggle("primary",mode==="word");
  at("selection-translation").classList.toggle("primary",mode==="translation");
  menu.hidden=false;
  menu.style.left=`${Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,rect.left))}px`;
  menu.style.top=`${Math.max(8,rect.top>menu.offsetHeight+10 ? rect.top-menu.offsetHeight-7 : Math.min(innerHeight-menu.offsetHeight-8,rect.bottom+7))}px`;
}

function scheduleMenu(){
  clearTimeout(timer);
  if(!pointerDown) timer=setTimeout(positionMenu,70);
}
body.addEventListener("pointerdown",()=>{pointerDown=true;hideMenu();});
document.addEventListener("pointerup",()=>{ pointerDown=false; scheduleMenu(); });
document.addEventListener("pointercancel",()=>{ pointerDown=false; scheduleMenu(); });
document.addEventListener("selectionchange",scheduleMenu);
menu.addEventListener("pointerdown",event=>event.preventDefault());
document.addEventListener("keydown",event=>{
  if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
  clearTimeout(timer);
  if (menu.hidden) drawer.close();
  else hideMenu();
});
for (const [id,fn] of [["selection-word",tools.word],["selection-translation",tools.translation]]) at(id).addEventListener("click",()=>{
  if(!popup)return;
  const {text,source}=popup;
  hideMenu();
  document.getSelection()?.removeAllRanges();
  fn(text,source);
  drawer.open();
});
at("selection-bookmark").addEventListener("click",()=>{
  const bookmark=popup?.bookmark;
  if (!bookmark) return;
  hideMenu();
  document.getSelection()?.removeAllRanges();
  bookmarks.add(bookmark);
});
window.addEventListener("scroll",()=>{
  hideMenu();
  if (pdfFlow && !scrollFrame) scrollFrame=requestAnimationFrame(()=>{
    scrollFrame=undefined;
    syncPdfChapter();
  });
  clearTimeout(readingTimer);
  readingTimer=setTimeout(savePosition,350);
},{passive:true});
window.addEventListener("pagehide",savePosition);
const originalWord=new URLSearchParams(location.search).get("word");
if (originalWord) {
  void getWord(originalWord).then(record=>{
    if (!record) throw new Error("这个单词已不在单词本中。");
    return jumpToSource(record);
  }).catch(error=>{ status.textContent=error.message || "无法打开保存的原文。"; });
} else {
  void recentBook().then(({file:recent,legacy})=>{
    if (recent && !opening) void useFile(recent,legacy);
  }).catch(()=>{});
}
