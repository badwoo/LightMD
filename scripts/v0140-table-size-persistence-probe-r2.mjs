/**
 * 真机探针 r2：表格拖拽（列宽 / 行高）→ 保存 → **真正关闭文档** → 重新打开 → 尺寸是否仍生效。
 *
 * r1 的致命缺陷（Lead 指出，已修）：r1 点 `.tab-item.tab-active .tab-close` 时按钮是
 * `opacity:0 + pointer-events:none` 的常驻占位，CDP 鼠标点**点不到** → before=1/after=1，
 * 所谓"重开"其实只是把磁盘内容再喂一次 openFile，标签从未关闭。r2 用 4 条真实关闭路径，
 * 每条都断言标签数**确实减少**（after < before），否则该用例标为不可信并重试下一条路径。
 *
 * 覆盖 Lead 要求的 5 项 + 边界：
 *   S0  阅读模式下 textarea 的真实内容（解释旧探针 hasDirective=false 的假读数）
 *   S1  基线列宽：拖 → 阅读模式 Ctrl+S → 真实关闭 → 从磁盘 open-path 重开 → 量 attrs/DOM
 *   S2  行高：拖**并验证手势真的启动**（指示线类型 + attrs 变化）→ 保存 → 真实关闭 → 重开
 *   S3  表格在文档末尾（标题之后只有表格，无尾段）
 *   S4  文档**只有一张表**（无标题无尾段，文件最后一行就是表格末行）
 *   S5  表格后**没有空行**直接跟段落
 *   S6  文档两个表格，拖第二个
 *   S7  CRLF 文件（Windows 常见行尾）
 *   S8  拖列宽后在同一表格单元格里敲字（B6 快路径混合）
 *   S9  文件已含指令 → 重开后再拖（稳定性 / 是否重复或丢失）
 *   S10 阅读模式拖 → 切编辑模式 → Ctrl+S（源码模式保存，取 contentRef）
 *   S11 **编辑模式**（右侧预览开）里拖拽：iframe 预览里的表格能否拖？主文档 .pm-table 状态？
 *   S12 **进程重启**：taskkill exe → 重新 launch（同 temp profile）→ 从磁盘打开 S1 → 量 attrs
 *
 * 机制复用既有探针（不重写底层连接）：
 *   - scripts/real-machine-v0140-batch2.mjs 的 connect / launch / ev / rect / click / cmd
 *   - scripts/v0140-probe-toggle-geometry.mjs 的 exe 内联 dist hash 守卫
 *
 * 用法：node scripts/v0140-table-size-persistence-probe.mjs
 * 环境变量：V0140_TS_PORT（默认 9293）/ V0140_EXE / V0140_TS_SKIP_RESTART=1
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = process.env.V0140_EXE || path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const DIST_DIR = path.join(ROOT, "dist");
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0140-table-size-persistence-probe-r2.txt");
const OUT_JSON = path.join(OUT_DIR, "v0140-table-size-persistence-probe-r2.json");
const PORT = Number(process.env.V0140_TS_PORT || 9293);
const CDP = `http://127.0.0.1:${PORT}`;
const SKIP_RESTART = process.env.V0140_TS_SKIP_RESTART === "1";

const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 逐字节可读：JSON.stringify 保留 \r \n 转义与行首空格，能区分 LF/CRLF */
const raw = (s) => JSON.stringify(s);

// ─── 连接（与 real-machine-v0140-batch2.mjs 同源） ─────────────────────────
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id).resolve(m);
        pending.delete(m.id);
      }
    };
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        ws,
        send(method, params, timeoutMs = 60000) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method, params }));
          return new Promise((res, rej) => {
            const t = setTimeout(() => {
              pending.delete(i);
              rej(new Error(`CDP ${method} 超时`));
            }, timeoutMs);
            pending.set(i, {
              resolve: (v) => {
                clearTimeout(t);
                res(v);
              },
            });
          });
        },
        close() {
          try {
            ws.close();
          } catch {}
        },
      });
  });
}

