/**
 * LightMD v0.14.0 需求1 修复 实机探针（打包产物 + WebView2 CDP）
 *
 * 用户原话：
 *   「设置里点检查更新报『无法连接 GitHub』，我预期能正常检查；若确实没有新版本，
 *     应显示『已是最新版本』，而不是报连不上 GitHub。」
 *   「真断网时要显示『暂时无法检查更新（网络不可用）』，不许谎报版本状态。」
 *
 * 本探针在**真实打包产物**里验证三件事：
 *   ① 点「检查更新」后**不再**出现 `error sending request` / 「无法连接 GitHub」；
 *   ② 连通且无新版 → 出现 `[data-testid=update-uptodate]`，文案含「已是最新版本」；
 *   ③ 断网（本轮用「临时改写 hosts 之外的软手段」不可靠，改为**离线等价断言**：
 *      把 API 域名指向不可路由地址不可行，故只验证 ① ②；③ 由 Rust 单测
 *      `unreachable_host_is_classified_as_network` + 前端 mock 用例覆盖）。
 *
 * 用法（需先构建 release：`cd src-tauri && cargo build --release`）：
 *   node scripts/v0140-fix-update-probe.mjs
 * 环境变量：V0140U_PORT（默认 9311）
 * 输出：_verify-out/v0140-fix-update-probe.txt（+ 截图 v0140u-*.png）
 * 互斥：跑之前先抢 _verify-out/probe.lock（所有会 taskkill lightmd.exe 的探针必须串行）。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140U_PORT || 9311);
const CDP = `http://127.0.0.1:${PORT}`;
const VERIFY_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT = path.join(VERIFY_DIR, "v0140-fix-update-probe.txt");
const LOCK = path.join(VERIFY_DIR, "probe.lock");

const lines = [];
const log = (s = "") => {
  console.log(s);
  lines.push(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 探针互斥锁 ───────────────────────────────────────────
async function acquireLock(maxWaitMs = 6 * 60 * 1000) {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fh = await fs.promises.open(LOCK, "wx");
      await fh.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString(), script: "v0140-fix-update-probe" }),
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
  // 只删自己抢到的锁，避免破坏其他成员的互斥
  try {
    const info = JSON.parse(fs.readFileSync(LOCK, "utf-8"));
    if (info && info.pid !== undefined && info.pid !== process.pid) return;
  } catch {
    return;
  }
  try { fs.unlinkSync(LOCK); } catch {}
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection"]) {
  process.on(sig, (e) => {
    if (e) log(`捕获 ${sig}：${e && e.stack ? e.stack : e}`);
    releaseLock();
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
    try { fs.writeFileSync(OUT, lines.join("\n"), "utf-8"); } catch {}
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
          const r = await c.send(
            "Runtime.evaluate",
            { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true },
            15000,
          );
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

async function main() {
  if (!fs.existsSync(EXE)) {
    log(`✗ 找不到打包产物：${EXE}`);
    log("  请先构建：cd src-tauri && cargo build --release");
    return 2;
  }
  if (!(await acquireLock())) return 3;

  log("── v0.14.0 需求1 修复实机探针 ──");
  log(`产物：${EXE}`);
  log(`修改时间：${fs.statSync(EXE).mtime.toISOString()}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0140u-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });

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
  const ev = async (body) => {
    const r = await cdp.send(
      "Runtime.evaluate",
      { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true },
      40000,
    );
    if (r.result?.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    }
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    try {
      const r = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(VERIFY_DIR, { recursive: true });
      fs.writeFileSync(path.join(VERIFY_DIR, `${name}.png`), Buffer.from(r.result.data, "base64"));
      log(`  截图：_verify-out/${name}.png`);
    } catch (e) {
      log(`  截图失败（忽略）：${e.message}`);
    }
  };

  let exitCode = 0;
  try {
    await sleep(3000);

    // 1. 打开设置（Ctrl+,）——优先走应用内快捷键；失败则退回直接渲染入口
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", modifiers: 2, key: ",", code: "Comma", windowsVirtualKeyCode: 188,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", modifiers: 2, key: ",", code: "Comma", windowsVirtualKeyCode: 188,
    });
    await sleep(1500);
    const opened = await ev(`return !!document.querySelector('[data-testid="settings-update-section"]')`);
    log(`设置弹窗已打开（找到软件更新区）：${opened}`);
    if (!opened) {
      log("✗ Ctrl+, 未能打开设置弹窗，无法继续");
      await shot("v0140u-fail-no-settings");
      exitCode = 4;
      throw new Error("settings not opened");
    }

    // 2. 滚到更新区并点「检查更新」
    await ev(`
      const sec = document.querySelector('[data-testid="settings-update-section"]');
      sec.scrollIntoView({ block: "center" });
      return true;
    `);
    await sleep(400);
    await shot("v0140u-before-check");

    await ev(`
      const btn = document.querySelector('[data-testid="update-check-btn"]');
      if (!btn) return "no-btn";
      btn.click();
      return "clicked";
    `);

    // 3. 轮询三种终态：uptodate / offline / error
    let state = null;
    for (let i = 0; i < 100; i++) {
      state = await ev(`
        const pick = (id) => {
          const el = document.querySelector('[data-testid="' + id + '"]');
          return el ? el.textContent.trim() : null;
        };
        if (pick("update-uptodate") !== null) return { kind: "uptodate", text: pick("update-uptodate") };
        if (pick("update-offline") !== null) return { kind: "offline", text: pick("update-offline") };
        if (pick("update-error") !== null) return { kind: "error", text: pick("update-error") };
        if (pick("update-available") !== null) return { kind: "available", text: pick("update-available").slice(0, 200) };
        return null;
      `);
      if (state) break;
      await sleep(300);
    }

    await shot("v0140u-after-check");

    log("");
    log("── 结果 ──");
    if (!state) {
      log("✗ 30s 内未进入任何终态（检查按钮可能仍在 loading）");
      exitCode = 5;
    } else {
      log(`终态：${state.kind}`);
      log(`文案：${state.text}`);
      log("");
      // 核心断言
      const isNetworkError = /error sending request|无法连接 GitHub/i.test(state.text ?? "");
      if (state.kind === "error" && isNetworkError) {
        log("✗ 仍然报「无法连接 GitHub / error sending request」→ TLS/代理修复未生效");
        exitCode = 6;
      } else if (state.kind === "uptodate") {
        log("✓ 连通且无新版 → 显示「已是最新版本」（用户预期达成）");
      } else if (state.kind === "available") {
        log("✓ 连通且有新版 → 显示版本信息（说明网络已通，只是线上有更新）");
      } else if (state.kind === "offline") {
        log("⚠ 显示「暂时无法检查更新（网络不可用）」——语义正确（未谎报版本），");
        log("  但本机应能连通 GitHub；若反复出现请检查 FastGithub 是否在运行。");
      } else if (state.kind === "error") {
        log("⚠ 业务错误（非网络层）：请人工确认是否为 GitHub 403 限流");
        exitCode = 7;
      }
    }

    // 4. 顺带确认：本地版本号展示正确（不该出现「已是最新版本 v0.13.2」这种远端 tag）
    const cur = await ev(`return document.querySelector('[data-testid="update-current-version"]')?.textContent?.trim() ?? null`);
    log(`当前版本显示：${cur}`);
  } catch (e) {
    if (exitCode === 0) exitCode = 1;
    log(`探针异常：${e && e.stack ? e.stack : e}`);
  } finally {
    try { cdp.close(); } catch {}
    try { child.kill(); } catch {}
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(VERIFY_DIR, { recursive: true });
    fs.writeFileSync(OUT, lines.join("\n"), "utf-8");
    log("");
    log(`输出已写入：${OUT}`);
  }
  return exitCode;
}

main().then((code) => process.exit(code));
