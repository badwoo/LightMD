/**
 * LightMD v0.14.0 需求3+4 实机探针（打包产物 + WebView2 CDP）
 *
 * 需求3：左侧「最近打开」点时钟图标后面板不出来
 * 需求4：文件夹栏高度只有 7 个条目，要求 11 条 + 末尾留空一行
 *
 * 全部证据来自真实应用的 DOM / 布局，不做源码推断。分三个独立会话，
 * 每个会话用独立临时 profile（互不污染），结论落在 _verify-out/v0140-probe-recent.txt。
 *
 *   阶段1（干净态）：打开文件夹 + 点开 3 个文件 → 量需求4几何 → 点时钟(前/后/再收起)
 *   阶段2（侧栏溢出态）：开文件夹 + 开 15 个文件（temp 栏很高）→ 点时钟
 *                       → 面板是否被排到滚动视口之外（用户"窗口不出来"的最可能成因）
 *   阶段3（只有文件夹历史）：recentFiles=[] / recentFolders>=1 → 点时钟
 *                       → 检验 `showRecent && recentFiles.length > 0` 渲染条件是否把栏整条挡掉
 *
 * 用法：node scripts/v0140-probe-recent.mjs
 * 环境变量：V0140R_PORT（默认 9295）
 * 输出：_verify-out/v0140-probe-recent.txt（+ 截图 v0140r-*.png）
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140R_PORT || 9295);
const CDP = `http://127.0.0.1:${PORT}`;
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-probe-recent.txt";
const SHOTS = "D:\\AI\\markdown view\\_verify-out";

const lines = [];
const log = (s = "") => {
  console.log(s);
  lines.push(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const indent = (obj) => JSON.stringify(obj, null, 2).replace(/\n/g, "\n  ");

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
        send(method, params, timeoutMs = 30000) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method, params }));
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs);
            pending.set(i, {
              resolve: (v) => {
                clearTimeout(t);
                res(v);
              },
            });
          });
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
  });
}

/** 找到 Tauri 页面目标并连上（重载后调用可重新拿一个新连接） */
async function attach() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        let c = null;
        try {
          c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", {
            expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`,
            returnByValue: true,
          }, 15000);
          if (r.result?.result?.value === true) {
            await c.send("Page.enable");
            return c;
          }
          c.close();
        } catch {
          try { c?.close(); } catch {}
        }
      }
    } catch {}
    await sleep(400);
  }
  throw new Error("连不上 CDP / 找不到 Tauri 页面");
}

/** 一个会话：独立 profile、独立进程、可重载后重连 */
async function openSession(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0140r-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const workDir = path.join(tmp, "工作区");
  fs.mkdirSync(workDir, { recursive: true });
  for (let i = 1; i <= 20; i++) {
    fs.writeFileSync(
      path.join(workDir, `笔记-${String(i).padStart(2, "0")}.md`),
      `# 笔记 ${i}\n\n第 ${i} 篇内容。\n`,
      "utf-8",
    );
  }
  log(`── 会话「${label}」 ──`);
  log(`   临时工作区：${workDir}`);
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });
  let cdp = await attach();
  const session = {
    child,
    get cdp() { return cdp; },
    async ev(body) {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await cdp.send("Runtime.evaluate", {
            expression: `(() => { ${body} })()`,
            returnByValue: true,
            awaitPromise: true,
          }, 40000);
          if (r.result?.exceptionDetails) {
            throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
          }
          return r.result?.result?.value;
        } catch (e) {
          lastErr = e;
          // 目标可能因重载/崩溃被换掉 → 重连后再试
          try { cdp.close(); } catch {}
          try { cdp = await attach(); } catch {}
          await sleep(600);
        }
      }
      throw lastErr;
    },
    async clickXY(x, y, wait = 700) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
      await sleep(wait);
    },
    async reload(wait = 6500) {
      try { await cdp.send("Page.reload", { ignoreCache: false }); } catch {}
      await sleep(wait);
      try { cdp.close(); } catch {}
      cdp = await attach();
      await sleep(800);
    },
    async shot(name) {
      try {
        const r = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64"));
      } catch {}
    },
    async close() {
      try { cdp.close(); } catch {}
      try { child.kill(); } catch {}
      try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
      await sleep(900);
    },
    workDir,
  };
  await sleep(2600); // 等启动恢复流程走完
  return session;
}

