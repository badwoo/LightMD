/**
 * 定向取证：打开预览场景下，左屏 scrollTop 被谁写（抓完整调用栈）。
 * 用与几何探针完全相同的文档，确保能复现 7553.333。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.P || 9297);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); const pend = new Map(); let id = 0;
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id).resolve(m); pend.delete(m.id); } };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      send(method, params, timeoutMs = 90000) {
        const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((res, rej) => { const t = setTimeout(() => { pend.delete(i); rej(new Error("timeout " + method)); }, timeoutMs);
          pend.set(i, { resolve: (v) => { clearTimeout(t); res(v); } }); });
      }, close() { try { ws.close(); } catch {} },
    });
  });
}

const main = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lm-wr-"));
  const prof = path.join(tmp, "p"); fs.mkdirSync(prof, { recursive: true });
  const doc = path.join(tmp, "d.md");
  const p = ["# 宽度变化诊断文档", ""];
  const longLine = (i) => `第 ${i} 段：这是一段刻意写长的正文，用于让 textarea 的 white-space: pre-wrap 在较窄宽度下折成更多视觉行，从而 scrollHeight 随左栏宽度变化而变化。继续堆字以拉长该逻辑行，确保在不同宽度下折行数明显不同。`;
  for (let i = 1; i <= 100; i++) { p.push(longLine(i)); p.push(""); }
  p.push("## 末段"); p.push("最后一段用于确认底部。");
  const text = p.join("\n");
  fs.writeFileSync(doc, text, "utf-8");
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1000);
  const child = spawn(EXE, [], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: prof }, stdio: "ignore" });
  let cdp = null;
  for (let i = 0; i < 60 && !cdp; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        try {
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", { expression: 'typeof window.__TAURI_INTERNALS__!=="undefined"', returnByValue: true });
          if (r.result?.result?.value === true) { cdp = c; break; } c.close();
        } catch {}
      }
    } catch {}
    if (!cdp) await sleep(400);
  }
  if (!cdp) throw new Error("no cdp");
  const ev = async (b) => {
    const r = await cdp.send("Runtime.evaluate", { expression: `(()=>{${b}})()`, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result?.result?.value;
  };
  try {
    // 确保预览打开
    for (let a = 0; a < 8; a++) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(doc)},content:${JSON.stringify(text)}}}));return 1`);
      await sleep(1200);
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.edit"}}));return 1`);
      await sleep(1000);
      const r = await ev(`const ta=document.querySelector("textarea.source-editor");return ta?{len:ta.value.length,max:Math.max(0,ta.scrollHeight-ta.clientHeight)}:null`);
      if (r && r.len === text.length && r.max > 100) { console.log("ready", JSON.stringify(r)); break; }
    }
    const s0 = await ev(`return {open:!!document.querySelector(".split-preview-open")}`);
    if (!s0.open) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.togglePreview"}}));return 1`);
      await sleep(2400);
    }
    // 稳定贴底
    await ev(`
      return new Promise((resolve)=>{
        const ta=document.querySelector("textarea.source-editor");
        let n=0;
        const step=()=>{ ta.scrollTop=Math.max(0,ta.scrollHeight-ta.clientHeight); if(++n>=10) return resolve(1); setTimeout(step,80); };
        step();
      });`);
    await sleep(600);
    // 关闭 → 稳定
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.togglePreview"}}));return 1`);
    await sleep(2400);
    await ev(`
      return new Promise((resolve)=>{
        const ta=document.querySelector("textarea.source-editor");
        let n=0;
        const step=()=>{ ta.scrollTop=Math.max(0,ta.scrollHeight-ta.clientHeight); if(++n>=10) return resolve(1); setTimeout(step,80); };
        step();
      });`);
    await sleep(600);
    const base = await ev(`const ta=document.querySelector("textarea.source-editor");const max=Math.max(0,ta.scrollHeight-ta.clientHeight);return{st:+ta.scrollTop.toFixed(2),max:+max.toFixed(2),gap:+(max-ta.scrollTop).toFixed(2),open:!!document.querySelector(".split-preview-open")}`);
    console.log("BASELINE", JSON.stringify(base));

    // 装 hook：记录所有 textarea.scrollTop 写入（含完整调用栈）
    await ev(`
      window.__w=[];
      const proto=Element.prototype;
      const d=Object.getOwnPropertyDescriptor(proto,"scrollTop");
      const os=d.set, og=d.get;
      Object.defineProperty(proto,"scrollTop",{configurable:true,enumerable:d.enumerable,
        get(){return og.call(this);},
        set(v){
          if(this&&this.tagName==="TEXTAREA"){
            const st=new Error().stack||"";
            window.__w.push({t:+performance.now().toFixed(0),from:+og.call(this).toFixed(2),to:+Number(v).toFixed(2),
              frames:st.split("\\n").slice(1,8).map(s=>s.trim().slice(0,150))});
          }
          return os.call(this,v);
        }});
      return 1;`);

    // 打开预览，观察 5s
    await ev(`window.__w.length=0;window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.togglePreview"}}));return 1`);
    await sleep(5000);
    const fin = await ev(`const ta=document.querySelector("textarea.source-editor");const max=Math.max(0,ta.scrollHeight-ta.clientHeight);return{st:+ta.scrollTop.toFixed(2),max:+max.toFixed(2),gap:+(max-ta.scrollTop).toFixed(2)}`);
    console.log("AFTER-OPEN", JSON.stringify(fin));
    const ws = await ev(`return window.__w`);
    console.log("WRITES: " + ws.length);
    for (const w of ws) {
      if (Math.abs(w.to - w.from) < 0.05) continue;
      console.log(`  t=${w.t} ${w.from} → ${w.to}`);
      for (const f of w.frames) console.log("      " + f);
    }
  } finally {
    try { cdp.close(); } catch {}
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
};
main().catch((e) => { console.error("fail", e); try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {} process.exit(2); });
