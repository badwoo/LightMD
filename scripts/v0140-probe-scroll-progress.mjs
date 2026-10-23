/**
 * 探针：v0.14.0 需求2/3 —— 阅读进度在「模式切换」与「关闭重开」后是否丢失。
 *
 * 为什么要实机：滚动位置依赖真实布局（scrollHeight/clientHeight），jsdom 里恒为 0，
 * 任何单测都无法复现这类缺陷（项目既有教训：观感/几何类缺陷必须实测）。
 *
 * 覆盖：
 *  A. 阅读模式滚到 ~50% → 双击 Ctrl 切编辑 → 再切回阅读：scrollTop 是否回到原处
 *  B. 阅读模式滚到 ~50% → 切编辑（左源码）滚到 ~50% → 切回阅读 → 再切编辑：双向
 *  C. 关闭标签 → 重新打开同一文件：进度是否保留（用户需求3 要求保留）
 *  D. 重启应用 → 恢复的标签是否保留进度
 *
 * 用法：node scripts/v0140-probe-scroll-progress.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_SCROLL_PORT || 9281);
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-probe-scroll-progress.txt";

const lines = [];
const log = (s) => {
  console.log(s);
  lines.push(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
            pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); } });
          });
        },
        close() { try { ws.close(); } catch {} },
      });
  });
}

async function launch(profileDir) {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profileDir,
    },
    stdio: "ignore",
  });
  let cdp = null;
  for (let i = 0; i < 50 && !cdp; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        try {
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", {
            expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`,
            returnByValue: true,
          });
          if (r.result?.result?.value === true) { cdp = c; break; }
          c.close();
        } catch {}
      }
    } catch {}
    if (!cdp) await sleep(400);
  }
  if (!cdp) throw new Error("no tauri target");
  await cdp.send("Page.enable");
  return { child, cdp };
}

const mk = (cdp) => {
  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(() => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  const key2 = async (key, vk, code, modifiers = 0) => {
    for (let i = 0; i < 2; i++) {
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key, modifiers });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key });
      await sleep(70);
    }
    await sleep(700);
  };
  return { ev, key2 };
};

const main = async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-scroll-probe-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const doc = path.join(tmpDir, "长文档.md");
  const parts = ["# 长文档标题", ""];
  for (let i = 1; i <= 200; i++) parts.push(`第 ${i} 段正文内容，用来把文档撑长以便验证滚动位置是否保留。`, "");
  fs.writeFileSync(doc, parts.join("\n"));

  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);

  let session = await launch(profile);
  try {
    const { ev, key2 } = mk(session.cdp);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(doc)}}})); return 1;`);
    await sleep(1800);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.preview"}})); return 1;`);
    await sleep(900);

    const state = () => ev(`
      const c = document.querySelector(".editor-container");
      const ta = document.querySelector("textarea.source-editor");
      const isTa = !!(ta && ta.offsetParent);
      const el = isTa ? ta : c;
      const max = el ? el.scrollHeight - el.clientHeight : -1;
      return {
        mode: isTa ? "edit" : "preview",
        scrollTop: el ? Math.round(el.scrollTop) : -1,
        max,
        percent: max > 0 ? +(el.scrollTop / max).toFixed(3) : null,
        // localStorage 里的进度快照（心跳 5s 才写，仅供观察）
        snapshot: (() => { try { return JSON.parse(localStorage.getItem("lightmd-scroll-progress") || "null"); } catch { return "parse-error"; } })(),
      };
    `);

    const setScroll = (frac) => ev(`
      const ta = document.querySelector("textarea.source-editor");
      const isTa = !!(ta && ta.offsetParent);
      const el = isTa ? ta : document.querySelector(".editor-container");
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = Math.round(max * ${frac});
      el.dispatchEvent(new Event("scroll"));
      return { mode: isTa ? "edit" : "preview", top: el.scrollTop, max };
    `);

    log("=== A. 阅读 → 编辑 → 阅读：进度是否保留 ===");
    log(`初始: ${JSON.stringify(await state())}`);
    log(`滚到 50%: ${JSON.stringify(await setScroll(0.5))}`);
    await sleep(500);
    const a0 = await state();
    log(`阅读@50%: ${JSON.stringify(a0)}`);

    await key2("Control", 17, "ControlLeft", 2); // 双击 Ctrl → 编辑
    const a1 = await state();
    log(`切到编辑: ${JSON.stringify(a1)}`);
    await key2("Control", 17, "ControlLeft", 2); // 双击 Ctrl → 阅读
    await sleep(600);
    const a2 = await state();
    log(`切回阅读: ${JSON.stringify(a2)}`);
    const aKeep = a2.percent !== null && Math.abs(a2.percent - a0.percent) < 0.06;
    log(`${aKeep ? "PASS" : "FAIL"}  A: 阅读↔编辑往返后进度保持（${a0.percent} → ${a2.percent}）`);

    log("");
    log("=== B. 编辑模式内滚到 50% → 阅读 → 回编辑 ===");
    await key2("Control", 17, "ControlLeft", 2); // → 编辑
    await sleep(500);
    log(`滚到 50%: ${JSON.stringify(await setScroll(0.5))}`);
    await sleep(400);
    const b0 = await state();
    await key2("Control", 17, "ControlLeft", 2); // → 阅读
    await sleep(600);
    const b1 = await state();
    log(`切到阅读: ${JSON.stringify(b1)}`);
    await key2("Control", 17, "ControlLeft", 2); // → 编辑
    await sleep(600);
    const b2 = await state();
    log(`回编辑: ${JSON.stringify(b2)}`);
    const bKeep = b2.percent !== null && b0.percent !== null && Math.abs(b2.percent - b0.percent) < 0.06;
    log(`${bKeep ? "PASS" : "FAIL"}  B: 编辑→阅读→编辑 往返后进度保持（${b0.percent} → ${b2.percent}）`);

    log("");
    log("=== C. 关闭标签 → 重新打开同一文件：进度是否保留 ===");
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.preview"}})); return 1;`);
    await sleep(700);
    await setScroll(0.6);
    await sleep(700);
    const c0 = await state();
    log(`关闭前: ${JSON.stringify(c0)}`);
    // 关闭当前标签（Ctrl+W 走 App 的 handleTabClose）
    await session.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, code: "KeyW", key: "w", modifiers: 2 });
    await session.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, code: "KeyW", key: "w" });
    await sleep(1200);
    log(`关闭后: ${JSON.stringify(await state())}`);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(doc)}}})); return 1;`);
    await sleep(2000);
    const c1 = await state();
    log(`重新打开: ${JSON.stringify(c1)}`);
    const cKeep = c1.percent !== null && Math.abs(c1.percent - c0.percent) < 0.06;
    log(`${cKeep ? "PASS" : "FAIL"}  C: 关闭重开后进度保持（关闭前 ${c0.percent} → 重开 ${c1.percent}）`);

    log("");
    log("=== D. 重启应用 → 恢复标签是否保留进度 ===");
    await setScroll(0.42);
    await sleep(6000); // 等 5s 心跳把快照写进 localStorage
    const d0 = await state();
    log(`重启前: ${JSON.stringify(d0)}`);
  } finally {
    try { session.cdp.close(); } catch {}
    try { session.child.kill(); } catch {}
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  }
  await sleep(2000);

  session = await launch(profile);
  try {
    const { ev } = mk(session.cdp);
    await sleep(3500);
    const st = await ev(`
      const c = document.querySelector(".editor-container");
      const ta = document.querySelector("textarea.source-editor");
      const isTa = !!(ta && ta.offsetParent);
      const el = isTa ? ta : c;
      const max = el ? el.scrollHeight - el.clientHeight : -1;
      const tab = (document.querySelector(".tab-item.tab-active .tab-name")?.textContent || "").trim();
      return { tab, mode: isTa ? "edit" : "preview", scrollTop: el ? Math.round(el.scrollTop) : -1, max, percent: max > 0 ? +(el.scrollTop / max).toFixed(3) : null, snapshot: (() => { try { return JSON.parse(localStorage.getItem("lightmd-scroll-progress") || "null"); } catch { return "parse-error"; } })() };
    `);
    log(`重启后: ${JSON.stringify(st)}`);
    const ok = st.percent !== null && Math.abs(st.percent - 0.42) < 0.08;
    log(`${ok ? "PASS" : "FAIL"}  D: 重启后恢复进度（期望 ~0.42，实际 ${st.percent}）`);
  } finally {
    try { session.cdp.close(); } catch {}
    try { session.child.kill(); } catch {}
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf-8");
  console.log(`\n报告：${OUT}`);
};

main().catch((e) => {
  console.error("探针异常：", e);
  process.exit(1);
});