// ─── 公共测量 ──────────────────────────────────────────────
const fileStore = (ev) =>
  ev(`
    const raw = localStorage.getItem("lightmd-file-store");
    if (!raw) return { raw: null, recentFiles: [], recentFolders: [] };
    let s = null;
    try { s = JSON.parse(raw).state || {}; } catch (e) { return { parseError: String(e), recentFiles: [], recentFolders: [] }; }
    return {
      rawLen: raw.length,
      recentFiles: (s.recentFiles || []).map(f => ({ path: f.path, name: f.name })),
      recentFolders: (s.recentFolders || []).map(f => ({ path: f.path, name: f.name })),
      sessionFolders: s.sessionFolders || null,
    };
  `);

const measureFolder = (ev) =>
  ev(`
    const sec = document.querySelector(".filetree-folder-section");
    if (!sec) return null;
    const header = sec.querySelector(".filetree-root-path");
    const content = sec.querySelector(".filetree-folder-content");
    const nodeEls = [...(content ? content.querySelectorAll(".filetree-node") : [])];
    const cs = content ? getComputedStyle(content) : null;
    const contentH = content ? content.clientHeight : 0;
    const rowH = nodeEls.length ? nodeEls[0].getBoundingClientRect().height : 0;
    const top = content ? content.getBoundingClientRect().top : 0;
    let fullyVisible = 0;
    for (const n of nodeEls) {
      const r = n.getBoundingClientRect();
      if (r.bottom <= top + contentH + 0.5) fullyVisible++;
    }
    return {
      sectionH: +sec.getBoundingClientRect().height.toFixed(2),
      sectionInlineH: sec.style.height || null,
      headerH: header ? +header.getBoundingClientRect().height.toFixed(2) : null,
      headerPadTop: header ? getComputedStyle(header).paddingTop : null,
      headerPadBottom: header ? getComputedStyle(header).paddingBottom : null,
      headerFontSize: header ? getComputedStyle(header).fontSize : null,
      headerLineHeight: header ? getComputedStyle(header).lineHeight : null,
      contentClientH: contentH,
      contentScrollH: content ? content.scrollHeight : null,
      contentPaddingTop: cs ? cs.paddingTop : null,
      contentPaddingBottom: cs ? cs.paddingBottom : null,
      nodeCount: nodeEls.length,
      rowH: +rowH.toFixed(2),
      fullyVisibleRows: fullyVisible,
      emptySpaceBelowRows: +(contentH - nodeEls.length * rowH).toFixed(2),
      sidebarScrollClientH: document.querySelector(".filetree-scroll")?.clientHeight ?? null,
    };
  `);

const measureRecent = (ev) =>
  ev(`
    const panel = document.querySelector(".recent-files");
    const list = document.querySelector(".recent-files-list");
    const items = list ? [...list.querySelectorAll(".recent-file-item")] : [];
    const clock = document.querySelector('.filetree-btn[title="最近打开"]');
    const sc = document.querySelector(".filetree-scroll");
    const scr = sc ? sc.getBoundingClientRect() : null;
    const pr = panel ? panel.getBoundingClientRect() : null;
    return {
      panelExists: !!panel,
      panelRect: pr ? { h: +pr.height.toFixed(2), w: +pr.width.toFixed(2), top: +pr.top.toFixed(2), bottom: +pr.bottom.toFixed(2) } : null,
      panelInlineHeight: panel ? (panel.style.height || null) : null,
      panelDisplay: panel ? getComputedStyle(panel).display : null,
      wrapClass: panel && panel.parentElement ? panel.parentElement.className : null,
      wrapRectH: panel && panel.parentElement ? +panel.parentElement.getBoundingClientRect().height.toFixed(2) : null,
      listClientH: list ? list.clientHeight : null,
      listScrollH: list ? list.scrollHeight : null,
      itemCount: items.length,
      itemNames: items.slice(0, 4).map(n => (n.querySelector(".filetree-name")?.textContent || "").trim()),
      clockExists: !!clock,
      clockActive: clock ? clock.className.includes("active") : null,
      scrollTop: sc ? sc.scrollTop : null,
      scrollClientH: sc ? sc.clientHeight : null,
      scrollScrollH: sc ? sc.scrollHeight : null,
      scrollViewportTop: scr ? +scr.top.toFixed(1) : null,
      scrollViewportBottom: scr ? +scr.bottom.toFixed(1) : null,
      // 面板在**滚动容器视口**内可见（这才是用户"看得见"的判据）
      panelInScrollViewport: !!(pr && scr) ? (pr.bottom > scr.top + 1 && pr.top < scr.bottom - 1) : false,
      panelFullyBelowViewport: !!(pr && scr) ? pr.top >= scr.bottom - 1 : false,
      panelFullyVisible: !!(pr && scr) ? (pr.top >= scr.top - 1 && pr.bottom <= scr.bottom + 1) : false,
      viewportInViewport: pr ? (pr.height > 0 && pr.top >= -1 && pr.top < window.innerHeight) : false,
    };
  `);

