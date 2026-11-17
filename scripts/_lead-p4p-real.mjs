/**
 * Lead · **真机（打包 exe / WebView2）** 验证：双击 Shift 开/关预览后两屏是否对齐
 *
 * ## 为什么必须单独跑真机
 * 浏览器（Chrome）与 WebView2 在以下方面可能不同：
 * - iframe 文档的 scroll 事件派发时序（跨文档队列延迟）；
 * - CM6 的 measure 时机；
 * - 字体度量（影响块高，进而影响块锚点映射的误差量级）。
 * 本探针连的是**已启动的打包 exe**（`http://tauri.localhost/`），不是 dist。
 *
 * 用法：
 *   1. 先启动 exe 并开 CDP：
 *      $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
 *      .\src-tauri\target\release\lightmd.exe
 *   2. node scripts/_lead-p4p-real.mjs
 */
import fs from "node:fs";
import path from "node:path";

const CDP = process.env.P4_CDP || "http://127.0.0.1:9222";
const USER_DOC = process.env.P4_DOC || "D:\\10254\\桌面\\job plan\\明途知识产权-高级数据工程师-沟通场景表.md";
const OUT = "D:/AI/markdown view/lightmd/_verify-out";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsConnect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => res({
      send(method, params) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((a, b) => {
          pending.set(i, { a, b });
          setTimeout(() => { if (pending.delete(i)) b(new Error("CDP timeout: " + method)); }, 40000);
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
    }));
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const it = pending.get(m.id); if (!it) return;
      pending.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error).slice(0, 300))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws error")));
    setTimeout(() => rej(new Error("ws open timeout")), 25000);
  });
}

const LEFT_CENTER = `
  const sc=document.querySelector(".cm-scroller"); if(!sc)return null;
  const R=sc.getBoundingClientRect(), h=sc.clientHeight, midViewport=R.top+h/2;
  let best=null,bestD=1e9;
  for(const l of sc.querySelectorAll(".cm-line")){
    const t=(l.textContent||"").trim(); if(!t||t.length<4)continue;
    const r=l.getBoundingClientRect(), c=(r.top+r.bottom)/2, d=Math.abs(c-midViewport);
    if(d<bestD){bestD=d;best={text:t,delta:Math.round((c-midViewport)*10)/10};}
  }
  return {st:Math.round(sc.scrollTop),sh:sc.scrollHeight,ch:h,max:Math.round(sc.scrollHeight-h),
    w:sc.clientWidth,text:best?best.text:null,delta:best?best.delta:null};
`;

