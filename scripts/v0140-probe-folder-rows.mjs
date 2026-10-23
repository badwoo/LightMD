/**
 * LightMD v0.14.0 需求2 实机探针（打包产物 + WebView2 CDP）
 *
 * 用户原话（本轮口径修正）：「左侧栏还没实现我要求的打开文件夹然后点击打开一个文件，
 * 文件夹范围为11个文件条目即10个文件栏位+1条空白栏位的需求。」
 *
 * 口径：文件夹区总高 = 11 个条目位 = 10 个**文件栏位** + 1 个**空白栏位**。
 *   - 文件栏位：内容滚动区高 = 10 × SIDEBAR_ITEM_HEIGHT(30) = 300px（第 11 个文件行不得完整可见）
 *   - 空白栏位：列表下方**常驻** 30px 空白条（不随文件数变化，用户在这块空白处右键）
 *   - 合计内容区 = 330px；section 高 = 标题栏(实测 31.33/常量 32) + 330 ≈ 362px
 *
 * 必须取证的三件事：
 *   ① 打包产物里「打开文件夹 → 点击打开一个文件」后的真实几何（section 高、列表 clientHeight、
 *      完整可见文件行数、末尾空白高度、有无半行裁切）；
 *   ② 「点击打开一个文件」是否反过来改文件夹栏高度（temp/auto-fill effect 抢高度）；
 *   ③ 老用户持久化 `sidebarSectionSizes` 里残留的旧默认（250 / 392）是否被迁移清掉，
 *      同时用户明确拖大过的高度（> 旧默认）必须保留。
 *
 * 用法：node scripts/v0140-probe-folder-rows.mjs
 * 环境变量：V0140F_PORT（默认 9298）
 * 输出：_verify-out/v0140-probe-folder-rows.txt（+ 截图 v0140f-*.png）
 * 互斥：跑之前先抢 _verify-out/probe.lock（两个探针都会 taskkill lightmd.exe，必须串行）。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140F_PORT || 9298);
const CDP = `http://127.0.0.1:${PORT}`;
const VERIFY_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT = path.join(VERIFY_DIR, "v0140-probe-folder-rows.txt");
const LOCK = path.join(VERIFY_DIR, "probe.lock");

const lines = [];
const log = (s = "") => {
  console.log(s);
  lines.push(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const indent = (obj) => JSON.stringify(obj, null, 2).replace(/\n/g, "\n  ");

// ─── 探针互斥锁 ───────────────────────────────────────────
async function acquireLock(maxWaitMs = 6 * 60 * 1000) {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fh = await fs.promises.open(LOCK, "wx");
      await fh.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString(), script: "v0140-probe-folder-rows" }),
        "utf-8",
      );
      await fh.close();
      log(`已抢到探针互斥锁：${LOCK}`);
      return true;
    } catch {
      let stale = false;
      try {
        const st = fs.statSync(LOCK);
        stale = Date.now() - st.mtimeMs > 6 * 60 * 1000;
      } catch {}
      if (stale) {
        log("探针锁已陈旧（>6 分钟），删除后重试");
        try { fs.unlinkSync(LOCK); } catch {}
        continue;
      }
      if (Date.now() - started > maxWaitMs) {
        log(`等待探针锁超时（${maxWaitMs / 1000}s），放弃本次运行`);
        return false;
      }
      log("探针锁被占用，5s 后重试…");
      await sleep(5000);
    }
  }
}
function releaseLock() {
  // 只删自己抢到的锁：锁文件可能已被别的成员（Lead 的构建 / 另一个探针）接管，
  // 无条件 unlink 会破坏互斥。任何退出路径（正常结束、异常、Ctrl+C、kill）都要调到这里。
  try {
    const raw = fs.readFileSync(LOCK, "utf-8");
    const info = JSON.parse(raw);
    if (info && info.pid !== undefined && info.pid !== process.pid) return;
  } catch {
    // 锁不存在 / 内容非法 → 视为已被清理，无需处理
    return;
  }
  try { fs.unlinkSync(LOCK); } catch {}
}
// 任何退出路径都放锁：Ctrl+C / SIGTERM / 未捕获异常 / 正常结束
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"]) {
  process.on(sig, (e) => {
    if (e) log(`捕获 ${sig}：${e && e.stack ? e.stack : e}`);
    releaseLock();
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
    process.exit(sig === "uncaughtException" || sig === "unhandledRejection" ? 2 : 130);
  });
}
process.on("exit", () => releaseLock());

// ─── CDP ──────────────────────────────────────────────────
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

async function openSession(label, fileCount = 20) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0140f-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const workDir = path.join(tmp, "工作区");
  fs.mkdirSync(workDir, { recursive: true });
  for (let i = 1; i <= fileCount; i++) {
    fs.writeFileSync(
      path.join(workDir, `笔记-${String(i).padStart(2, "0")}.md`),
      `# 笔记 ${i}\n\n第 ${i} 篇内容。\n`,
      "utf-8",
    );
  }
  log(`── 会话「${label}」 ──`);
  log(`   临时工作区：${workDir}（${fileCount} 个 md）`);
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
          try { cdp.close(); } catch {}
          try { cdp = await attach(); } catch {}
          await sleep(600);
        }
      }
      throw lastErr;
    },
    async clickXY(x, y, wait = 800) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
      await sleep(wait);
    },
    async reload(wait = 7500) {
      try { await cdp.send("Page.reload", { ignoreCache: false }); } catch {}
      await sleep(wait);
      try { cdp.close(); } catch {}
      cdp = await attach();
      await sleep(900);
    },
    async shot(name) {
      try {
        const r = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.mkdirSync(VERIFY_DIR, { recursive: true });
        fs.writeFileSync(path.join(VERIFY_DIR, `${name}.png`), Buffer.from(r.result.data, "base64"));
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
  await sleep(2600);
  return session;
}

// ─── 测量 ─────────────────────────────────────────────────
/**
 * 文件夹栏几何。
 * 关键定义（与需求口径一一对应）：
 *   - 文件栏位高度 = `.filetree-folder-content` 的 clientHeight（滚动视口 = 能完整看到几行文件）
 *   - 空白栏位高度 = section 高 - 标题栏高 - 文件栏位高（列表下方留给右键的空白条）
 *   - 半行裁切 = 有文件行 top 在列表视口内、bottom 超出视口（>=1px 超出）
 */
