/**
 * 真机探针 r3：**因果验证**「重开后列宽/行高未应用」的根因。
 *
 * r2 已确认的事实（不再重复验证，只在本轮引用）：
 *   · 拖拽 → attrs 写入 OK
 *   · Ctrl+S → 磁盘含 `<!-- lightmd-table-size: … -->` OK（逐字节原文已留档）
 *   · 真实关闭（标签数确实减少）→ 从磁盘重开 → parser 读回 attrs **OK**
 *     （`.table-wrapper.pmViewDesc.node.attrs.columnWidths` 已等于 [316,176,246]）
 *   · 但多数用例 th/td 的 `style.width` 为 null，各列被浏览器均分（245.77px），
 *     仅 table 自身的 `style.width=738px` 生效；少数用例（S5/S7/S10）偶然正常。
 *
 * 本轮要回答的问题：为什么"有时生效有时不生效"？
 *
 * 假设 H1（构造时序）：`TableView` 构造函数里调 `applyColumnWidths(node)`，而
 *   此刻 `this.contentDOM`（`<table>`）还没有任何 `<tr>/<td>` 子节点 ——
 *   ProseMirror 在 NodeView 构造**之后**才 `updateChildren` 填充内容。
 *   于是构造期只写了 `table.style.width`，逐 cell 的 `width` 一条都没写；
 *   要等某次 `update()` 被调用（NodeView 复用、内容变、模式重解析…）才补上。
 *   → 表现就是"同一份文件，重开有时生效有时不生效"（取决于加载后有没有别的事务）。
 *
 * 验证手段（全部在页面内，**不改 src**）：
 *   T1 打开文档瞬间用 MutationObserver 记录：`.table-wrapper` 首次出现时它内部
 *      有几个 `tr`、`table.style.width` 是多少、cell 有没内联 width → 直接观测构造期状态。
 *   T2 重开后在稳定态读 cell width；然后手动调 `pmViewDesc.nodeView.update(node)`
 *      （NodeView 的公共方法，就是 PM 内部走的同一条路径）→ 再读。
 *      若 update() 之后 cell width 出现，则 H1 成立：**构造期看得见 table、看不见 cell**。
 *   T3 用户可感知的其它"补救路径"：切模式 preview→edit→preview、重开同一标签，
 *      各自是否把 cell width 补上（解释"有时生效"）。
 *   T4 时间维度：打开后 0/300/1000/2500/5000ms 连续读数，确认不是"等久点就好"。
 *   T5 行高同理（applyRowHeights 也一样在构造期跑）。
 *
 * 输出：_verify-out/v0140-table-size-persistence-probe-r3.txt 与 .json
 * 用法：node scripts/v0140-table-size-persistence-probe-r3.mjs
 * 环境变量：V0140_TS_PORT（默认 9294）/ V0140_EXE
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = process.env.V0140_EXE || path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const DIST_DIR = path.join(ROOT, "dist");
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, "v0140-table-size-persistence-probe-r3.txt");
const OUT_JSON = path.join(OUT_DIR, "v0140-table-size-persistence-probe-r3.json");
const PORT = Number(process.env.V0140_TS_PORT || 9294);
const CDP = `http://127.0.0.1:${PORT}`;

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
const DOC_TABLE = ["# 表格尺寸因果验证", "", ...ROWS, "", TAIL, ""].join("\n");
/** 已带指令的文件（模拟"上次拖过并保存过"的真实磁盘状态） */
const DOC_WITH_DIRECTIVE = [
  "# 已保存过尺寸",
  "",
  ...ROWS,
  "",
  '<!-- lightmd-table-size: {"columnWidths":[316,176,246]} -->',
  "",
  TAIL,
  "",
].join("\n");
/** 行高版 */
const DOC_WITH_ROWHEIGHT = [
  "# 已保存过行高",
  "",
  ...ROWS,
  "",
  '<!-- lightmd-table-size: {"rowHeights":[30,81,30]} -->',
  "",
  TAIL,
  "",
].join("\n");

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(EXE)) throw new Error(`缺少打包产物：${EXE}`);

  // exe 内联 dist 守卫（同 v0140-probe-toggle-geometry.mjs）
  const html = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf-8");
  const hm = html.match(/index-[A-Za-z0-9_-]+\.js/);
  const wantHash = hm ? hm[0] : null;
  if (!wantHash) throw new Error("dist/index.html 里找不到 index-*.js");
  if (!fs.readFileSync(EXE).includes(Buffer.from(wantHash))) {
    throw new Error(`exe 内联 dist 已过期（dist=${wantHash}）。先 npx tauri build --no-bundle`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-ts-r3-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const fCol = path.join(tmp, "已存列宽.md");
  const fRow = path.join(tmp, "已存行高.md");
  const fFresh = path.join(tmp, "无尺寸.md");
  fs.writeFileSync(fCol, DOC_WITH_DIRECTIVE, "utf-8");
  fs.writeFileSync(fRow, DOC_WITH_ROWHEIGHT, "utf-8");
  fs.writeFileSync(fFresh, DOC_TABLE, "utf-8");

  log("════════════ 前置校验 ════════════");
  log(`exe=${EXE}`);
  log(`  exe mtime=${fs.statSync(EXE).mtime.toISOString()} size=${fs.statSync(EXE).size}`);
  log(`  dist hash 校验通过：${wantHash}`);
  log(`  profile（重启复用）: ${profile}`);
  log("已存列宽.md 磁盘原文: " + raw(DOC_WITH_DIRECTIVE));
  log("已存行高.md 磁盘原文: " + raw(DOC_WITH_ROWHEIGHT));

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

  const session = await launch();
  const cdp = session.cdp;
  const ev = async (body, awaitPromise = true) => {
    const r = await cdp.send("Runtime.evaluate", { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 900));
    return r.result?.result?.value;
  };
  const cmd = async (id, wait = 1000) => {
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); return 1;`);
    await sleep(wait);
  };
  const tabsState = () =>
    ev(`const tabs=[...document.querySelectorAll(".tab-item")];
        return { count: tabs.length, names: tabs.map(t=>(t.querySelector(".tab-name")?.textContent||"").trim()),
                 active: (document.querySelector(".tab-item.tab-active .tab-name")?.textContent||"").trim() };`);
  const closeActiveTab = async () => {
    await ev(`window.confirm = () => true; return 1;`);
    const before = await tabsState();
    if (before.count === 0) return { ok: true, before, after: before };
    const idx = await ev(`const tabs=[...document.querySelectorAll(".tab-item")]; return tabs.findIndex(t=>t.classList.contains("tab-active"));`);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"tab.close",index:${idx}}})); return 1;`);
    await sleep(1500);
    const after = await tabsState();
    return { ok: after.count < before.count, before, after };
  };
  /** 从磁盘打开并**切到该标签**（open-path 可能复用已有标签，需显式激活） */
  const openByPath = async (p) => {
    const base = path.basename(p).replace(/\.md$/, "");
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(p)}}})); return 1;`);
    await sleep(1500);
    const act = await ev(`
      const tabs=[...document.querySelectorAll(".tab-item")];
      const el=tabs.find(t=>(t.querySelector(".tab-name")?.textContent||"").includes(${JSON.stringify(base)}));
      if (!el) return { ok:false };
      el.click();
      return { ok:true, name:(el.querySelector(".tab-name")?.textContent||"").trim() };`);
    await sleep(1400);
    const now = await tabsState();
    return { ...act, tabs: now };
  };

  /**
   * T1 核心：**在打开文档的同一帧**装一个 MutationObserver，记录
   * `.table-wrapper` 首次出现的那一刻，它内部状态是什么。
   * 这是"构造期可见性"的直接观测，不依赖任何假设。
   */
  const installTableBirthObserver = () =>
    ev(`
      window.__tableBirth = [];
      const isTbl = (n) => n && n.nodeType === 1 && n.classList && n.classList.contains("table-wrapper");
      const snap = (label) => {
        const wrap = document.querySelector(".table-wrapper");
        if (!wrap) return null;
        const tbl = wrap.querySelector("table");
        return {
          label,
          t: +(performance.now()).toFixed(1),
          rowsAtThisMoment: tbl ? tbl.querySelectorAll("tr").length : -1,
          cellsAtThisMoment: tbl ? tbl.querySelectorAll("td,th").length : -1,
          tableInlineWidth: tbl ? (tbl.style.width || null) : null,
          cellInlineWidths: tbl ? [...tbl.querySelectorAll("td,th")].map(c=>c.style.width||null) : [],
          nodeViewHasAttrs: wrap.pmViewDesc && wrap.pmViewDesc.node ? {
            columnWidths: wrap.pmViewDesc.node.attrs.columnWidths ?? null,
            rowHeights: wrap.pmViewDesc.node.attrs.rowHeights ?? null,
          } : null,
        };
      };
      const mo = new MutationObserver((muts) => {
        if (!document.querySelector(".table-wrapper")) return;
        if (window.__tableBirth.length > 0) return;
        // 首个 wrapper 出现的这一刻：立刻记录（同步在 mutation 回调里，重绘前）
        window.__tableBirth.push(snap("first-wrapper-appears"));
        // 再记一帧之后的状态，用来看"子节点是什么时候补齐的"
        requestAnimationFrame(() => {
          window.__tableBirth.push(snap("raf-after-appear"));
          requestAnimationFrame(() => window.__tableBirth.push(snap("raf2-after-appear")));
        });
      });
      mo.observe(document.getElementById("root") || document.body, { childList: true, subtree: true });
      window.__tableBirthMo = mo;
      return true;`);
  const readBirth = () =>
    ev(`const b = window.__tableBirth || [];
        if (window.__tableBirthMo) { window.__tableBirthMo.disconnect(); window.__tableBirthMo = null; }
        return b;`);

  /** 稳定态读数：attrs + table + 逐 cell */
  const tableState = () =>
    ev(`
      const wrap = document.querySelector(".table-wrapper");
      const desc = wrap && wrap.pmViewDesc;
      const node = desc && desc.node;
      const tbl = wrap && wrap.querySelector(".pm-table, table");
      return {
        found: !!wrap,
        attrs: node ? { columnWidths: node.attrs.columnWidths ?? null, rowHeights: node.attrs.rowHeights ?? null } : null,
        tableInlineWidth: tbl ? (tbl.style.width || null) : null,
        tableRectWidth: tbl ? +tbl.getBoundingClientRect().width.toFixed(2) : -1,
        cellInlineWidths: tbl ? [...tbl.querySelectorAll("td,th")].map(c=>c.style.width||null) : [],
        cellRects: tbl ? [...tbl.querySelectorAll("td,th")].map(c=>+c.getBoundingClientRect().width.toFixed(2)) : [],
        rowCellInlineHeights: tbl ? [...tbl.querySelectorAll("tr")].map(tr=>[...tr.querySelectorAll("td,th")].map(c=>c.style.height||null)) : [],
        rowRects: tbl ? [...tbl.querySelectorAll("tr")].map(tr=>+tr.getBoundingClientRect().height.toFixed(2)) : [],
        nodeViewInstanceFound: !!(desc && desc.nodeView),
      };`);

  /** T2：手动调用 NodeView.update(node) —— PM 内部复用 NodeView 时走的正是这条路径 */
  const callNodeViewUpdate = () =>
    ev(`
      const wrap = document.querySelector(".table-wrapper");
      const desc = wrap && wrap.pmViewDesc;
      if (!desc || !desc.nodeView) return { ok:false, reason:"no nodeView on pmViewDesc" };
      const nv = desc.nodeView;
      const node = desc.node;
      const before = {
        tableInlineWidth: wrap.querySelector("table")?.style.width || null,
        cellInlineWidths: [...wrap.querySelectorAll("td,th")].map(c=>c.style.width||null),
      };
      const ret = nv.update(node);
      const after = {
        tableInlineWidth: wrap.querySelector("table")?.style.width || null,
        cellInlineWidths: [...wrap.querySelectorAll("td,th")].map(c=>c.style.width||null),
        cellRects: [...wrap.querySelectorAll("td,th")].map(c=>+c.getBoundingClientRect().width.toFixed(2)),
      };
      return { ok:true, updateReturned: ret, before, after };`);

  const evidence = {};
  try {
    // ══════ T1：打开「已存列宽」文件，观测 .table-wrapper 诞生瞬间 ══════
    log("");
    log("════════════ T1：.table-wrapper 诞生瞬间的内部状态（列宽文件） ════════════");
    await installTableBirthObserver();
    const opened1 = await openByPath(fCol);
    log(`  [打开] ${JSON.stringify(opened1)}`);
    await sleep(2200);
    const birth = await readBirth();
    log(`  诞生时刻记录（${birth.length} 条）:`);
    for (const b of birth) log(`   · ${raw(b)}`);
    evidence.T1 = { opened: opened1, birth };

    await cmd("view.preview", 1500);
    const t1stable = await tableState();
    log(`  ── 稳定态（阅读模式）`);
    log(`  attrs=${raw(t1stable.attrs)} tableInlineWidth=${raw(t1stable.tableInlineWidth)} tableRect=${t1stable.tableRectWidth}`);
    log(`  cellInlineWidths=${raw(t1stable.cellInlineWidths)}`);
    log(`  cellRects=${raw(t1stable.cellRects)}`);
    log(`  nodeView 实例可见=${t1stable.nodeViewInstanceFound}`);
    evidence.T1.previewStable = t1stable;

    // ══════ T2：手动调 NodeView.update(node) ══════
    log("");
    log("════════════ T2：手动调用 NodeView.update(node)（PM 复用 NodeView 的同一条路径） ════════════");
    const t2 = await callNodeViewUpdate();
    log(`  ${raw(t2)}`);
    evidence.T2 = t2;

    // ══════ T3：其它"补救路径" ══════
    log("");
    log("════════════ T3：切口模式 / 重开同一标签 是否自动补上 cell width ════════════");
    // 先关掉再重开，重建"坏状态"
    await closeActiveTab();
    const reopened = await openByPath(fCol);
    await cmd("view.preview", 1500);
    const t3a = await tableState();
    log(`  [路径 a] 重开刚进阅读模式: cellInlineWidths=${raw(t3a.cellInlineWidths)} tableInline=${raw(t3a.tableInlineWidth)}`);
    await cmd("view.edit", 1500);
    await cmd("view.preview", 1600);
    const t3b = await tableState();
    log(`  [路径 b] 再切 edit→preview 之后: cellInlineWidths=${raw(t3b.cellInlineWidths)} tableInline=${raw(t3b.tableInlineWidth)}`);
    await cmd("view.edit", 1200);
    await cmd("view.preview", 1200);
    const t3c = await tableState();
    log(`  [路径 c] 再来一轮 edit→preview: cellInlineWidths=${raw(t3c.cellInlineWidths)}`);
    evidence.T3 = { afterReopen: t3a, afterEditPreviewOnce: t3b, afterEditPreviewTwice: t3c };

    // ══════ T4：时间维度 ══════
    log("");
    log("════════════ T4：打开后连续 0/300/1000/2500/5000ms 读数（排除「等久点就好」） ════════════");
    await closeActiveTab();
    await openByPath(fCol);
    await cmd("view.preview", 800);
    const t4 = [];
    for (const wait of [0, 300, 1000, 2500, 5000]) {
      if (wait) await sleep(wait);
      const st = await tableState();
      t4.push({ waitedMs: wait, cellInlineWidths: st.cellInlineWidths, tableInlineWidth: st.tableInlineWidth, cellRects: st.cellRects });
      log(`  +${wait}ms: cellInline=${raw(st.cellInlineWidths)} tableInline=${raw(st.tableInlineWidth)} rects=${raw(st.cellRects)}`);
    }
    evidence.T4 = t4;

    // ══════ T5：行高文件同款验证 ══════
    log("");
    log("════════════ T5：行高文件（applyRowHeights 应该在构造期跑） ════════════");
    await closeActiveTab();
    await installTableBirthObserver();
    const opened5 = await openByPath(fRow);
    log(`  [打开] ${JSON.stringify(opened5)}`);
    await sleep(2200);
    const birth5 = await readBirth();
    for (const b of birth5) log(`   · ${raw(b)}`);
    await cmd("view.preview", 1500);
    const t5 = await tableState();
    log(`  attrs=${raw(t5.attrs)}`);
    log(`  逐行 cell 内联 height=${raw(t5.rowCellInlineHeights)}  行 rect=${raw(t5.rowRects)}`);
    evidence.T5 = { opened: opened5, birth: birth5, previewStable: t5 };
    const t5upd = await callNodeViewUpdate();
    log(`  手动 update() 之后: ${raw({ rowCellInlineHeights: t5upd.after ? null : null })}`);
    const t5after = await tableState();
    log(`  手动 update() 之后逐行 height=${raw(t5after.rowCellInlineHeights)} 行 rect=${raw(t5after.rowRects)}`);
    evidence.T5.afterManualUpdate = { called: t5upd, state: t5after };

    // ══════ T6：无尺寸文件（对照组） ══════
    log("");
    log("════════════ T6：无尺寸文件对照组（确认默认态 = table 100% + cell 无内联宽） ════════════");
    await closeActiveTab();
    await openByPath(fFresh);
    await cmd("view.preview", 1500);
    const t6 = await tableState();
    log(`  attrs=${raw(t6.attrs)} tableInlineWidth=${raw(t6.tableInlineWidth)} cellInlineWidths=${raw(t6.cellInlineWidths)} rects=${raw(t6.cellRects)}`);
    evidence.T6 = t6;
  } finally {
    try { cdp.close(); } catch {}
    try { session.child.kill(); } catch {}
    killExe();
  }

  // ─── 结论（严格依据上面的观测） ───────────────────────────────────────────
  log("");
  log("════════════ 因果结论 ════════════");
  const b0 = evidence.T1?.birth?.[0];
  const bRaf = evidence.T1?.birth?.[1];
  log(`T1 诞生瞬间: rows=${b0?.rowsAtThisMoment} cells=${b0?.cellsAtThisMoment} tableInlineWidth=${raw(b0?.tableInlineWidth)} cellInline=${raw(b0?.cellInlineWidths)}`);
  log(`   raf 之后: rows=${bRaf?.rowsAtThisMoment} cells=${bRaf?.cellsAtThisMoment} cellInline=${raw(bRaf?.cellInlineWidths)}`);
  const stableCells = evidence.T1?.previewStable?.cellInlineWidths || [];
  log(`T1 稳定态: cellInline=${raw(stableCells)}（全 null 即"构造期写不进去"的直接后果）`);
  if (evidence.T2?.ok) {
    log(`T2 手动 update(): 之前 cellInline=${raw(evidence.T2.before?.cellInlineWidths)} → 之后 cellInline=${raw(evidence.T2.after?.cellInlineWidths)} updateReturned=${evidence.T2.updateReturned}`);
  }
  log(`T3 补救路径: 重开=${raw(evidence.T3?.afterReopen?.cellInlineWidths)} edit→preview×1=${raw(evidence.T3?.afterEditPreviewOnce?.cellInlineWidths)} ×2=${raw(evidence.T3?.afterEditPreviewTwice?.cellInlineWidths)}`);
  log(`T4 时间维度: ${raw((evidence.T4 || []).map((x) => ({ ms: x.waitedMs, cells: x.cellInlineWidths?.[0] ?? null })))}`);
  log(`T5 行高稳定态: 逐行内联 height=${raw(evidence.T5?.previewStable?.rowCellInlineHeights)} 行 rect=${raw(evidence.T5?.previewStable?.rowRects)}`);
  log(`T5 手动 update() 后: 逐行内联 height=${raw(evidence.T5?.afterManualUpdate?.state?.rowCellInlineHeights)} 行 rect=${raw(evidence.T5?.afterManualUpdate?.state?.rowRects)}`);
  log(`T6 无尺寸对照组: tableInline=${raw(evidence.T6?.tableInlineWidth)} cellInline=${raw(evidence.T6?.cellInlineWidths)}`);

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
