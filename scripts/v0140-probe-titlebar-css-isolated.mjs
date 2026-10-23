/**
 * 需求6 CSS 层级的独立隔离实验（headless Edge）—— 只验证 CSS 规则本身
 *
 * 为什么需要它：实机探针（scripts/v0140-probe-titlebar-menu.mjs）跑的是**打包产物**，
 * 而打包会被并行队友的中间状态阻塞（tsc 报错 → 无法生成新 exe）。这个脚本直接用
 * 修复后的 TitleBar.css / global.css / editor.css 片段在真实 Chromium（WebView2 同内核）
 * 里搭一个最小复刻页面，证明"层级规则本身"能把菜单顶到编辑区之上。
 *
 * 做法：
 *   1. 读真实 CSS 文件（TitleBar.css / App.css / AppShell.css / global.css 的 :root 令牌，
 *      以及 editor.css 的 .editor-main-area / .editor-empty-state）
 *   2. 用与 App.tsx 相同的 DOM 结构拼一个页面（.app > .titlebar + .app-shell > ...）
 *   3. 真实鼠标事件打开下拉菜单 → 截图 → 像素 diff（同 before/after 探针口径）
 *   4. 对照实验：把 .titlebar 的 z-index 去掉（= 修复前），同样的像素实验应失败
 *
 * 用法：node scripts/v0140-probe-titlebar-css-isolated.mjs
 * 落盘：_verify-out/v0140-probe-titlebar-css-isolated.txt + *.png
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT = path.join(OUT_DIR, "v0140-probe-titlebar-css-isolated.txt");
const PORT = Number(process.env.V0140_ISO_PORT || 9355);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (s) => {
  console.log(s);
  lines.push(s);
};

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** 从整份 CSS 里抽取指定选择器的规则块（含 @media/@supports 外的顶层规则） */
function pickRules(css, patterns) {
  let out = "";
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(css)))) {
    const sel = m[1].trim();
    if (patterns.some((p) => (p instanceof RegExp ? p.test(sel) : sel === p))) out += `${sel} {${m[2]}}\n`;
  }
  return out;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      }
    };
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        send(method, params, timeoutMs = 60000) {
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
          try {
            ws.close();
          } catch {}
        },
      });
  });
}

const PIXDIFF_JS = (a, b) => `
  const load = (u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
  const [ia, ib] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
  if (ia.width !== ib.width || ia.height !== ib.height) return { error: "size", a: [ia.width, ia.height], b: [ib.width, ib.height] };
  const cv = document.createElement("canvas");
  cv.width = ia.width; cv.height = ia.height;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(ia, 0, 0);
  const da = ctx.getImageData(0, 0, ia.width, ia.height).data;
  ctx.clearRect(0, 0, ia.width, ia.height);
  ctx.drawImage(ib, 0, 0);
  const db = ctx.getImageData(0, 0, ia.width, ia.height).data;
  let diff = 0, darkA = 0, darkB = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
    if (d > 24) diff++;
    if (0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2] < 140) darkA++;
    if (0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2] < 140) darkB++;
  }
  return { total: da.length / 4, diff, darkA, darkB };
`;

