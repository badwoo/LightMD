/**
 * 真机探针 r5 = **修复验证版**（同时可作修复前基线）。
 *
 * 背景（由 Lead 定位，本脚本不重复排查）：
 *   `new EditorView` 里 TableView 的 constructor **先于** PM 把 thead/tbody/tr/td
 *   填进 contentDOM 执行 → 构造期 `contentDOM.querySelectorAll("tr")` 恒为空：
 *     · `table.style.width` 设得上（只用 attrs 求和）；
 *     · 每个 td/th 的 `style.width/height` 一个都没写；
 *   而 PM 渲染完子节点后不会再调 update()（节点没变）→ 重开后尺寸永久缺失。
 *   拖拽后正常，是因为每次拖拽事务都产生新表格节点 → update() 被调用。
 *   修复 = `scheduleApplyAfterRender()` 微任务 + rAF + MutationObserver 三层补应用。
 *
 * 本脚本对**任意** exe 都能跑，输出同样的指标，便于"修复前 vs 修复后"直接对照：
 *   同一个 exe 先跑基线、再跑修复版，两份报告逐字段可比。
 *
 * 关键覆盖（Lead 明确要求）：
 *   C1 真正关闭→重开：`tab.close` 命令 / Ctrl+W / `lightmd:closeFile` 三路，
 *      **断言标签数真的减少**（after < before），否则该用例判为不可信并换下一路。
 *   C2 整进程重启：taskkill → 同 temp profile 重新 launch → 从磁盘打开同一 md。
 *   C3 重开后必须量到 `th.style.width` **等于指令里的数值**（316/176/246），
 *      以及行高 `td.style.height` 等于 30/81/30。
 *   C4 只读文件里已有指令的路径（模拟"上次拖过并保存"的真实磁盘状态），
 *      覆盖"重开即生效"这一主诉求。
 *   C5 无尺寸表格对照组：重开后**不得**出现任何内联 width/height（防过度应用）。
 *   C6 只有列宽 / 只有行高 各自的独立性（防"写列宽顺手把行高写死"）。
 *
 * 用法：
 *   node scripts/v0140-table-size-reopen-verify.mjs                 # 测默认 exe
 *   V0140_TS_TAG=pre-fix node scripts/...                           # 报告名带标记
 *   V0140_EXE=<path> node scripts/...                               # 测指定的 exe
 * 输出：_verify-out/v0140-table-size-reopen-verify[-<tag>].txt / .json
 */
