import { candidates, normalize } from "./words.mjs";
import { lexicalForms, lookupCorpus } from "./lexicon.mjs";

let starterPromise;
let databasePromise;
const META = "active";
const STAGED = "staged";

export function starterDictionary() {
  starterPromise ??= fetch(new URL("./starter.tsv", import.meta.url)).then(async response => {
    if (!response.ok) throw new Error("无法载入内置词库");
    const entries = new Map();
    for (const line of (await response.text()).split(/\r?\n/u)) {
      if (!line || line.startsWith("#")) continue;
      const [word, translation, examples] = line.split("\t");
      entries.set(normalize(word), { word, translation, examples });
    }
    return entries;
  }).catch(error => {
    starterPromise = undefined;
    throw error;
  });
  return starterPromise;
}

function database() {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("readpane-quick-dictionary", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("words", { keyPath: "key" }).createIndex("generation", "generation");
      db.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function complete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error("词库写入已取消"));
  });
}

export async function dictionaryInfo() {
  const db = await database();
  return requestValue(db.transaction("meta").objectStore("meta").get(META));
}

async function updateMeta(db, update) {
  const tx = db.transaction("meta", "readwrite");
  const done = complete(tx);
  update(tx.objectStore("meta"));
  await done;
}

export async function lookup(selection) {
  const forms = candidates(selection);
  if (!forms.length) return { type: "invalid" };

  const exact = forms[0];
  const exceptions = await lexicalForms(exact);
  const expanded = [...new Set([exact, ...exceptions, ...forms.slice(1)])];
  const starter = await starterDictionary();
  const db = await database();
  // Use one read snapshot so a concurrent import cannot remove the active entries mid-lookup.
  const tx = db.transaction(["meta", "words"]);
  const local = await requestValue(tx.objectStore("meta").get(META));
  const words = tx.objectStore("words");
  const entries = local
    ? await Promise.all(expanded.map(form => requestValue(words.get([local.generation, form]))))
    : [];
  const matches = [];
  for (const [i, form] of expanded.entries()) {
    const corpus = await lookupCorpus(form);
    const localEntry = entries[i];
    const preferred = starter.get(form);
    if (!corpus && !localEntry && !preferred) continue;
    const result = {
      word: form,
      phonetic: localEntry?.phonetic || corpus?.phonetic || "",
      translation: localEntry?.translation || corpus?.translation || preferred?.translation || "",
      senses: corpus?.senses || [],
      examples: preferred?.examples || "",
      note: preferred?.translation !== corpus?.translation ? preferred?.translation : "",
      definition: localEntry?.definition || "",
    };
    matches.push(result);
    if (form !== exact || (!exceptions.length && (result.senses.length || result.translation))) break;
  }
  if (matches.length) return { type: "match", result: matches[0], related: matches[1], usedForm: matches[0].word === exact ? "" : matches[0].word };
  return { type: "missing" };
}

// Read RFC 4180 fields across chunks, including escaped quotes and embedded line breaks.
export async function* rowsFrom(stream) {
  const chunks = stream.pipeThrough(new TextDecoderStream("utf-8", { fatal: true }));
  let row = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  let afterCR = false;
  for await (const chunk of chunks) {
    for (const char of chunk) {
      if (afterCR) {
        afterCR = false;
        if (char === "\n") continue;
      }
      if (quoted) {
        if (char === '"') {
          quoted = false;
          afterQuote = true;
        } else {
          cell += char;
        }
        continue;
      }
      if (afterQuote && char === '"') {
        cell += char;
        quoted = true;
        afterQuote = false;
      } else if (char === ",") {
        row.push(cell);
        cell = "";
        afterQuote = false;
      } else if (char === "\r" || char === "\n") {
        row.push(cell);
        yield row;
        row = [];
        cell = "";
        afterQuote = false;
        afterCR = char === "\r";
      } else if (!cell && !afterQuote && char === '"') {
        quoted = true;
      } else {
        if (afterQuote && char !== " " && char !== "\t") throw new Error("CSV 引号格式有误");
        if (!afterQuote) cell += char;
      }
    }
  }
  if (quoted) throw new Error("CSV 文件的结束引号缺失");
  if (cell || row.length || afterQuote) yield [...row, cell];
}

async function clearGeneration(db, generation) {
  const tx = db.transaction("words", "readwrite");
  const done = complete(tx);
  const cursor = tx.objectStore("words").index("generation").openCursor(IDBKeyRange.only(generation));
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (current) {
      current.delete();
      current.continue();
    }
  };
  await done;
}

function clean(value, limit) {
  return (value || "").replace(/\\n/gu, "\n").trim().slice(0, limit);
}

export async function importDictionary(file, onProgress) {
  if (!file.size || file.size > 100 * 1024 * 1024) throw new Error("请选择 100 MB 以内的 UTF-8 CSV 文件");
  return navigator.locks.request("dictionary-import", { ifAvailable: true }, async lock => {
    if (!lock) throw new Error("另一个侧栏正在导入词库");
    const db = await database();
    const old = await dictionaryInfo();
    const abandoned = await requestValue(db.transaction("meta").objectStore("meta").get(STAGED));
    if (abandoned && abandoned !== old?.generation) await clearGeneration(db, abandoned);
    const generation = crypto.randomUUID();
    await updateMeta(db, meta => meta.put(generation, STAGED));
    const seen = new Set();
    let pending = [];
    let columns;

    async function commitBatch() {
      const tx = db.transaction("words", "readwrite");
      const done = complete(tx);
      const store = tx.objectStore("words");
      for (const item of pending) store.put(item);
      await done;
      pending = [];
      onProgress(seen.size);
    }

    try {
      for await (const row of rowsFrom(file.stream())) {
        if (!columns) {
          const headers = row.map(value => value.trim().toLowerCase());
          columns = Object.fromEntries(["word", "translation", "phonetic", "definition"].map(name => [name, headers.indexOf(name)]));
          if (columns.word < 0 || columns.translation < 0) {
            throw new Error("CSV 第一行须包含 word 和 translation 两列");
          }
          continue;
        }
        const word = (row[columns.word] || "").trim();
        const key = normalize(word);
        const translation = clean(row[columns.translation], 1600);
        if (word.length > 120 || !key || !translation || seen.has(key)) continue;
        if (!/^[a-z\d][a-z\d' -]*$/u.test(key) || !/[a-z]/u.test(key)) continue;
        seen.add(key);
        pending.push({
          key: [generation, key], generation, word, translation,
          phonetic: clean(row[columns.phonetic], 160),
          definition: clean(row[columns.definition], 1000),
        });
        if (pending.length >= 1500) await commitBatch();
      }
      if (!seen.size) throw new Error("文件里没有可用的英汉词条");
      if (pending.length) await commitBatch();
      const active = { generation, count: seen.size };
      await updateMeta(db, meta => {
        meta.put(active, META);
        if (old) meta.put(old.generation, STAGED);
        else meta.delete(STAGED);
      });
      if (old) {
        await clearGeneration(db, old.generation)
          .then(() => updateMeta(db, meta => meta.delete(STAGED))).catch(() => {});
      }
      return active;
    } catch (error) {
      await clearGeneration(db, generation)
        .then(() => updateMeta(db, meta => meta.delete(STAGED))).catch(() => {});
      throw error;
    }
  });
}
