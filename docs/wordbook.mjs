import { storage } from "./web-platform.mjs";
import { normalize } from "./words.mjs";
import { sentenceQuote } from "./passage.mjs";

const PREFIX = "wordbook:";
const key = word => PREFIX + normalize(word);

export async function getWord(word) {
  const name = key(word);
  return (await storage.local.get(name))[name];
}

export async function bookEntries() {
  return Object.entries(await storage.local.get(null))
    .filter(([name]) => name.startsWith(PREFIX))
    .map(([, value]) => value)
    .sort((a, b) => b.added - a.added);
}

export async function addWord(item, selection, source = {}) {
  const name = key(item.word);
  const previous = (await storage.local.get(name))[name];
  const quote = source.quote || sentenceQuote(source.context,selection);
  const keepPrevious = !source.title || source.title===previous?.source;
  const record = {
    word: item.word,
    selection: selection.slice(0, 120),
    translation: (item.translation || item.senses?.[0]?.[1] || "").slice(0, 2400),
    source: (source.title || previous?.source || "").slice(0, 240),
    context: (source.context || (keepPrevious && previous?.context) || "").slice(0, 1200),
    added: previous?.added || Date.now(),
  };
  if (quote || (keepPrevious && previous?.quote)) record.quote = quote || previous.quote;
  if (source.location || (keepPrevious && !source.context && previous?.location)) {
    record.location = source.location || previous.location;
  }
  await storage.local.set({ [name]: record });
}

export function removeWord(word) {
  return storage.local.remove(key(word));
}

export function watchWords(callback) {
  storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some(k => k.startsWith(PREFIX))) callback();
  });
}

export function wordCsv(entries) {
  const csv = value => {
    let text = String(value || "");
    if (/^[\s]*[=+@-]/u.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return "\ufeff" + [["单词","所选词形","释义","书名","语境"], ...entries.map(record =>
    [record.word,record.selection,record.translation,record.source,
      record.quote?.text || sentenceQuote(record.context,record.selection || record.word)?.text || ""])]
    .map(row => row.map(csv).join(",")).join("\r\n");
}
