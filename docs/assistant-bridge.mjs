const LOOPBACK = "http://127.0.0.1:17464";
const SESSION_KEY = "b-read-assistant-session";
export const hostedReader = location.protocol === "https:";
let session;
try { session = hostedReader ? sessionStorage.getItem(SESSION_KEY) || "" : ""; }
catch { session = ""; }

export function isPaired() { return Boolean(session); }

function saveSession(token) {
  session = token;
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // The connection can still live in this tab's memory.
  }
  if (hostedReader) window.dispatchEvent(new Event("b-read-bridge-change"));
}

function setupError(message) {
  return Object.assign(new Error(message), {code:"setup_required"});
}

export async function assistantRequest(path, data = {}) {
  let result;
  const connecting = path === "/pair";
  if (hostedReader && !connecting && !session) {
    throw setupError("请先连接本地助手，再使用 GPT 功能。");
  }
  const prefix = (hostedReader ? LOOPBACK : "") + "/api/assistant";
  const headers = {"Content-Type":"application/json"};
  if (hostedReader && !connecting) headers["X-B-Read-Session"] = session;
  try {
    const response = await fetch(prefix + path, {
      method:"POST", headers, body:JSON.stringify(data), credentials:"omit",
      cache:"no-store", referrerPolicy:"no-referrer",
      signal:AbortSignal.timeout(connecting ? 15000 : 135000),
      ...(hostedReader && {targetAddressSpace:"loopback"}),
    });
    result = await response.json();
  } catch (error) {
    if (error.name === "TimeoutError" && !connecting) throw new Error("精读助手响应超时，请重试。");
    if (hostedReader) {
      throw setupError("无法连接助手。请启动 Start_Assistant.cmd，确认网址一致，并允许浏览器访问本地设备。");
    }
    throw Object.assign(new Error("无法连接精读助手。请双击 Start_B-read.cmd 后重试。"),{code:"assistant_disconnected"});
  }
  if (!result?.result) {
    if (hostedReader && result?.code === "setup_required") saveSession("");
    throw Object.assign(new Error(result?.error || "暂时无法完成精读。"), {code:result?.code});
  }
  return result.result;
}

export async function pairAssistant(code) {
  const {session:token} = await assistantRequest("/pair", {code:code.trim()});
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{24,64}$/.test(token)) {
    throw new Error("助手返回的配对信息无效，请重新启动。");
  }
  saveSession(token);
}

export async function disconnectAssistant() {
  await assistantRequest("/disconnect");
  saveSession("");
}