const measureFolderBody = () => `
  const sec = document.querySelector(".filetree-folder-section");
  if (!sec) return { exists: false };
  const header = sec.querySelector(".filetree-root-path");
  const list = sec.querySelector(".filetree-folder-content");
  const secR = sec.getBoundingClientRect();
  const headerH = header ? +header.getBoundingClientRect().height.toFixed(2) : 0;
  const listH = list ? list.clientHeight : 0;
  const listR = list ? list.getBoundingClientRect() : null;
  const nodes = list ? [...list.querySelectorAll(".filetree-node")] : [];
  const rows = nodes.map((n) => {
    const r = n.getBoundingClientRect();
    // 在列表视口内的可见高度：用于判定"半行被裁"（只认 >2px 的可见残行；
    // 0.x px 的亚像素缝隙不构成半行，是 clientHeight 取整带来的）
    const visibleH = listR
      ? Math.max(0, Math.min(r.bottom, listR.bottom) - Math.max(r.top, listR.top))
      : 0;
    return {
      name: (n.querySelector ? (n.querySelector(".filetree-name")?.textContent || "") : "").trim(),
      top: +r.top.toFixed(2),
      bottom: +r.bottom.toFixed(2),
      h: +r.height.toFixed(2),
      visibleH: +visibleH.toFixed(2),
      fullyInList: listR ? (r.top >= listR.top - 0.5 && r.bottom <= listR.bottom + 0.5) : false,
      // 半行被裁 = 可见部分既不是 0 也明显不足一整行（>2px 且 < 行高-2px）
      partiallyClipped: !!listR && visibleH > 2 && visibleH < r.height - 2,
      startsAbove: listR ? r.top < listR.top - 0.5 : false,
    };
  });
  const fullyVisible = rows.filter((r) => r.fullyInList).length;
  // 真·半行 = 可见部分 >2px 且 < 行高-2px；亚像素残行（<1px）单独记录，避免误判
  const clipped = rows.filter((r) => r.partiallyClipped).length;
  const slivers = rows.filter((r) => listR && r.visibleH > 0.05 && r.visibleH <= 2);
  const rowH = rows.length ? +rows[0].h.toFixed(2) : 0;
  // 紧挨"最后一个完整可见行"的下一行（默认高度下就是第 11 个文件行）露出多少
  const nextRow = rows.find((r) => !r.fullyInList && (r.visibleH > 0.05 || (listR && r.top < listR.bottom)));
  // 列表视口底边再往上 0.4px 命中的元素：确认那条亚像素缝里到底是谁
  const stripeEl = listR
    ? document.elementFromPoint(listR.left + listR.width / 2, listR.bottom - 0.4)
    : null;
  // 文件栏位（滚动视口）能完整容纳几行
  const rowsFit = rowH > 0 ? +(listH / rowH).toFixed(3) : 0;
  const blankStripH = +(secR.height - headerH - listH).toFixed(2);
  return {
    exists: true,
    sectionH: +secR.height.toFixed(2),
    sectionInline: sec.style.height || null,
    sectionClass: sec.className,
    headerH,
    listClientH: listH,
    listScrollH: list ? list.scrollHeight : null,
    listOverflowY: list ? getComputedStyle(list).overflowY : null,
    listPaddingBottom: list ? getComputedStyle(list).paddingBottom : null,
    rowH,
    nodeCount: rows.length,
    fullyVisible,
    partiallyClipped: clipped,
    subPixelSliver: slivers.length,
    nextRowName: nextRow ? nextRow.name : null,
    nextRowVisibleH: nextRow ? nextRow.visibleH : null,
    listBoxH: listR ? +listR.height.toFixed(3) : null,
    bottomStripeHit: stripeEl ? (typeof stripeEl.className === "string" ? stripeEl.className : stripeEl.tagName) : null,
    rowsFit,
    blankStripH,
    // 空白栏位内可命中的元素（用户要在这块右键）
    blankHitClass: (() => {
      const y = secR.bottom - Math.min(15, Math.max(1, blankStripH / 2));
      const x = secR.left + secR.width / 2;
      const el = document.elementFromPoint(x, y);
      return el ? (el.className && typeof el.className === "string" ? el.className : el.tagName) : null;
    })(),
    blankPoint: { x: secR.left + secR.width / 2, y: secR.bottom - Math.min(15, Math.max(1, blankStripH / 2)) },
    firstRowTop: rows.length ? rows[0].top : null,
    lastRowBottom: rows.length ? rows[rows.length - 1].bottom : null,
    listTop: listR ? +listR.top.toFixed(2) : null,
    listBottom: listR ? +listR.bottom.toFixed(2) : null,
    secBottom: +secR.bottom.toFixed(2),
    sampleRowNames: rows.slice(0, 12).map((r) => r.name),
    scrollTop: list ? list.scrollTop : null,
  };
`;