import { spawn, execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = process.env.V0140_EXE || path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const DIST_DIR = path.join(ROOT, "dist");
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const TAG = process.env.V0140_TS_TAG || "fixed";
const SUFFIX = TAG === "fixed" ? "" : `-${TAG}`;
const OUT_TXT = path.join(OUT_DIR, `v0140-table-size-reopen-verify${SUFFIX}.txt`);
const OUT_JSON = path.join(OUT_DIR, `v0140-table-size-reopen-verify${SUFFIX}.json`);
const PORT = Number(process.env.V0140_TS_PORT || 9296);
const CDP = `http://127.0.0.1:${PORT}`;
const SKIP_RESTART = process.env.V0140_TS_SKIP_RESTART === "1";
/** 修复前 exe 内联的是 index-DA4_JNVt.js；修复版会换新 hash。用来判定跑的是哪一版 */
const KNOWN_PRE_FIX_HASH = "index-DA4_JNVt.js";

const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raw = (s) => JSON.stringify(s);

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

const ROWS = ["| 姓名 | 年龄 | 备注 |", "| --- | --- | --- |", "| 张三 | 30 | x |", "| 李四 | 40 | y |"];
const TAIL = "尾段。";
/** 目标尺寸（与指令里写的一致，便于逐个比对） */
const WANT_W = [316, 176, 246];
const WANT_H = [30, 81, 30];

const DOCS = {
  // 磁盘里已带列宽指令（"上次拖过并保存"的真实状态）
  col: { file: "列宽已存.md", text: ["# 列宽已存", "", ...ROWS, "", `<!-- lightmd-table-size: {"columnWidths":[${WANT_W}]} -->`, "", TAIL, ""].join("\n") },
  // 磁盘里已带行高指令
  row: { file: "行高已存.md", text: ["# 行高已存", "", ...ROWS, "", `<!-- lightmd-table-size: {"rowHeights":[${WANT_H}]} -->`, "", TAIL, ""].join("\n") },
  // 列宽+行高都有
  both: {
    file: "列宽行高都有.md",
    text: ["# 列宽行高都有", "", ...ROWS, "", `<!-- lightmd-table-size: {"columnWidths":[${WANT_W}],"rowHeights":[${WANT_H}]} -->`, "", TAIL, ""].join("\n"),
  },
  // 对照组：无尺寸
  plain: { file: "无尺寸.md", text: ["# 无尺寸", "", ...ROWS, "", TAIL, ""].join("\n") },
  // 待拖拽生成的文件（验证"拖 → 保存 → 关 → 重开"全链路）
  end2end: { file: "拖拽全链路.md", text: ["# 拖拽全链路", "", ...ROWS, "", TAIL, ""].join("\n") },
  end2endRow: { file: "行高全链路.md", text: ["# 行高全链路", "", ...ROWS, "", TAIL, ""].join("\n") },
};

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(EXE)) throw new Error(`缺少 exe：${EXE}`);

  // ─── 判定被测 exe 的版本（不硬失败：跑基线时 dist 与 exe 本就不一致） ─────
  const html = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf-8");
  const hm = html.match(/index-[A-Za-z0-9_-]+\.js/);
  const distHash = hm ? hm[0] : null;
  const exeBuf = fs.readFileSync(EXE);
  const exeHasDist = distHash ? exeBuf.includes(Buffer.from(distHash)) : false;
  const exeHasPreFix = exeBuf.includes(Buffer.from(KNOWN_PRE_FIX_HASH));

  log("════════════ 被测产物 ════════════");
  log(`exe=${EXE}`);
  log(`  exe mtime=${fs.statSync(EXE).mtime.toISOString()} size=${fs.statSync(EXE).size}`);
  log(`  exe sha256=${execSync(`powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 '${EXE.replace(/'/g, "''")}').Hash"`).toString().trim()}`);
  log(`  dist/index.html 指向=${distHash}`);
  log(`  exe 内联当前 dist = ${exeHasDist}  |  exe 含修复前 hash(${KNOWN_PRE_FIX_HASH}) = ${exeHasPreFix}`);
  if (exeHasDist) log(`  ⇒ 被测 exe 与当前 dist 一致（是修复后产物）`);
  else if (exeHasPreFix) log(`  ⇒ ⚠️ 被测 exe 内联的是**修复前** dist（基线跑）`);
  else log(`  ⇒ ⚠️ exe 与 dist 不一致且不是已知修复前 hash：结果需谨慎解读`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-ts-r5-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const files = {};
  for (const [k, d] of Object.entries(DOCS)) {
    files[k] = path.join(tmp, d.file);
    fs.writeFileSync(files[k], d.text, "utf-8");
  }
  log(`  临时工作区: ${tmp}`);

  /**
   * 结束被测进程。
   *
   * ⚠️ 必须按**被测 exe 的实际文件名**杀，不能硬编码 "lightmd.exe"：
   * 跑修复前基线时 exe 被复制成了 `lightmd-pre-fix-baseline.exe`，按 lightmd.exe
   * 杀不掉它 → 上一轮残留实例锁住同一个 WebView2 user-data-folder 且占用
   * `--remote-debugging-port`，新实例绑不上端口 → 「找不到 WebView2 CDP target」。
   */
  const exeImageName = path.basename(EXE);
  const killExe = () => {
    for (const name of new Set([exeImageName, "lightmd.exe"])) {
      try {
        execFileSync("taskkill", ["/IM", name, "/F"], { stdio: "ignore" });
      } catch {}
    }
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
    const r = await cdp.send("Runtime.evaluate", { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 900));
    return r.result?.result?.value;
  };
  const cmd = async (id, wait = 1000) => {
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); return 1;`);
    await sleep(wait);
  };
  const ctrlS = async () => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", { type, windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, code: "KeyS", key: "s", modifiers: 2 });
    }
    await sleep(1700);
  };
  const pressCtrlW = async () => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", { type, windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, code: "KeyW", key: "w", modifiers: 2 });
    }
    await sleep(1600);
  };
  const tabsState = () =>
    ev(`const tabs=[...document.querySelectorAll(".tab-item")];
        return { count: tabs.length,
                 names: tabs.map(t=>(t.querySelector(".tab-name")?.textContent||"").trim()),
                 dirty: tabs.map(t=>!!t.querySelector(".tab-dirty")),
                 active: (document.querySelector(".tab-item.tab-active .tab-name")?.textContent||"").trim() };`);

  /** 从磁盘打开（真实链路：lightmd:open-path → fileService.readFile(Rust)）并确保目标标签激活 */
  const openByPath = async (p) => {
    const base = path.basename(p).replace(/\.md$/, "");
    for (let attempt = 0; attempt < 5; attempt++) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(p)}}})); return 1;`);
      await sleep(1600);
      const has = await ev(`
        const tabs=[...document.querySelectorAll(".tab-item")];
        return tabs.some(t=>(t.querySelector(".tab-name")?.textContent||"").includes(${JSON.stringify(base)}));`);
      if (has) {
        await ev(`
          const tabs=[...document.querySelectorAll(".tab-item")];
          const el=tabs.find(t=>(t.querySelector(".tab-name")?.textContent||"").includes(${JSON.stringify(base)}));
          if (el && !el.classList.contains("tab-active")) el.click();
          return 1;`);
        await sleep(1500);
        return { ok: true, attempt, tabs: await tabsState() };
      }
    }
    return { ok: false, tabs: await tabsState() };
  };

  /**
   * 真实关闭：三路依次尝试，**每路都校验标签数减少**。
   * `.tab-close` 是 opacity:0 + pointer-events:none 的占位按钮，鼠标点不到
   * （旧版 r1 踩坑：before=1/after=1，标签根本没关）。
   */
  const closeActiveTab = async () => {
    await ev(`window.confirm = () => true; return 1;`);
    const before = await tabsState();
    if (before.count === 0) return { ok: true, strategy: "已无标签", before, after: before };
    const strategies = [
      {
        name: "command tab.close(activeIdx)",
        run: async () => {
          const idx = await ev(`const tabs=[...document.querySelectorAll(".tab-item")]; return tabs.findIndex(t=>t.classList.contains("tab-active"));`);
          await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"tab.close",index:${idx}}})); return 1;`);
          await sleep(1600);
        },
      },
      { name: "Ctrl+W", run: pressCtrlW },
      {
        name: "lightmd:closeFile",
        run: async () => {
          await ev(`window.dispatchEvent(new CustomEvent("lightmd:closeFile")); return 1;`);
          await sleep(1600);
        },
      },
      {
        name: "DOM click .tab-close（hover 后）",
        run: async () => {
          const r = await ev(`const el=document.querySelector(".tab-item.tab-active"); if(!el) return null; const b=el.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2};`);
          if (r) {
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
            await sleep(300);
          }
          await ev(`document.querySelector(".tab-item.tab-active .tab-close")?.click(); return 1;`);
          await sleep(1600);
        },
      },
    ];
    const attempts = [];
    for (const s of strategies) {
      try {
        await s.run();
      } catch (e) {
        attempts.push({ strategy: s.name, error: String(e).slice(0, 160) });
        continue;
      }
      const after = await tabsState();
      attempts.push({ strategy: s.name, beforeCount: before.count, afterCount: after.count });
      if (after.count < before.count) return { ok: true, strategy: s.name, before, after, attempts };
    }
    return { ok: false, strategy: null, before, after: await tabsState(), attempts };
  };

  /** 核心取样：attrs + table + 逐 cell 内联尺寸 + 实际 rect */
  const tableState = () =>
    ev(`
      const wrap = document.querySelector(".table-wrapper");
      const desc = wrap && wrap.pmViewDesc;
      const node = desc && desc.node;
      const tbl = wrap && wrap.querySelector("table.pm-table");
      return {
        found: !!wrap,
        attrs: node ? { columnWidths: node.attrs.columnWidths ?? null, rowHeights: node.attrs.rowHeights ?? null } : null,
        tableInlineWidth: tbl ? (tbl.style.width || null) : null,
        tableRectWidth: tbl ? +tbl.getBoundingClientRect().width.toFixed(2) : -1,
        // ⚠️ 不能用 "tr:first-child th, tr:first-child td"：它同时命中 thead 首行的 th
        // 与 tbody 首行的 td（两组各 3 个 → 6 个值），比对时会被误判成"多出来的值"。
        // 这里分开取：表头行（权威列宽展示位）+ 表体首行（确认宽度从 thead 继承一致）。
        thInlineWidths: tbl ? [...tbl.querySelectorAll("thead tr:first-of-type > th")].map(c=>c.style.width || null) : [],
        thRects: tbl ? [...tbl.querySelectorAll("thead tr:first-of-type > th")].map(c=>+c.getBoundingClientRect().width.toFixed(2)) : [],
        tbodyFirstRowWidths: tbl ? [...tbl.querySelectorAll("tbody tr:first-of-type > td")].map(c=>c.style.width || null) : [],
        allCellsWidths: tbl ? [...tbl.querySelectorAll("td,th")].map(c=>c.style.width || null) : [],
        rowFirstCellInlineHeights: tbl ? [...tbl.querySelectorAll("tr")].map(tr=>(tr.querySelector("td,th") || {}).style ? (tr.querySelector("td,th").style.height || null) : null) : [],
        rowRects: tbl ? [...tbl.querySelectorAll("tr")].map(tr=>+tr.getBoundingClientRect().height.toFixed(2)) : [],
        anyInlineStyleOnCells: tbl ? [...tbl.querySelectorAll("td,th")].some(c=>!!(c.style.width || c.style.height)) : false,
        directiveLeakedToBody: (document.querySelector(".ProseMirror")?.textContent||"").includes("lightmd-table-size"),
      };`);

  const sourceState = () =>
    ev(`
      const ta = document.querySelector("textarea.source-editor");
      const v = ta ? ta.value : null;
      return {
        textareaInDom: !!ta, textareaVisible: !!(ta && ta.offsetParent),
        len: v ? v.length : -1,
        hasDirective: v ? v.includes("lightmd-table-size") : false,
        directiveLines: v ? v.split("\\n").filter(l => l.includes("lightmd-table-size")) : [],
      };`);

  const mouseDrag = async (x, y, dx, dy, steps = 10) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
    const probes = [];
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (dx * i) / steps, y: y + (dy * i) / steps, button: "left", buttons: 1 });
      await sleep(45);
      if (i === 1 || i === steps) {
        probes.push(await ev(`return { step:${i}, col: !!document.querySelector(".table-resize-indicator"), row: !!document.querySelector(".table-resize-indicator-h") };`));
      }
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + dx, y: y + dy, button: "left", clickCount: 1, buttons: 0 });
    await sleep(1000);
    return probes;
  };
  const dragColumn = async () => {
    const info = await ev(`
      const th = document.querySelector(".table-wrapper .pm-table th, .table-wrapper .pm-table td");
      if (!th) return null;
      const r = th.getBoundingClientRect();
      return { edgeX: r.right - 2, y: r.top + r.height/2, thW: +r.width.toFixed(2) };`);
    if (!info) return { info: null, probes: [] };
    return { info, probes: await mouseDrag(info.edgeX, info.y, 70, 0) };
  };
  const dragRow = async () => {
    const info = await ev(`
      const rows = [...document.querySelectorAll(".table-wrapper .pm-table tr")];
      const tr = rows[1] || rows[0];
      if (!tr) return null;
      const cell = tr.querySelector("td, th");
      const r = cell.getBoundingClientRect();
      return { x: r.left + r.width/2, edgeY: r.bottom - 2, cellH: +r.height.toFixed(2) };`);
    if (!info) return { info: null, probes: [] };
    return { info, probes: await mouseDrag(info.x, info.edgeY, 0, 40) };
  };

  const dumpDisk = (p) => {
    const text = fs.readFileSync(p, "utf8");
    const all = text.split("\n");
    const idx = all.findIndex((l) => l.includes("lightmd-table-size"));
    const tbl = all.findIndex((l) => l.trim().startsWith("|"));
    const from = idx >= 0 ? Math.max(0, Math.min(tbl < 0 ? idx : tbl, idx) - 1) : Math.max(0, tbl);
    return {
      path: p,
      bytes: Buffer.byteLength(text, "utf8"),
      hasCRLF: text.includes("\r\n"),
      hasDirective: text.includes("lightmd-table-size"),
      directiveCount: all.filter((l) => l.includes("lightmd-table-size")).length,
      directiveLines: all.map((l, i) => ({ i, raw: raw(l) })).filter((x) => x.raw.includes("lightmd-table-size")),
      window: all.slice(from, Math.min(all.length, from + 10)).map((l, k) => ({ n: from + k, chars: l.length, raw: raw(l) })),
      fullText: raw(text),
    };
  };

  /** 比对：期望 vs 实测 */
  const compare = (label, want, got, extra = "") => {
    const ok = want.length === got.length && want.every((w, i) => got[i] === w);
    log(`  ${ok ? "MATCH" : "DIFF "} ${label}: 期望=${raw(want)} 实测=${raw(got)}${extra ? " | " + extra : ""}`);
    return { ok, want, got, extra };
  };

  const evidence = {};
  try {
    await ev(`localStorage.clear(); return 1;`);

    // ═══════════════════════ C1：已有列宽指令 → 打开即生效 ═══════════════════════
    log("");
    log("════════════ C1：磁盘已含列宽指令 → 打开文档（阅读模式）即应生效 ════════════");
    {
      const o = await openByPath(files.col);
      log(`  [打开] ${raw(o)}`);
      await cmd("view.preview", 1800);
      const st = await tableState();
      log(`  attrs=${raw(st.attrs)}  tableInlineWidth=${raw(st.tableInlineWidth)}  tableRect=${st.tableRectWidth}`);
      log(`  th.style.width=${raw(st.thInlineWidths)}`);
      log(`  th rect=${raw(st.thRects)}`);
      log(`  任一行首格 style.height=${raw(st.rowFirstCellInlineHeights)}  行 rect=${raw(st.rowRects)}`);
      log(`  指令漏成正文=${st.directiveLeakedToBody}`);
      const cmp = compare("th.style.width", WANT_W.map((w) => `${w}px`), st.thInlineWidths);
      evidence.C1 = { opened: o, state: st, compare: cmp };
    }

    // ═════════════════ C2：已有行高指令 → 打开即生效 ═════════════════
    log("");
    log("════════════ C2：磁盘已含行高指令 → 打开文档（阅读模式）即应生效 ════════════");
    {
      await closeActiveTab();
      const o = await openByPath(files.row);
      log(`  [打开] ${raw(o)}`);
      await cmd("view.preview", 1800);
      const st = await tableState();
      log(`  attrs=${raw(st.attrs)}`);
      log(`  逐行首格 style.height=${raw(st.rowFirstCellInlineHeights)}  行 rect=${raw(st.rowRects)}`);
      log(`  指令漏成正文=${st.directiveLeakedToBody}`);
      const cmp = compare("td.style.height（逐行首格）", WANT_H.map((h) => `${h}px`), st.rowFirstCellInlineHeights);
      evidence.C2 = { opened: o, state: st, compare: cmp };
    }

    // ═════════════════ C3：列宽+行高同时 ═════════════════
    log("");
    log("════════════ C3：磁盘同时含列宽与行高 → 两者都应生效且互不干扰 ════════════");
    {
      await closeActiveTab();
      const o = await openByPath(files.both);
      log(`  [打开] ${raw(o)}`);
      await cmd("view.preview", 1800);
      const st = await tableState();
      log(`  attrs=${raw(st.attrs)}`);
      log(`  th.style.width=${raw(st.thInlineWidths)}  th rect=${raw(st.thRects)}`);
      log(`  逐行 style.height=${raw(st.rowFirstCellInlineHeights)}  行 rect=${raw(st.rowRects)}`);
      const cmpW = compare("th.style.width", WANT_W.map((w) => `${w}px`), st.thInlineWidths);
      const cmpH = compare("td.style.height", WANT_H.map((h) => `${h}px`), st.rowFirstCellInlineHeights);
      evidence.C3 = { opened: o, state: st, compareW: cmpW, compareH: cmpH };
    }

    // ═════════════════ C4：无尺寸对照组（不得出现任何内联尺寸） ═════════════════
    log("");
    log("════════════ C4：无尺寸对照组 → 不得出现任何内联 width/height（防过度应用） ════════════");
    {
      await closeActiveTab();
      const o = await openByPath(files.plain);
      log(`  [打开] ${raw(o)}`);
      await cmd("view.preview", 1800);
      const st = await tableState();
      log(`  attrs=${raw(st.attrs)}  tableInlineWidth=${raw(st.tableInlineWidth)}`);
      log(`  th.style.width=${raw(st.thInlineWidths)}  逐行 style.height=${raw(st.rowFirstCellInlineHeights)}`);
      log(`  任一 cell 有内联尺寸=${st.anyInlineStyleOnCells}（应为 false）`);
      evidence.C4 = { opened: o, state: st, ok: st.anyInlineStyleOnCells === false && st.tableInlineWidth === "100%" };
    }

    // ═════════ C5：全链路「拖 → 保存 → 真正关闭 → 从磁盘重开」列宽 ═════════
    log("");
    log("════════ C5：列宽全链路 = 阅读模式拖 → Ctrl+S → **真正关闭**（校验标签数减少）→ 磁盘重开 ════════════");
    {
      const p = files.end2end;
      const o = await openByPath(p);
      log(`  [打开] ${raw(o)}`);
      await cmd("view.preview", 1500);
      const before = await tableState();
      log(`  拖前 attrs=${raw(before.attrs)} th.style.width=${raw(before.thInlineWidths)}`);

      const drag = await dragColumn();
      log(`  [拖拽] 目标=${raw(drag.info)} 手势=${raw(drag.probes)}`);
      const afterDrag = await tableState();
      log(`  拖后 attrs=${raw(afterDrag.attrs)} th.style.width=${raw(afterDrag.thInlineWidths)} th rect=${raw(afterDrag.thRects)}`);

      await ctrlS();
      const disk = dumpDisk(p);
      log(`  ── 磁盘原文（Ctrl+S 后） ${"─".repeat(30)}`);
      log(`  字节=${disk.bytes} 含指令=${disk.hasDirective} 指令行数=${disk.directiveCount} CRLF=${disk.hasCRLF}`);
      log(`  指令行=${raw(disk.directiveLines)}`);
      for (const l of disk.window) log(`   L${String(l.n).padStart(2)} (${String(l.chars).padStart(3)}字符) ${l.raw}`);
      log(`  全文=${disk.fullText}`);
      // 从磁盘指令解析出期望值（不信任内存）
      let wantFromDisk = null;
      try {
        const m = /lightmd-table-size:\s*(\{.*?\})\s*-->/.exec(fs.readFileSync(p, "utf8"));
        if (m) wantFromDisk = (JSON.parse(m[1]).columnWidths || []).map((w) => `${w}px`);
      } catch {}
      log(`  磁盘指令里的 columnWidths → 期望 ${raw(wantFromDisk)}`);

      const close = await closeActiveTab();
      log(`  [真实关闭] ok=${close.ok} 策略=${raw(close.strategy)} before=${close.before?.count} after=${close.after?.count}`);
      log(`  关闭尝试=${raw(close.attempts)}`);
      if (!close.ok) {
        log(`  ⚠️ 标签未减少 → 本用例重开不可信，标记 skip`);
        evidence.C5 = { opened: o, before, drag, afterDrag, disk, close, skipped: "close-failed", wantFromDisk };
      } else {
        const ro = await openByPath(p);
        log(`  [磁盘重开] ${raw(ro)}`);
        await cmd("view.preview", 1900);
        const reopened = await tableState();
        log(`  重开 attrs=${raw(reopened.attrs)}`);
        log(`  重开 th.style.width=${raw(reopened.thInlineWidths)}  th rect=${raw(reopened.thRects)}`);
        log(`  重开 tableInlineWidth=${raw(reopened.tableInlineWidth)} tableRect=${reopened.tableRectWidth}`);
        log(`  重开 逐行 style.height=${raw(reopened.rowFirstCellInlineHeights)}`);
        const cmp = compare("重开 th.style.width vs 磁盘指令", wantFromDisk || [], reopened.thInlineWidths);
        evidence.C5 = { opened: o, before, drag, afterDrag, disk, close, reopened, wantFromDisk, compare: cmp };
      }
    }

    // ═════════ C6：全链路「拖行高 → 保存 → 真正关闭 → 磁盘重开」行高 ═════════
    log("");
    log("════════ C6：行高全链路 = 阅读模式拖行高 → Ctrl+S → **真正关闭** → 磁盘重开 ════════════");
    {
      const p = files.end2endRow;
      const o = await openByPath(p);
      log(`  [打开] ${raw(o)}`);
      await cmd("view.preview", 1500);
      const before = await tableState();
      log(`  拖前 attrs=${raw(before.attrs)} 逐行 height=${raw(before.rowFirstCellInlineHeights)}`);

      const drag = await dragRow();
      log(`  [拖拽] 目标=${raw(drag.info)} 手势=${raw(drag.probes)}（row=true 才算行高拖拽真的启动）`);
      const afterDrag = await tableState();
      log(`  拖后 attrs=${raw(afterDrag.attrs)} 逐行 height=${raw(afterDrag.rowFirstCellInlineHeights)} 行 rect=${raw(afterDrag.rowRects)}`);
      const dragOK = Array.isArray(afterDrag.attrs?.rowHeights) && afterDrag.attrs.rowHeights.length > 0;

      await ctrlS();
      const disk = dumpDisk(p);
      log(`  ── 磁盘原文（Ctrl+S 后） ${"─".repeat(30)}`);
      log(`  字节=${disk.bytes} 含指令=${disk.hasDirective} 指令行数=${disk.directiveCount}`);
      log(`  指令行=${raw(disk.directiveLines)}`);
      for (const l of disk.window) log(`   L${String(l.n).padStart(2)} (${String(l.chars).padStart(3)}字符) ${l.raw}`);
      log(`  全文=${disk.fullText}`);
      let wantH = null;
      try {
        const m = /lightmd-table-size:\s*(\{.*?\})\s*-->/.exec(fs.readFileSync(p, "utf8"));
        if (m) wantH = (JSON.parse(m[1]).rowHeights || []).map((h) => `${h}px`);
      } catch {}
      log(`  磁盘指令里的 rowHeights → 期望 ${raw(wantH)}`);

      const close = await closeActiveTab();
      log(`  [真实关闭] ok=${close.ok} 策略=${raw(close.strategy)} before=${close.before?.count} after=${close.after?.count}`);
      if (!close.ok) {
        evidence.C6 = { opened: o, before, drag, afterDrag, disk, close, skipped: "close-failed", wantH };
      } else {
        const ro = await openByPath(p);
        log(`  [磁盘重开] ${raw(ro)}`);
        await cmd("view.preview", 1900);
        const reopened = await tableState();
        log(`  重开 attrs=${raw(reopened.attrs)}`);
        log(`  重开 逐行 style.height=${raw(reopened.rowFirstCellInlineHeights)}  行 rect=${raw(reopened.rowRects)}`);
        log(`  重开 th.style.width=${raw(reopened.thInlineWidths)}（行高文件不应写列宽）`);
        const cmp = compare("重开 td.style.height vs 磁盘指令", wantH || [], reopened.rowFirstCellInlineHeights);
        evidence.C6 = { opened: o, before, drag, afterDrag, disk, close, reopened, wantH, compare: cmp, dragOK };
      }
    }

    // ═════════ C7：整进程重启（taskkill → 同 profile 重新 launch → 从磁盘打开） ═════════
    log("");
    log("════════════ C7：整进程重启 → 从磁盘打开同一 md（列宽 + 行高都要验） ════════════");
    if (SKIP_RESTART) {
      log("  （V0140_TS_SKIP_RESTART=1，跳过）");
      evidence.C7 = { skipped: "env" };
    } else {
      const diskC5 = dumpDisk(files.end2end);
      const diskC6 = dumpDisk(files.end2endRow);
      log(`  重启前 列宽文件 指令=${raw(diskC5.directiveLines)}`);
      log(`  重启前 行高文件 指令=${raw(diskC6.directiveLines)}`);

      try { cdp.close(); } catch {}
      try { session.child.kill(); } catch {}
      killExe();
      await sleep(2400);
      log("  exe 已结束 → 同 profile 重新 launch…");
      session = await launch();
      cdp = session.cdp;

      // 7a 列宽
      const o1 = await openByPath(files.end2end);
      log(`  [重启后打开 列宽文件] ${raw(o1)}`);
      await cmd("view.preview", 2000);
      const st1 = await tableState();
      log(`  重启后 attrs=${raw(st1.attrs)}`);
      log(`  重启后 th.style.width=${raw(st1.thInlineWidths)}  th rect=${raw(st1.thRects)}`);
      log(`  重启后 tableInlineWidth=${raw(st1.tableInlineWidth)}`);
      let wantW = null;
      try {
        const m = /lightmd-table-size:\s*(\{.*?\})\s*-->/.exec(fs.readFileSync(files.end2end, "utf8"));
        if (m) wantW = (JSON.parse(m[1]).columnWidths || []).map((w) => `${w}px`);
      } catch {}
      const cmpW = compare("重启后 th.style.width vs 磁盘指令", wantW || [], st1.thInlineWidths);

      // 7b 行高
      const o2 = await openByPath(files.end2endRow);
      log(`  [重启后打开 行高文件] ${raw(o2)}`);
      await cmd("view.preview", 2000);
      const st2 = await tableState();
      log(`  重启后 attrs=${raw(st2.attrs)}`);
      log(`  重启后 逐行 style.height=${raw(st2.rowFirstCellInlineHeights)}  行 rect=${raw(st2.rowRects)}`);
      let wantH2 = null;
      try {
        const m = /lightmd-table-size:\s*(\{.*?\})\s*-->/.exec(fs.readFileSync(files.end2endRow, "utf8"));
        if (m) wantH2 = (JSON.parse(m[1]).rowHeights || []).map((h) => `${h}px`);
      } catch {}
      const cmpH = compare("重启后 td.style.height vs 磁盘指令", wantH2 || [], st2.rowFirstCellInlineHeights);

      evidence.C7 = { diskC5, diskC6, col: { opened: o1, state: st1, want: wantW, compare: cmpW }, row: { opened: o2, state: st2, want: wantH2, compare: cmpH } };
    }
  } finally {
    try { cdp?.close(); } catch {}
    try { session?.child?.kill(); } catch {}
    killExe();
  }

  // ─── 汇总 ────────────────────────────────────────────────────────────────
  log("");
  log("════════════ 汇总 ════════════");
  const verdict = (k, res, detail) => {
    const ok = res === true;
    log(`${ok ? "PASS" : "FAIL"}  ${k} — ${detail}`);
    return ok;
  };
  const results = [];
  results.push(verdict("C1 打开已有列宽指令即生效", evidence.C1?.compare?.ok, `th.style.width=${raw(evidence.C1?.state?.thInlineWidths)}`));
  results.push(verdict("C2 打开已有行高指令即生效", evidence.C2?.compare?.ok, `逐行 height=${raw(evidence.C2?.state?.rowFirstCellInlineHeights)}`));
  results.push(verdict("C3 列宽+行高同时生效", evidence.C3?.compareW?.ok && evidence.C3?.compareH?.ok, `width=${raw(evidence.C3?.state?.thInlineWidths)} height=${raw(evidence.C3?.state?.rowFirstCellInlineHeights)}`));
  results.push(verdict("C4 无尺寸表格零内联样式", evidence.C4?.ok, `anyInline=${evidence.C4?.state?.anyInlineStyleOnCells} tableInline=${raw(evidence.C4?.state?.tableInlineWidth)}`));
  results.push(verdict("C5 列宽 拖→保存→真关闭→重开 生效", evidence.C5?.compare?.ok === true, `关闭策略=${raw(evidence.C5?.close?.strategy)} ${evidence.C5?.close?.before?.count}→${evidence.C5?.close?.after?.count} 重开=${raw(evidence.C5?.reopened?.thInlineWidths)} 期望=${raw(evidence.C5?.wantFromDisk)}`));
  results.push(verdict("C6 行高 拖→保存→真关闭→重开 生效", evidence.C6?.compare?.ok === true, `关闭策略=${raw(evidence.C6?.close?.strategy)} ${evidence.C6?.close?.before?.count}→${evidence.C6?.close?.after?.count} 重开=${raw(evidence.C6?.reopened?.rowFirstCellInlineHeights)} 期望=${raw(evidence.C6?.wantH)}`));
  if (!evidence.C7 || evidence.C7.skipped) log(`SKIP  C7 整进程重启（${evidence.C7?.skipped || "未跑"}）`);
  else {
    results.push(verdict("C7a 重启后列宽生效", evidence.C7.col.compare.ok, `th.style.width=${raw(evidence.C7.col.state?.thInlineWidths)} 期望=${raw(evidence.C7.col.want)}`));
    results.push(verdict("C7b 重启后行高生效", evidence.C7.row.compare.ok, `逐行 height=${raw(evidence.C7.row.state?.rowFirstCellInlineHeights)} 期望=${raw(evidence.C7.row.want)}`));
  }
  const pass = results.filter(Boolean).length;
  log("");
  log(`被测 exe: ${EXE}`);
  log(`  exe 内联当前 dist=${exeHasDist}  含修复前 hash=${exeHasPreFix}`);
  log(`结果：${pass} PASS / ${results.length - pass} FAIL（共 ${results.length}）`);

  fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf-8");
  fs.writeFileSync(OUT_JSON, JSON.stringify({ meta: { exe: EXE, tag: TAG, distHash, exeHasDist, exeHasPreFix, when: new Date().toISOString() }, evidence }, null, 2), "utf-8");
  console.log(`\n报告：${OUT_TXT}`);
  console.log(`原始数据：${OUT_JSON}`);
  process.exit(pass === results.length ? 0 : 1);
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
