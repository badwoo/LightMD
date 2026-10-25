/**
 * 真机探针：表格拖拽（列宽 / 行高）→ 保存 → 关闭文档重新打开 → 尺寸是否仍生效。
 *
 * 输出**事实数据**（不是断言清单），用于定位断裂点属于哪一步：
 *   E1 拖拽当场：ProseMirror 权威节点 `.table-wrapper.pmViewDesc.node.attrs` 是否已写入；
 *   E2 源码层：切到编辑模式读 `textarea.source-editor.value`，表格之后有没有
 *      `<!-- lightmd-table-size: … -->` 指令行；
 *   E3 磁盘层：Ctrl+S 后 `fs.readFileSync` 读盘，打印表格块 + 其后若干行**逐字节**原文
 *      （JSON.stringify 保留 \r\n，可区分行尾）；
 *   E4 重开层：**真关标签**（JS click 绕过 pointer-events:none）→ 用 `lightmd:open-path`
 *      让 App 走 fileService.readFile 从磁盘读回 → 阅读模式打印 attrs / th.style.width /
 *      getBoundingClientRect / table 宽度 / 源码里是否仍有指令；
 *   E5 重启层：唯一基线场景额外做「关掉 exe → 冷启动 → 从磁盘打开」。
 *
 * 变体矩阵（每条用独立临时文件）：
 *   S0 阅读模式读 textarea 是否拿到**陈旧内容**（解释旧探针为何误判）
 *   S1 基线：表格 + 尾段，列宽拖拽 → 阅读模式 Ctrl+S → 关标签 → 磁盘重开 → 冷启动重开
 *   S2 行高拖拽 → 阅读模式 Ctrl+S → 关标签 → 磁盘重开
 *   S3 表格在**文档末尾**（其后无任何块）列宽拖拽
 *   S4 表格后**没有空行**直接跟段落（指令行插入位置压力）
 *   S5 文档**两个表格**，拖第二个
 *   S6 **CRLF** 文件（Windows 常见）
 *   S7 拖列宽后在**同表格单元格里敲字**（B6 快路径混合：表格 miss、其它 hit）
 *   S8 已有指令的文件：重开（指令已被 parser 吞掉）后再拖一次 → 检查指令行数/值稳定性
 *   S9 阅读模式拖 → 切编辑模式 → Ctrl+S（源码模式保存，取 contentRef）
 *
 * 机制全部复用既有探针（不重写底层连接）：
 *   - scripts/real-machine-v0140-batch2.mjs 的 connect / launch / ev / rect / clickXY / cmd
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
const OUT_TXT = path.join(OUT_DIR, "v0140-table-size-persistence-probe.txt");
const OUT_JSON = path.join(OUT_DIR, "v0140-table-size-persistence-probe.json");
const PORT = Number(process.env.V0140_TS_PORT || 9293);
const CDP = `http://127.0.0.1:${PORT}`;
const SKIP_RESTART = process.env.V0140_TS_SKIP_RESTART === "1";

const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 逐字节可读：JSON.stringify 把 \r \n 显示成转义，能区分 LF / CRLF，也保留行首空格 */
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
const TABLE_BLOCK = [
  "| 姓名 | 年龄 | 备注 |",
  "| --- | --- | --- |",
  "| 张三 | 30 | x |",
  "| 李四 | 40 | y |",
];
const TAIL = "表格后的尾段（用于观察指令行插在哪两行之间）。";
/** 每种变体的内容：{ title, text, eol } */
const DOCS = {
  S1: { title: "S1-基线-列宽", text: ["# S1 基线", "", ...TABLE_BLOCK, "", TAIL, ""].join("\n") },
  S2: { title: "S2-行高", text: ["# S2 行高", "", ...TABLE_BLOCK, "", TAIL, ""].join("\n") },
  S3: { title: "S3-表格在文末", text: ["# S3 表格结尾", "", ...TABLE_BLOCK, ""].join("\n") },
  // ⚠️ 用户真实文件常见形态：表格后**直接**跟正文（没有空行）。指令行要插在这里。
  S4: { title: "S4-表格后无空行", text: ["# S4 无空行", "", ...TABLE_BLOCK, TAIL, ""].join("\n") },
  S5: {
    title: "S5-两个表格",
    text: [
      "# S5 两个表格",
      "",
      "| A | B |",
      "| --- | --- |",
      "| a1 | b1 |",
      "",
      "中间段落。",
      "",
      ...TABLE_BLOCK,
      "",
      TAIL,
      "",
    ].join("\n"),
  },
  S6: { title: "S6-CRLF", text: ["# S6 CRLF", "", ...TABLE_BLOCK, "", TAIL, ""].join("\r\n") },
  S7: { title: "S7-拖后敲字", text: ["# S7 拖后敲字", "", ...TABLE_BLOCK, "", TAIL, ""].join("\n") },
  S8: {
    title: "S8-已有指令再拖",
    text: ["# S8 已有指令", "", ...TABLE_BLOCK, "", '<!-- lightmd-table-size: {"columnWidths":[100,100,100]} -->', "", TAIL, ""].join("\n"),
  },
  S9: { title: "S9-拖后切编辑保存", text: ["# S9 切编辑保存", "", ...TABLE_BLOCK, "", TAIL, ""].join("\n") },
  S0: { title: "S0-模式读数", text: ["# S0 模式读数", "", ...TABLE_BLOCK, "", TAIL, ""].join("\n") },
};

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(EXE)) throw new Error(`缺少打包产物：${EXE}`);

  // ─── 守卫：exe 内联的 dist 必须与 dist/ 一致（照抄 v0140-probe-toggle-geometry.mjs）──
  const html = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf-8");
  const m = html.match(/index-[A-Za-z0-9_-]+\.js/);
  const wantHash = m ? m[0] : null;
  if (!wantHash) throw new Error("dist/index.html 里找不到 index-*.js，请先 vite build");
  if (!fs.readFileSync(EXE).includes(Buffer.from(wantHash))) {
    throw new Error(`exe 内联 dist 已过期：dist 是 ${wantHash}，exe 里没有。先执行：npx tauri build --no-bundle`);
  }
  log("════════════ 前置校验 ════════════");
  log(`exe: ${EXE}`);
  log(`  exe mtime = ${fs.statSync(EXE).mtime.toISOString()}  size=${fs.statSync(EXE).size}`);
  log(`  dist/index.html mtime = ${fs.statSync(path.join(DIST_DIR, "index.html")).mtime.toISOString()}`);
  log(`  内联 dist hash 校验通过：${wantHash}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-ts-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const files = {};
  for (const [key, d] of Object.entries(DOCS)) {
    files[key] = path.join(tmp, `${d.title}.md`);
    fs.writeFileSync(files[key], d.text, "utf-8");
  }
  log(`临时工作区: ${tmp}`);

  const killExe = () => {
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {}
  };
  killExe();
  await sleep(1200);

  // ─── 启动 + 连 CDP ────────────────────────────────────────────────────────
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
    await sleep(1600);
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

  /**
   * 从磁盘打开（**真实链路**）：派发 `lightmd:open-path` → App.openFileByPath
   * → fileService.readFile（走 Rust read_file）→ lightmd:openFile。
   * 这样重开读的一定是磁盘字节，而不是内存标签内容。
   */
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
   * 真关当前标签：`.tab-close` 是 `opacity:0 + pointer-events:none` 的常驻占位按钮，
   * CDP 鼠标点**点不到**（旧版探针实测 before=1/after=1 就是踩了这个坑）。
   * 直接调 DOM `.click()` 走 React onClick 才可靠；关脏标签的 window.confirm 先替换为恒真。
   */
  const closeActiveTab = async () => {
    await ev(`window.confirm = () => true; return 1;`);
    for (let i = 0; i < 5; i++) {
      const before = await tabsState();
      if (before.count === 0) return { ok: true, before, after: before };
      const clicked = await ev(`
        const btn = document.querySelector(".tab-item.tab-active .tab-close");
        if (!btn) return false;
        btn.click();
        return true;`);
      await sleep(1400);
      const after = await tabsState();
      if (after.count < before.count) return { ok: true, before, after };
      if (!clicked) await sleep(600);
    }
    return { ok: false, before: await tabsState(), after: await tabsState() };
  };

  // ─── 页面内取样 ────────────────────────────────────────────────────────────
  /** PM 权威节点 attrs：拖拽是否写进节点对象的**唯一可信证据**（不受模式/序列化影响） */
  const tableState = () =>
    ev(`
      const wrap = document.querySelector(".table-wrapper");
      const desc = wrap && wrap.pmViewDesc;
      const node = desc && desc.node;
      const tbl = wrap && wrap.querySelector(".pm-table");
      return {
        found: !!wrap,
        hasDesc: !!desc,
        nodeType: node ? node.type.name : null,
        attrs: node ? { columnWidths: node.attrs.columnWidths ?? null, rowHeights: node.attrs.rowHeights ?? null } : null,
        tableInlineWidth: tbl ? tbl.style.width : null,
        tableRectWidth: tbl ? +tbl.getBoundingClientRect().width.toFixed(2) : null,
        colCells: tbl ? [...tbl.querySelectorAll("tr:first-child th, tr:first-child td")].map(c=>({ style:c.style.width||null, rect:+c.getBoundingClientRect().width.toFixed(2) })) : [],
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

  /** 真实鼠标拖拽：按下 → 多段 mousemove → 松开；记录手势是否升级为 resize（指示线出现） */
  const mouseDrag = async (x, y, dx, dy, steps = 10) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
    const probes = [];
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: "left", buttons: 1 });
      await sleep(45);
      if (i === 1 || i === steps) {
        probes.push(
          await ev(`return { step:${i}, indicator: !!document.querySelector(".table-resize-indicator, .table-resize-indicator-h"), range: !!document.querySelector(".pm-cell-in-range") };`),
        );
      }
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y: y + dy, button: "left", clickCount: 1, buttons: 0 });
    await sleep(900);
    return probes;
  };
  const dragColumn = async (tableIndex = 0) => {
    const info = await ev(`
      const tables=[...document.querySelectorAll(".table-wrapper")];
      const wrap=tables[${tableIndex}];
      if(!wrap) return null;
      const th=wrap.querySelector(".pm-table th, .pm-table td");
      if(!th) return null;
      const r=th.getBoundingClientRect();
      return { tableIndex:${tableIndex}, edgeX:r.right-2, y:r.top+r.height/2, w:+r.width.toFixed(2), tableRect:+wrap.querySelector(".pm-table").getBoundingClientRect().width.toFixed(2) };`);
    if (!info) return { info: null, probes: [] };
    const probes = await mouseDrag(info.edgeX, info.y, 70, 0);
    return { info, probes };
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
    const probes = await mouseDrag(info.x, info.edgeY, 0, 40);
    return { info, probes };
  };

  /** 读磁盘并把表格块 + 其后 8 行**逐字节**打出来 */
  const dumpDisk = (p) => {
    const text = fs.readFileSync(p, "utf8");
    const all = text.split("\n");
    const idx = all.findIndex((l) => l.includes("lightmd-table-size"));
    const directives = all.map((l, i) => ({ i, raw: raw(l) })).filter((x) => x.raw.includes("lightmd-table-size"));
    let from = 0;
    const tbl = all.findIndex((l) => l.trim().startsWith("|"));
    from = idx >= 0 ? Math.max(0, Math.min(tbl < 0 ? idx : tbl, idx) - 1) : Math.max(0, tbl);
    const to = Math.min(all.length, (idx >= 0 ? idx : from) + 9);
    return {
      path: p,
      bytes: Buffer.byteLength(text, "utf8"),
      hasCRLF: text.includes("\r\n"),
      hasDirective: text.includes("lightmd-table-size"),
      directiveCount: directives.length,
      directiveLines: directives,
      window: all.slice(from, to).map((l, k) => ({ n: from + k, chars: l.length, raw: raw(l) })),
      fullText: raw(text),
    };
  };
  const logDisk = (d, tag) => {
    log(`  ── 磁盘原文（${tag}）─────────────────────────`);
    log(`  路径: ${d.path}`);
    log(`  字节=${d.bytes} CRLF=${d.hasCRLF} 含指令=${d.hasDirective} 指令行数=${d.directiveCount}`);
    log(`  指令行: ${JSON.stringify(d.directiveLines)}`);
    for (const l of d.window) log(`   L${String(l.n).padStart(2)} (${String(l.chars).padStart(3)}字符) ${l.raw}`);
    log(`  全文: ${d.fullText}`);
  };
  const logTable = (st, tag) => {
    log(`  ── 阅读模式 DOM/节点 attrs（${tag}）───────────────`);
    log(`  wrapper=${st.found} pmViewDesc=${st.hasDesc} node=${st.nodeType}`);
    log(`  attrs.columnWidths=${JSON.stringify(st.attrs?.columnWidths)} attrs.rowHeights=${JSON.stringify(st.attrs?.rowHeights)}`);
    log(`  table inline.width=${JSON.stringify(st.tableInlineWidth)} rect=${st.tableRectWidth}`);
    log(`  首行各列: ${JSON.stringify(st.colCells)}`);
    log(`  各行高度: ${JSON.stringify(st.rows)}`);
    log(`  指令漏成正文=${st.directiveLeakedToBody}`);
  };

  const evidence = {};
  /** 跑一条变体：打开 → 阅读模式 → 拖 → 保存 → 关标签(验证真关) → 磁盘重开 → 取样 */
  const runCase = async (key, opts = {}) => {
    const p = files[key];
    const diskBefore = fs.readFileSync(p);
    const r = { key, path: p, dragKind: opts.dragKind || "column", saveMode: opts.saveMode || "preview", tableIndex: opts.tableIndex || 0, before: null, drag: null, afterDrag: null, save: null, close: null, reopen: null };

    log("");
    log(`════════════ ${key}：${opts.desc || DOCS[key].title} ════════════`);
    log(`  磁盘初始字节=${diskBefore.length} CRLF=${diskBefore.includes(Buffer.from("\r\n"))}`);
    const opened = await openByPath(p);
    if (!opened) throw new Error(`${key} 打开失败`);
    log(`  打开后标签: ${JSON.stringify(opened)}`);
    await cmd("view.preview", 1400);
    r.before = await tableState();
    logTable(r.before, `${key} 拖拽前`);

    r.drag = opts.dragKind === "row" ? await dragRow(r.tableIndex, opts.rowIndex ?? 1) : await dragColumn(r.tableIndex);
    log(`  拖拽目标: ${JSON.stringify(r.drag.info)}`);
    log(`  手势特征: ${JSON.stringify(r.drag.probes)}（indicator=true 表示真的升级成缩放而非文本选择）`);
    r.afterDrag = await tableState();
    logTable(r.afterDrag, `${key} 拖拽后（仍阅读模式）`);

    if (opts.typeInCell) {
      const typed = await ev(`
        const wrap=[...document.querySelectorAll(".table-wrapper")][${r.tableIndex}];
        const cell=wrap?.querySelector(".pm-table tbody td, .pm-table td");
        if(!cell) return null;
        const r=cell.getBoundingClientRect();
        return {x:r.left+20,y:r.top+r.height/2};`);
      if (typed) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: typed.x, y: typed.y, button: "left", clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: typed.x, y: typed.y, button: "left", clickCount: 1 });
        await sleep(500);
        await cdp.send("Input.insertText", { text: "X" });
        await sleep(700);
        log(`  已在单元格内敲入 "X"，再取一次 attrs: ${JSON.stringify((await tableState()).attrs)}`);
        r.afterType = await tableState();
      }
    }

    if (r.saveMode === "edit") {
      log("  [保存] 切到编辑模式（preview→source 同步调 getMarkdownFromDoc）");
      await cmd("view.edit", 1500);
      const src = await sourceState();
      log(`  textarea: 在DOM=${src.textareaInDom} 可见=${src.textareaVisible} len=${src.len} 含指令=${src.hasDirective}`);
      log(`  指令行: ${JSON.stringify(src.directiveLines)}`);
      log(`  textarea 全文: ${raw(src.value)}`);
      r.sourceBeforeSave = { len: src.len, hasDirective: src.hasDirective, directiveLines: src.directiveLines, value: src.value };
      await ctrlS();
    } else {
      log("  [保存] 保持阅读模式 Ctrl+S（App.handleSaveFile → getMarkdownFromDoc 序列化）");
      const preSaveSrc = await sourceState();
      log(`  ⚠️ 阅读模式下 textarea 仍在 DOM=${preSaveSrc.textareaInDom} 可见=${preSaveSrc.textareaVisible} len=${preSaveSrc.len} 含指令=${preSaveSrc.hasDirective}`);
      r.previewTextareaWhilePreview = { inDom: preSaveSrc.textareaInDom, visible: preSaveSrc.textareaVisible, len: preSaveSrc.len, hasDirective: preSaveSrc.hasDirective };
      await ctrlS();
    }
    r.save = { disk: dumpDisk(p), tabs: await tabsState() };
    logDisk(r.save.disk, `${key} Ctrl+S 后`);
    log(`  标签: ${JSON.stringify(r.save.tabs)}`);

    r.close = await closeActiveTab();
    log(`  [关闭标签] ${JSON.stringify(r.close)}`);
    if (!r.close.ok) throw new Error(`${key} 关闭标签失败（重开将不是磁盘内容，数据不可信）`);

    const reopenedTabs = await openByPath(p);
    if (!reopenedTabs) throw new Error(`${key} 磁盘重开失败`);
    log(`  [磁盘重开] 标签: ${JSON.stringify(reopenedTabs)}`);
    await cmd("view.preview", 1600);
    const prev = await tableState();
    logTable(prev, `${key} 磁盘重开·阅读模式`);
    await cmd("view.edit", 1300);
    const src2 = await sourceState();
    log(`  重开后 textarea 含指令=${src2.hasDirective} 指令行=${JSON.stringify(src2.directiveLines)} len=${src2.len}`);
    log(`  重开后 textarea 全文: ${raw(src2.value)}`);
    r.reopen = { tabs: reopenedTabs, preview: prev, source: { len: src2.len, hasDirective: src2.hasDirective, directiveLines: src2.directiveLines, value: src2.value } };
    await cmd("view.preview", 1200);
    return r;
  };

  try {
    // ── S0：阅读模式下 textarea 里到底是什么（解释旧探针的误判） ──────────
    log("");
    log("════════════ S0：阅读模式下 textarea.source-editor 的真实内容 ════════════");
    await openByPath(files.S0);
    await cmd("view.preview", 1400);
    const s0preview = await sourceState();
    log(`  阅读模式：在DOM=${s0preview.textareaInDom} 可见=${s0preview.textareaVisible} len=${s0preview.len} 含指令=${s0preview.hasDirective}`);
    log(`  value=${raw(s0preview.value)}`);
    await cmd("view.edit", 1300);
    const s0edit = await sourceState();
    log(`  编辑模式：len=${s0edit.len} 含指令=${s0edit.hasDirective} value=${raw(s0edit.value)}`);
    evidence.S0 = { previewModeTextarea: s0preview, editModeTextarea: s0edit, note: "阅读模式下 textarea 仍在 DOM 但是隐藏的陈旧副本；旧探针在阅读模式读它得到 hasDirective=false 属误导" };
    await closeActiveTab();

    // ── 变体矩阵 ──────────────────────────────────────────────────────────
    evidence.S1 = await runCase("S1", { desc: "基线：列宽拖拽 → 阅读模式 Ctrl+S → 关标签 → 磁盘重开" });
    evidence.S2 = await runCase("S2", { dragKind: "row", desc: "行高拖拽 → 阅读模式 Ctrl+S → 关标签 → 磁盘重开" });
    evidence.S3 = await runCase("S3", { desc: "表格在文档末尾（其后无块）" });
    evidence.S4 = await runCase("S4", { desc: "表格后没有空行直接跟段落" });
    evidence.S5 = await runCase("S5", { tableIndex: 1, desc: "文档两个表格，拖第二个" });
    evidence.S6 = await runCase("S6", { desc: "CRLF 文件" });
    evidence.S7 = await runCase("S7", { typeInCell: true, desc: "拖列宽后在同一表格单元格里敲字（B6 混合路径）" });
    evidence.S8 = await runCase("S8", { desc: "文件已有指令 → 重开后再拖一次（稳定性/是否重复或丢失）" });
    evidence.S9 = await runCase("S9", { saveMode: "edit", desc: "阅读模式拖 → 切编辑模式 → Ctrl+S（源码模式保存）" });

    // ── S1 追加：冷启动 exe 后从磁盘打开 ───────────────────────────────────
    log("");
    log("════════════ S1-RESTART：关掉 exe → 冷启动 → 从磁盘打开 S1 ════════════");
    if (SKIP_RESTART) {
      log("  （V0140_TS_SKIP_RESTART=1，跳过）");
      evidence.S1_RESTART = { skipped: true };
    } else {
      const s1Disk = dumpDisk(files.S1);
      logDisk(s1Disk, "冷启动前 S1 磁盘");
      try { cdp.close(); } catch {}
      try { session.child.kill(); } catch {}
      killExe();
      await sleep(2000);
      log("  exe 已结束，重新启动…");
      session = await launch();
      cdp = session.cdp;
      const opened = await openByPath(files.S1);
      if (!opened) throw new Error("冷启动后打开 S1 失败");
      log(`  冷启动后标签: ${JSON.stringify(opened)}`);
      await cmd("view.preview", 1800);
      const st = await tableState();
      logTable(st, "冷启动重开·阅读模式");
      await cmd("view.edit", 1300);
      const src = await sourceState();
      log(`  冷启动重开 textarea 含指令=${src.hasDirective} 指令行=${JSON.stringify(src.directiveLines)}`);
      evidence.S1_RESTART = { tabs: opened, preview: st, source: { hasDirective: src.hasDirective, directiveLines: src.directiveLines }, diskBeforeRestart: s1Disk };
      await cmd("view.preview", 1000);
    }
  } finally {
    try {
      cdp?.close();
    } catch {}
    try {
      session?.child?.kill();
    } catch {}
    killExe();
  }

  // ─── 汇总：逐步判定（只引用上面的原始数据） ───────────────────────────────
  log("");
  log("════════════ 逐步判定（依据上方原始数据） ════════════");
  const q = (v) => JSON.stringify(v);
  const judge = (key, dragKind) => {
    const c = evidence[key];
    if (!c) return log(`${key} 缺失`);
    const wOK = dragKind === "row" ? Array.isArray(c.afterDrag?.attrs?.rowHeights) : Array.isArray(c.afterDrag?.attrs?.columnWidths);
    const diskOK = !!c.save?.disk?.hasDirective;
    const reopenOK = dragKind === "row"
      ? Array.isArray(c.reopen?.preview?.attrs?.rowHeights) && (c.reopen.preview.rows || []).some((r) => (r.cellStyles || []).some(Boolean))
      : Array.isArray(c.reopen?.preview?.attrs?.columnWidths) && (c.reopen.preview.colCells || []).some((x) => !!x.style);
    log(`${key} ${wOK ? "OK   " : "BREAK"} 拖拽写 attrs | ${diskOK ? "OK   " : "BREAK"} 写盘含指令 | ${reopenOK ? "OK   " : "BREAK"} 磁盘重开生效`
      + `  ‖ attrs=${q(c.afterDrag?.attrs)} 磁盘指令行数=${c.save?.disk?.directiveCount} 重开attrs=${q(c.reopen?.preview?.attrs)} 重开首列style=${q(c.reopen?.preview?.colCells?.[0]?.style)} 重开行高=${q((c.reopen?.preview?.rows || []).map((r) => r.cellStyles))}`);
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

  if (evidence.S1_RESTART && !evidence.S1_RESTART.skipped) {
    const st = evidence.S1_RESTART.preview;
    log(`S1-RESTART ${Array.isArray(st?.attrs?.columnWidths) ? "OK   " : "BREAK"} 冷启动从磁盘重开生效 ‖ attrs=${q(st?.attrs)} 首列style=${q(st?.colCells?.[0]?.style)} 指令行=${q(evidence.S1_RESTART.source?.directiveLines)}`);
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