// measureFolderBody 是「返回代码字符串」的箭头函数，不是函数体本身 → 必须调用它
const folderGeometry = (S) => S.ev(measureFolderBody());

/**
 * 在空白栏位里右键，看空区菜单是否出来（用户在空白处右键是明确需求）。
 * 必须分两步：React 对 discrete event 的 state 更新在事件派发返回后才 flush，
 * 同步紧接着查 DOM 会查不到菜单（第一版就栽在这里，误报 ok:false）。
 */
async function blankRightClick(S) {
  const target = await S.ev(`
    const sec = document.querySelector(".filetree-folder-section");
    if (!sec) return { ok: false, reason: "no section" };
    const r = sec.getBoundingClientRect();
    const list = sec.querySelector(".filetree-folder-content");
    const listR = list.getBoundingClientRect();
    const y = Math.min(r.bottom - 4, listR.bottom + 15);
    const x = r.left + r.width / 2;
    const el = document.elementFromPoint(x, y);
    if (!el) return { ok: false, reason: "elementFromPoint null" };
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
    return { hitTarget: typeof el.className === "string" ? el.className : el.tagName, x: +x.toFixed(1), y: +y.toFixed(1) };
  `);
  await sleep(400);
  const menu = await S.ev(`
    const menu = document.querySelector(".filetree-context-menu");
    const items = menu ? [...menu.querySelectorAll("button, .context-menu-item")].map(b => (b.textContent || "").trim()) : [];
    // 关掉菜单（全局监听在 window / body 上）
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return { ok: !!menu, items };
  `);
  return { ...target, ...menu };
}

