/** LightMD v0.16.0 侧栏 UI 实机探针：真实 WebView2 DOM、几何与动画。 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = process.env.V0160_UI_EXE || path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = Number(process.env.V0160_UI_PORT || 9416);
const OUT_DIR = path.join(ROOT, "_verify-out");
const DEV_CHROMIUM = process.env.V0160_UI_DEV === "1";
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((item) => fs.existsSync(item));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = [];
const log = (text = "") => { lines.push(text); console.log(text); };

function verifyExe() {
  if (DEV_CHROMIUM) {
    if (!EDGE) throw new Error("DEV 模式需要本机 Microsoft Edge");
    log("[probe] 独立 Chromium + Vite 开发产物（不是 WebView2 验收）");
    return;
  }
  if (!fs.existsSync(EXE)) throw new Error("请先执行 npx tauri build --no-bundle");
  const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  const match = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!match || !fs.readFileSync(EXE).includes(Buffer.from(match[1]))) {
    throw new Error("exe 内联 dist 与当前构建不一致，请重新打包");
  }
  const processes = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  if (/^"lightmd\.exe"/im.test(processes)) {
    throw new Error("检测到已有 LightMD 进程。为避免干扰用户会话，请先关闭后重跑探针。");
  }
  log(`[probe] dist=${match[1]}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => resolve({
      send(method, params) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return new Promise((res, rej) => {
          pending.set(msgId, { res, rej });
          setTimeout(() => {
            if (pending.delete(msgId)) rej(new Error(`CDP timeout: ${method}`));
          }, 15000);
        });
      },
      close() { ws.close(); },
    }));
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      const item = pending.get(msg.id);
      if (!item) return;
      pending.delete(msg.id);
      if (msg.error) item.rej(new Error(JSON.stringify(msg.error)));
      else item.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${url}`)));
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExe();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0160-ui-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const fileA = path.join(tmp, "alpha.md");
  const fileB = path.join(tmp, "beta.md");
  fs.writeFileSync(fileA, "# Alpha\n", "utf8");
  fs.writeFileSync(fileB, "# Beta\n", "utf8");

  let child = null;
  let vite = null;
  let cdp = null;
  try {
    if (DEV_CHROMIUM) {
      vite = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", "1421", "--strictPort"], { cwd: ROOT, stdio: "ignore" });
      await sleep(1800);
      child = spawn(EDGE, [`--headless=new`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--window-size=1280,800", "http://127.0.0.1:1421"], { stdio: "ignore" });
    } else {
      child = spawn(EXE, [], {
        env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile },
        stdio: "ignore",
      });
    }
    for (let attempt = 0; attempt < 120 && !cdp; attempt++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
        for (const target of targets) {
          if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
          const candidate = await connect(target.webSocketDebuggerUrl);
          await candidate.send("Runtime.enable");
          const ready = await candidate.send("Runtime.evaluate", { expression: `!!document.querySelector(".filetree")`, returnByValue: true });
          if (ready.result?.result?.value) { cdp = candidate; break; }
          candidate.close();
        }
      } catch { /* WebView2 尚未就绪 */ }
      if (!cdp) await sleep(300);
    }
    if (!cdp) throw new Error("找不到 LightMD WebView2 CDP target");
    const evaluate = async (body) => {
      const result = await cdp.send("Runtime.evaluate", { expression: `(async()=>{${body}})()`, returnByValue: true, awaitPromise: true });
      if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 1600));
      return result.result?.result?.value;
    };
    const waitFor = async (expression, timeout = 12000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await evaluate(`return (${expression});`);
        if (value) return value;
        await sleep(150);
      }
      throw new Error(`等待超时：${expression}`);
    };
    const checks = [];
    const check = (name, ok, detail = "") => {
      checks.push({ name, ok: !!ok, detail });
      log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    };

    await evaluate(`localStorage.clear(); location.reload(); return true;`);
    await sleep(2500);
    await waitFor(`!!document.querySelector(".filetree-new-primary")`);
    await evaluate(`
      window.__v0160Command = "";
      window.addEventListener("lightmd:command", (event) => { window.__v0160Command = event.detail?.id || ""; });
      for (const [name, content] of ${JSON.stringify([[fileA, "# Alpha\n"], [fileB, "# Beta\n"]])}) {
        window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: name, content } }));
      }
      return true;
    `);
    await sleep(900);

    const initial = await evaluate(`
      const button = document.querySelector(".titlebar-sidebar-btn").getBoundingClientRect();
      const brand = document.querySelector(".titlebar-brand").getBoundingClientRect();
      const create = document.querySelector(".filetree-new-primary");
      create.click();
      return { buttonRight: button.right, brandLeft: brand.left, createWidth: create.getBoundingClientRect().width,
        sidebarWidth: document.querySelector(".app-sidebar").getBoundingClientRect().width,
        headerHeight: document.querySelector(".filetree-header").getBoundingClientRect().height };
    `);
    check("侧栏按钮位于 LightMD 左侧", initial.buttonRight <= initial.brandLeft, JSON.stringify(initial));
    check("大新建按钮保留原新建文件命令", await evaluate(`return window.__v0160Command === "file.new";`), `width=${initial.createWidth}`);

    await evaluate(`document.querySelector('.filetree-btn[title="收藏"]').click(); return true;`);
    await sleep(65);
    const enterX = await evaluate(`
      const panel = document.querySelector(".sidebar-panel-slide-enter");
      const matrix = new DOMMatrix(getComputedStyle(panel).transform);
      return matrix.m41;
    `);
    await waitFor(`!!document.querySelector(".favorites-panel")`);
    check("收藏从左侧滑入", enterX < 0, `x=${enterX.toFixed(2)}`);
    check("收藏占满内容区且文件树保活隐藏", await evaluate(`
      const files = document.querySelector(".filetree-scroll");
      const panel = document.querySelector(".favorites-panel");
      const host = document.querySelector(".filetree-view-host");
      return files && files.getAttribute("aria-hidden") === "true" &&
        Math.abs(panel.getBoundingClientRect().height - host.getBoundingClientRect().height) < 2;
    `));

    await evaluate(`document.querySelector('.filetree-btn[title="最近打开"]').click(); return true;`);
    await sleep(350);
    const switchState = await evaluate(`
      return { recent: !!document.querySelector(".recent-files-panel"), favorites: !!document.querySelector(".favorites-panel"),
        empty: !!document.querySelector(".recent-files-empty"), items: document.querySelectorAll(".recent-file-item").length, title: document.querySelector(".titlebar-sidebar-btn")?.title,
        slides: Array.from(document.querySelectorAll(".filetree-special-panels > div")).map((node) => node.className) };
    `);
    check("收藏与最近打开直接互切且最近记录可见", switchState.recent && !switchState.favorites && (switchState.empty || switchState.items === 2), JSON.stringify(switchState));

    await evaluate(`document.querySelector(".titlebar-sidebar-btn").click(); return true;`);
    await sleep(65);
    const exitX = await evaluate(`
      const panel = document.querySelector(".sidebar-panel-slide-exit");
      return panel ? new DOMMatrix(getComputedStyle(panel).transform).m41 : null;
    `);
    check("关闭特殊面板向右滑出", exitX !== null && exitX > 0, `x=${exitX}`);
    await sleep(250);
    check("关闭最近返回文件管理且侧栏不收起", await evaluate(`
      return document.querySelector(".filetree-scroll").getAttribute("aria-hidden") === "false" &&
        document.querySelector(".titlebar-sidebar-btn").title === "收起侧栏" &&
        document.querySelector(".app-sidebar").getBoundingClientRect().width > 100;
    `));

    const widthBefore = await evaluate(`return document.querySelector(".app-sidebar").getBoundingClientRect().width;`);
    await evaluate(`document.querySelector(".titlebar-sidebar-btn").click(); return true;`);
    await sleep(350);
    check("标题栏按钮收起整个侧栏", await evaluate(`
      return document.querySelector(".app-sidebar").getBoundingClientRect().width < 1 &&
        document.querySelector(".app-sidebar-content").hasAttribute("inert");
    `));
    await evaluate(`document.querySelector(".titlebar-sidebar-btn").click(); return true;`);
    await sleep(350);
    const widthAfter = await evaluate(`return document.querySelector(".app-sidebar").getBoundingClientRect().width;`);
    check("展开恢复原侧栏宽度", Math.abs(widthAfter - widthBefore) < 2, `${widthBefore}→${widthAfter}`);

    await evaluate(`document.querySelector('.filetree-btn[title="收藏"]').click(); return true;`);
    await waitFor(`!!document.querySelector(".favorites-panel")`);
    await evaluate(`document.querySelector(".favorites-add-btn").click(); return true;`);
    await waitFor(`!!document.querySelector(".favorites-add-picker")`);
    const candidates = await evaluate(`
      const boxes = Array.from(document.querySelectorAll('[role="checkbox"]'));
      return { names: boxes.map((box) => box.getAttribute("aria-label")), untitled: boxes.some((box) => /未命名|新文档/.test(box.getAttribute("aria-label") || "")) };
    `);
    check("候选包含两个已落盘标签并排除未保存标签", candidates.names.length === 2 && !candidates.untitled, JSON.stringify(candidates));
    await evaluate(`
      document.querySelectorAll('[role="checkbox"]').forEach((box) => box.click());
      return true;
    `);
    await waitFor(`!document.querySelector(".favorites-picker-confirm").disabled`);
    await evaluate(`document.querySelector(".favorites-picker-confirm").click(); return true;`);
    await waitFor(`document.querySelectorAll(".favorites-list .favorite-item").length === 2`);
    const addedState = await evaluate(`
      return { count: document.querySelectorAll(".favorites-list .favorite-item").length,
        feedback: document.querySelector(".favorites-feedback")?.textContent || "",
        picker: !!document.querySelector(".favorites-add-picker"),
        selected: document.querySelector(".favorites-selected-count")?.textContent || "",
        stored: localStorage.getItem("lightmd-file-store") };
    `);
    check("多选批量添加两个收藏并有成功反馈", addedState.count === 2 && addedState.feedback.includes("2") && !addedState.picker, JSON.stringify(addedState));

    await evaluate(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.toggleLeft" } })); return true;`);
    await sleep(350);
    await evaluate(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.toggleLeft" } })); return true;`);
    await sleep(350);
    check("快捷键收起/展开保留收藏视图", await evaluate(`
      return !!document.querySelector(".favorites-panel") &&
        document.querySelector(".titlebar-sidebar-btn").title === "关闭收藏";
    `));

    await evaluate(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.toggleLeft" } })); return true;`);
    await sleep(300);
    await evaluate(`document.querySelector(".titlebar-sidebar-btn").click(); return true;`);
    await sleep(300);
    check("收起状态下关闭收藏会展开文件管理", await evaluate(`
      return document.querySelector(".filetree-scroll").getAttribute("aria-hidden") === "false" &&
        document.querySelector(".app-sidebar").getBoundingClientRect().width > 100 &&
        document.querySelector(".titlebar-sidebar-btn").title === "收起侧栏";
    `));

    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await evaluate(`document.querySelector('.filetree-btn[title="最近打开"]').click(); return true;`);
    await sleep(40);
    check("减少动态效果时禁用滑移动画", await evaluate(`
      const panel = document.querySelector(".sidebar-panel-slide-enter");
      return panel && getComputedStyle(panel).animationName === "none";
    `));
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });

    await evaluate(`document.querySelector(".titlebar-sidebar-btn").click(); return true;`);
    await sleep(250);
    await evaluate(`document.documentElement.style.setProperty("--sidebar-width", "180px"); return true;`);
    await sleep(80);
    check("180px 最小宽度下工具栏不横向溢出", await evaluate(`
      const actions = document.querySelector(".filetree-actions");
      return actions.scrollWidth <= actions.clientWidth + 1 &&
        document.querySelector(".filetree-new-primary").getBoundingClientRect().width > 100;
    `));

    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT_DIR, "v0160-sidebar-ui.png"), Buffer.from(screenshot.result.data, "base64"));
    const failed = checks.filter((item) => !item.ok).length;
    log(`合计 ${checks.length} 项，通过 ${checks.length - failed}，失败 ${failed}`);
    fs.writeFileSync(path.join(OUT_DIR, "v0160-sidebar-ui.json"), JSON.stringify({ checks, candidates }, null, 2), "utf8");
    fs.writeFileSync(path.join(OUT_DIR, "v0160-sidebar-ui.txt"), lines.join("\n") + "\n", "utf8");
    if (failed) process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    for (const process of [child, vite]) {
      if (process?.pid) {
        try { execFileSync("taskkill", ["/PID", String(process.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* ignore */ }
      }
    }
  }
}

main().catch((error) => {
  log(`探针中止：${error.stack || error}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "v0160-sidebar-ui.txt"), lines.join("\n") + "\n", "utf8");
  process.exitCode = 2;
});
