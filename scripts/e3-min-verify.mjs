/**
 * E3 最终实机验证(精确构造场景):
 * 1. DOM 全选 + Backspace → 干净空段落
 * 2. 行首输入 "- a" → 空格触发列表规则(证明 InputRule 实机链路正常)
 * 3. Enter 新列表项 → 输入 "---" → 断言:E3 守卫生效,保持字面文本,无 <hr>
 * 4. 再到顶层空段落行首输入 "---" → 断言:正常转 <hr>(既有行为回归)
 */
const CDP_BASE = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  const res = await fetch(`${CDP_BASE}/json/list`);
  return (await res.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = () => resolve({
      send(method, params) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((r) => pending.set(i, r));
      },
      close: () => ws.close(),
    });
  });
}

const target = await findPageTarget();
const cdp = await connect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
const evalJs = async (expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "?");
  return r.result?.result?.value;
};

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);

const pmInfo = () => evalJs(`(() => {
  const pm = [...document.querySelectorAll(".ProseMirror")].find(e => e.offsetParent !== null) || document.querySelector(".ProseMirror");
  const blocks = [];
  pm.childNodes.forEach((c) => blocks.push(c.tagName + ":" + c.textContent.slice(0, 24)));
  return JSON.stringify({ blocks, listText: pm.querySelector("ul,ol")?.textContent ?? "", hr: pm.querySelectorAll("hr").length });
})()`);

const typeText = async (text) => {
  for (const ch of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch });
    await sleep(70);
  }
};
const keyPress = async (key, opts = {}) => {
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, ...opts });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, ...opts });
};
const selectAllDom = () => evalJs(`(() => {
  const pm = [...document.querySelectorAll(".ProseMirror")].find(e => e.offsetParent !== null) || document.querySelector(".ProseMirror");
  pm.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(pm);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
})()`);

// 点击聚焦
const rect = await evalJs(`(() => {
  const el = [...document.querySelectorAll(".ProseMirror")].find(e => e.offsetParent !== null) || document.querySelector(".ProseMirror");
  const b = el.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 14) });
})()`);
const { x, y } = JSON.parse(rect);
await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
await sleep(250);

// ── 清空 → 空段落 ──
await selectAllDom();
await sleep(150);
await keyPress("Backspace", { code: "Backspace", windowsVirtualKeyCode: 8 });
await sleep(300);
console.log("清空后:", await pmInfo());

// ── 场景 A:行首输入 "- a" 造列表,Enter 后在列表项内输入 "---" ──
await typeText("- a");
await sleep(300);
console.log("输入 '- a' 后:", await pmInfo());
await keyPress("Enter", { code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(300);
await typeText("---");
await sleep(400);
const a = await pmInfo();
console.log("列表项内输入 '---' 后:", a);
const A = JSON.parse(a);
check("E3: 列表项内输入 --- 不转换为水平线", A.hr === 0, a);
check("E3: --- 字面文本保留在列表项中", A.listText.includes("---"), a);
check("E3: 列表结构已建立('- ' 触发列表规则)", A.listText.includes("a"), a);

// ── 场景 B:退出列表,顶层段落行首输入 "---" → 正常转换(既有行为回归) ──
// 连续 Shift+Tab/Enter 不可靠,直接用 DOM 全选重置后行首输入
await selectAllDom();
await sleep(150);
await keyPress("Backspace", { code: "Backspace", windowsVirtualKeyCode: 8 });
await sleep(300);
await typeText("---");
await sleep(400);
const b = await pmInfo();
console.log("顶层行首输入 '---' 后:", b);
const B = JSON.parse(b);
check("回归: 顶层段落行首 --- 仍转换为水平线", B.hr >= 1, b);

console.log("\n===== E3 最终实机验证 =====");
results.forEach((r) => console.log(r));
cdp.close();
process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