const openFolder = async (S, dir) => {
  await S.ev(`window.dispatchEvent(new CustomEvent("lightmd:openFolder",{detail:{path:${JSON.stringify(dir)}}})); return 1;`);
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    if (await S.ev(`return !!document.querySelector(".filetree-folder-section .filetree-node");`)) return true;
  }
  return false;
};

/** 点文件夹树里的第 1 个文件（用户原话的主路径：打开文件夹后点击打开一个文件） */
const clickFirstTreeNode = async (S) => {
  const n = await S.ev(`
    const n = document.querySelector(".filetree-folder-section .filetree-node");
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, name: (n.querySelector(".filetree-name")?.textContent || "").trim() };
  `);
  if (n) await S.clickXY(n.x, n.y, 1600);
  return n;
};

// ─── 会话 A：真实路径几何（打开文件夹 → 点击打开一个文件） ──
async function phaseGeometry() {
  log("");
  log("═══ 会话 A：打开文件夹 → 点击打开一个文件 → 量文件夹栏几何 ═══");
  const S = await openSession("geometry", 20);
  try {
    log(`  打开文件夹（20 个文件）→ ${await openFolder(S, S.workDir)}`);
    await sleep(1200);
    const before = await folderGeometry(S);
    log("  [点文件前] " + indent(before));

    const clicked = await clickFirstTreeNode(S);
    log(`  点击文件树节点：${clicked ? clicked.name : "未找到"}`);
    await sleep(900);
    const after = await folderGeometry(S);
    log("  [点文件后 900ms] " + indent(after));
    await sleep(1500);
    const settled = await folderGeometry(S);
    log("  [点文件后 2.4s] " + indent(settled));
    await S.shot("v0140f-geometry");

    // 空白栏位右键
    const ctx = await blankRightClick(S);
    log("  [空白栏位右键] " + JSON.stringify(ctx));
    await S.shot("v0140f-blank-context");

    // 亚像素取证：把「列表视口底边（第 10 行末尾 / 第 11 行起点）」放大 8 倍截图。
    // header 实测 31.33px 不是 32 → section 362 时滚动区实际 300.67px，第 11 行会露出 0.67px；
    // 这张图用来判断那条亚像素缝肉眼是否可见（.filetree-node 本身无边框/无背景 → 预期不可见）。
    const boundary = await S.ev(`
      const sec = document.querySelector(".filetree-folder-section");
      const list = sec.querySelector(".filetree-folder-content");
      const r = list.getBoundingClientRect();
      const rows = [...list.querySelectorAll(".filetree-node")];
      const r11 = rows[10];
      const clip = (el) => {
        const b = el.getBoundingClientRect();
        return { top: +b.top.toFixed(3), bottom: +b.bottom.toFixed(3), h: +b.height.toFixed(3) };
      };
      const vis = r11 ? +Math.max(0, Math.min(r11.getBoundingClientRect().bottom, r.bottom) - Math.max(r11.getBoundingClientRect().top, r.top)).toFixed(3) : null;
      const cs = getComputedStyle(r11 || list);
      return {
        clip: { x: r.left, y: r.bottom - 8, width: r.width, height: 16, scale: 8 },
        listBoxH: +r.height.toFixed(3),
        row10: rows[9] ? clip(rows[9]) : null,
        row11: r11 ? clip(r11) : null,
        row11VisibleH: vis,
        row11Background: cs.backgroundColor,
        row11BorderTop: cs.borderTopWidth,
      };
    `);
    log("  [亚像素边界] " + JSON.stringify(boundary));
    try {
      const shot = await S.cdp.send("Page.captureScreenshot", { format: "png", clip: boundary.clip });
      fs.writeFileSync(path.join(VERIFY_DIR, "v0140f-folder-bottom-zoom.png"), Buffer.from(shot.result.data, "base64"));
      log("  已存放大截图：_verify-out/v0140f-folder-bottom-zoom.png（8x）");
    } catch (e) {
      log(`  放大截图失败：${String(e).slice(0, 200)}`);
    }

    return { before, after, settled, ctx, boundary };
  } finally {
    await S.close();
  }
}

