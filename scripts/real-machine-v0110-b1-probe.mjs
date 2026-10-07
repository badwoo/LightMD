/**
 * LightMD v0.11.0 —— B1 实机终测（定性 A2 陈旧态缺陷 与 B1-3 宽度是否真实生效）
 *
 * 前两轮的教训（都记在测试构造里，不是产品问题）：
 *  - 应用有 startupRestore：启动后会恢复上次打开的标签，若不等它稳定就 openFile，
 *    读取到的可能还是上一个文档 → 必须先 openFile 再**校验当前源码内容**，不一致就重试。
 *  - 图片用不存在的/无效的 PNG 时 naturalWidth=0（破图），此时测量渲染宽度无意义。
 *    本轮改用**保证可解码的 data URI 图片**。
 *
 * 本轮要回答两个确定性问题：
 *  Q1 光标确实在表体单元格（TD）时，「删除行」按钮是否仍然 disabled？
 *     若「光标=TD 且按钮 disabled」→ 陈旧态缺陷成立（表体行删不掉，用户可感知）。
 *  Q2 <img width="300"> 在图片**真实可解码**时渲染宽度是否为 300px？
 *
 * 用法：node scripts/real-machine-v0110-b1-probe.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0110_PROBE_PORT || 9230);
const CDP_BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const t = (await (await fetch(`${CDP_BASE}/json/list`)).json())
        .find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch {}
    await sleep(500);
  }
  throw new Error("未找到 WebView2 调试目标");
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
      ws,
      send(method, params) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((r) => pending.set(i, r));
      },
      close: () => ws.close(),
    });
  });
}

// 保证可解码：1x1 透明 GIF（IEND 完整）
const GIF_1x1 = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

async function main() {
  if (!fs.existsSync(EXE)) { console.error(`未找到打包产物：${EXE}`); process.exit(3); }
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); await sleep(1200); } catch {}

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0110-probe-"));
  const fTable = path.join(tmpDir, "probe-table.md");
  const fImage = path.join(tmpDir, "probe-image.md");
  const TABLE_SRC = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n";
  const IMAGE_SRC = `![alt|300](${GIF_1x1})\n\n![plain](${GIF_1x1})\n`;
  fs.writeFileSync(fTable, TABLE_SRC);
  fs.writeFileSync(fImage, IMAGE_SRC);
  console.log(`临时目录: ${tmpDir}`);

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
  });

  let cdp;
  try {
    cdp = await connect((await findPageTarget()).webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");

    const evalJs = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result?.result?.value;
    };
    const runCommand = async (id) => {
      await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); true`);
      await sleep(300);
    };
    const readSource = async () => {
      await runCommand("view.edit");
      await sleep(500);
      return evalJs(`(() => { const ta = document.querySelector('textarea.source-editor') || document.querySelector('textarea'); return ta ? ta.value : "NO-TEXTAREA"; })()`);
    };
    /** openFile 并校验当前文档确实是目标内容（对抗 startupRestore 竞态） */
    const openAndVerify = async (p, content, marker) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(p)},content:${JSON.stringify(content)}}})); true`);
        await sleep(900);
        const v = await readSource();
        if (typeof v === "string" && v.includes(marker)) {
          await runCommand("view.preview");
          await sleep(400);
          return true;
        }
        await sleep(700);
      }
      return false;
    };
    const clickAt = async (selector, nth = 0) => {
      const s = await evalJs(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}];
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`);
      if (!s) return "no-el";
      const { x, y } = JSON.parse(s);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await sleep(320);
      return "ok";
    };
    /** 光标当前落在哪种单元格 —— 这是判定「陈旧态」的关键独立证据 */
    const caretCell = async () => evalJs(`(() => {
      const sel = document.getSelection();
      let n = sel && sel.anchorNode;
      if (!n) return 'no-selection';
      let el = n.nodeType === 1 ? n : n.parentElement;
      while (el && !['TH','TD','P','CODE'].includes(el.tagName)) el = el.parentElement;
      return el ? (el.tagName + '|' + (el.textContent || '').trim().slice(0, 4)) : 'none';
    })()`);
    const readToolbar = async () => JSON.parse(await evalJs(`(() => {
      const tb = document.querySelector('.table-toolbar');
      if (!tb) return JSON.stringify({ present: false });
      const del = [...tb.querySelectorAll('button')].find(b => b.textContent.trim() === '↕');
      return JSON.stringify({ present: true, disabled: del ? !!del.disabled : null, title: del ? del.title : null });
    })()`));
    const clickDeleteRow = async () => evalJs(`(() => {
      const tb = document.querySelector('.table-toolbar');
      if (!tb) return 'no-toolbar';
      const del = [...tb.querySelectorAll('button')].find(b => b.textContent.trim() === '↕');
      if (!del) return 'no-btn';
      del.click();
      return 'clicked';
    })()`);

    // ═══ Q1：光标在表体（TD）时按钮是否可用 + 能否真删 ═══
    await runCommand("view.preview");
    const okTable = await openAndVerify(fTable, TABLE_SRC, "| A | B |");
    check("前置：表格文档已成为当前文档", okTable, `openAndVerify=${okTable}`);

    await clickAt(".ProseMirror td", 0);
    const cellBody = await caretCell();
    const tbBody = await readToolbar();
    const clickBody = await clickDeleteRow();
    await sleep(400);
    const afterBody = await readSource();
    check(
      "Q1a 光标在表体(TD)时「删除行」按钮可用",
      tbBody.present && tbBody.disabled === false,
      `光标=${cellBody} 按钮=${JSON.stringify(tbBody)}`
    );
    check(
      "Q1b 光标在表体(TD)时点击「删除行」真的删掉该行",
      !String(afterBody).includes("| 1 | 2 |"),
      `click=${clickBody} 存盘=${String(afterBody).replace(/\n/g, "\\n")}`
    );

    // ═══ Q1c：表头 → 表体，光标确实进入 TD 后按钮是否仍 disabled（陈旧态定性）═══
    await runCommand("view.preview");
    await openAndVerify(fTable, TABLE_SRC, "| A | B |");
    await clickAt(".ProseMirror th", 0);
    const cellHead = await caretCell();
    const tbHead = await readToolbar();
    await clickAt(".ProseMirror td", 0);
    const cellBody2 = await caretCell();
    const tbBody2 = await readToolbar();
    const clickStale = await clickDeleteRow();
    await sleep(400);
    const afterStale = await readSource();
    const caretReallyInTd = /^TD/.test(String(cellBody2));
    check(
      "Q1c 表头→表体后光标确实已进入表体单元格(TD)",
      caretReallyInTd,
      `表头光标=${cellHead} 表体光标=${cellBody2}`
    );
    check(
      "Q1d 【核心】光标已在表体但按钮仍置灰 = 陈旧态缺陷",
      caretReallyInTd && tbBody2.disabled === true,
      `表头=${JSON.stringify(tbHead)} → 表体=${JSON.stringify(tbBody2)} click=${clickStale} 存盘=${String(afterStale).replace(/\n/g, "\\n")}`
    );

    // ═══ Q2：真实可解码图片下 |300 是否渲染为 300px ═══
    await runCommand("view.preview");
    const okImg = await openAndVerify(fImage, IMAGE_SRC, "alt|300");
    await runCommand("view.split");
    await sleep(1600);
    let imgState = "no-iframe";
    for (let i = 0; i < 12; i++) {
      imgState = await evalJs(`(() => {
        const f = document.querySelector('iframe');
        if (!f || !f.contentDocument) return "no-iframe";
        const imgs = [...f.contentDocument.querySelectorAll('img')];
        if (imgs.length < 2) return "no-img";
        const sized = imgs[0], plain = imgs[1];
        return JSON.stringify({
          sizedAlt: sized.getAttribute('alt'),
          sizedWidthAttr: sized.getAttribute('width'),
          sizedRenderedW: Math.round(sized.getBoundingClientRect().width),
          sizedNaturalW: sized.naturalWidth,
          sizedComplete: sized.complete,
          plainAlt: plain.getAttribute('alt'),
          plainWidthAttr: plain.getAttribute('width'),
          plainRenderedW: Math.round(plain.getBoundingClientRect().width),
          plainNaturalW: plain.naturalWidth,
        });
      })()`);
      try {
        const o = JSON.parse(imgState);
        if (o.sizedComplete && o.sizedNaturalW > 0) break;
      } catch {}
      await sleep(400);
    }
    let img = {};
    try { img = JSON.parse(imgState); } catch {}
    check("前置：图片已真实解码（naturalWidth>0），测量才有意义", img.sizedNaturalW > 0, imgState);
    check(
      "Q2 |300 的图片渲染宽度为 300px（宽度真实生效）",
      img.sizedWidthAttr === "300" && img.sizedRenderedW === 300,
      imgState
    );
    check(
      "Q2 无后缀图片按自然尺寸渲染且无 width 属性（无回归）",
      !img.plainWidthAttr && img.plainRenderedW === img.plainNaturalW && img.plainNaturalW > 0,
      imgState
    );

    console.log("");
    console.log("=== LightMD v0.11.0 B1 实机终测结果 ===");
    for (const l of results) console.log(l);
    console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  } finally {
    try { cdp?.close(); } catch {}
    try { child.kill(); } catch {}
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("终测脚本执行失败:", e); process.exit(2); });
