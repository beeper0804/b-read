export const lookupKey = windowId => `lookup:${windowId}`;

export function queryText(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, 120) : "";
}

export function normalize(value) {
  return queryText(value).normalize("NFKD").toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[’‘]/gu, "'")
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/\u00ad/gu, "")
    .replace(/^[^a-z\d]+|[^a-z\d]+$/gu, "");
}

const IRREGULAR = {
  am: "be", are: "be", been: "be", was: "be", were: "be",
  brought: "bring", bought: "buy", caught: "catch", came: "come", dealt: "deal",
  did: "do", done: "do", drew: "draw", drawn: "draw", fell: "fall", fallen: "fall",
  felt: "feel", found: "find", gave: "give", given: "give", went: "go", gone: "go",
  grown: "grow", had: "have", heard: "hear", held: "hold", kept: "keep",
  knew: "know", known: "know", led: "lead", left: "leave", made: "make",
  meant: "mean", met: "meet", paid: "pay", ran: "run", rose: "rise", risen: "rise",
  said: "say", saw: "see", seen: "see", sent: "send", sold: "sell", sought: "seek",
  spoke: "speak", spoken: "speak", stood: "stand", struck: "strike", took: "take",
  taken: "take", taught: "teach", thought: "think", told: "tell", wore: "wear",
  worn: "wear", wrote: "write", written: "write", children: "child", feet: "foot",
  men: "man", people: "person", women: "woman", teeth: "tooth", mice: "mouse",
  criteria: "criterion", phenomena: "phenomenon", analyses: "analysis",
  theses: "thesis", hypotheses: "hypothesis", indices: "index", strata: "stratum",
  vying: "vie", lying: "lie", dying: "die", tying: "tie",
};

function inflections(word) {
  const candidates = [];
  if (Object.hasOwn(IRREGULAR, word)) candidates.push(IRREGULAR[word]);
  if (word.endsWith("'s")) candidates.push(word.slice(0, -2));
  if (word.length > 4 && word.endsWith("ies")) candidates.push(word.slice(0, -3) + "y");
  if (word.length > 4 && word.endsWith("ied")) candidates.push(word.slice(0, -3) + "y");
  if (/(?:sh|ch|ss|x|z|o)es$/u.test(word)) candidates.push(word.slice(0, -2));
  if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/u.test(word)) {
    candidates.push(word.slice(0, -1));
  }
  if (word.length > 4 && /(?:ed|ing)$/u.test(word)) {
    const stem = word.replace(/(?:ed|ing)$/u, "");
    if (/([b-df-hj-np-tv-z])\1$/u.test(stem)) candidates.push(stem.slice(0, -1));
    if (word.endsWith("ed")) candidates.push(word.slice(0, -1));
    candidates.push(stem, stem + "e");
  }
  return candidates;
}

function spellings(word) {
  const result = [];
  if (/our(?:s)?\b/u.test(word)) result.push(word.replace(/our(s)?\b/u, "or$1"));
  if (/or(?:s)?\b/u.test(word)) result.push(word.replace(/or(s)?\b/u, "our$1"));
  if (/ise|isation|ising/u.test(word)) result.push(word.replace(/is(e|ation|ing)/u, "iz$1"));
  if (/ize|ization|izing/u.test(word)) result.push(word.replace(/iz(e|ation|ing)/u, "is$1"));
  return result;
}

export function candidates(value) {
  const exact = normalize(value);
  if (!/^[a-z\d][a-z\d' -]*$/u.test(exact) || !/[a-z]/u.test(exact)) return [];
  const expanded = [exact];
  if (exact.includes("-")) expanded.push(exact.replace(/-/gu, " "));
  for (const candidate of expanded.slice()) expanded.push(...spellings(candidate));

  const words = exact.split(/ +/u);
  if (words.length === 1) {
    for (const form of inflections(exact)) expanded.push(form, ...spellings(form));
  } else {
    const last = words.at(-1);
    const prefix = words.slice(0, -1).join(" ");
    for (const form of inflections(last)) expanded.push(prefix + " " + form);
  }
  return [...new Set(expanded)];
}
