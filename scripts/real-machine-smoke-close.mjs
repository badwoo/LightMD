/**
 * LightMD 实机冒烟收尾脚本：恢复窗口最大化（冒烟测试需要还原窗口才能测 F11），
 * 并通过应用自身的 Ctrl+Q 正常退出（保存会话与窗口状态，无僵尸进程）。
 *
 * 用法：node scripts\real-machine-smoke-close.mjs
 */
const CDP_BASE = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`${CDP_BASE}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) {
  console.log("未找到调试目标（应用可能已退出）");
  process.exit(0);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
await new Promise((res) => (ws.onopen = res));
const send = (method, params) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pending.set(i, r));
};
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

// 恢复最大化（window_state 会记下退出时的几何）
const size = await evalJs(`({ w: window.innerWidth, maximized: window.innerWidth >= screen.availWidth - 4 })`);
if (!size.maximized) {
  await evalJs(`document.querySelector(".wc-btn.wc-max").click(); true`);
  await sleep(700);
}
console.log("窗口状态:", await evalJs(`({ w: window.innerWidth, h: window.innerHeight })`));

// Ctrl+Q：走应用自身的退出流程（保存会话 + 正常销毁窗口）
await evalJs(
  `window.dispatchEvent(new KeyboardEvent("keydown",{key:"q",code:"KeyQ",ctrlKey:true,bubbles:true,cancelable:true})); true`,
);
await sleep(1500);
ws.close();
console.log("已发送 Ctrl+Q 退出");
