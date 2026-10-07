/**
 * LightMD v0.11.0 —— B1 实机复测（针对首轮 3 项 FAIL 的定性）
 *
 * 首轮 real-machine-v0110-b1.mjs 有 3 项 FAIL，需要用更严格的构造区分
 * 「真实缺陷」与「测试本身构造不当」：
 *
 *  A. B1-2 表体行删除：首轮在「先点表头」之后才测表体 → 按钮仍是 disabled。
 *     本脚本从**干净状态**直接点表体行，判定究竟是
 *       (a) 表体删除功能整体被禁掉（严重回归），还是
 *       (b) 仅「表头→表体」切换后禁用态不刷新（陈旧态，中等缺陷）。
 *     另外单独测「先点表头再点表体」复现陈旧态，并验证就算按钮陈旧为可用，
 *     表头删除也不会丢数据（deleteRow 真实兜底）。
 *
 *  B. B1-3 图片宽度：首轮 width 属性确实是 300，但实测渲染宽度 33px ——
 *     因为 a.png 并不存在（破图）。本脚本写入**真实存在的 PNG**后复测，
 *     以判定「宽度是否真的生效」而不是被破图影响。
 *
 * 用法：node scripts/real-machine-v0110-b1-fixups.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0110_FIX_PORT || 9229);
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
      const res = await fetch(`${CDP_BASE}/json/list`);
      const t = (await res.json()).find((x) => x.type === "page" && x.webSocketDebuggerUrl);
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

// 8x8 纯色 PNG（真实可解码，避免破图干扰宽度测量）
const PNG_8x8 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVR42mP8z8Dwn4EIwDiqkL4K" +
  "AZ0kE/9kzBqeAAAAAElFTkSuQmCC",
  "base64"
);

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`未找到打包产物：${EXE}`);
    process.exit(3);
  }
  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    await sleep(1200);
  } catch {}

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0110-fix-"));
  const fTable = path.join(tmpDir, "表格.md");
  const fImage = path.join(tmpDir, "图片.md");
  const TABLE_SRC = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n";
  const IMAGE_SRC = "![alt|300](real.png)\n\n![plain](real.png)\n";
  fs.writeFileSync(fTable, TABLE_SRC);
  fs.writeFileSync(fImage, IMAGE_SRC);
  fs.writeFileSync(path.join(tmpDir, "real.png"), PNG_8x8); // 真实存在的图片
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
      await sleep(300);
      return "ok";
    };

    const runCommand = async (id) => {
      await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); true`);
      await sleep(300);
    };
    const openFile = async (p, c) => {
      await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(p)},content:${JSON.stringify(c)}}})); true`);
      await sleep(700);
    };
    const readSource = async () => {
      await runCommand("view.edit");
      await sleep(600);
      return evalJs(`(() => { const ta = document.querySelector('textarea.source-editor') || document.querySelector('textarea'); return ta ? ta.value : "NO-TEXTAREA"; })()`);
    };
    const readToolbar = async () => JSON.parse(await evalJs(`(() => {
      const tb = document.querySelector('.table-toolbar');
      if (!tb) return JSON.stringify({ present: false });
      const del = [...tb.querySelectorAll('button')].find(b => b.textContent.trim() === '↕');
      return JSON.stringify({ present: true, found: !!del, disabled: del ? !!del.disabled : null, title: del ? del.title : null });
    })()`));
    const clickDeleteRow = async () => evalJs(`(() => {
      const tb = document.querySelector('.table-toolbar');
      if (!tb) return 'no-toolbar';
      const del = [...tb.querySelectorAll('button')].find(b => b.textContent.trim() === '↕');
      if (!del) return 'no-btn';
      del.click();
      return 'clicked';
    })()`);

    // ═══ A1. 干净状态：直接点表体行 → 删除行应可用且真的能删 ═══
    await runCommand("view.preview");
    await openFile(fTable, TABLE_SRC);
    await clickAt(".ProseMirror td", 0);
    await sleep(300);
    const tbClean = await readToolbar();
    const clicked = await clickDeleteRow();
    await sleep(400);
    const afterClean = await readSource();
    check(
      "A1 干净状态直接点表体行：「删除行」可用且表体行被真实删除",
      tbClean.present && tbClean.disabled === false && !afterClean.includes("| 1 | 2 |"),
      `按钮=${JSON.stringify(tbClean)} click=${clicked} 存盘=${String(afterClean).replace(/\n/g, "\\n")}`
    );

    // ═══ A2. 复现陈旧态：先点表头 → 再点表体，按钮禁用态是否刷新 ═══
    await runCommand("view.preview");
    await openFile(fTable, TABLE_SRC);
    await clickAt(".ProseMirror th", 0);
    await sleep(350);
    const tbHead = await readToolbar();
    await clickAt(".ProseMirror td", 0); // 仍在表格内 → onDocClick 不销毁工具栏
    await sleep(350);
    const tbAfterMove = await readToolbar();
    check(
      "A2 先点表头再点表体：按钮禁用态已刷新（无陈旧态）",
      !(tbHead.disabled === true && tbAfterMove.disabled === true),
      `表头=${JSON.stringify(tbHead)} → 表体=${JSON.stringify(tbAfterMove)}`
    );

    // ═══ A3. 陈旧态下点表体行是否真的删不掉（用户可感知后果）═══
    const clicked2 = await clickDeleteRow();
    await sleep(400);
    const afterStale = await readSource();
    check(
      "A3 陈旧态下切到表体后仍能删除该表体行（功能未受阻）",
      !afterStale.includes("| 1 | 2 |"),
      `按钮=${JSON.stringify(tbAfterMove)} click=${clicked2} 存盘=${String(afterStale).replace(/\n/g, "\\n")}`
    );

    // ═══ A4. 反向：先点表体（按钮可用）再点表头 → 点按钮不得丢表头 ═══
    await runCommand("view.preview");
    await openFile(fTable, TABLE_SRC);
    await clickAt(".ProseMirror td", 0);
    await sleep(300);
    const tbBodyFirst = await readToolbar();
    await clickAt(".ProseMirror th", 0);
    await sleep(350);
    const tbHeadSecond = await readToolbar();
    await clickDeleteRow();
    await sleep(400);
    const afterReverse = await readSource();
    check(
      "A4 反向顺序（先表体后表头）：表头 A/B 与数据均未丢失（deleteRow 兜底生效）",
      afterReverse.includes("A") && afterReverse.includes("B") && afterReverse.includes("| 1 | 2 |"),
      `表体=${JSON.stringify(tbBodyFirst)} 表头=${JSON.stringify(tbHeadSecond)} 存盘=${String(afterReverse).replace(/\n/g, "\\n")}`
    );

    // ═══ B. B1-3 用真实存在的图片复测宽度 ═══
    await runCommand("view.preview");
    await openFile(fImage, IMAGE_SRC);
    await sleep(400);
    await runCommand("view.split");
    await sleep(1500);
    let imgState = "no-iframe";
    for (let i = 0; i < 12; i++) {
      imgState = await evalJs(`(() => {
        const f = document.querySelector('iframe');
        if (!f || !f.contentDocument) return "no-iframe";
        const imgs = [...f.contentDocument.querySelectorAll('img')];
        if (!imgs.length) return "no-img";
        const sized = imgs[0], plain = imgs[1];
        const rSized = sized.getBoundingClientRect();
        return JSON.stringify({
          sizedAlt: sized.getAttribute('alt'),
          sizedWidthAttr: sized.getAttribute('width'),
          sizedRenderedW: Math.round(rSized.width),
          sizedNaturalW: sized.naturalWidth,
          sizedComplete: sized.complete,
          plainAlt: plain ? plain.getAttribute('alt') : null,
          plainWidthAttr: plain ? plain.getAttribute('width') : null,
          plainRenderedW: plain ? Math.round(plain.getBoundingClientRect().width) : null,
          plainNaturalW: plain ? plain.naturalWidth : null,
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
    check(
      "B  真实图片下 |300 渲染宽度为 300px（宽度真实生效）",
      img.sizedWidthAttr === "300" && img.sizedRenderedW === 300,
      imgState
    );
    check(
      "B  无后缀图片按其自然尺寸渲染（无回归，无 width 属性）",
      !img.plainWidthAttr && img.plainRenderedW === img.plainNaturalW,
      imgState
    );

    console.log("");
    console.log("=== LightMD v0.11.0 B1 实机复测结果 ===");
    for (const l of results) console.log(l);
    console.log(`共 ${results.length} 项，失败 ${failed} 项`);
  } finally {
    try { cdp?.close(); } catch {}
    try { child.kill(); } catch {}
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("复测脚本执行失败:", e); process.exit(2); });
