import { hostedReader, isPaired, pairAssistant, disconnectAssistant } from "./assistant-bridge.mjs";

export function mountAssistantPairing(targets) {
  if (!hostedReader) return;
  const dialog = document.createElement("dialog");
  dialog.className = "bridge-dialog";
  dialog.setAttribute("aria-labelledby","bridge-title");
  dialog.innerHTML = [
    '<h2 id="bridge-title">连接本地助手</h2>',
    '<div class="button-row"><a href="./B-read-Assistant.zip" download>下载 Windows 助手</a><a href="./B-read-Assistant-macOS.zip" download>下载 macOS 助手</a></div>',
    '<p>解压后双击启动文件。Windows 用 <code>Start_Assistant.cmd</code>，Mac 用 <code>Start_Assistant.command</code>（需要 <a href="https://www.python.org/downloads/macos/" target="_blank" rel="noopener noreferrer">Python 3.11 或更新版本</a>）。</p>',
    '<p>首次启动时，把本页网址粘贴到助手窗口。</p><div class="button-row"><button type="button" data-copy>复制本页网址</button></div>',
    '<form>',
    '<label for="bridge-code">助手窗口里的配对码</label>',
    '<input id="bridge-code" type="text" required autocomplete="off" spellcheck="false" maxlength="64" pattern="[A-Za-z0-9_\\-]{16,64}">',
    '<p data-pair-status role="status" class="meta"></p>',
    '<div class="button-row"><button type="submit" class="primary">连接</button><button type="button" data-close>取消</button></div>',
    '</form>',
  ].join("");
  document.body.append(dialog);
  const form=dialog.querySelector("form");
  const code=dialog.querySelector("#bridge-code");
  const status=dialog.querySelector("[data-pair-status]");
  const buttons=[];
  function refresh() {
    const paired=isPaired();
    for (const button of buttons) button.textContent=paired ? "断开本地助手" : "连接本地助手";
  }
  for (const target of targets) {
    const button=document.createElement("button");
    const feedback=document.createElement("span");
    button.type="button";
    feedback.className="meta";
    feedback.setAttribute("role","status");
    target.append(button,feedback);
    buttons.push(button);
    button.addEventListener("click",async()=>{
      feedback.textContent="";
      if (!isPaired()) {
        code.value="";
        status.textContent="";
        dialog.showModal();
        return;
      }
      button.disabled=true;
      try {
        await disconnectAssistant();
        feedback.textContent="已断开。若要重连，请用助手窗口里新显示的配对码。";
      } catch (error) {
        feedback.textContent=error.message;
      } finally { button.disabled=false; }
    });
  }
  refresh();
  window.addEventListener("b-read-bridge-change",refresh);
  dialog.querySelector("[data-close]").onclick=()=>dialog.close();
  dialog.querySelector("[data-copy]").onclick=async()=>{
    const address=location.origin + location.pathname;
    try {
      await navigator.clipboard.writeText(address);
      status.textContent="网址已复制。";
    } catch { status.textContent=address; }
  };
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    const button=event.submitter;
    button.disabled=true;
    status.textContent="正在连接。如果 Chrome 询问访问本地设备，请选择允许。";
    try {
      await pairAssistant(code.value);
      code.value="";
      dialog.close();
    } catch (error) { status.textContent=error.message; }
    finally { button.disabled=false; }
  });
}