const RIGHT_CENTER = (text) => `
  const f=document.querySelector(".split-preview-shell iframe"); const d=f&&f.contentDocument;
  if(!d)return null; const sc=d.scrollingElement||d.documentElement||d.body;
  const h=sc.clientHeight; if(!(h>0))return null;
  const BT=String.fromCharCode(96), STAR=String.fromCharCode(42);
  const norm=(s)=>{
    let t=(s||"");
    t=t.replace(new RegExp(BT+"[^"+BT+"]*"+BT,"g")," ");
    t=t.replace(new RegExp("["+STAR+"_~]{1,3}","g"),"");
    t=t.replace(new RegExp("\\\\|","g")," ");
    t=t.replace(new RegExp("^[ \\\\t]*(#{1,6}|>|[-+"+STAR+"])[ \\\\t]*","g"),"");
    t=t.replace(new RegExp("\\\\s+","g")," ");
    return t.trim();
  };
  const full=norm(${JSON.stringify(text)});
  let needle=(full.length>=12?full.slice(0,12):full).split(" ").join("");
  if(!needle) needle=full;
  const LEAF=new Set(["P","H1","H2","H3","H4","H5","H6","LI","TD","TH","PRE","BLOCKQUOTE"]);
  let hit=null;
  for(const el of d.querySelectorAll("body *")){
    if(!LEAF.has(el.tagName))continue;
    const ts=norm(el.textContent||"").split(" ").join("");
    if(ts && ts.indexOf(needle)>=0){hit=el;break;}
  }
  const max=Math.max(0,sc.scrollHeight-h);
  if(!hit) return {st:Math.round(sc.scrollTop),sh:sc.scrollHeight,ch:h,max:Math.round(max),
    w:sc.clientWidth,found:false,deltaFromCenter:null};
  const r=hit.getBoundingClientRect();
  return {st:Math.round(sc.scrollTop),sh:sc.scrollHeight,ch:h,max:Math.round(max),w:sc.clientWidth,
    found:true, deltaFromCenter:Math.round((r.top+r.height/2-h/2)*10)/10};
`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const logLines = [];
  const log = (s) => { console.log(s); logLines.push(s); };
  const results = [];
  const add = (id, name, status, detail) => {
    results.push({ id, name, status, detail });
    log(`${status === "PASS" ? "PASS " : status === "KNOWN" ? "KNOWN" : "FAIL "} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
  };

  let cdp = null;
  for (let i = 0; i < 40 && !cdp; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        if (!String(t.url || "").includes("tauri.localhost")) continue;
        const c = await wsConnect(t.webSocketDebuggerUrl).catch(() => null);
        if (c) { cdp = c; break; }
      }
    } catch { /* not ready */ }
    if (!cdp) await sleep(500);
  }
  if (!cdp) throw new Error(`找不到打包 exe 的 CDP target（${CDP}）。请先按文件头说明启动 exe。`);
  log(`[p4p] 已连接打包 exe（tauri.localhost）`);

  await cdp.send("Page.enable").catch(() => {});
  await cdp.send("Runtime.enable").catch(() => {});

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`, returnByValue: true, awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };

  const LC = () => ev(LEFT_CENTER);
  const RC = (t) => ev(RIGHT_CENTER(t));
  const isOpen = () => ev(`const s=document.querySelector(".split-preview-shell");return !!s&&s.getBoundingClientRect().width>40;`);
  const dblShift = async () => {
    for (let i = 0; i < 2; i++) {
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await sleep(80);
    }
  };

  // 装夹具文档（走 App 的 openFile 事件，纯前端路径）
  const doc = fs.existsSync(USER_DOC) ? fs.readFileSync(USER_DOC, "utf8") : "# 夹具\n\n第1段 PI01\n\n第2段 PI02\n";
  const usingUser = fs.existsSync(USER_DOC);
  log(`[p4p] 文档=${usingUser ? "用户真实文档" : "夹具"}（${doc.length} 字符）`);
  const tmp = path.join(OUT, "_p4p-real.md");
  fs.writeFileSync(tmp, doc, "utf8");
  for (let i = 0; i < 10; i++) {
    await ev(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", {
        detail: { path: ${JSON.stringify(tmp)}, name: "p4p-real.md", content: ${JSON.stringify(doc)} }
      })); return true;
    `).catch(() => {});
    await sleep(700);
    const ok = await ev(`return !!document.querySelector(".cm-editor")`).catch(() => false);
    if (ok) break;
  }

  await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.edit"}})); return true;`).catch(() => {});
  await sleep(2600);
  if (await isOpen()) { await dblShift(); await sleep(2400); }
  log(`[p4p] 规范化 open=${await isOpen()}`);

  const scrollLeftTo = async (frac) => {
    for (let i = 0; i < 70; i++) {
      const c = await LC();
      if (!c || c.max <= 0) return c;
      const d = Math.round(c.max * frac) - c.st;
      if (Math.abs(d) < 35) break;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: 400, y: 500, deltaX: 0,
        deltaY: Math.max(-800, Math.min(800, d)), pointerType: "mouse",
      });
      await sleep(45);
    }
    await sleep(600);
    return await LC();
  };

  const rows = [];
  for (const frac of [0.3, 0.5, 0.7]) {
    const closed = await scrollLeftTo(frac);
    await dblShift();
    await sleep(3400);
    const L = await LC();
    const R = await RC(L && L.text);
    rows.push({ frac, closed, L, R });
    log(`[p4p] frac=${frac} 打开后 左="${(L.text||"").slice(0,24)}"(偏移${L.delta}) → 右命中=${R.found} 离中央=${R.deltaFromCenter}px (右st=${R.st}/${R.max})`);
    await dblShift();
    await sleep(2400);
  }

  const gaps = rows.filter((r) => r.R && r.R.found && typeof r.R.deltaFromCenter === "number").map((r) => Math.abs(r.R.deltaFromCenter));
  const worst = gaps.length ? Math.max(...gaps) : null;
  const found = rows.filter((r) => r.R && r.R.found).length;
  log(`[p4p] ===== 汇总：命中 ${found}/${rows.length}，|Δ中央| = ${JSON.stringify(gaps)} 最差=${worst} =====`);
  add("P4P-1", "★ 真机：开预览后左屏中央内容在右屏中央附近（|Δ| ≤ 120px）",
    worst !== null && worst <= 120 ? "PASS" : (found === 0 ? "KNOWN" : "FAIL"),
    `|Δ|=${JSON.stringify(gaps)}px 最差=${worst}；命中=${found}/${rows.length}` +
    (found === 0 ? "（文本指纹未命中：夹具含大量表格分隔线，需人工目视复核）" : ""));

  fs.writeFileSync(path.join(OUT, "lead-p4p-real.json"),
    JSON.stringify({ usingUser, rows, gaps, worst }, null, 1), "utf8");
  fs.writeFileSync(path.join(OUT, "lead-p4p-real.txt"), logLines.join("\n") + "\n", "utf8");
  cdp.close();
}

main().catch((e) => { console.error("[p4p] 失败:", e.message); process.exitCode = 1; });