// ─── 文档模板 ────────────────────────────────────────────────────────────────
const ROWS = ["| 姓名 | 年龄 | 备注 |", "| --- | --- | --- |", "| 张三 | 30 | x |", "| 李四 | 40 | y |"];
const TAIL = "表格后的尾段（观察指令行插在哪两行之间）。";
const DOCS = {
  S0: { title: "S0-模式读数", text: ["# S0 模式读数", "", ...ROWS, "", TAIL, ""].join("\n") },
  S1: { title: "S1-基线-列宽", text: ["# S1 基线", "", ...ROWS, "", TAIL, ""].join("\n") },
  S2: { title: "S2-行高", text: ["# S2 行高", "", ...ROWS, "", TAIL, ""].join("\n") },
  S3: { title: "S3-表格在文末", text: ["# S3 表格结尾", "", ...ROWS, ""].join("\n") },
  S4: { title: "S4-仅一张表", text: [...ROWS, ""].join("\n") },
  S5: { title: "S5-表格后无空行", text: ["# S5 无空行", "", ...ROWS, TAIL, ""].join("\n") },
  S6: {
    title: "S6-两个表格",
    text: ["# S6 两个表格", "", "| A | B |", "| --- | --- |", "| a1 | b1 |", "", "中间段落。", "", ...ROWS, "", TAIL, ""].join("\n"),
  },
  S7: { title: "S7-CRLF", text: ["# S7 CRLF", "", ...ROWS, "", TAIL, ""].join("\r\n") },
  S8: { title: "S8-拖后敲字", text: ["# S8 拖后敲字", "", ...ROWS, "", TAIL, ""].join("\n") },
  S9: {
    title: "S9-已有指令",
    text: ["# S9 已有指令", "", ...ROWS, "", '<!-- lightmd-table-size: {"columnWidths":[100,100,100]} -->', "", TAIL, ""].join("\n"),
  },
  S10: { title: "S10-切编辑保存", text: ["# S10 切编辑保存", "", ...ROWS, "", TAIL, ""].join("\n") },
  S11: { title: "S11-编辑模式拖拽", text: ["# S11 编辑模式拖拽", "", ...ROWS, "", TAIL, ""].join("\n") },
};

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(EXE)) throw new Error(`缺少打包产物：${EXE}`);

  // ─── 守卫：exe 内联 dist 必须与 dist/ 一致（照抄 v0140-probe-toggle-geometry.mjs）──
  const html = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf-8");
  const m = html.match(/index-[A-Za-z0-9_-]+\.js/);
  const wantHash = m ? m[0] : null;
  if (!wantHash) throw new Error("dist/index.html 里找不到 index-*.js，请先 vite build");
  if (!fs.readFileSync(EXE).includes(Buffer.from(wantHash))) {
    throw new Error(`exe 内联 dist 已过期：dist 是 ${wantHash}，exe 里没有。先执行：npx tauri build --no-bundle`);
  }
  log("════════════ 前置校验 ════════════");
  log(`exe: ${EXE}`);
  log(`  exe mtime=${fs.statSync(EXE).mtime.toISOString()} size=${fs.statSync(EXE).size}`);
  log(`  dist/index.html mtime=${fs.statSync(path.join(DIST_DIR, "index.html")).mtime.toISOString()}`);
  log(`  内联 dist hash 校验通过：${wantHash}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-ts-r2-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const files = {};
  const initialBytes = {};
  for (const [key, d] of Object.entries(DOCS)) {
    files[key] = path.join(tmp, `${d.title}.md`);
    fs.writeFileSync(files[key], d.text, "utf-8");
    initialBytes[key] = fs.readFileSync(files[key]).length;
  }
  log(`临时工作区: ${tmp}`);
  log(`profile（重启复用同一个）: ${profile}`);

  const killExe = () => {
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {}
  };
  killExe();
  await sleep(1200);

  const launch = async () => {
    const child = spawn(EXE, [], {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
        WEBVIEW2_USER_DATA_FOLDER: profile,
      },
      stdio: "ignore",
    });
    let cdp = null;
    for (let i = 0; i < 70 && !cdp; i++) {
      try {
        const list = await (await fetch(`${CDP}/json/list`)).json();
        for (const t of list) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          try {
            const c = await connect(t.webSocketDebuggerUrl);
            await c.send("Runtime.enable");
            const r = await c.send("Runtime.evaluate", {
              expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`,
              returnByValue: true,
            });
            if (r.result?.result?.value === true) {
              cdp = c;
              break;
            }
            c.close();
          } catch {}
        }
      } catch {}
      if (!cdp) await sleep(400);
    }
    if (!cdp) throw new Error("找不到 WebView2 CDP target");
    await cdp.send("Page.enable");
    return { child, cdp };
  };

  let session = await launch();
  let cdp = session.cdp;

  const ev = async (body, awaitPromise = true) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(() => { ${body} })()`,
      returnByValue: true,
      awaitPromise,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    return r.result?.result?.value;
  };
  const rect = (sel) =>
    ev(`const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom};`);
  const cmd = async (id, wait = 900) => {
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); return 1;`);
    await sleep(wait);
  };
  const ctrlS = async () => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", { type, windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, code: "KeyS", key: "s", modifiers: 2 });
    }
    await sleep(1700);
  };
  const pressKey = async (key, code, vk, modifiers = 2) => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", { type, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key, modifiers });
    }
    await sleep(1400);
  };
  const mouseClick = async (x, y, wait = 700) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(wait);
  };
  const mouseMove = async (x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await sleep(250);
  };

  const tabsState = () =>
    ev(`
      const tabs=[...document.querySelectorAll(".tab-item")];
      return {
        count: tabs.length,
        names: tabs.map(t=>(t.querySelector(".tab-name")?.textContent||"").trim()),
        dirty: tabs.map(t=>!!t.querySelector(".tab-dirty")),
        active: (document.querySelector(".tab-item.tab-active .tab-name")?.textContent||"").trim(),
      };`);

  /** 从磁盘打开（真实链路）：lightmd:open-path → App.openFileByPath → fileService.readFile(Rust) */
  const openByPath = async (p) => {
    const base = path.basename(p).replace(/\.md$/, "");
    for (let i = 0; i < 8; i++) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(p)}}})); return 1;`);
      await sleep(1500);
      const st = await tabsState();
      if (st.names.some((n) => n.includes(base))) return st;
    }
    return null;
  };

  /**
   * 真实关闭当前标签：依次尝试 4 条路径，**每条都校验标签数确实减少**。
   * 为什么不能用鼠标点 `.tab-close`：它是 `opacity:0 + pointer-events:none` 的常驻占位
   * 按钮（TabBar.css 149/173 行），CDP 派发的鼠标事件落在它上面会被 pointer-events 吞掉
   * —— r1 实测点完 before=1/after=1，标签根本没关，导致"重开"测的其实是内存内容。
   */
  const closeActiveTab = async (caseTag) => {
    // 脏标签关闭会弹 window.confirm（阻塞 CDP 求值）→ 先替换为恒真
    await ev(`window.confirm = () => true; return 1;`);
    const before = await tabsState();
    if (before.count === 0) return { ok: true, strategy: "already-empty", before, after: before };

    const strategies = [
      {
        name: "command tab.close(index=activeIdx)",
        run: async () => {
          const idx = await ev(`
            const tabs=[...document.querySelectorAll(".tab-item")];
            return tabs.findIndex(t=>t.classList.contains("tab-active"));`);
          await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"tab.close",index:${idx}}})); return 1;`);
          await sleep(1500);
        },
      },
      {
        name: "Ctrl+W（shortcut tab.close 默认键）",
        run: async () => {
          await pressKey("w", "KeyW", 87);
        },
      },
      {
        name: "事件 lightmd:closeFile",
        run: async () => {
          await ev(`window.dispatchEvent(new CustomEvent("lightmd:closeFile")); return 1;`);
          await sleep(1500);
        },
      },
      {
        name: "hover 标签后点 .tab-close（DOM click）",
        run: async () => {
          const r = await rect(".tab-item.tab-active");
          if (r) await mouseMove(r.x, r.y);
          await ev(`document.querySelector(".tab-item.tab-active .tab-close")?.click(); return 1;`);
          await sleep(1500);
        },
      },
    ];

    const attempts = [];
    for (const s of strategies) {
      try {
        await s.run();
      } catch (e) {
        attempts.push({ strategy: s.name, error: String(e).slice(0, 200) });
        continue;
      }
      const after = await tabsState();
      attempts.push({ strategy: s.name, before: before.count, after: after.count, names: after.names });
      if (after.count < before.count) return { ok: true, strategy: s.name, before, after, attempts };
    }
    return { ok: false, strategy: null, before, after: await tabsState(), attempts };
  };

  // ─── 页面内取样 ────────────────────────────────────────────────────────────
  /**
   * PM 权威节点：`.table-wrapper.pmViewDesc.node.attrs` 是拖拽是否写进文档的**唯一可信证据**。
   *
   * @param tableIndex 取样第几个 `.table-wrapper`（默认 0）。多表格用例必须传目标索引——
   *   否则量到的是**第一个**表格的 attrs（S6「拖第二个表格」曾因此被误判成 attrsFAIL）。
   */
  const tableState = (tableIndex = 0) =>
    ev(`
      const wrap = [...document.querySelectorAll(".table-wrapper")][${tableIndex}];
      const desc = wrap && wrap.pmViewDesc;
      const node = desc && desc.node;
      const tbl = wrap && wrap.querySelector(".pm-table");
      const cs = tbl ? getComputedStyle(tbl) : null;
      return {
        found: !!wrap,
        hasDesc: !!desc,
        nodeType: node ? node.type.name : null,
        attrs: node ? { columnWidths: node.attrs.columnWidths ?? null, rowHeights: node.attrs.rowHeights ?? null } : null,
        tableInlineWidth: tbl ? tbl.style.width : null,
        tableRectWidth: tbl ? +tbl.getBoundingClientRect().width.toFixed(2) : null,
        tableDisplay: cs ? cs.display : null,
        tableVisible: tbl ? !!(tbl.offsetParent) : false,
        colCells: tbl ? [...tbl.querySelectorAll("thead tr:first-of-type > th")].map(c=>({ style:c.style.width||null, rect:+c.getBoundingClientRect().width.toFixed(2) })) : [],
        rows: tbl ? [...tbl.querySelectorAll("tr")].map(tr=>({ cellStyles:[...tr.querySelectorAll("td,th")].map(c=>c.style.height||null), rect:+tr.getBoundingClientRect().height.toFixed(2) })) : [],
        directiveLeakedToBody: (document.querySelector(".ProseMirror")?.textContent||"").includes("lightmd-table-size"),
      };`);
  const sourceState = () =>
    ev(`
      const ta = document.querySelector("textarea.source-editor");
      const v = ta ? ta.value : null;
      return {
        textareaInDom: !!ta,
        textareaVisible: !!(ta && ta.offsetParent),
        len: v ? v.length : -1,
        hasDirective: v ? v.includes("lightmd-table-size") : false,
        directiveLines: v ? v.split("\\n").filter(l => l.includes("lightmd-table-size")) : [],
        value: v,
      };`);

  /** 真实鼠标拖拽；返回每步手势特征（指示线类型可区分列宽 / 行高） */
  const mouseDrag = async (x, y, dx, dy, steps = 10) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
    const probes = [];
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: "left", buttons: 1 });
      await sleep(45);
      if (i === 1 || i === Math.round(steps / 2) || i === steps) {
        probes.push(
          await ev(`
            const col = !!document.querySelector(".table-resize-indicator");
            const row = !!document.querySelector(".table-resize-indicator-h");
            return { step:${i}, indicatorCol: col, indicatorRow: row, range: !!document.querySelector(".pm-cell-in-range") };`),
        );
      }
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y: y + dy, button: "left", clickCount: 1, buttons: 0 });
    await sleep(950);
    return probes;
  };
  const dragColumn = async (tableIndex = 0) => {
    const info = await ev(`
      const wrap=[...document.querySelectorAll(".table-wrapper")][${tableIndex}];
      if(!wrap) return null;
      const th=wrap.querySelector(".pm-table th, .pm-table td");
      if(!th) return null;
      const r=th.getBoundingClientRect();
      return { tableIndex:${tableIndex}, edgeX:r.right-2, y:r.top+r.height/2, thW:+r.width.toFixed(2), tableRect:+wrap.querySelector(".pm-table").getBoundingClientRect().width.toFixed(2) };`);
    if (!info) return { info: null, probes: [] };
    return { info, probes: await mouseDrag(info.edgeX, info.y, 70, 0) };
  };
  const dragRow = async (tableIndex = 0, rowIndex = 1) => {
    const info = await ev(`
      const wrap=[...document.querySelectorAll(".table-wrapper")][${tableIndex}];
      if(!wrap) return null;
      const rows=[...wrap.querySelectorAll(".pm-table tr")];
      const tr=rows[${rowIndex}]||rows[0];
      if(!tr) return null;
      const cell=tr.querySelector("td, th");
      const r=cell.getBoundingClientRect();
      return { rowIndex: rows.indexOf(tr), x:r.left+r.width/2, edgeY:r.bottom-2, cellW:+r.width.toFixed(2), cellH:+r.height.toFixed(2) };`);
    if (!info) return { info: null, probes: [] };
    return { info, probes: await mouseDrag(info.x, info.edgeY, 0, 40) };
  };

  const dumpDisk = (p) => {
    const text = fs.readFileSync(p, "utf8");
    const all = text.split("\n");
    const idx = all.findIndex((l) => l.includes("lightmd-table-size"));
    const directives = all.map((l, i) => ({ i, raw: raw(l) })).filter((x) => x.raw.includes("lightmd-table-size"));
    const tbl = all.findIndex((l) => l.trim().startsWith("|"));
    const from = idx >= 0 ? Math.max(0, Math.min(tbl < 0 ? idx : tbl, idx) - 1) : Math.max(0, tbl);
    const to = Math.min(all.length, (idx >= 0 ? idx : from) + 9);
    return {
      path: p,
      bytes: Buffer.byteLength(text, "utf8"),
      lineCount: all.length,
      hasCRLF: text.includes("\r\n"),
      hasDirective: text.includes("lightmd-table-size"),
      directiveCount: directives.length,
      directiveLines: directives,
      window: all.slice(from, to).map((l, k) => ({ n: from + k, chars: l.length, raw: raw(l) })),
      fullText: raw(text),
    };
  };
  const logDisk = (d, tag) => {
    log(`  ── 磁盘原文（${tag}）${"─".repeat(28)}`);
    log(`  路径: ${d.path}`);
    log(`  字节=${d.bytes} 行数=${d.lineCount} CRLF=${d.hasCRLF} 含指令=${d.hasDirective} 指令行数=${d.directiveCount}`);
    log(`  指令行: ${JSON.stringify(d.directiveLines)}`);
    for (const l of d.window) log(`   L${String(l.n).padStart(2)} (${String(l.chars).padStart(3)}字符) ${l.raw}`);
    log(`  全文: ${d.fullText}`);
  };
  const logTable = (st, tag) => {
    log(`  ── PM 节点/DOM（${tag}）${"─".repeat(28)}`);
    log(`  wrapper=${st.found} pmViewDesc=${st.hasDesc} node=${st.nodeType} display=${st.tableDisplay} 可见=${st.tableVisible}`);
    log(`  attrs.columnWidths=${JSON.stringify(st.attrs?.columnWidths)} attrs.rowHeights=${JSON.stringify(st.attrs?.rowHeights)}`);
    log(`  table inline.width=${JSON.stringify(st.tableInlineWidth)} rect=${st.tableRectWidth}`);
    log(`  首行各列: ${JSON.stringify(st.colCells)}`);
    log(`  各行高度: ${JSON.stringify(st.rows)}`);
    log(`  指令漏成正文=${st.directiveLeakedToBody}`);
  };

  const evidence = {};

  /**
   * 跑一条变体：打开 → 阅读模式 → 拖 → 保存 → **真实关闭（校验标签数减少）** →
   * 从磁盘 open-path 重开 → 阅读模式量 attrs/DOM，切编辑模式读 textarea。
   */
  const runCase = async (key, opts = {}) => {
    const p = files[key];
    const r = {
      key, path: p, desc: opts.desc || DOCS[key].title, dragKind: opts.dragKind || "column",
      saveMode: opts.saveMode || "preview", tableIndex: opts.tableIndex || 0, initialBytes: initialBytes[key],
    };
    log("");
    log(`════════════ ${key}：${r.desc} ════════════`);

    const opened = await openByPath(p);
    if (!opened) throw new Error(`${key} 打开失败`);
    log(`  [打开] 标签: ${JSON.stringify(opened)}`);
    await cmd("view.preview", 1400);
    r.before = await tableState(r.tableIndex);
    logTable(r.before, `${key} 拖拽前`);

    r.drag = r.dragKind === "row" ? await dragRow(r.tableIndex, opts.rowIndex ?? 1) : await dragColumn(r.tableIndex);
    log(`  [拖拽] 目标=${JSON.stringify(r.drag.info)}`);
    log(`  [拖拽] 手势特征=${JSON.stringify(r.drag.probes)}`);
    r.afterDrag = await tableState(r.tableIndex);
    logTable(r.afterDrag, `${key} 拖拽后（仍阅读模式）`);
    r.dragEffect = {
      attrsChanged: JSON.stringify(r.before.attrs) !== JSON.stringify(r.afterDrag.attrs),
      gestureStarted: (r.drag.probes || []).some((x) => x.indicatorCol || x.indicatorRow),
      indicatorKind: (r.drag.probes || []).some((x) => x.indicatorRow) ? "row" : (r.drag.probes || []).some((x) => x.indicatorCol) ? "column" : "none",
    };
    log(`  [拖拽] 生效判定: ${JSON.stringify(r.dragEffect)}`);

    if (opts.typeInCell) {
      const t = await ev(`
        const wrap=[...document.querySelectorAll(".table-wrapper")][${r.tableIndex}];
        const cell=wrap?.querySelector(".pm-table tbody td, .pm-table td");
        if(!cell) return null;
        const rc=cell.getBoundingClientRect();
        return {x:rc.left+20,y:rc.top+rc.height/2};`);
      if (t) {
        await mouseClick(t.x, t.y, 500);
        await cdp.send("Input.insertText", { text: "X" });
        await sleep(800);
        r.afterType = await tableState(r.tableIndex);
        log(`  [单元格敲字 X] 之后 attrs=${JSON.stringify(r.afterType.attrs)} tableRect=${r.afterType.tableRectWidth}`);
      }
    }

    if (r.saveMode === "edit") {
      log("  [保存] 切到编辑模式（preview→source 同步调 getMarkdownFromDoc）");
      await cmd("view.edit", 1500);
      const src = await sourceState();
      log(`  textarea: 在DOM=${src.textareaInDom} 可见=${src.textareaVisible} len=${src.len} 含指令=${src.hasDirective}`);
      log(`  指令行: ${JSON.stringify(src.directiveLines)}`);
      log(`  全文: ${raw(src.value)}`);
      r.sourceBeforeSave = { len: src.len, hasDirective: src.hasDirective, directiveLines: src.directiveLines, value: src.value };
      await ctrlS();
    } else {
      log("  [保存] 阅读模式 Ctrl+S（handleSaveFile → getMarkdownFromDoc 序列化）");
      const pre = await sourceState();
      log(`  ⚠️ 此刻 textarea 仍在 DOM=${pre.textareaInDom} 可见=${pre.textareaVisible} len=${pre.len} 含指令=${pre.hasDirective}（隐藏陈旧副本，见 S0）`);
      r.previewModeTextarea = { inDom: pre.textareaInDom, visible: pre.textareaVisible, len: pre.len, hasDirective: pre.hasDirective };
      await ctrlS();
    }
    r.save = { disk: dumpDisk(p), tabs: await tabsState() };
    logDisk(r.save.disk, `${key} Ctrl+S 后`);
    log(`  标签: ${JSON.stringify(r.save.tabs)}`);

    r.close = await closeActiveTab(key);
    log(`  [真实关闭] ok=${r.close.ok} 策略=${JSON.stringify(r.close.strategy)} before=${r.close.before?.count} after=${r.close.after?.count}`);
    log(`  关闭尝试序列: ${JSON.stringify(r.close.attempts || [])}`);
    if (!r.close.ok) {
      log(`  ⚠️ 该用例**关闭失败**（标签数未减少），重开数据不可信，跳过。`);
      r.reopen = { skipped: "close-failed" };
      return r;
    }

    const reopenedTabs = await openByPath(p);
    if (!reopenedTabs) throw new Error(`${key} 磁盘重开失败`);
    log(`  [磁盘重开] 标签: ${JSON.stringify(reopenedTabs)}`);
    await cmd("view.preview", 1600);
    const prev = await tableState(r.tableIndex);
    logTable(prev, `${key} 磁盘重开·阅读模式`);
    await cmd("view.edit", 1400);
    const src2 = await sourceState();
    log(`  重开后 textarea 含指令=${src2.hasDirective} 指令行=${JSON.stringify(src2.directiveLines)} len=${src2.len}`);
    log(`  重开后 textarea 全文: ${raw(src2.value)}`);
    r.reopen = { tabs: reopenedTabs, preview: prev, source: { len: src2.len, hasDirective: src2.hasDirective, directiveLines: src2.directiveLines, value: src2.value } };
    await cmd("view.preview", 1200);
    return r;
  };

  try {
    // ══════ S0：阅读模式下 textarea 里的真实内容（解释 r1 的假读数） ══════
    log("");
    log("════════════ S0：阅读模式下 textarea.source-editor 的真实内容 ════════════");
    await openByPath(files.S0);
    await cmd("view.preview", 1400);
    const s0p = await sourceState();
    log(`  阅读模式: 在DOM=${s0p.textareaInDom} 可见=${s0p.textareaVisible} len=${s0p.len} 含指令=${s0p.hasDirective}`);
    log(`  value=${raw(s0p.value)}`);
    await cmd("view.edit", 1400);
    const s0e = await sourceState();
    log(`  编辑模式: 在DOM=${s0e.textareaInDom} 可见=${s0e.textareaVisible} len=${s0e.len} 含指令=${s0e.hasDirective}`);
    log(`  value=${raw(s0e.value)}`);
    evidence.S0 = { previewMode: s0p, editMode: s0e, note: "阅读模式 textarea 在 DOM 里但隐藏，内容是进入阅读模式前的陈旧副本；旧探针在阅读模式读它得 hasDirective=false 属误导" };
    const s0close = await closeActiveTab("S0");
    log(`  [关闭] ok=${s0close.ok} 策略=${JSON.stringify(s0close.strategy)} ${s0close.before?.count}→${s0close.after?.count}`);

    // ══════ 变体矩阵 ══════
    evidence.S1 = await runCase("S1", { desc: "基线：列宽拖拽 → 阅读模式 Ctrl+S → 真实关闭 → 磁盘重开" });
    evidence.S2 = await runCase("S2", { dragKind: "row", desc: "行高拖拽（验手势启动）→ 阅读模式 Ctrl+S → 真实关闭 → 磁盘重开" });
    evidence.S3 = await runCase("S3", { desc: "表格在文档末尾（标题后只有表格，无尾段）" });
    evidence.S4 = await runCase("S4", { desc: "文档只有一张表（无标题无尾段，文件末行=表格末行）" });
    evidence.S5 = await runCase("S5", { desc: "表格后没有空行直接跟段落" });
    evidence.S6 = await runCase("S6", { tableIndex: 1, desc: "文档两个表格，拖第二个" });
    evidence.S7 = await runCase("S7", { desc: "CRLF 文件" });
    evidence.S8 = await runCase("S8", { typeInCell: true, desc: "拖列宽后在同一表格单元格里敲字（B6 混合路径）" });
    evidence.S9 = await runCase("S9", { desc: "文件已含指令 → 重开后再拖（稳定性）" });
    evidence.S10 = await runCase("S10", { saveMode: "edit", desc: "阅读模式拖 → 切编辑模式 → Ctrl+S（源码模式保存）" });

    // ══════ S11：编辑模式（右侧预览开）里能不能拖表格？ ══════
    log("");
    log("════════════ S11：编辑模式（右屏预览开着）里的表格拖拽 ════════════");
    {
      const p = files.S11;
      const opened = await openByPath(p);
      log(`  [打开] 标签=${JSON.stringify(opened)}`);
      await cmd("view.edit", 1600); // view.edit 会自动 setSplitPreviewOpen(true)
      const modeState = await ev(`
        const ta = document.querySelector("textarea.source-editor");
        const shell = document.querySelector(".split-preview-shell");
        const ifr = document.querySelector(".split-preview-shell iframe");
        const wrap = document.querySelector(".table-wrapper");
        const tbl = wrap && wrap.querySelector(".pm-table");
        let d = null; try { d = ifr && ifr.contentDocument; } catch {}
        const ifrTbl = d ? d.querySelector("table") : null;
        const cs = tbl ? getComputedStyle(tbl) : null;
        return {
          viewMode_edit: !!(ta && ta.offsetParent),
          splitOpen: !!shell && shell.classList.contains("split-preview-open"),
          shellW: shell ? +shell.getBoundingClientRect().width.toFixed(1) : -1,
          mainTableWrapper: !!wrap,
          mainTableDisplay: cs ? cs.display : null,
          mainTableRect: tbl ? { w:+tbl.getBoundingClientRect().width.toFixed(2), h:+tbl.getBoundingClientRect().height.toFixed(2) } : null,
          iframeAccessible: !!d,
          iframeTable: ifrTbl ? { tag: ifrTbl.tagName, rect: { w:+ifrTbl.getBoundingClientRect().width.toFixed(2) }, cellInlineWidth: [...ifrTbl.querySelectorAll("th,td")].map(c=>c.style.width||null), className: ifrTbl.className } : null,
        };`);
      log(`  模式状态: ${JSON.stringify(modeState)}`);
      evidence.S11 = { modeState };

      // 尝试在 iframe 预览里拖 iframe 表格的列边缘（用户看到"右边有个表格"，自然会去拖）
      if (modeState.iframeTable) {
        const ifrTarget = await ev(`
          const ifr = document.querySelector(".split-preview-shell iframe");
          const d = ifr.contentDocument;
          const th = d.querySelector("table th, table td");
          if (!th) return null;
          const r = th.getBoundingClientRect();
          const ir = ifr.getBoundingClientRect();
          return { edgeX: ir.left + r.right - 2, y: ir.top + r.top + r.height/2, cellW:+r.width.toFixed(2), iframeRoot: (d.documentElement.outerHTML||"").slice(0,300) };`);
        log(`  iframe 拖拽目标（主视口坐标）: ${JSON.stringify(ifrTarget)}`);
        if (ifrTarget) {
          const probes = await mouseDrag(ifrTarget.edgeX, ifrTarget.y, 70, 0);
          log(`  iframe 拖拽手势特征: ${JSON.stringify(probes)}（indicatorCol/Row 都是 false 说明 iframe 里根本没有缩放逻辑）`);
          const afterIfr = await ev(`
            const ifr = document.querySelector(".split-preview-shell iframe");
            const d = ifr.contentDocument;
            const t = d.querySelector("table");
            return { cellInlineWidth: [...t.querySelectorAll("th,td")].map(c=>c.style.width||null), tableInlineWidth: t.style.width || null, tableRect: +t.getBoundingClientRect().width.toFixed(2) };`);
          log(`  iframe 表格拖后: ${JSON.stringify(afterIfr)}`);
          evidence.S11.iframeDrag = { target: ifrTarget, probes, after: afterIfr };
        }
      }

      // 尝试在编辑模式里直接拖主文档的 .pm-table（display:none）
      const mainTblRect = await ev(`
        const wrap = document.querySelector(".table-wrapper");
        const tbl = wrap && wrap.querySelector(".pm-table");
        if (!tbl) return null;
        const r = tbl.getBoundingClientRect();
        return { w: r.width, h: r.height, left: r.left, top: r.top };`);
      log(`  编辑模式下主文档 .pm-table rect: ${JSON.stringify(mainTblRect)}（w/h 为 0 即不可交互）`);
      evidence.S11.mainTableInEdit = mainTblRect;

      // 保存 + 真实关闭 + 重开（验证"编辑模式里看到过表格"这条路径的数据完整性）
      await ctrlS();
      const disk = dumpDisk(p);
      logDisk(disk, "S11 编辑模式 Ctrl+S 后（注意：此处没拖成功，只是验证编辑模式保存不丢东西）");
      evidence.S11.disk = disk;
      const cls = await closeActiveTab("S11");
      log(`  [关闭] ok=${cls.ok} 策略=${JSON.stringify(cls.strategy)} ${cls.before?.count}→${cls.after?.count}`);
      evidence.S11.close = cls;
    }

    // ══════ S12：进程重启（taskkill → 同 profile 重新 launch → 从磁盘打开 S1） ══════
    log("");
    log("════════════ S12：整进程重启后从磁盘打开 S1 ════════════");
    if (SKIP_RESTART) {
      log("  （V0140_TS_SKIP_RESTART=1，跳过）");
      evidence.S12 = { skipped: true };
    } else {
      const s1Disk = dumpDisk(files.S1);
      logDisk(s1Disk, "重启前 S1 磁盘");
      try { cdp.close(); } catch {}
      try { session.child.kill(); } catch {}
      killExe();
      await sleep(2200);
      log("  exe 已结束 → 用同一 temp profile 重新 launch…");
      session = await launch();
      cdp = session.cdp;
      const opened = await openByPath(files.S1);
      if (!opened) throw new Error("重启后打开 S1 失败");
      log(`  [重启后打开] 标签=${JSON.stringify(opened)}`);
      await cmd("view.preview", 1800);
      const st = await tableState();
      logTable(st, "S12 重启后·阅读模式");
      await cmd("view.edit", 1400);
      const src = await sourceState();
      log(`  重启后 textarea 含指令=${src.hasDirective} 指令行=${JSON.stringify(src.directiveLines)}`);
      log(`  重启后 textarea 全文: ${raw(src.value)}`);
      evidence.S12 = { tabs: opened, preview: st, source: { hasDirective: src.hasDirective, directiveLines: src.directiveLines }, disk: s1Disk };
      await cmd("view.preview", 1000);
    }
  } finally {
    try { cdp?.close(); } catch {}
    try { session?.child?.kill(); } catch {}
    killExe();
  }

  // ─── 汇总（只引用上面打印过的原始数据） ───────────────────────────────────
  log("");
  log("════════════ 逐用例判定（依据上方原始数据） ════════════");
  const q = (v) => JSON.stringify(v);
  const judge = (key, dragKind = "column") => {
    const c = evidence[key];
    if (!c) return log(`${key} 缺失`);
    const closeOK = c.close?.ok === true;
    const writeOK = dragKind === "row" ? Array.isArray(c.afterDrag?.attrs?.rowHeights) : Array.isArray(c.afterDrag?.attrs?.columnWidths);
    const diskOK = !!c.save?.disk?.hasDirective;
    const reopenAttrs = dragKind === "row" ? c.reopen?.preview?.attrs?.rowHeights : c.reopen?.preview?.attrs?.columnWidths;
    const reopenDOM = dragKind === "row"
      ? (c.reopen?.preview?.rows || []).some((r) => (r.cellStyles || []).some(Boolean))
      : (c.reopen?.preview?.colCells || []).some((x) => !!x.style);
    log(
      `${key.padEnd(4)} ${closeOK ? "关闭OK" : "关闭FAIL"} | ${writeOK ? "attrsOK" : "attrsFAIL"} | ${diskOK ? "写盘OK" : "写盘FAIL"} | ` +
      `${Array.isArray(reopenAttrs) && reopenDOM ? "重开生效" : "重开失效"}\n` +
      `      拖拽attrs=${q(c.afterDrag?.attrs)} 指令行数=${c.save?.disk?.directiveCount} 关闭=${c.close?.before?.count}→${c.close?.after?.count}` +
      ` 重开attrs=${q(c.reopen?.preview?.attrs)} 重开tableW=${c.reopen?.preview?.tableRectWidth}` +
      ` 重开首列=${q(c.reopen?.preview?.colCells?.map((x) => x.style))} 重开行高=${q((c.reopen?.preview?.rows || []).map((r) => r.cellStyles))}`
    );
  };
  judge("S1");
  judge("S2", "row");
  judge("S3");
  judge("S4");
  judge("S5");
  judge("S6");
  judge("S7");
  judge("S8");
  judge("S9");
  judge("S10");
  if (evidence.S12 && !evidence.S12.skipped) {
    const st = evidence.S12.preview;
    log(`S12  ${Array.isArray(st?.attrs?.columnWidths) ? "重启后生效" : "重启后失效"}  attrs=${q(st?.attrs)} 首列style=${q(st?.colCells?.map((x) => x.style))} 指令行=${q(evidence.S12.source?.directiveLines)}`);
  }

  fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf-8");
  fs.writeFileSync(OUT_JSON, JSON.stringify(evidence, null, 2), "utf-8");
  console.log(`\n报告：${OUT_TXT}`);
  console.log(`原始数据：${OUT_JSON}`);
  process.exit(0);
};

main().catch((e) => {
  console.error("探针失败：", e);
  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {}
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join("\n") + `\n\n[探针异常] ${String(e?.stack || e)}\n`, "utf-8");
  } catch {}
  process.exit(2);
});
