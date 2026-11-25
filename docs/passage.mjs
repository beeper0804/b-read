const segmenter = new Intl.Segmenter("en",{granularity:"sentence"});

export const cleanSelection = text => text.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,"");
const normalized = text => text.replace(/\s+/gu," ").trim();

export function findTerm(text,selection,near=0) {
  const term = cleanSelection(selection);
  if (!term) return undefined;
  const pattern = term.split(/\s+/u).map(word=>word.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&")
    .replace(/['’]/gu,"['’]")).join("\\s+");
  const matches = text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`,"giu"));
  let nearest;
  for (const match of matches) {
    if (!nearest || Math.abs(match.index-near) < Math.abs(nearest.start-near)) {
      nearest = {start:match.index,length:match[0].length};
    }
    if (nearest.start===near) break;
  }
  return nearest;
}

export function sentenceQuote(text,selection,near=0) {
  if (!text?.trim()) return undefined;
  const term = findTerm(text,selection,near);
  const masked = text.replace(/\b(?:Dr|Prof|Mr|Mrs|Ms|St|Jr|Sr|Rev|Fig|No|vs|cf|e\.g|i\.e|et al)\.(?=\s+\S)/giu,
    abbreviation=>abbreviation.slice(0,-1)+"·");
  for (const part of segmenter.segment(masked)) {
    if (term && part.index+part.segment.length <= term.start) continue;
    if (term && part.index > term.start) break;
    const original = text.slice(part.index,part.index+part.segment.length);
    const value = normalized(original);
    if (!value) continue;
    const prefix = term ? normalized(original.slice(0,term.start-part.index)) : "";
    return {text:value,mark:findTerm(value,selection,prefix.length)};
  }
  return undefined;
}

export function passageMatch(text,record,exact=false) {
  const quote = record.quote?.text || sentenceQuote(record.context,record.selection || record.word)?.text;
  const clean = normalized(text).toLowerCase();
  if ((!quote || !clean.includes(normalized(quote).toLowerCase())) && !exact) return undefined;
  return findTerm(text,record.selection || record.word,exact ? record.location.offset : 0);
}

export function highlightRange(element,match) {
  const nodes = document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const stop = match.start+match.length;
  let offset=0, started=false;
  for (let node=nodes.nextNode(); node; node=nodes.nextNode()) {
    const end = offset+node.length;
    if (!started && match.start < end) {
      range.setStart(node,match.start-offset);
      started=true;
    }
    if (started && stop <= end) {
      range.setEnd(node,stop-offset);
      return range;
    }
    offset=end;
  }
}