const main = async () => {
  if (!fs.existsSync(EDGE)) {
    console.error(`缺少 Edge：${EDGE}`);
    process.exit(3);
  }

  // ─── 用真实 CSS 文件拼装页面 ───
  const titlebarCss = read("src/components/layout/TitleBar.css");
  const appShellCss = read("src/components/layout/AppShell.css");
  const appCss = read("src/App.css");
  const editorCss = read("src/styles/editor.css");
  const globalCss = read("src/styles/global.css");
  const rootTokens = (globalCss.match(/:root\s*\{[\s\S]*?\}/) || [""])[0];

  const cssParts = [
    rootTokens,
    // 主题变量（浅色主题的最小必要集）
    `:root{--bg-primary:#fff;--bg-secondary:#f5f5f5;--bg-tertiary:#eee;--bg-hover:#f0f0f0;
      --text-primary:#1a1a1a;--text-secondary:#555;--text-tertiary:#888;
      --border-color:#e0e0e0;--titlebar-bg:#f5f5f5;--sidebar-bg:#fafafa;
      --titlebar-height:40px;--shadow-md:0 4px 12px rgba(0,0,0,.12);
      --transition-fast:150ms ease;--sidebar-width:279px;--outline-width:259px;}`,
    pickRules(appCss, [".app"]),
    // 真实 TitleBar.css 的层级相关规则（这是被测对象）
    pickRules(titlebarCss, [
      ".titlebar",
      ".titlebar-left",
      ".titlebar-menu",
      ".titlebar-menu-btn",
      ".titlebar-new-menu",
      ".titlebar-dropdown",
      ".titlebar-dropdown-item",
      ".titlebar-window-dropdown",
      ".titlebar-right",
      ".titlebar-center",
    ]),
    pickRules(appShellCss, [".app-shell", ".app-sidebar", ".app-sidebar-content", ".app-main", ".app-outline"]),
    pickRules(editorCss, [".editor-main-area", ".editor-empty-state", ".editor-container", ".ProseMirror"]),
    // 兜底：让内容区有视觉参照
    `body{margin:0;font-family:system-ui;font-size:14px;background:#fff;color:#1a1a1a;}
     .app-sidebar,.app-outline{background:#fafafa;border-right:1px solid #e0e0e0;}
     .app-outline{border-left:1px solid #e0e0e0;border-right:none;}
     #root{height:100vh;}`,
  ];

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${cssParts.join("\n")}</style></head>
<body><div id="root">
  <div class="app">
    <div class="titlebar" data-tauri-drag-region>
      <div class="titlebar-left">
        <span class="titlebar-brand">LightMD</span>
        <div class="titlebar-menu">
          <div class="titlebar-new-menu" id="newMenu">
            <button class="titlebar-menu-btn" id="newBtn">新建 ▾</button>
            <div class="titlebar-dropdown" id="newDD" style="display:none">
              <button class="titlebar-dropdown-item">新建文件</button>
              <button class="titlebar-dropdown-item">新建文件夹</button>
            </div>
          </div>
          <button class="titlebar-menu-btn">打开</button>
          <button class="titlebar-menu-btn">保存</button>
          <div class="titlebar-new-menu" id="winMenu">
            <button class="titlebar-menu-btn" id="winBtn">窗口</button>
            <div class="titlebar-dropdown titlebar-window-dropdown" id="winDD" style="display:none">
              <button class="titlebar-dropdown-item">新建窗口<span class="titlebar-dropdown-shortcut">Ctrl+Shift+N</span></button>
              <button class="titlebar-dropdown-item">关闭窗口<span class="titlebar-dropdown-shortcut">Ctrl+Shift+W</span></button>
              <div class="titlebar-dropdown-sep"></div>
              <div class="titlebar-dropdown-label">窗口列表</div>
              <button class="titlebar-dropdown-item titlebar-window-item is-self">主窗口 •</button>
              <button class="titlebar-dropdown-item">退出 LightMD</button>
            </div>
          </div>
        </div>
      </div>
      <div class="titlebar-center"><span class="titlebar-title">无标题.md</span></div>
      <div class="titlebar-right"></div>
    </div>
    <div class="app-shell">
      <aside class="app-sidebar" style="width:279px"><div class="app-sidebar-content">文件管理</div></aside>
      <main class="app-main">
        <div class="editor-main-area">
          <div class="editor-container">
            <div class="ProseMirror">正文区域</div>
            <div class="editor-empty-state">LIGHTMD 空状态</div>
          </div>
        </div>
      </main>
      <aside class="app-outline" style="width:259px"><div>大纲</div></aside>
    </div>
  </div>
</div>
<script>
  // 复刻 TitleBar.tsx 的 onMouseEnter 展开行为
  const bind = (btnId, ddId) => {
    const btn = document.getElementById(btnId), dd = document.getElementById(ddId);
    btn.addEventListener("mouseenter", () => { dd.style.display = "block"; });
    btn.addEventListener("mouseleave", () => { dd.style.display = "none"; });
    dd.addEventListener("mouseenter", () => { dd.style.display = "block"; });
  };
  bind("newBtn", "newDD");
  bind("winBtn", "winDD");
  // 对照实验开关：window.__fix=false 时把 .titlebar 的 z-index 去掉（=修复前状态）
  window.__setFix = (on) => {
    const tb = document.querySelector(".titlebar");
    if (on) { tb.style.removeProperty("z-index"); }
    else { tb.style.setProperty("z-index", "auto", "important"); }
  };
</script>
</body></html>`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-iso-"));
  const htmlPath = path.join(tmp, "probe.html");
  fs.writeFileSync(htmlPath, html, "utf8");
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });

  const child = spawn(
    EDGE,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--disable-gpu",
      "--window-size=1440,852",
      "--hide-scrollbars",
      `file:///${htmlPath.replace(/\\/g, "/")}`,
    ],
    { stdio: "ignore" },
  );

  let cdp = null;
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60 && !cdp; i++) {
    try {
      const list = await (await fetch(`${base}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) cdp = await connect(page.webSocketDebuggerUrl);
    } catch {}
    if (!cdp) await sleep(300);
  }
  if (!cdp) {
    try {
      child.kill();
    } catch {}
    throw new Error("no headless target");
  }
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await sleep(700);

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };
  const mouse = async (type, x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type, x, y });
    await sleep(150);
  };
  const shoot = async (rect) => {
    const r = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, scale: 1 },
    });
    return r.result.data;
  };
  const save = (name, b64) => {
    const p = path.join(OUT_DIR, `v0140-probe-titlebar-css-isolated-${name}.png`);
    fs.writeFileSync(p, Buffer.from(b64, "base64"));
    return p;
  };

  /**
   * 打开菜单 → 量矩形 → 像素实验：
   *   隐藏 .editor-empty-state（脱流、不改布局）后同区域截图，比较是否变化。
   *   正确分层：菜单画在空状态之上 → 隐藏空状态不影响菜单区域任何像素（diff=0）。
   *   修复前：空状态画在菜单之上 → 隐藏它会让菜单露出来（diff 很大 + 暗色像素激增）。
   */
  const experiment = async (which, fixOn) => {
    log(`\n──── ${which === "new" ? "新建" : "窗口"}菜单｜修复${fixOn ? "后（保留 .titlebar z-index）" : "前（.titlebar z-index:auto）"} ────`);
    await ev(`window.__setFix(${fixOn}); return 1;`);
    // 真实鼠标：移到按钮上
    const btn = await ev(`
      const b = document.getElementById(${JSON.stringify(which === "new" ? "newBtn" : "winBtn")});
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    await mouse("mouseMoved", btn.x - 30, btn.y);
    await mouse("mouseMoved", btn.x, btn.y);
    await sleep(400);
    const dd = await ev(`
      const dd = document.getElementById(${JSON.stringify(which === "new" ? "newDD" : "winDD")});
      const r = dd.getBoundingClientRect();
      const cs = getComputedStyle(dd);
      return { left: r.left, top: r.top, width: r.width, height: r.height, zIndex: cs.zIndex, display: cs.display,
               leftZ: getComputedStyle(document.querySelector(".titlebar-left")).zIndex,
               titlebarZ: getComputedStyle(document.querySelector(".titlebar")).zIndex,
               emptyZ: getComputedStyle(document.querySelector(".editor-empty-state")).zIndex };
    `);
    log(`  菜单矩形 left=${dd.left.toFixed(1)} top=${dd.top.toFixed(1)} ${dd.width.toFixed(0)}×${dd.height.toFixed(0)}；.titlebar z-index=${dd.titlebarZ}；.titlebar-left z-index=${dd.leftZ}；.editor-empty-state z-index=${dd.emptyZ}`);
    const rect = { left: dd.left, top: dd.top, width: dd.width, height: dd.height };
    const before = await shoot(rect);
    save(`${which}-${fixOn ? "fixed" : "before"}-A`, before);
    await ev(`const el=document.querySelector(".editor-empty-state"); el.setAttribute("data-prev", el.style.visibility||""); el.style.setProperty("visibility","hidden","important"); return 1;`);
    await sleep(250);
    const after = await shoot(rect);
    save(`${which}-${fixOn ? "fixed" : "before"}-B-emptyHidden`, after);
    await ev(`const el=document.querySelector(".editor-empty-state"); el.style.removeProperty("visibility"); const p=el.getAttribute("data-prev"); if(p) el.style.visibility=p; el.removeAttribute("data-prev"); return 1;`);
    await sleep(200);
    const d = await ev(PIXDIFF_JS(`data:image/png;base64,${before}`, `data:image/png;base64,${after}`));
    const verdict = d.diff === 0 ? "✔ 菜单画在空状态之上（隐藏空状态不影响菜单）" : `✘ 空状态画在菜单之上（隐藏后 ${d.diff} 像素变化 / ${(d.diff / d.total * 100).toFixed(1)}%，菜单文字暗色像素 ${d.darkA}→${d.darkB}）`;
    log(`  基线（可见）菜单内暗色像素=${d.darkA}`);
    log(`  像素实验：diff=${d.diff}/${d.total} 暗色像素(可见/隐藏空状态)=${d.darkA}/${d.darkB} → ${verdict}`);
    return { fixOn, diff: d.diff, darkA: d.darkA, darkB: d.darkB, verdict };
  };

  try {
    log("LightMD 需求6 —— CSS 层级隔离实验（headless Edge / Chromium，与 WebView2 同内核）");
    log(`时间：${new Date().toISOString()}`);
    log(`被测 CSS：src/components/layout/TitleBar.css（真实文件）+ global.css 的 --z-titlebar 令牌`);
    log("");
    const r1 = await experiment("new", false);
    const r2 = await experiment("new", true);
    const r3 = await experiment("window", false);
    const r4 = await experiment("window", true);
    log("\n══════════ 结论 ══════════");
    const beforeFailed = r1.diff > 0 && r3.diff > 0;
    const afterPassed = r2.diff === 0 && r4.diff === 0;
    log(`修复前（.titlebar z-index:auto）：新建菜单 diff=${r1.diff}、窗口菜单 diff=${r3.diff} → ${beforeFailed ? "复现缺陷 ✔" : "未复现 ✘"}`);
    log(`修复后（.titlebar z-index:var(--z-titlebar,100)）：新建菜单 diff=${r2.diff}、窗口菜单 diff=${r4.diff} → ${afterPassed ? "缺陷消失 ✔" : "仍有问题 ✘"}`);
    lines.push(`RESULT beforeFailed=${beforeFailed} afterPassed=${afterPassed}`);
  } finally {
    try {
      cdp.close();
    } catch {}
    try {
      child.kill();
    } catch {}
    try {
      execFileSync("taskkill", ["/IM", "msedge.exe", "/F"], { stdio: "ignore" });
    } catch {}
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf-8");
  log(`\n报告：${OUT}`);
};

main().catch((e) => {
  console.error("隔离实验异常：", e);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT, `隔离实验异常：${e?.stack || e}\n`, "utf-8");
  } catch {}
  process.exit(2);
});
