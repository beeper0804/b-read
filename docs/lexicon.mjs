const cached = new Map();

function resource(name) {
  return fetch(new URL(`./lexicon/${name}.json`, import.meta.url)).then(result => {
    if (!result.ok) throw new Error("词库文件不可用");
    return result.json();
  });
}

let meta, aliases;
export function lexiconMeta() {
  meta ??= resource("meta").catch(error => {
    meta = undefined;
    throw error;
  });
  return meta;
}

export async function lexicalForms(head) {
  aliases ??= resource("aliases").catch(error => {
    aliases = undefined;
    throw error;
  });
  const forms = await aliases;
  return Object.hasOwn(forms, head) ? forms[head] : [];
}

export async function lookupCorpus(word) {
  const prefix = (word.replace(/[^a-z]/gu, "") + "__").slice(0, 2);
  if (!(await lexiconMeta()).shards.includes(prefix)) return undefined;
  let shard = cached.get(prefix);
  if (!shard) {
    if (cached.size === 9) cached.delete(cached.keys().next().value);
    shard = resource(prefix).catch(error => {
      if (cached.get(prefix) === shard) cached.delete(prefix);
      throw error;
    });
    cached.set(prefix, shard);
  }
  const words = await shard;
  if (!Object.hasOwn(words, word)) return undefined;
  const [phonetic, translation, senses] = words[word];
  return { word, phonetic, translation, senses };
}
