import { storage } from "./web-platform.mjs";
const prefix = scope => `collections:${scope}:`;

export function folderState(scope, values) {
  const base=prefix(scope);
  const folders=[];
  const assignments=new Map();
  for (const [key,value] of Object.entries(values)) {
    if (key.startsWith(base+"folder:")) folders.push(value);
    if (key.startsWith(base+"item:")) assignments.set(key.slice((base+"item:").length),value);
  }
  folders.sort((a,b)=>a.name.localeCompare(b.name,"zh-CN"));
  return {folders,assignments};
}

export async function readFolders(scope) {
  return folderState(scope,await storage.local.get(null));
}

export async function writeFolder(scope,name,id) {
  const label=name.trim();
  if (!label || label.length>60) throw new Error("请输入 1–60 个字符的名称。");
  const {folders}=await readFolders(scope);
  if (folders.some(folder=>folder.id!==id && folder.name.toLocaleLowerCase()===label.toLocaleLowerCase())) {
    throw new Error("已存在同名文件夹。");
  }
  const folder={id:id || crypto.randomUUID(),name:label};
  await storage.local.set({[prefix(scope)+"folder:"+folder.id]:folder});
  return folder.id;
}

export function moveItem(scope,item,folder) {
  const key=prefix(scope)+"item:"+item;
  return folder ? storage.local.set({[key]:folder}) : storage.local.remove(key);
}

export async function removeFolder(scope,id) {
  const {assignments}=await readFolders(scope);
  const base=prefix(scope);
  const keys=[base+"folder:"+id];
  for (const [item,folder] of assignments) {
    if (folder===id) keys.push(base+"item:"+item);
  }
  await storage.local.remove(keys);
}

export function watchFolders(scope,callback) {
  const base=prefix(scope);
  storage.onChanged.addListener((changes,area)=>{
    if (area==="local" && Object.keys(changes).some(key=>key.startsWith(base))) callback();
  });
}

export function visibleIn(selection,folder) {
  return selection==="all" || (folder || "")===selection;
}

export function mountFolders(root,scope,label,refresh,{removable=false}={}) {
  root.innerHTML=`
    <div class="folder-tools">
      <select data-folder-list></select>
      <button type="button" class="secondary" data-folder-create>新建${label}</button>
      <button type="button" class="secondary" data-folder-rename hidden>重命名</button>
      ${removable ? `<button type="button" class="secondary shelf-delete" data-folder-remove hidden>删除${label}</button>` : ""}
    </div>
    <form class="folder-form" hidden>
      <input type="text" maxlength="60" required>
      <button type="submit" class="primary">保存</button>
      <button type="button" class="secondary">取消</button>
    </form>
    <p class="meta folder-status" role="status"></p>`;
  const select=root.querySelector("[data-folder-list]");
  const create=root.querySelector("[data-folder-create]");
  const rename=root.querySelector("[data-folder-rename]");
  const remove=root.querySelector("[data-folder-remove]");
  const form=root.querySelector("form");
  const input=form.querySelector("input");
  const error=root.querySelector(".folder-status");
  select.setAttribute("aria-label",`选择${label}`);
  input.setAttribute("aria-label",`${label}名称`);
  input.placeholder=`${label}名称`;
  const cancel=form.querySelector('button[type="button"]');
  let id="all", editing, folders=[];
  function edit(folder) {
    editing=folder?.id;
    input.value=folder?.name || "";
    error.textContent="";
    form.hidden=false;
    input.focus();
  }
  function update(available) {
    folders=available;
    if (id!=="all" && id && !folders.some(folder=>folder.id===id)) id="all";
    select.replaceChildren(new Option("全部","all"),new Option("未分类",""),
      ...folders.map(folder=>new Option(folder.name,folder.id)));
    select.value=id;
    rename.hidden=id==="all" || !id;
    if (remove) remove.hidden=rename.hidden;
  }
  select.addEventListener("change",()=>{
    id=select.value;
    form.hidden=true;
    error.textContent="";
    refresh();
  });
  create.addEventListener("click",()=>edit());
  rename.addEventListener("click",()=>edit(folders.find(folder=>folder.id===id)));
  remove?.addEventListener("click",async()=>{
    const selected=folders.find(folder=>folder.id===id);
    if (!selected || !window.confirm(`删除${label}「${selected.name}」？其中的书籍和文献将移到「未分类」。`)) return;
    remove.disabled=true;
    try {
      await removeFolder(scope,selected.id);
      if (id===selected.id || id==="all") id="";
      form.hidden=true;
      error.textContent="";
      refresh();
    } catch {
      error.textContent="无法删除，请重试。";
    } finally { remove.disabled=false; }
  });
  cancel.addEventListener("click",()=>{form.hidden=true;error.textContent="";});
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    input.disabled=true;
    const submit=form.querySelector('button[type="submit"]');
    submit.disabled=true;
    try {
      id=await writeFolder(scope,input.value,editing);
      form.hidden=true;
      error.textContent="";
      refresh();
    } catch(problem) { error.textContent=problem.message || "无法保存，请重试。"; }
    finally { input.disabled=false; submit.disabled=false; }
  });
  return {update,current:()=>id};
}

export function folderPicker(scope,item,folders,current,label,refresh) {
  const picker=document.createElement("select");
  picker.className="folder-picker";
  picker.setAttribute("aria-label",`将${label}移动到文件夹`);
  picker.append(new Option("未分类",""),...folders.map(folder=>new Option(folder.name,folder.id)));
  picker.value=folders.some(folder=>folder.id===current) ? current : "";
  picker.title="移动到文件夹";
  picker.addEventListener("change",async()=>{
    picker.disabled=true;
    try {
      await moveItem(scope,item,picker.value);
      refresh();
    } catch {
      picker.value=current || "";
      picker.title="移动失败，请重试";
    } finally { picker.disabled=false; }
  });
  return picker;
}
