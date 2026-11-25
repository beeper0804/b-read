const READER_STORE = "reader";
const BOOK_STORE = "books";

async function transaction(stores, mode, work) {
  const db = await new Promise((resolve,reject)=>{
    const request = indexedDB.open("readpane-local-reader",2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(READER_STORE)) db.createObjectStore(READER_STORE);
      if (!db.objectStoreNames.contains(BOOK_STORE)) db.createObjectStore(BOOK_STORE,{keyPath:"id"});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.onversionchange = () => db.close();
  try {
    return await new Promise((resolve,reject)=>{
      const tx = db.transaction(stores,mode);
      let request;
      tx.oncomplete = () => resolve(request?.result);
      tx.onabort = () => reject(tx.error || new Error("书库操作已取消。"));
      try { request = work(tx); }
      catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally { db.close(); }
}

export function saveBook(book,file) {
  const record = {id:book.identifier,title:book.title,author:book.author,opened:Date.now()};
  return transaction([BOOK_STORE,READER_STORE],"readwrite",tx=>{
    tx.objectStore(BOOK_STORE).put(record);
    const reader = tx.objectStore(READER_STORE);
    reader.put(file,`book:${record.id}`);
    reader.put(record.id,"recent");
  });
}

export function listBooks() {
  return transaction([BOOK_STORE],"readonly",tx=>tx.objectStore(BOOK_STORE).getAll());
}

export function loadBook(id) {
  return transaction([READER_STORE],"readonly",tx=>tx.objectStore(READER_STORE).get(`book:${id}`));
}

export function removeBook(id) {
  return transaction([BOOK_STORE,READER_STORE],"readwrite",tx=>{
    const books=tx.objectStore(BOOK_STORE);
    const reader=tx.objectStore(READER_STORE);
    books.delete(id);
    reader.delete(`book:${id}`);
    const recent=reader.get("recent");
    recent.onsuccess=()=>{
      if (recent.result!==id) return;
      const remaining=books.getAll();
      remaining.onsuccess=()=>{
        const latest=remaining.result.reduce((newest,book)=>!newest || book.opened>newest.opened ? book : newest,null);
        if (latest) reader.put(latest.id,"recent");
        else reader.delete("recent");
      };
    };
  });
}

export async function recentBook() {
  const recent = await transaction([READER_STORE],"readonly",tx=>tx.objectStore(READER_STORE).get("recent"));
  if (typeof recent === "string") return {file:await loadBook(recent), legacy:false};
  return {file:recent, legacy:Boolean(recent)};
}

export const progressKey = id => `reader-position:${id}`;
