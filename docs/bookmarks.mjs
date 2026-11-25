import { storage } from "./web-platform.mjs";
import { highlightRange } from "./passage.mjs";

const prefix="reader-bookmark:";
const selectionLimit=12_000;

export function captureBookmark(selection,range,root,book,chapter) {
  const quote=selection.toString().trim();
  if (!quote || quote.length>selectionLimit) return;
  const inPdf=book.format==="pdf";
  const targets=inPdf ? [...root.querySelectorAll(".pdf-text-layer")].map(layer=>({
    root:layer, chapter:Number(layer.closest("[data-pdf-index]").dataset.pdfIndex),
  })) : [{root,chapter}];
  const segments=[];
  let total=0;
  for (const target of targets) {
    const host=target.root;
    if (!range.intersectsNode(host)) continue;
    const part=document.createRange();
    part.selectNodeContents(host);
    if (host.contains(range.startContainer)) part.setStart(range.startContainer,range.startOffset);
    if (host.contains(range.endContainer)) part.setEnd(range.endContainer,range.endOffset);
    const text=part.toString();
    if (!text.trim()) continue;
    const before=document.createRange();
    before.selectNodeContents(host);
    before.setEnd(part.startContainer,part.startOffset);
    total+=text.length;
    if (total>selectionLimit) return;
    segments.push({chapter:target.chapter,start:before.toString().length,text});
  }
  if (!segments.length) return;
  return {bookId:book.identifier,title:book.title,format:book.format,quote,segments};
}

export function bookmarkRange(root,segment) {
  const source=root.textContent;
  const {text,start}=segment;
  let position=start;
  if (source.slice(start,start+text.length)!==text) {
    position=-1;
    let distance=Infinity;
    for (let found=source.indexOf(text); found!==-1; found=source.indexOf(text,found+1)) {
      const next=Math.abs(found-start);
      if (next>=distance) break;
      position=found;
      distance=next;
    }
  }
  if (position>=0) return highlightRange(root,{start:position,length:text.length});
}

const create=(tag,text)=>{
  const element=document.createElement(tag);
  if (text!==undefined) element.textContent=text;
  return element;
};

function control(label,action) {
  const button=create("button",label);
  button.type="button";
  button.addEventListener("click",action);
  return button;
}

async function records() {
  return Object.entries(await storage.local.get(null))
    .filter(([key])=>key.startsWith(prefix)).map(([,value])=>value)
    .sort((first,second)=>second.created-first.created);
}

function exportRecords(items) {
  const markdown=["# B-read 书签"];
  for (const record of items) {
    markdown.push(
      "## " + record.title.replace(/\s+/gu," ") + " · " + record.chapterLabel,
      record.quote.split("\n").map(line=>"> "+line).join("\n"),
      record.note || "",
    );
  }
  const url=URL.createObjectURL(new Blob([markdown.join("\n\n")+"\n"],{type:"text/markdown;charset=utf-8"}));
  const link=create("a");
  link.download="B-read_Bookmarks.md";
  link.href=url;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function mountBookmarks(dialog,{jump,activeBook}) {
  const at=id=>dialog.querySelector("#"+id);
  const title=at("bookmarks-title");
  const tools=at("bookmarks-tools");
  const scope=at("bookmarks-scope");
  const list=at("bookmarks-list");
  const form=at("bookmark-form");
  const quote=at("bookmark-quote");
  const note=at("bookmark-note");
  const message=at("bookmarks-status");
  const download=at("export-bookmarks");
  let draft;
  let visible=[];
  let revision=0;
  let selectedScope;

  const clearStatus=()=>{ message.textContent=""; };

  function showEditor(record) {
    ++revision;
    draft=record;
    title.textContent=record.id ? "编辑书签" : "添加书签";
    quote.textContent=record.quote;
    note.value=record.note || "";
    tools.hidden=list.hidden=true;
    form.hidden=false;
    clearStatus();
    if (!dialog.open) dialog.showModal();
    note.focus();
  }

  function buildItem(record) {
    const row=create("li");
    row.append(create("p",record.title+" · "+record.chapterLabel));
    row.firstElementChild.className="meta";
    row.append(create("blockquote",record.quote));
    if (record.note) {
      const text=create("p",record.note);
      text.className="bookmark-note";
      row.append(text);
    }
    const actions=create("div");
    actions.className="button-row";
    const go=control("跳转原文",async()=>{
      go.disabled=true;
      try {
        await jump(record);
        dialog.close();
      } catch (error) {
        message.textContent=error.message || "暂时无法跳转原文。";
      } finally {
        go.disabled=false;
      }
    });
    const deletion=control("删除",()=>{
      const confirm=control("确认删除",async()=>{
        confirm.disabled=true;
        try {
          await storage.local.remove(prefix+record.id);
          await showList();
        } catch { message.textContent="未能删除书签，请重试。"; }
        finally { confirm.disabled=false; }
      });
      const cancel=control("取消",()=>{
        confirm.remove();
        cancel.remove();
        deletion.hidden=false;
        deletion.focus();
      });
      deletion.hidden=true;
      actions.append(confirm,cancel);
      cancel.focus();
    });
    actions.append(go,control("编辑",()=>showEditor(record)),deletion);
    row.append(actions);
    return row;
  }

  async function showList() {
    const version=++revision;
    const id=activeBook();
    draft=undefined;
    title.textContent="书签";
    if (!id) selectedScope="all";
    scope.options[0].disabled=!id;
    scope.value=selectedScope || "book";
    download.disabled=true;
    form.hidden=true;
    tools.hidden=list.hidden=false;
    list.replaceChildren();
    clearStatus();
    if (!dialog.open) dialog.showModal();
    try {
      const all=await records();
      if (version!==revision || !dialog.open) return;
      visible=scope.value==="book" ? all.filter(item=>item.bookId===id) : all;
      list.replaceChildren(...visible.map(buildItem));
      download.disabled=!visible.length;
      if (!visible.length) message.textContent="还没有书签。选中正文里的句子，点击「添加书签」。";
    } catch {
      if (version===revision) message.textContent="暂时无法读取书签。";
    }
  }

  form.addEventListener("submit",async event=>{
    event.preventDefault();
    if (!draft) return;
    const submit=event.submitter;
    if (submit) submit.disabled=true;
    const record={...draft,id:draft.id || crypto.randomUUID(),created:draft.created || Date.now(),note:note.value.trim()};
    try {
      await storage.local.set({[prefix+record.id]:record});
      await showList();
      scope.focus();
    } catch {
      message.textContent="未能保存书签，请检查浏览器存储空间。";
    } finally { if (submit) submit.disabled=false; }
  });
  at("cancel-bookmark").addEventListener("click",()=>draft?.id ? void showList() : dialog.close());
  scope.addEventListener("change",()=>{ selectedScope=scope.value; void showList(); });
  download.addEventListener("click",()=>exportRecords(visible));
  dialog.addEventListener("close",()=>{ ++revision; draft=undefined; });
  return {open:()=>{ selectedScope=activeBook() ? "book" : "all"; return showList(); }, add:showEditor};
}
