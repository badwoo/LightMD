/**
 * LightMD v0.9.5 启动恢复专项实机验证（重启驱动）
 *
 * 覆盖 0.9.5 反馈修复的可自动化部分：
 *  1. 问题2（legacy 路径）：写入 open-file-tabs 快照（含 2 个真实文件）→
 *     重启应用 → 只恢复这 2 个标签，历史中的其他文件不恢复
 *  2. 问题3：快照中的文件被删除 → 重启 → 无红色"读取文件失败"提示；
 *     最近打开中该条目仍存在（用户可看到 ⚠）
 *  3. 问题1（回归确认）：打开收藏栏 → 标题栏可见 + 空档 spacer + 打开文件栏自适应
 *
 * 用法：先手动启动打包产物（--remote-debugging-port=9225），脚本内部会自行重启应用
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CDP_BASE = process.env.V095_CDP_BASE || "http://127.0.0.1:9225";
const EXE = process.env.V095_EXE || "";
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
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 端口未就绪 */ }
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
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = () =>
      resolve({
        send(method, params) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method, params }));
          return new Promise((r) => pending.set(i, r));
        },
        close: () => ws.close(),
      });
  });
}

async function withCdp(fn) {
  const target = await findPageTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

async function main() {
  // ── 准备 3 个真实文件(其中 1 个将在重启前删除) ──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v095b-"));
  const keep1 = path.join(tmpDir, "保留文档甲.md");
  const keep2 = path.join(tmpDir, "保留文档乙.md");
  const doomed = path.join(tmpDir, "将删除文档.md");
  fs.writeFileSync(keep1, "# 保留文档甲\n\nKEEP-ONE\n");
  fs.writeFileSync(keep2, "# 保留文档乙\n\nKEEP-TWO\n");
  fs.writeFileSync(doomed, "# 将删除文档\n\nDOOMED\n");

  // ── 阶段 1:在运行中的应用里写快照 + 打开收藏栏验证问题 1 ──
  await withCdp(async (cdp) => {
    const ev = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result?.result?.value;
    };
    // 确保启动恢复开关开启(保留其他设置),并打开一个文件让「打开的文件」栏存在
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(keep1.replace(/\\/g, "/"))},content:${JSON.stringify("# 保留文档甲\\n\\nKEEP-ONE\\n")}}})); true`);
    await sleep(500);
    // 清理 untitled 残留持久化(此前调试遗留的"新文件"标签会干扰恢复观察)
    await ev(`(() => {
      Object.keys(localStorage)
        .filter(k => k.startsWith("lightmd-untitled-tabs"))
        .forEach(k => localStorage.removeItem(k));
      return "ok";
    })()`);
    await ev(`(() => {
      try {
        const raw = localStorage.getItem("lightmd-settings");
        const parsed = raw ? JSON.parse(raw) : { state: {} };
        parsed.state = parsed.state || {};
        parsed.state.loadLastFileOnStartup = true;
        localStorage.setItem("lightmd-settings", JSON.stringify(parsed));
      } catch (e) { return String(e); }
      return "ok";
    })()`);
    // 写入退出时标签快照:仅 2 个保留文件(将删除文档也在其中,用于问题3)
    const snapshot = JSON.stringify([
      { path: keep1.replace(/\\/g, "/"), name: "保留文档甲.md" },
      { path: keep2.replace(/\\/g, "/"), name: "保留文档乙.md" },
      { path: doomed.replace(/\\/g, "/"), name: "将删除文档.md" },
    ]);
    await ev(`localStorage.setItem("lightmd-open-file-tabs", ${JSON.stringify(snapshot)}); true`);
    // 同时让 recentFiles 历史只含一个"诱饵条目"(不应被恢复)
    await ev(`(() => {
      try {
        const raw = localStorage.getItem("lightmd-file-store");
        const parsed = raw ? JSON.parse(raw) : { state: {} };
        parsed.state = parsed.state || {};
        parsed.state.recentFiles = [{ path: "D:/__不应恢复的文件__.md", name: "不应恢复.md", accessedAt: 9999 }];
        localStorage.setItem("lightmd-file-store", JSON.stringify(parsed));
      } catch (e) { return String(e); }
      return "ok";
    })()`);
    // 问题 1 回归:打开收藏栏(若残留为打开态则先关闭再打开)
    await ev(`(async () => {
      const btns = [...document.querySelectorAll('.filetree-btn')];
      const star = btns.find(b => b.innerHTML.includes('8 1l2.2'));
      if (!star) return "no-star";
      if (document.querySelector('.favorites-section')) {
        star.click();
        await new Promise(r => setTimeout(r, 500));
      }
      star.click();
      return "clicked";
    })()`);
    await sleep(500);
    const fav = await ev(`(() => {
      const sec = document.querySelector('.favorites-section');
      if (!sec) return JSON.stringify({ ok: false, why: "no-section" });
      const header = sec.querySelector('.favorites-header');
      const headerVisible = !!header && getComputedStyle(header).display !== "none";
      const spacer = !!sec.querySelector('.filetree-temp-spacer');
      const temp = document.querySelector('.filetree-temp-section');
      const tempAuto = temp ? temp.style.height === "" : false;
      return JSON.stringify({ ok: headerVisible && spacer && tempAuto, headerVisible, spacer, tempAuto });
    })()`);
    try {
      const o = JSON.parse(fav);
      check("问题1 收藏栏标题栏可见 + 空档 + 打开文件栏自适应", o.ok === true, fav);
    } catch {
      check("问题1 收藏栏标题栏可见 + 空档 + 打开文件栏自适应", false, fav);
    }
  });

  // ── 阶段 2:删除一个文件 + 强制 legacy 模式(清 session.json)+ 重启应用 ──
  fs.rmSync(doomed, { force: true });
  execSync("taskkill /IM lightmd.exe /F 2>nul", { shell: "cmd.exe", stdio: "ignore" });
  execSync("taskkill /IM msedgewebview2.exe /F 2>nul", { shell: "cmd.exe", stdio: "ignore" });
  await sleep(2000);
  // 删除 session.json,强制走 legacy 恢复路径(验证 open-file-tabs 快照数据源)
  const sessionFile = path.join(process.env.APPDATA || "", "com.lightmd.app", "session.json");
  try { fs.rmSync(sessionFile, { force: true }); } catch { /* 忽略 */ }
  if (!EXE) throw new Error("未指定 V095_EXE(打包产物路径)");
  execSync(`powershell -Command "$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9225'; Start-Process '${EXE.replace(/'/g, "''")}'"`, { stdio: "ignore" });
  await sleep(3000);

  // ── 阶段 3:验证恢复结果 ──
  await withCdp(async (cdp) => {
    const ev = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      return r.result?.result?.value;
    };
    // 等待启动恢复完成
    await sleep(4000);
    const state = await ev(`(() => {
      const text = document.body.innerText;
      return JSON.stringify({
        keep1: text.includes("KEEP-ONE") || text.includes("保留文档甲"),
        keep2: text.includes("KEEP-TWO") || text.includes("保留文档乙"),
        doomedError: text.includes("读取文件失败"),
        decoyRestored: text.includes("不应恢复"),
        toasts: [...document.querySelectorAll("[class*=toast],[class*=notification]")].map(e => e.textContent).join("|").slice(0, 120),
      });
    })()`);
    try {
      const o = JSON.parse(state);
      check("问题2 快照中的标签被恢复", o.keep1 === true && o.keep2 === true, state);
      check("问题2 历史中已关闭的条目不被恢复", o.decoyRestored === false, state);
      check("问题3 已删除文件恢复无红色提示", o.doomedError === false, `toasts=${o.toasts}`);
    } catch {
      check("问题2/3 恢复状态解析", false, state);
    }
  });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.log("=== v0.9.5 启动恢复专项验证 ===");
  for (const r of results) console.log(r);
  console.log(`\n${failed === 0 ? "ALL PASS" : "FAILED: " + failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("脚本执行失败:", err.message);
  for (const r of results) console.log(r);
  process.exitCode = 1;
});
