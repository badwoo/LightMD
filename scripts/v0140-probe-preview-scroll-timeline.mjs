/**
 * 探针 v3：v0.14.0 需求2 根因定位 —— 阅读 → 编辑 切换后，右屏 iframe 的 scrollTop 时间序列。
 *
 * 目的：看清 0~2500ms 内 pm/textarea/iframe 三个滚动容器各自的变化，
 * 判断是「从未恢复」还是「恢复了又被分屏同步/iframe 重写冲掉」。
 *
 * 用法：node scripts/v0140-probe-preview-scroll-timeline.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_TL_PORT || 9283);
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-probe-preview-timeline.txt";

const lines = [];
const log = (s) => { console.log(s); lines.push(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
    };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      ws,
      send(method, params, timeoutMs = 30000) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs);
          pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); } });
        });
      },
      close() { try { ws.close(); } catch {} },
    });
  });
}

const main = async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-tl-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const doc = path.join(tmpDir, "长文档.md");
  const parts = ["# 长文档标题", ""];
  for (let i = 1; i <= 200; i++) parts.push(`第 ${i} 段正文内容，用来把文档撑长以便验证滚动位置是否保留。`, "");
  fs.writeFileSync(doc, parts.join("\n"));

  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile },
    stdio: "ignore",
  });
  let cdp = null;
  for (let i = 0; i < 50 && !cdp; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        try {
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true });
          if (r.result?.result?.value === true) { cdp = c; break; }
          c.close();
        } catch {}
      }
    } catch {}
    if (!cdp) await sleep(400);
  }
  if (!cdp) throw new Error("no target");
  await cdp.send("Page.enable");

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  const rect = (sel) => ev(`const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};`);
  const click = async (sel, wait = 0) => {
    const r = await rect(sel);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
    if (wait) await sleep(wait);
  };

  // 在页面里装一个采样器：每 40ms 记录一次三个容器的百分比
  const installSampler = () => ev(`
    window.__tl = [];
    window.__tlTimer && clearInterval(window.__tlTimer);
    const pct = (el) => { if (!el) return null; const m = el.scrollHeight - el.clientHeight; return m > 0 ? +(el.scrollTop / m).toFixed(3) : null; };
    window.__tlTimer = setInterval(() => {
      const c = document.querySelector(".editor-container");
      const ta = document.querySelector("textarea.source-editor");
      const ifr = document.querySelector(".split-preview-shell iframe");
      let d = null; try { d = ifr && ifr.contentDocument; } catch {}
      const s = d ? (d.scrollingElement || d.documentElement) : null;
      window.__tl.push({
        t: performance.now() | 0,
        pm: pct(c),
        ta: pct(ta),
        ifr: pct(s),
        ifrH: s ? (s.scrollHeight - s.clientHeight) : -1,
        shell: (() => { const sh = document.querySelector(".split-preview-shell"); return sh ? Math.round(sh.getBoundingClientRect().width) : -1; })(),
      });
    }, 40);
    return true;
  `);
  const dump = (label) => ev(`
    const arr = window.__tl || [];
    return { label: ${JSON.stringify(label)}, samples: arr.length, points: arr.filter((x, i) => i === 0 || i === arr.length - 1 || (i > 0 && (arr[i].pm !== arr[i-1].pm || arr[i].ta !== arr[i-1].ta || arr[i].ifr !== arr[i-1].ifr))) };
  `);

  try {
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(doc)}}})); return 1;`);
    await sleep(1800);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.preview"}})); return 1;`);
    await sleep(900);

    log("=== 阅读滚到 50%，然后点「编辑」，采样 2.5s ===");
    await ev(`const el=document.querySelector(".editor-container"); const m=el.scrollHeight-el.clientHeight; el.scrollTop=Math.round(m*0.5); el.dispatchEvent(new Event("scroll")); return true;`);
    await sleep(700);
    log(`阅读态: ${JSON.stringify(await ev(`
      const c=document.querySelector(".editor-container"); const m=c.scrollHeight-c.clientHeight;
      return { pm:+(c.scrollTop/m).toFixed(3), max:m };
    `))}`);

    await installSampler();
    await click(".titlebar-mode-switch button:nth-child(2)");
    await sleep(2500);
    const d1 = await dump("阅读→编辑");
    log(`采样 ${d1.samples} 点，变化点：`);
    for (const p of d1.points) log(`  t=${p.t} pm=${p.pm} ta=${p.ta} ifr=${p.ifr} ifrMaxH=${p.ifrH} shell=${p.shell}`);
    await ev(`clearInterval(window.__tlTimer); return true;`);

    log("");
    log("=== 再点回「阅读」，采样 2s（看是否又被重置）===");
    await installSampler();
    await click(".titlebar-mode-switch button:nth-child(1)");
    await sleep(2000);
    const d2 = await dump("编辑→阅读");
    for (const p of d2.points) log(`  t=${p.t} pm=${p.pm} ta=${p.ta} ifr=${p.ifr}`);
    await ev(`clearInterval(window.__tlTimer); return true;`);
  } finally {
    try { cdp?.close(); } catch {}
    try { child.kill(); } catch {}
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf-8");
  console.log(`\n报告：${OUT}`);
};

main().catch((e) => { console.error("探针异常：", e); process.exit(1); });
