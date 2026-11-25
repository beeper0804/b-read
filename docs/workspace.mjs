import { storage } from "./web-platform.mjs";
import { mountAssistantPairing } from "./assistant-pairing.mjs";
import { hostedReader } from "./assistant-bridge.mjs";
import { lookup, dictionaryInfo, importDictionary } from "./data.mjs";
import { lexiconMeta } from "./lexicon.mjs";
import { addWord, bookEntries, removeWord, watchWords, wordCsv } from "./wordbook.mjs";
import { excerpt, requestAssistant, translateExample, translateWithGpt } from "./translation.mjs";
import { localExamples } from "./examples.mjs";
import { appearanceFields, mountAppearance } from "./appearance.mjs";
import { sentenceQuote } from "./passage.mjs";
import { folderPicker, mountFolders, readFolders, visibleIn, watchFolders } from "./collections.mjs";

const POS = /^(?:(?:adj|adv|abbr|aux(?:\s+v)?|prep|pron|conj|int|interj|num|det|art|phr|pl|vi|vt|v|n|a)\.)(?=\s|\p{Script=Han}|[、/]|$)/iu;
const singleWord = /^[\p{L}]+(?:[’'-][\p{L}]+)*[’'".,!?;:)]*$/u;
const USAGE_PAGE = "https://chatgpt.com/settings/usage";
const MODEL_KEY = "gpt-reading-model";
const EFFORT_KEY = "gpt-reading-effort";
const EFFORT_LABELS = new Map([["", "模型默认"], ["low", "低"], ["medium", "中等"],
  ["high", "高"], ["xhigh", "很高"], ["max", "最高"]]);
const TYPE_KEY = "dictionary-typography";
const FONTS = new Map([
  ["georgia", "Georgia, 'Times New Roman', serif"],
  ["times", "'Times New Roman', Georgia, serif"],
  ["arial", "Arial, sans-serif"],
  ["system", "system-ui, sans-serif"],
]);
export function selectionMode(value) {
  return singleWord.test(value.trim().replace(/^[“‘"'(]+/u,"")) ? "word" : "translation";
}

function create(tag, text, css) {
  const node = document.createElement(tag);
  if (css) node.className = css;
  if (text) node.textContent = text;
  return node;
}

function button(label, fn, primary=false) {
  const node = create("button", label, primary ? "primary" : "secondary");
  node.type = "button";
  node.addEventListener("click", fn);
  return node;
}

function usageLink() {
  const link = create("a","管理用量");
  link.href = USAGE_PAGE;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function plainReadingText(text) {
  return text.replace(/^ {0,3}#{1,6}[ \t]+/gmu, "")
    .replace(/\*{1,3}([^*\n]+)\*{1,3}|_{2,3}([^_\n]+)_{2,3}|\x60([^\x60\n]+)\x60/gu,
      (_, marked, underlined, code) => marked || underlined || code);
}

export function displayReading({answer,model,effort}) {
  const card = create("article","","card gpt-reading");
  const detail = [model,effort ? EFFORT_LABELS.get(effort) : ""].filter(Boolean).join(" · ");
  if (detail) card.append(create("p",detail,"meta gpt-reading-model"));
  const translation = create("section","","reading-section");
  translation.append(create("h3","译文"),create("p",plainReadingText(answer.translation),"reading-translation"));
  card.append(translation);
  if (answer.terms.length) {
    const section = create("section","","reading-section");
    const terms = create("dl","","reading-terms");
    for (const {phrase,explanation} of answer.terms) {
      const entry = create("div");
      const title = create("dt",plainReadingText(phrase));
      title.lang = "en";
      entry.append(title,create("dd",plainReadingText(explanation)));
      terms.append(entry);
    }
    section.append(create("h3","关键词段讲解"),terms);
    card.append(section);
  }
  return card;
}

async function loadReadingPreferences() {
  const saved = await storage.local.get({[MODEL_KEY]:"",[EFFORT_KEY]:"medium"});
  return {model:saved[MODEL_KEY], effort:saved[EFFORT_KEY]};
}

export function chineseGroups(translation) {
  const groups = new Map();
  let currentLabels = [];
  for (const line of translation.split(/\r?\n|[；;]/u)) {
    let meaning = line.trim();
    if (!meaning) continue;
    let labels = [];
    const tag = POS.exec(meaning);
    if (tag) {
      while (true) {
        const match = POS.exec(meaning);
        if (!match) break;
        const label = match[0].toLowerCase().slice(0,-1).replace(/\s+/gu," ");
        labels.push(label === "a" ? "adj" : label);
        meaning = meaning.slice(match[0].length).replace(/^[\s、/]+/gu,"");
      }
      currentLabels = labels;
    } else if (meaning.startsWith("[")) {
      currentLabels = [];
    } else {
      labels = currentLabels;
    }
    for (const label of (labels.length ? labels : [""])) {
      if (meaning) {
        if (!groups.has(label)) groups.set(label,[]);
        groups.get(label).push(meaning);
      }
    }
  }
  return groups;
}

function phoneticText(value) {
  let phonetic = value.trim().replace(/^\/+|\/+$/gu,"").replace(/^\[|\]$/gu,"").trim();
  phonetic = phonetic.replace(/^\.(?=\S)/u,"ˌ").replaceAll("ә","ə").replaceAll("'", "ˈ");
  return phonetic ? `/${phonetic}/` : "";
}

function displayExample(target, pair) {
  const english = create("p",pair[0],"example-en");
  english.lang = "en";
  target.replaceChildren(create("h3","例句"),english,create("p",pair[1],"example-zh"));
}

function existingSentence(item) {
  for (const [,sense] of item.senses) {
    for (const [,text] of sense.matchAll(/;\s*"([^"\n]+)"/gu)) {
      if (/^[A-Za-z][^;]{20,195}$/u.test(text) && text.split(/\s+/u).length >= 5) {
        return text[0].toUpperCase() + text.slice(1) + (/[.!?]$/u.test(text) ? "" : ".");
      }
    }
  }
  return "";
}

function displayWord(item, getExample) {
  const card = create("article", "", "card entry-card");
  const title = create("h2",item.word);
  title.lang = "en";
  card.append(title);
  const phonetic = phoneticText(item.phonetic);
  if (phonetic) card.append(create("p",phonetic,"entry-phonetic"));

  for (const [pos, meanings] of chineseGroups(item.translation)) {
    const section = create("section","","entry-pos");
    if (pos) {
      const heading = create("h3",pos,"part-of-speech");
      heading.lang = "en";
      section.append(heading);
    }
    if (pos) {
      section.append(create("p",[...new Set(meanings)].join("；"),"entry-meanings"));
    } else {
      for (const meaning of new Set(meanings)) {
        const group = create("p","","entry-meanings entry-domain");
        const tag = /^\[([^\]]+)\]\s*/u.exec(meaning);
        if (tag) group.append(create("span",tag[1],"domain-tag"));
        group.append(create("span",meaning.slice(tag?.[0].length || 0)));
        section.append(group);
      }
    }
    card.append(section);
  }
  if (!item.translation.trim()) card.append(create("p","暂无中文释义。","meta"));
  const example = create("section","","entry-example");
  const builtIn = localExamples.get(item.word);
  if (builtIn) displayExample(example,builtIn);
  else getExample(example,item);
  card.append(example);
  return card;
}

const markup = `
<nav class="tool-tabs" aria-label="查词工具">
  <button type="button" data-page="words">词典</button><button type="button" data-page="translation">AI 翻译</button>
  <button type="button" data-page="book">单词本</button><button type="button" data-page="settings">设置</button>
</nav>
<div data-view="words">
  <form data-form="word"><label class="sr-only" for="word-query">英文单词或词组</label>
  <input id="word-query" type="search" placeholder="输入英文单词或词组" maxlength="120" autocomplete="off" lang="en"><button class="primary" type="submit">查词</button></form>
  <div data-word-results aria-live="polite"><p class="empty">输入英文，或从书页选中单词。</p></div>
</div>
<div data-view="translation" hidden>
  <label class="sr-only" for="translation-query">要翻译的英文</label>
  <textarea id="translation-query" rows="6" lang="en" maxlength="8000" placeholder="输入或从书页选中英文短语、句子"></textarea>
  <div data-translation-actions class="button-row"></div>
  <div data-translation-connection class="button-row"></div>
  <div data-plan-badge hidden class="plan-badge"></div>
  <div data-translation-results aria-live="polite"></div>
</div>
<div data-view="book" hidden><div data-word-folders></div><div data-wordbook-actions class="button-row"></div><div data-wordbook></div></div>
<div data-view="settings" hidden>
  <section class="reading-settings">
    <h2>显示</h2>
    ${appearanceFields}
    <div class="reading-fields">
      <label for="tool-font-size">字号</label>
      <select id="tool-font-size">
        <option value="16">16 px</option><option value="18" selected>18 px</option>
        <option value="20">20 px</option><option value="22">22 px</option><option value="24">24 px</option>
      </select>
      <label for="tool-english-font">英文字体</label>
      <select id="tool-english-font">
        <option value="georgia">Georgia</option><option value="times">Times New Roman</option>
        <option value="arial">Arial</option><option value="system">系统字体</option>
      </select>
    </div>
    <p class="meta">字号和英文字体应用于词典与 AI 翻译。</p>
  </section>
  <section class="reading-settings">
    <h2>GPT 精读</h2>
    <div class="reading-fields">
      <label for="gpt-reading-model">模型</label>
      <select id="gpt-reading-model" disabled></select>
      <label for="gpt-reading-effort">推理强度</label>
      <select id="gpt-reading-effort" disabled></select>
    </div>
    <p data-reading-settings-status class="meta" role="status"></p>
  </section>
  <h2>ChatGPT 套餐</h2>
  <details data-assistant-setup class="setup-card">
    <summary>Windows 本地助手</summary>
    <p>${hostedReader ? "下载并启动 Windows 本地助手，在这里配对后完成 ChatGPT 授权。" :
      "双击 Start_B-read.cmd 打开阅读器并启动本地助手。首次使用时，在 OpenAI 页面完成 ChatGPT 套餐授权。"}</p>
    <div data-settings-connection class="button-row"></div>
  </details>
  <p data-gpt-status role="status" class="meta"></p>
  <label for="chatgpt-account" class="sr-only">ChatGPT 登录账号</label>
  <select id="chatgpt-account" hidden></select>
  <div data-plan-actions class="button-row"></div>
  <section class="settings-dictionary">
    <h2>本地词库</h2>
    <p data-count class="meta"></p>
    <p class="meta">可上传 ECDICT 格式的 CSV，补充本地查词。</p>
    <button type="button" class="secondary" data-import-dictionary>上传词库文件</button>
    <input id="custom-dictionary" type="file" accept=".csv,text/csv" hidden>
    <p data-import-status role="status" class="meta"></p>
  </section>
</div>`;

export function mountWorkspace(container,{jumpToSource}={}) {
  // This template is static. Book data, words and model output are rendered with textContent.
  container.innerHTML = markup;
  mountAppearance(container);
  const find = selector => container.querySelector(selector);
  const wordInput = find("#word-query");
  const sentence = find("#translation-query");
  const wordResult = find("[data-word-results]");
  const translationResult = find("[data-translation-results]");
  let initialSentence = "";
  let translationSource = {};
  let wordSource = {};
  let wordRevision = 0;
  let translateRevision = 0;
  let booksRevision = 0;
  let planRevision = 0;
  const planStatus = find("[data-gpt-status]");
  const accounts = find("#chatgpt-account");
  const planBadge = find("[data-plan-badge]");
  const modelField = find("#gpt-reading-model");
  const effortField = find("#gpt-reading-effort");
  const readingStatus = find("[data-reading-settings-status]");
  const sizeField = find("#tool-font-size");
  const fontField = find("#tool-english-font");
  let catalogRevision = 0;
  let planConnection;

  function applyTypography(preferences) {
    const size = [16,18,20,22,24].includes(preferences?.size) ? preferences.size : 18;
    const font = FONTS.has(preferences?.font) ? preferences.font : "georgia";
    container.style.setProperty("--tool-size",`${size}px`);
    container.style.setProperty("--english-font",FONTS.get(font));
    sizeField.value = String(size);
    fontField.value = font;
  }

  void storage.local.get(TYPE_KEY).then(saved=>applyTypography(saved[TYPE_KEY])).catch(()=>{});
  for (const field of [sizeField,fontField]) field.addEventListener("change",()=>{
    const preferences = {size:Number(sizeField.value),font:fontField.value};
    applyTypography(preferences);
    void storage.local.set({[TYPE_KEY]:preferences}).catch(()=>{});
  });
  storage.onChanged.addListener((values,area)=>{
    if (area==="local" && values[TYPE_KEY]) applyTypography(values[TYPE_KEY].newValue);
  });

  function select(view) {
    for (const element of container.querySelectorAll("[data-view]")) element.hidden = element.dataset.view !== view;
    for (const element of container.querySelectorAll("[data-page]")) {
      element.setAttribute("aria-pressed",String(element.dataset.page === view));
    }
    if (view === "book") void showBook();
    if (view === "settings") void showSettings();
    if (view === "translation") void refreshPlan(false);
  }
  function notice(target,message) { target.replaceChildren(create("p",message,"empty")); }
  function openReadingSettings() {
    select("settings");
    modelField.scrollIntoView({block:"nearest"});
  }
  for (const item of container.querySelectorAll("[data-page]")) item.addEventListener("click",()=>select(item.dataset.page));

  async function showWord(selection, source={}) {
    const revision = ++wordRevision;
    wordSource = source;
    wordInput.value = selection.slice(0,120);
    select("words");
    notice(wordResult,"正在查词…");
    if (!wordInput.value.trim()) return notice(wordResult,"请输入英文单词或短语。");
    try {
      const found = await lookup(wordInput.value);
      if (revision !== wordRevision) return;
      if (found.type !== "match") {
        notice(wordResult,found.type==="invalid" ? "请选择英文单词或固定词组。" : "词库未找到这个词。可以换个拼写，或用 AI 翻译判断语境。");
        wordResult.append(button("查看语境",()=>showTranslation(selection,source)));
        return;
      }
      wordResult.replaceChildren();
      if (found.usedForm) wordResult.append(create("p",`所选词形 ${selection} · 词头 ${found.usedForm}`,"meta"));
      const entry = displayWord(found.result,getExample);
      const add = button("加入单词本",async () => {
        add.disabled = true;
        try { await addWord(found.result,selection,source); add.textContent = "已加入单词本"; }
        catch { add.textContent = "保存失败，重试"; add.disabled = false; }
      },true);
      const actions = create("div","","button-row");
      actions.append(add,button("语境精读",()=>showTranslation(selection,source)));
      wordResult.append(actions,entry);
      if (found.related) {
        const related = create("details","","related");
        related.append(create("summary",`原形 ${found.related.word}`),displayWord(found.related,getExample));
        wordResult.append(related);
      }
    } catch {
      if (revision===wordRevision) notice(wordResult,"本地词库读取失败，请重新打开阅读页再试。");
    }
  }

  function showTranslation(value,source={}) {
    ++translateRevision;
    initialSentence = excerpt(value).slice(0,8000);
    sentence.value = initialSentence;
    translationSource = source;
    translationResult.replaceChildren();
    select("translation");
  }

  function translationInput() {
    const text = excerpt(sentence.value).slice(0,8000);
    return {text, context:text===initialSentence ? (translationSource.context || "").slice(0,1200) : ""};
  }

  async function openSignIn(account) {
    const {url,opened} = await requestAssistant("/plan/start", {account});
    const authorization = new URL(url);
    if (authorization.origin !== "https://auth.openai.com" || authorization.pathname !== "/api/accounts/authorize") {
      throw new Error("无法验证 OpenAI 的授权页地址。");
    }
    if (!opened) {
      const tab=window.open(authorization.href,"_blank");
      if (!tab) throw new Error("授权页未能打开。请允许 B-read 打开新标签，然后重试。");
      tab.opener=null;
    }
  }

  async function waitForSignIn(isCurrent) {
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline && isCurrent()) {
      await new Promise(resolve => setTimeout(resolve,1500));
      if (!isCurrent()) return false;
      const status = await requestAssistant("/plan/status");
      if (!status.pending) {
        if (!isCurrent()) return false;
        displayPlan(status,true);
        if (!status.ready) throw new Error(status.feedback || "ChatGPT 授权未完成。请重新点击 GPT 精读。");
        return true;
      }
    }
    if (isCurrent()) throw new Error("授权等待已超时。请重新点击 GPT 精读。");
    return false;
  }

  async function withGpt(send, isCurrent, update) {
    const preferences = await loadReadingPreferences();
    const status = await requestAssistant("/plan/status");
    if (!isCurrent()) return;
    if (status.ready && !status.pending) {
      try {
        return await send(preferences);
      } catch (error) {
        if (error.code !== "signin_required") throw error;
      }
    }
    if (!isCurrent()) return;
    if (!status.pending) await openSignIn(status.active || null);
    update("请在 OpenAI 页面完成授权，然后回到阅读页。");
    if (await waitForSignIn(isCurrent) && isCurrent()) {
      update("正在等待 GPT 回复…");
      return send(preferences);
    }
  }

  function showAiError(target,error) {
    const content = create("div","","action-notice");
    notice(content,error.message || "处理失败，请重试。");
    if (error.code === "usage_limit") content.append(usageLink());
    if (["model_unavailable","reasoning_unavailable"].includes(error.code)) {
      content.append(button("打开精读设置",openReadingSettings));
    }
    if (["setup_required","assistant_disconnected"].includes(error.code)) {
      content.append(button("打开安装说明",()=>{
        select("settings");
        find("[data-assistant-setup]").open = true;
      }));
    }
    target.replaceChildren(content);
  }

  function getExample(target,item) {
    const key = `bilingual-example:${item.word}`;
    const status = create("div","","example-status");
    status.setAttribute("aria-live","polite");
    const generate = button("生成双语例句",async()=>{
      generate.disabled = true;
      const isCurrent = () => target.isConnected;
      const update = message => { if (isCurrent()) notice(status,message); };
      update("正在生成例句…");
      try {
        const sample = await withGpt(preferences=>requestAssistant("/example",{
          text:item.word,context:item.translation.slice(0,1200),...preferences,
        }),isCurrent,update);
        if (sample) {
          const pair = [plainReadingText(sample.english),plainReadingText(sample.chinese)];
          if (isCurrent()) displayExample(target,pair);
          void storage.local.set({[key]:pair}).catch(()=>{});
        }
      } catch (error) {
        if (isCurrent()) showAiError(status,error);
      } finally {
        generate.disabled = false;
      }
    });
    target.append(generate,status);
    void storage.local.get(key).then(saved=>{
      const pair = saved[key];
      if (!target.isConnected || generate.disabled) return;
      if (Array.isArray(pair) && pair.length===2) {
        displayExample(target,pair);
        return;
      }
      const sentence = existingSentence(item);
      if (!sentence) return;
      return translateExample(sentence).then(chinese=>{
        if (chinese && target.isConnected && !generate.disabled) displayExample(target,[sentence,chinese]);
      });
    }).catch(()=>{});
  }

  function followUpBox(reading, source, isCurrent) {
    const section = create("section","","follow-up");
    const heading = create("h3","继续追问");
    const transcript = create("div","","follow-transcript");
    transcript.setAttribute("role","log");
    transcript.setAttribute("aria-label","精读对话");
    const form = create("form","","follow-form");
    const input = create("textarea");
    input.rows = 2;
    input.maxLength = 1400;
    input.placeholder = "例如，这个词为什么这样翻译？";
    input.setAttribute("aria-label","追问当前选段");
    const send = create("button","发送","primary");
    send.type = "submit";
    const status = create("div","","follow-status");
    status.setAttribute("aria-live","polite");
    form.append(input,send);
    section.append(heading,transcript,form,status);
    const original = JSON.stringify(reading.answer).slice(0,4200);
    const history = [];
    form.addEventListener("submit",async event=>{
      event.preventDefault();
      const question = input.value.trim().slice(0,1400);
      if (!question || send.disabled) return;
      send.disabled = true;
      input.disabled = true;
      const update = message => { if (isCurrent()) notice(status,message); };
      update("正在等待 GPT 回复…");
      try {
        const result = await withGpt(preferences=>requestAssistant("/follow-up",{
          ...source, ...preferences, question, original, history,
        }),isCurrent,update);
        if (!result || !isCurrent()) return;
        const answer = plainReadingText(result.answer);
        history.push({question,answer:answer.slice(0,1800) || "（无额外内容）"});
        if (history.length > 6) history.shift();
        const turn = create("div","","follow-turn");
        turn.append(create("p",question,"follow-question"),create("p",answer,"follow-answer"));
        transcript.append(turn);
        input.value = "";
        status.replaceChildren();
      } catch (error) {
        if (isCurrent()) showAiError(status,error);
      } finally {
        input.disabled = false;
        send.disabled = false;
      }
    });
    return section;
  }

  async function run() {
    const {text,context} = translationInput();
    if (!text) return notice(translationResult,"请输入或在书页选中要翻译的英文。");
    const current = ++translateRevision;
    const isCurrent = () => current===translateRevision && container.isConnected;
    const update = msg => { if (isCurrent()) notice(translationResult,msg); };
    update("正在请 GPT 讲解…");
    try {
      const answer = await withGpt(preferences=>translateWithGpt(text,context,preferences),isCurrent,update);
      if (isCurrent() && answer) {
        translationResult.replaceChildren(displayReading(answer),followUpBox(answer,{text,context},isCurrent));
      }
    } catch (error) {
      if (isCurrent()) showAiError(translationResult,error);
    }
  }
  sentence.addEventListener("input",()=>{ ++translateRevision; translationResult.replaceChildren(); });
  find("[data-translation-actions]").append(button("GPT 精读",()=>void run(),true),
    button("精读设置",openReadingSettings));
  mountAssistantPairing([find("[data-translation-connection]"),find("[data-settings-connection]")]);

  async function showBook() {
    const current = ++booksRevision;
    const target=find("[data-wordbook]");
    try {
      const [entries,collections]=await Promise.all([bookEntries(),readFolders("words")]);
      if (current!==booksRevision) return;
      folders.update(collections.folders);
      if (!entries.length) return notice(target,"在释义卡片点「加入单词本」后，单词会出现在这里。");
      const listed=entries.filter(record=>visibleIn(folders.current(),collections.assignments.get(record.word)));
      if (!listed.length) return notice(target,"这个文件夹里还没有单词。");
      target.replaceChildren(...listed.map(record=>{
        const item=create("article","","card saved-word");
        const heading=create("h3",record.word);
        heading.lang="en";
        item.append(heading,create("p",record.translation,"definition"));
        if(record.source) item.append(create("p",record.source,"saved-source"));
        const quote=record.quote || sentenceQuote(record.context,record.selection || record.word);
        if(quote?.text){
          const q=create("blockquote","","saved-quote");
          q.lang="en";
          const mark=quote.mark;
          if (mark?.length && mark.start>=0 && mark.start+mark.length<=quote.text.length) {
            q.append(document.createTextNode(quote.text.slice(0,mark.start)),
              create("mark",quote.text.slice(mark.start,mark.start+mark.length)),
              document.createTextNode(quote.text.slice(mark.start+mark.length)));
          } else q.textContent = quote.text;
          item.append(q);
        }
        const controls=create("div","","button-row");
        if (collections.folders.length) {
          controls.append(folderPicker("words",record.word,collections.folders,collections.assignments.get(record.word),record.word,showBook));
        }
        controls.append(button("查看释义",()=>void showWord(record.selection || record.word,{
          title:record.source,context:record.context,quote:record.quote,location:record.location,
        })),
          button("移除",async()=>{ try { await removeWord(record.word); } catch { notice(target,"移除失败，重新打开单词本后再试。"); } }));
        item.append(controls);
        if (record.location || (record.source && quote?.mark)) {
          const jumpStatus=create("p","","meta jump-status");
          jumpStatus.setAttribute("role","status");
          const jump=button("跳转原文",async()=>{
            jump.disabled=true;
            jumpStatus.textContent="";
            try {
              if (jumpToSource) await jumpToSource(record);
              else location.assign(`reader.html?word=${encodeURIComponent(record.word)}`);
            } catch (error) {
              jumpStatus.textContent=error.message || "暂时无法跳转原文。";
            } finally { jump.disabled=false; }
          });
          controls.prepend(jump);
          item.append(jumpStatus);
        }
        return item;
      }));
    } catch { if (current===booksRevision) notice(target,"单词本暂时无法读取。"); }
  }
  const folders=mountFolders(find("[data-word-folders]"),"words","文件夹",showBook);
  watchFolders("words",()=>{ if (!find('[data-view="book"]').hidden) void showBook(); });
  watchWords(()=>{ if (!find('[data-view="book"]').hidden) void showBook(); });
  find("[data-wordbook-actions]").append(button("导出 CSV",async()=>{
    const entries=await bookEntries().catch(()=>[]);
    if(!entries.length) return;
    const url=URL.createObjectURL(new Blob([wordCsv(entries)],{type:"text/csv;charset=utf-8"}));
    const a=create("a");
    a.href=url; a.download="Vocabulary.csv"; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }));

  function displayPlan(connection, showFeedback) {
    planConnection = connection;
    planBadge.hidden = !connection || connection.mode !== "plan" || !connection.ready;
    if (!planBadge.hidden) {
      planBadge.replaceChildren(create("span","使用 ChatGPT 套餐"),usageLink());
    }
    accounts.hidden = !connection?.accounts?.length;
    if (!accounts.hidden) {
      const choices = connection.accounts.map(value => new Option(value.label,value.id));
      accounts.replaceChildren(new Option("添加 ChatGPT 账号",""),...choices);
      accounts.value = connection.active || choices[0]?.value || "";
    }
    if (!showFeedback || !connection) return;
    if (connection.ready) planStatus.textContent = `已连接 ${connection.account}，使用 ChatGPT 套餐。`;
    else planStatus.textContent = connection.feedback || "请登录 ChatGPT 并允许使用套餐。";
    if (connection.mode === "plan" && connection.ready && connection.active) {
      void showFirstConnection(connection.active);
    }
  }

  async function showFirstConnection(account) {
    const key = `chatgpt-welcome:${account}`;
    if ((await storage.local.get(key).catch(()=>({})))[key] || !container.isConnected || container.querySelector("[data-plan-welcome]")) return;
    const modal = create("dialog");
    if (typeof modal.showModal !== "function") return;
    modal.dataset.planWelcome = "";
    const dismiss = () => {
      storage.local.set({[key]:true}).catch(()=>{});
      modal.remove();
    };
    modal.addEventListener("close",dismiss,{once:true});
    modal.append(create("h2","已启用 ChatGPT 套餐"),create("p","此扩展的 GPT 精读将计入你的 ChatGPT 套餐用量。你可以随时在 ChatGPT 中查看限额。"),usageLink(),
      button("知道了",()=>modal.close(),true));
    container.append(modal);
    modal.showModal();
  }

  async function refreshPlan(showFeedback=true) {
    const revision = ++planRevision;
    try {
      const status = await requestAssistant("/plan/status");
      if (revision === planRevision) {
        displayPlan(status,showFeedback);
        if (showFeedback) void refreshReadingOptions(status.ready);
      }
    } catch (error) {
      if (revision !== planRevision) return;
      displayPlan(undefined,false);
      if (showFeedback) {
        displaySetupError(error);
        void refreshReadingOptions(false);
      }
    }
  }

  function displaySetupError(error) {
    planStatus.textContent = error.message;
    if (["setup_required","assistant_disconnected"].includes(error.code)) find("[data-assistant-setup]").open = true;
  }

  async function refreshReadingOptions(ready) {
    const revision = ++catalogRevision;
    modelField.disabled = true;
    readingStatus.textContent = ready ? "正在读取账号可用模型…" : "连接 ChatGPT 套餐后可选择模型。";
    try {
      const preferences = await loadReadingPreferences();
      if (revision !== catalogRevision) return;
      effortField.replaceChildren(...Array.from(EFFORT_LABELS,([value,label])=>new Option(label,value)));
      effortField.value = preferences.effort;
      effortField.disabled = false;
      const catalog = ready ? await requestAssistant("/plan/models") : {models:[]};
      if (revision !== catalogRevision) return;
      const models = catalog.models.map(({slug,name})=>new Option(name,slug));
      const fallback = catalog.models.find(({slug})=>slug===catalog.default)?.name;
      modelField.replaceChildren(new Option(fallback ? `自动（${fallback}）` : "自动",""),...models);
      if (preferences.model && !catalog.models.some(({slug})=>slug===preferences.model)) {
        const previous = new Option(`${preferences.model}（当前不可用）`,preferences.model);
        previous.disabled = true;
        modelField.append(previous);
        if (ready) readingStatus.textContent = "之前选定的模型当前不可用，请重新选择。";
      } else if (ready) {
        readingStatus.textContent = "";
      }
      modelField.value = preferences.model;
      modelField.disabled = !ready;
    } catch (error) {
      if (revision === catalogRevision) readingStatus.textContent = error.message || "暂时无法读取精读设置。";
    }
  }

  for (const [field,key] of [[modelField,MODEL_KEY],[effortField,EFFORT_KEY]]) {
    field.addEventListener("change",async()=>{
      try {
        await storage.local.set({[key]:field.value});
        readingStatus.textContent = "设置已保存。";
      } catch {
        readingStatus.textContent = "设置未能保存，请重试。";
      }
    });
  }

  async function showSettings() {
    const target=find("[data-count]");
    void refreshPlan();
    try {
      const [lexicon, custom] = await Promise.all([lexiconMeta(),dictionaryInfo()]);
      target.textContent = `内置英汉/英文词库 ${lexicon.entries.toLocaleString("zh-CN")} 个词头${custom ? ` · 自选 CSV ${custom.count.toLocaleString("zh-CN")} 条` : ""}`;
    } catch { target.textContent="词库信息暂时不可用。"; }
  }
  const signin = button("Continue with ChatGPT", async () => {
    signin.disabled = true;
    try {
      await openSignIn(accounts.hidden ? null : accounts.value || null);
      planStatus.textContent = "请在 OpenAI 页面完成授权，然后回到 B-read。";
      if (await waitForSignIn(()=>container.isConnected)) void refreshReadingOptions(true);
    } catch (error) { displaySetupError(error); }
    finally { signin.disabled = false; }
  },true);
  signin.setAttribute("data-oai-siwc-button","");
  signin.lang = "en";
  find("[data-plan-actions]").append(signin,button("检查连接",()=>void refreshPlan()),button("退出 ChatGPT",async()=>{
    try {
      if (!planConnection?.active) return;
      const result = await requestAssistant("/plan/logout");
      planStatus.textContent = result.feedback;
      void refreshPlan(false);
      void refreshReadingOptions(false);
    } catch (error) { planStatus.textContent = error.message; }
  }),usageLink());
  const fileInput=find("#custom-dictionary");
  const uploadDictionary=find("[data-import-dictionary]");
  uploadDictionary.addEventListener("click",()=>fileInput.click());
  fileInput.addEventListener("change",async()=>{
    const file=fileInput.files[0]; if(!file) return;
    fileInput.value=""; uploadDictionary.disabled=true;
    const target=find("[data-import-status]");
    target.textContent="正在导入，请保持页面开启…";
    try{
      const added=await importDictionary(file,n=>target.textContent=`已读取 ${n.toLocaleString("zh-CN")} 条…`);
      target.textContent=`已导入 ${added.count.toLocaleString("zh-CN")} 条。`;
      await showSettings();
    }catch(error){target.textContent=error.message || "导入失败。";}
    finally{uploadDictionary.disabled=false;}
  });
  find('[data-form="word"]').addEventListener("submit",event=>{
    event.preventDefault();
    const source=wordInput.value===wordSource.selection ? wordSource : {};
    void showWord(wordInput.value,source);
  });
  select("words");
  return {
    select,
    word:(text,source={})=>showWord(text,{...source,selection:text}),
    translation(text,source={}) {
      showTranslation(text,source);
    },
    selection(text,source={}) {
      if(selectionMode(text)==="word") void showWord(text,{...source,selection:text});
      else showTranslation(text,source);
    },
  };
}