// ─── 会话 B：老用户持久化迁移（旧默认 250/392 必须清，用户拖大的保留） ──
async function phaseMigration() {
  log("");
  log("═══ 会话 B：老用户持久化 sidebarSectionSizes 迁移 ═══");
  const S = await openSession("migration", 5);
  try {
    const seed = await S.ev(`
      const wdPath = ${JSON.stringify(S.workDir)};
      const sraw = localStorage.getItem("lightmd-settings");
      const st = sraw ? JSON.parse(sraw) : { state: {}, version: 0 };
      st.state = st.state || {};
      st.state.sidebarSectionSizes = {
        ["folder:" + wdPath]: 392,   // 上一版的"新默认"被拖拽时顺带持久化 → 旧默认，须清
        ["folder:C:\\\\ws-old"]: 250, // 更早的旧默认 → 须清
        ["folder:C:\\\\ws-custom"]: 300, // 用户自己拖过的 → 必须保留
        ["folder:C:\\\\ws-big"]: 620, // 用户明确拖大过 → 必须保留
        temp: 480,
      };
      st.state.loadLastFileOnStartup = false;
      st.state.loadLastFolderOnStartup = false;
      st.version = 5; // 升级前版本（本次迁移应升到 6）
      localStorage.setItem("lightmd-settings", JSON.stringify(st));
      return { seededVersion: st.version, sizes: st.state.sidebarSectionSizes };
    `);
    log(`  种入持久化（version=5）：${JSON.stringify(seed)}`);
    await S.reload(7500);

    // 迁移后读回 localStorage（FileTree 挂载 250ms 后会持久化一次，落库即迁移结果）
    await sleep(1200);
    const back = await S.ev(`
      const raw = localStorage.getItem("lightmd-settings");
      const st = raw ? JSON.parse(raw) : null;
      return { version: st ? st.version : null, sizes: st && st.state ? st.state.sidebarSectionSizes : null };
    `);
    log(`  重载后 localStorage：${JSON.stringify(back)}`);

    // 真实高度：folder 键被清 → 落到新默认。
    // 注意「只开一个文件夹」时它独占侧栏、会被 v0.8.2 的"末栏自动撑满到底部"撑高，
    // 那不是默认值口径；必须再点开一个文件让 temp 栏出现，folder 才回落到默认高度。
    log(`  打开文件夹 → ${await openFolder(S, S.workDir)}`);
    await sleep(1200);
    const geoAlone = await folderGeometry(S);
    log(`  [独栏] section 高 = ${geoAlone.sectionH}（末栏自动撑满，非默认值口径，仅 INFO）`);
    await S.ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(path.join(S.workDir, "笔记-01.md"))}}})); return 1;`);
    await sleep(1800);
    const geo = await folderGeometry(S);
    log(`  打开一个文件后 section 高 = ${geo.sectionH}（inline=${geo.sectionInline}，应为 362 = 迁移生效）`);
    await S.shot("v0140f-migration");
    return { seed, back, geo, geoAlone };
  } finally {
    await S.close();
  }
}

// ─── 主流程 ────────────────────────────────────────────────
const main = async () => {
  if (!fs.existsSync(EXE)) {
    console.error("缺少打包产物：" + EXE);
    process.exit(3);
  }
  const got = await acquireLock();
  if (!got) process.exit(4);
  let ok = false;
  try {
    log(`时间：${new Date().toISOString()}`);
    log(`打包产物：${EXE}`);
    log(`产物 mtime：${fs.statSync(EXE).mtime.toISOString()}`);

    const a = await phaseGeometry();
    const b = await phaseMigration();

    // ─── 判定 ───
    log("");
    log("═══════════════ 汇总判定（需求2：11 条目位 = 10 文件栏位 + 1 空白栏位）═══════════════");
    const g = a.settled;
    const rowH = g.rowH || 30;
    const headerH = g.headerH || 0;
    const expectedSection = +(headerH + 11 * rowH).toFixed(1); // header + 11 条目位
    log(`  标题栏实测 ${headerH}px / 行高 ${rowH}px → 目标 section 高 ≈ ${expectedSection}px（常量口径 32 + 11×30 = 362）`);
    log(`  实测 section 高 = ${g.sectionH}px；文件栏位（列表视口）= ${g.listClientH}px（可容 ${g.rowsFit} 行）；空白栏位 = ${g.blankStripH}px`);
    log(`  完整可见文件行 = ${g.fullyVisible}（目标 10）；真·半行裁切 = ${g.partiallyClipped}（目标 0）；节点总数 = ${g.nodeCount}`);
    log(
      `  亚像素残行：第 11 行露出 ${a.boundary?.row11VisibleH ?? "?"}px（列表盒高 ${g.listBoxH}px，第 11 行背景=${a.boundary?.row11Background ?? "?"}，border-top=${a.boundary?.row11BorderTop ?? "?"}）；` +
      `视口底边命中元素=${g.bottomStripeHit}`,
    );
    log(`  「点击打开一个文件」前后 section 高：${a.before.sectionH}（独占侧栏自动撑满）→ ${a.after.sectionH} → ${a.settled.sectionH}（应稳定在 362）`);

    const checks = {
      sectionHeight: Math.abs(g.sectionH - 362) <= 1,
      fileSlots10: g.fullyVisible === 10,
      noPartialRow: g.partiallyClipped === 0,
      blankSlot: g.blankStripH >= 29 && g.blankStripH <= 31,
      listIs10Rows: Math.abs(g.rowsFit - 10) <= 0.05,
      blankRightClick: a.ctx?.ok === true,
      // 「打开文件夹 → 点开一个文件」后不再有后续高度漂移：
      // 注意点开前 folder 是**独占侧栏**的状态（v0.8.2 自动撑满到底部），高度不等于终态，
      // 点开文件后 temp 栏出现、folder 才回到默认 362 —— 所以只能断言"点后稳定"，
      // 不能断言"点前 = 点后"。
      stableAfterClick: Math.abs(a.after.sectionH - a.settled.sectionH) <= 1,
    };
    // 迁移明细（键名不好在 Node 侧拼，按"值 + 路径片段"逐条判）
    const sizes = b.back?.sizes || {};
    const keys = Object.keys(sizes);
    const oldKey = keys.find((k) => k.endsWith("工作区") && sizes[k] === 392);
    const old250 = Object.entries(sizes).find(([k, v]) => k.includes("ws-old") && v === 250);
    const custom300 = Object.entries(sizes).find(([k, v]) => k.includes("ws-custom") && v === 300);
    const big620 = Object.entries(sizes).find(([k, v]) => k.includes("ws-big") && v === 620);
    const migrateChecks = {
      version6: b.back?.version === 6,
      cleared392: !oldKey,
      cleared250: !old250,
      keptCustom300: !!custom300,
      keptBig620: !!big620,
      folderHeightAfterMigration: Math.abs((b.geo?.sectionH ?? 0) - 362) <= 1,
    };
    log("");
    log("  判定明细：");
    for (const [k, v] of Object.entries(checks)) log(`    ${k}: ${v ? "✓" : "✗"}`);
    for (const [k, v] of Object.entries(migrateChecks)) log(`    ${k}: ${v ? "✓" : "✗"}`);
    ok = Object.values(checks).every(Boolean) && Object.values(migrateChecks).every(Boolean);
    log("");
    log(`  ⇒ 需求2：${ok ? "PASS" : "FAIL"}`);

    fs.mkdirSync(VERIFY_DIR, { recursive: true });
    fs.writeFileSync(OUT, ["LightMD v0.14.0 需求2 文件夹栏 11 条目位实机探针", ...lines, ""].join("\n"), "utf-8");
    console.log(`\n报告：${OUT}`);
    process.exit(ok ? 0 : 1);
  } finally {
    releaseLock();
  }
};

main().catch((e) => {
  console.error("探针异常：", e);
  try {
    fs.mkdirSync(VERIFY_DIR, { recursive: true });
    fs.writeFileSync(OUT, ["LightMD v0.14.0 需求2 探针（异常中断）", ...lines, String(e && e.stack ? e.stack : e), ""].join("\n"), "utf-8");
  } catch {}
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  releaseLock();
  process.exit(2);
});