const sectionsLayout = (ev) =>
  ev(`
    const sc = document.querySelector(".filetree-scroll");
    const secs = [...document.querySelectorAll(".filetree-scroll [data-section-key]")].map(el => {
      const r = el.getBoundingClientRect();
      return { key: el.dataset.sectionKey, h: +r.height.toFixed(1), top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), inline: el.style.height || null };
    });
    return {
      sections: secs,
      scrollClientH: sc ? sc.clientHeight : null,
      scrollScrollH: sc ? sc.scrollHeight : null,
      scrollTop: sc ? sc.scrollTop : null,
    };
  `);

const clockPos = (ev) =>
  ev(`
    const b = document.querySelector('.filetree-btn[title="最近打开"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const hit = document.elementFromPoint(cx, cy);
    return { x: cx, y: cy, w: r.width, h: r.height, active: b.className.includes("active"), hitIsBtn: hit === b || (b && hit ? b.contains(hit) : false) };
  `);

const openFolder = async (S, dir) => {
  await S.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFolder",{detail:{path:${JSON.stringify(dir)}}})); return 1;`);
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    if (await S.ev(`return !!document.querySelector(".filetree-folder-section .filetree-node");`)) return true;
  }
  return false;
};

const openPaths = async (S, paths, gap = 650) => {
  for (const p of paths) {
    await S.ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(p)}}})); return 1;`);
    await sleep(gap);
  }
};

/** 点文件夹树里第 1 个文件（真实用户主路径：handleSelectFile → addRecentFile） */
const clickFirstTreeNode = async (S) => {
  const n = await S.ev(`
    const n = document.querySelector(".filetree-folder-section .filetree-node");
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return {x: r.left + r.width/2, y: r.top + r.height/2, name: (n.querySelector(".filetree-name")?.textContent||"").trim()};
  `);
  if (n) await S.clickXY(n.x, n.y, 1800);
  return n;
};

async function phase1_clean() {
  log("");
  log("═══ 阶段1：干净态（开文件夹 + 点开 3 个文件）═══");
  const S = await openSession("clean");
  try {
    const store0 = await fileStore(S.ev);
    log(`  A0 启动后 localStorage：recentFiles=${store0.recentFiles?.length ?? 0} / recentFolders=${store0.recentFolders?.length ?? 0}`);

    log(`  打开文件夹 → ${await openFolder(S, S.workDir)}`);
    const clicked = await clickFirstTreeNode(S);
    log(`  点击文件树节点：${clicked ? clicked.name : "未找到"}`);
    await openPaths(S, [
      path.join(S.workDir, "笔记-05.md"),
      path.join(S.workDir, "笔记-09.md"),
    ]);
    const store1 = await fileStore(S.ev);
    log(`  A1 打开后 localStorage：recentFiles=${store1.recentFiles?.length ?? 0}（${JSON.stringify((store1.recentFiles || []).slice(0, 3).map(f => f.name))}）/ recentFolders=${store1.recentFolders?.length ?? 0}`);

    // ── 需求4 几何 ──
    const geo = await measureFolder(S.ev);
    log("");
    log("  B. 需求4：文件夹栏几何（本机实测）");
    log("  " + indent(geo));
    await S.shot("v0140r-req4-before");

    // ── 需求3 ──
    log("");
    log("  C. 需求3：点「最近打开」时钟");
    const clock = await clockPos(S.ev);
    log(`   时钟按钮：${JSON.stringify(clock)}`);
    const before = await measureRecent(S.ev);
    log(`   点前：panelExists=${before.panelExists} clockActive=${before.clockActive}`);
    await S.shot("v0140r-req3-before-click");
    await S.clickXY(clock.x, clock.y, 2000);
    const after = await measureRecent(S.ev);
    log("   点后：" + indent({
      panelExists: after.panelExists, panelRect: after.panelRect, panelInlineHeight: after.panelInlineHeight,
      itemCount: after.itemCount, itemNames: after.itemNames, listClientH: after.listClientH,
      clockActive: after.clockActive, panelInScrollViewport: after.panelInScrollViewport,
    }));
    const layout = await sectionsLayout(S.ev);
    log("   布局：" + indent(layout));
    await S.shot("v0140r-req3-after-click");
    await S.clickXY(clock.x, clock.y, 2000);
    const collapsed = await measureRecent(S.ev);
    log(`   再点一次（收起）：panelExists=${collapsed.panelExists} clockActive=${collapsed.clockActive}`);
    await S.shot("v0140r-req3-after-second-click");

    return { geo, store1, before, after, collapsed, layout };
  } finally {
    await S.close();
  }
}

async function phase2_overflow() {
  log("");
  log("═══ 阶段2：侧栏溢出态（开文件夹 + 打开 15 个文件 → temp 栏很高）═══");
  const S = await openSession("overflow");
  try {
    log(`  打开文件夹 → ${await openFolder(S, S.workDir)}`);
    const files = Array.from({ length: 15 }, (_, i) => path.join(S.workDir, `笔记-${String(i + 1).padStart(2, "0")}.md`));
    log(`  依次打开 ${files.length} 个文件…`);
    await openPaths(S, files, 600);
    await sleep(1500);
    const store = await fileStore(S.ev);
    const tabCount = await S.ev(`return document.querySelectorAll(".tab-item").length;`);
    log(`  已开标签数 = ${tabCount}；recentFiles = ${store.recentFiles?.length ?? 0} / recentFolders = ${store.recentFolders?.length ?? 0}`);

    const before = await sectionsLayout(S.ev);
    log("  F0 点前布局：" + indent(before));
    const clock = await clockPos(S.ev);
    log(`  时钟按钮：${JSON.stringify(clock)}`);
    const beforePanel = await measureRecent(S.ev);
    log(`  点前：panelExists=${beforePanel.panelExists} clockActive=${beforePanel.clockActive}`);
    await S.clickXY(clock.x, clock.y, 2600);
    const after = await measureRecent(S.ev);
    const layout = await sectionsLayout(S.ev);
    log("  F1 点后布局：" + indent(layout));
    log("  F1 点后面板：" + indent({
      panelExists: after.panelExists, panelRect: after.panelRect, panelInlineHeight: after.panelInlineHeight,
      itemCount: after.itemCount, listClientH: after.listClientH, clockActive: after.clockActive,
      scrollTop: after.scrollTop, scrollClientH: after.scrollClientH, scrollScrollH: after.scrollScrollH,
      scrollViewportTop: after.scrollViewportTop, scrollViewportBottom: after.scrollViewportBottom,
      panelInScrollViewport: after.panelInScrollViewport,
      panelFullyBelowViewport: after.panelFullyBelowViewport,
      panelFullyVisible: after.panelFullyVisible,
    }));
    await S.shot("v0140r-req3-overflow");
    return { store, tabCount, before, after, layout };
  } finally {
    await S.close();
  }
}

async function phase3_folderOnly() {
  log("");
  log("═══ 阶段3：只有文件夹历史（recentFiles=[] / recentFolders>=1）═══");
  const S = await openSession("folderOnly");
  try {
    // 注入：recentFiles 清空、recentFolders 留一条、关闭启动恢复上次文件
    // （否则启动恢复会通过 openFile 再次 addRecentFile，变量不纯）
    const seed = await S.ev(`
      const storeRaw = localStorage.getItem("lightmd-file-store");
      const store = storeRaw ? JSON.parse(storeRaw) : { state: {}, version: 0 };
      store.state = store.state || {};
      store.state.recentFiles = [];
      store.state.recentFolders = [{ path: ${JSON.stringify(S.workDir)}, name: "工作区", accessedAt: Date.now() }];
      store.state.sessionFolders = [];
      localStorage.setItem("lightmd-file-store", JSON.stringify(store));
      const settingsRaw = localStorage.getItem("lightmd-settings");
      const settings = settingsRaw ? JSON.parse(settingsRaw) : { state: {}, version: 0 };
      settings.state = settings.state || {};
      settings.state.loadLastFileOnStartup = false;
      settings.state.loadLastFolderOnStartup = false;
      delete settings.state.sidebarSectionSizes;
      localStorage.setItem("lightmd-settings", JSON.stringify(settings));
      localStorage.removeItem("lightmd-open-file-tabs");
      return { recentFiles: store.state.recentFiles.length, recentFolders: store.state.recentFolders.length, loadLastFileOnStartup: settings.state.loadLastFileOnStartup };
    `);
    log(`  G0 注入：${JSON.stringify(seed)}`);
    await S.reload(7000);
    const store = await fileStore(S.ev);
    log(`  G1 重载后 localStorage：recentFiles=${store.recentFiles?.length ?? 0} / recentFolders=${store.recentFolders?.length ?? 0}`);
    const tabCount = await S.ev(`return document.querySelectorAll(".tab-item").length;`);
    log(`  G1 标签数 = ${tabCount}（应为 0：没有文件被打开）`);

    // 打开一次文件夹（走真实路径：addRecentFolder 头插，recentFiles 仍为空）
    log(`  打开发文件夹 → ${await openFolder(S, S.workDir)}`);
    await sleep(1000);
    const store2 = await fileStore(S.ev);
    log(`  G2 开文件夹后：recentFiles=${store2.recentFiles?.length ?? 0} / recentFolders=${store2.recentFolders?.length ?? 0}`);

    const clock = await clockPos(S.ev);
    log(`  时钟按钮：${JSON.stringify(clock)}`);
    const before = await measureRecent(S.ev);
    await S.clickXY(clock.x, clock.y, 2200);
    const after = await measureRecent(S.ev);
    const layout = await sectionsLayout(S.ev);
    log("  G3 点后面板：" + indent({
      panelExists: after.panelExists, panelRect: after.panelRect, clockActive: after.clockActive,
      itemCount: after.itemCount, itemNames: after.itemNames,
      panelInScrollViewport: after.panelInScrollViewport,
    }));
    log("  G3 布局：" + indent(layout));
    await S.shot("v0140r-req3-folder-only");
    return { store2, before, after, layout };
  } finally {
    await S.close();
  }
}

const main = async () => {
  if (!fs.existsSync(EXE)) {
    console.error("缺少打包产物：" + EXE);
    process.exit(3);
  }
  log(`时间：${new Date().toISOString()}`);
  log(`打包产物：${EXE}`);
  log(`产物 mtime：${fs.statSync(EXE).mtime.toISOString()}`);

  const p1 = await phase1_clean();
  const p2 = await phase2_overflow();
  const p3 = await phase3_folderOnly();

  // ─── 汇总判定 ───
  log("");
  log("═══════════════ 汇总判定 ═══════════════");
  const headerH = p1.geo?.headerH ?? 0;
  const rowH = p1.geo?.rowH ?? 0;
  log("");
  log("【需求4】文件夹栏高度");
  log(`  实测：标题栏 .filetree-root-path = ${headerH}px（padding 6px 上下 + font-size 11px）`);
  log(`  实测：条目行高 .filetree-node = ${rowH}px（SIDEBAR_ITEM_HEIGHT）`);
  log(`  当前 section 高 = ${p1.geo?.sectionH}px → 内容区 ${p1.geo?.contentClientH}px → 完整可视条目 = ${p1.geo?.fullyVisibleRows} 条（旧产物 250px 时是 7 条，与用户反馈吻合）`);
  const expected = headerH + 12 * rowH;
  log(`  目标 = 标题栏 + (11 可见 + 1 留空) × 行高 = ${headerH} + 12×${rowH} = ${expected}px`);
  // 判定口径（用户诉求的精确形式）：
  //  ① section 高 == 标题栏 + 12 行（不多不少，避免"能显示 20 条"变成另一种偏差）
  //  ② 可视区恰好能容纳 ≥11 条完整条目（11 个内容是底线）
  //  ③ 内容区末尾剩出的空白 ≥ 1 个行高（即"最后一个条目位留空"，可直接右键）
  const req4ok =
    Math.abs((p1.geo?.sectionH ?? 0) - expected) <= 1 &&
    (p1.geo?.fullyVisibleRows ?? 0) >= 11 &&
    (p1.geo?.contentClientH ?? 0) - 11 * rowH >= rowH - 1;
  log(`  ①section 高 == ${expected}px：${Math.abs((p1.geo?.sectionH ?? 0) - expected) <= 1 ? "✓" : "✗"}（实测 ${p1.geo?.sectionH}）`);
  log(`  ②可视完整条目 ≥ 11：${(p1.geo?.fullyVisibleRows ?? 0) >= 11 ? "✓" : "✗"}（实测 ${p1.geo?.fullyVisibleRows}）`);
  log(`  ③末尾留白 ≥ 1 行(${rowH}px)：${(p1.geo?.contentClientH ?? 0) - 11 * rowH >= rowH - 1 ? "✓" : "✗"}（内容区 ${p1.geo?.contentClientH} - 11×${rowH} = ${+((p1.geo?.contentClientH ?? 0) - 11 * rowH).toFixed(1)}px）`);
  log(`  ⇒ ${req4ok ? "PASS" : "FAIL"}`);

  log("");
  log("【需求3】最近打开面板");
  log(`  阶段1 干净态：点前存在=${p1.before.panelExists} → 点后存在=${p1.after.panelExists} 高度=${p1.after.panelRect?.h ?? "null"} 条目=${p1.after.itemCount} 在滚动视口内=${p1.after.panelInScrollViewport}`);
  log(`  阶段2 溢出态：开 ${p2.tabCount} 个标签；点后存在=${p2.after.panelExists} 高度=${p2.after.panelRect?.h ?? "null"} top=${p2.after.panelRect?.top ?? "null"} / 视口 ${p2.after.scrollViewportTop}..${p2.after.scrollViewportBottom}；完全在视口下方=${p2.after.panelFullyBelowViewport}；在视口内=${p2.after.panelInScrollViewport}`);
  log(`  阶段3 只有文件夹历史：recentFiles=${p3.store2?.recentFiles?.length ?? 0} / recentFolders=${p3.store2?.recentFolders?.length ?? 0}；点后存在=${p3.after.panelExists} clockActive=${p3.after.clockActive} 高度=${p3.after.panelRect?.h ?? "null"}`);

  const p2bug = p2.after.panelExists === true && p2.after.panelFullyBelowViewport === true;
  const p3bug = p3.after.clockActive === true && p3.after.panelExists === false;
  log("");
  log(`  ⇒ 溢出态"面板在视口外看不见"：${p2bug ? "**命中**" : "未命中"}`);
  log(`  ⇒ 只有文件夹历史时"时钟已激活但面板不渲染"：${p3bug ? "**命中（渲染条件过严）**" : "未命中"}`);

  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(OUT, ["LightMD v0.14.0 需求3+4 实机探针", ...lines, ""].join("\n"), "utf-8");
  console.log(`\n报告：${OUT}`);
  process.exit(0);
};

main().catch((e) => {
  console.error("探针异常：", e);
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(OUT, ["LightMD v0.14.0 需求3+4 实机探针（异常中断）", ...lines, String(e)].join("\n"), "utf-8");
  } catch {}
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  process.exit(2);
});
