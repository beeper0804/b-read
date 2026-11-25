const changes = new Set();
const channel = new BroadcastChannel("b-read-settings");
channel.onmessage = ({data}) => announce(data);
let database;

function announce(event) {
  for (const listener of changes) listener(event,"local");
}

function openStorage() {
  database ??= new Promise((resolve,reject)=>{
    const request=indexedDB.open("b-read-web-settings",1);
    request.onupgradeneeded=()=>request.result.createObjectStore("settings");
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  }).catch(error=>{ database=undefined; throw error; });
  return database;
}

async function transaction(mode,run) {
  const db=await openStorage();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("settings",mode);
    let result;
    tx.oncomplete=()=>resolve(result);
    tx.onabort=()=>reject(tx.error || new Error("设置保存已取消。"));
    run(tx.objectStore("settings"),value=>{result=value;});
  });
}

async function get(keys=null) {
  const defaults=keys && typeof keys==="object" && !Array.isArray(keys) ? keys : {};
  const selected=typeof keys==="string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(defaults);
  return transaction("readonly",(store,finish)=>{
    const snapshot={...defaults};
    finish(snapshot);
    if (keys===null) {
      const request=store.openCursor();
      request.onsuccess=()=>{
        const cursor=request.result;
        if (!cursor) return;
        Object.defineProperty(snapshot,cursor.key,{value:cursor.value,enumerable:true,configurable:true,writable:true});
        cursor.continue();
      };
      return;
    }
    for (const key of selected) {
      const request=store.get(key);
      request.onsuccess=()=>{
        if (request.result!==undefined) {
          Object.defineProperty(snapshot,key,{value:request.result,enumerable:true,configurable:true,writable:true});
        }
      };
    }
  });
}

async function update(entries,remove) {
  const event=await transaction("readwrite",(store,finish)=>{
    const next=Object.create(null);
    finish(next);
    for (const [key,value] of entries) {
      const request=store.get(key);
      request.onsuccess=()=>{
        if (remove && request.result===undefined) return;
        const oldValue=request.result;
        next[key]=remove ? {oldValue} : {oldValue,newValue:value};
        if (remove) store.delete(key);
        else store.put(value,key);
      };
    }
  });
  if (!Object.keys(event).length) return;
  announce(event);
  channel.postMessage(event);
}

export const storage={
  local: {
    get,
    set: values=>update(Object.entries(values),false),
    remove: keys=>update((typeof keys==="string" ? [keys] : keys).map(key=>[key]),true),
  },
  onChanged:{
    addListener: listener=>changes.add(listener),
    removeListener: listener=>changes.delete(listener),
  },
};
