/**
 * LightMD v0.17.0 探针：**专注模式遮罩 + 打字机**
 *
 * ## 为什么需要（设计稿 V 阶段清单的最后一个未验证项）
 * 设计稿 §3.4 V 阶段要求实机探针覆盖「专注模式遮罩 / 打字机」，
 * 主探针里这两项一直是 `KNOWN`（"未开启专注模式，非判定失败"）——
 * 即**从未真正验证过**。本探针补上。
 *
 * ## 背景（A3 报告 §3 / §4 的登记）
 * - 打字机：报告判定「CM6 下实际不工作」（事件绑定缺失），列为**已知用户可见缺陷**；
 * - 专注遮罩：报告判定「部分工作」（遮罩随内容重绘，但光标移动不一定即时跟随）。
 *
 * 本探针要**证实或推翻**这两条判断，而不是直接引用报告。
 *
 * ## 判定项
 * 1. 专注模式开关生效 → `.source-focus-overlay` 存在且可见
 * 2. 遮罩随内容重绘（改变光标位置后遮罩几何变化）
 * 3. 打字机开关生效（不崩、不改变文本）
 * 4. 打字机是否真的滚动（报告说 CM6 下不工作 → 预期 KNOWN）
 *
 * 用法：node scripts/v0170-probe-focus-typewriter.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9476;
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-focus-typewriter.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-focus-typewriter.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

/** 需要足够长才能滚动，同时含结构块（NodeView 反查用） */
function makeDoc() {
  const parts = ["# 专注模式测试", ""];
  for (let i = 1; i <= 40; i++) {
    parts.push(`## 第 ${i} 节`, "", `第 ${i} 节正文段落，用于制造可滚动的行数。`, "");
  }
  parts.push("```ts", "const x = 1;", "```", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "");
  return parts.join("\n");
}
const DOC = makeDoc();

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => res({
      send(m, q) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method: m, params: q }));
        return new Promise((a, b) => { pending.set(i, { a, b }); setTimeout(() => { if (pending.delete(i)) b(new Error("timeout " + m)); }, 30000); });
      },
      close() { ws.close(); },
    }));
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const it = pending.get(m.id); if (!it) return;
      pending.delete(m.id); m.error ? it.b(new Error(JSON.stringify(m.error))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws error")));
  });
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  const hm = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!hm) throw new Error("dist 找不到入口 hash");
  if (!fs.readFileSync(EXE).includes(Buffer.from(hm[1]))) {
    throw new Error(`exe 内联 dist 不一致（找不到 ${hm[1]}）→ 请 npx tauri build --no-bundle`);
  }
  log(`[probe] exe 内联 dist 校验通过：${hm[1]}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-focus-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "focus.md");
  fs.writeFileSync(docFile, DOC, "utf8");

  let child = null, cdp = null;
  const results = [];
  const add = (id, name, status, detail) => {
    results.push({ id, name, status, detail });
    const tag = status === "PASS" ? "PASS " : status === "KNOWN" ? "KNOWN" : "FAIL ";
    log(`${tag} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    child = spawn(EXE, [], {
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile },
      stdio: "ignore",
    });
    for (let i = 0; i < 140 && !cdp; i++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })).json();
        for (const t of targets) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true });
          if (r.result?.result?.value) { cdp = c; break; }
          c.close();
        }
      } catch { }
      if (!cdp) await sleep(350);
    }
    if (!cdp) throw new Error("找不到 CDP target");

    const ev = async (body) => {
      const r = await cdp.send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
      return r.result?.result?.value;
    };

    // 打开 + 编辑模式（不要分屏，避免 iframe 抢焦点）
    let loaded = false;
    for (let i = 0; i < 25 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await sleep(650);
      loaded = await ev(`const pm = document.querySelector(".editor-container .ProseMirror"); return !!pm && (pm.textContent || "").indexOf("第 40 节") >= 0;`);
    }
    if (!loaded) throw new Error("文档未装入");
    await ev(`
      const b = document.querySelector(".mode-switch-btn");
      if (b && (b.getAttribute("aria-label") || "").indexOf("编辑") >= 0) b.click();
      return true;
    `);
    await sleep(1800);
    // 关掉分屏（若有）
    if (await ev(`return !!document.querySelector("iframe.split-preview");`)) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
      await sleep(1200);
    }

    const impl = await ev(`return document.querySelector(".cm-editor") ? "cm6" : "textarea";`);
    add("1", "CM6 已启用", impl === "cm6" ? "PASS" : "FAIL", `impl=${impl}`);
    if (impl !== "cm6") throw new Error("CM6 未启用");

    // ── 专注模式 ──
    const beforeFocus = await ev(`
      const ov = document.querySelector(".source-focus-overlay");
      return { exists: !!ov, visible: ov ? (ov.getBoundingClientRect().height > 0) : false };
    `);
    log("[probe] 开启前遮罩：" + JSON.stringify(beforeFocus));

    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.toggleFocusMode" } })); return true;`);
    await sleep(900);

    const afterFocus = await ev(`
      const ov = document.querySelector(".source-focus-overlay");
      if (!ov) return { exists: false };
      const r = ov.getBoundingClientRect();
      const cs = getComputedStyle(ov);
      return { exists: true, visible: r.height > 0, w: Math.round(r.width), h: Math.round(r.height), display: cs.display, opacity: cs.opacity };
    `);
    log("[probe] 开启后遮罩：" + JSON.stringify(afterFocus));
    add(
      "2",
      "专注模式开关生效（.source-focus-overlay 出现且可见）",
      afterFocus.exists && afterFocus.visible ? "PASS" : "FAIL",
      `exists=${afterFocus.exists} visible=${afterFocus.visible} 几何=${afterFocus.w}x${afterFocus.h}`,
    );

    // ── 判定 3：遮罩随光标位置重绘 ──
    if (afterFocus.exists) {
      const geo1 = await ev(`const ov = document.querySelector(".source-focus-overlay"); const r = ov.getBoundingClientRect(); return { h: Math.round(r.height), bg: (ov.style.backgroundImage || "").length };`);
      // 移动光标到文档中部（点击内容区中央）
      const box = await ev(`
        const c = document.querySelector(".cm-content");
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      `);
      if (box) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
        }
        await sleep(700);
      }
      const geo2 = await ev(`const ov = document.querySelector(".source-focus-overlay"); const r = ov.getBoundingClientRect(); return { h: Math.round(r.height), bg: (ov.style.backgroundImage || "").length };`);
      log(`[probe] 遮罩几何：移动前 ${JSON.stringify(geo1)} → 移动后 ${JSON.stringify(geo2)}`);
      add(
        "3",
        "遮罩随光标移动重绘（几何/内容有变化）",
        geo1.bg !== geo2.bg || geo1.h !== geo2.h ? "PASS" : "KNOWN",
        geo1.bg !== geo2.bg ? "遮罩渐变已更新（background-image 变化）" : "遮罩渐变未变（报告已登记「不一定即时跟随」）",
      );
    }

    // 关掉专注模式
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.toggleFocusMode" } })); return true;`);
    await sleep(600);

    // ── 打字机 ──
    const beforeType = await ev(`
      const ed = document.querySelector(".cm-editor");
      const sc = ed && ed.querySelector(".cm-scroller");
      return { scrollTop: sc ? Math.round(sc.scrollTop) : -1, textLen: (document.querySelector(".cm-editor") || {}).textContent?.length || 0 };
    `);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.toggleTypewriter" } })); return true;`);
    await sleep(800);
    const afterToggle = await ev(`
      const ed = document.querySelector(".cm-editor");
      const sc = ed && ed.querySelector(".cm-scroller");
      return { scrollTop: sc ? Math.round(sc.scrollTop) : -1, textLen: (document.querySelector(".cm-editor") || {}).textContent?.length || 0 };
    `);
    add(
      "4",
      "打字机开关不破坏内容（文本长度不变）",
      beforeType.textLen === afterToggle.textLen ? "PASS" : "FAIL",
      `文本 ${beforeType.textLen} → ${afterToggle.textLen}`,
    );

    /**
     * 判定 5：打字机是否真的居中滚动。
     *
     * 报告判定「CM6 下打字机不工作」，预期此判定为 KNOWN。
     * 验证方式：把光标放到文档中部并输入字符，观察 scrollTop 是否调整。
     */
    const sc0 = await ev(`
      const ed = document.querySelector(".cm-editor");
      const sc = ed && ed.querySelector(".cm-scroller");
      if (!sc) return null;
      // 先滚到顶部
      sc.scrollTop = 0;
      sc.dispatchEvent(new Event("scroll", { bubbles: false }));
      await new Promise((r) => setTimeout(r, 300));
      return { scrollTop: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };
    `);
    await sleep(300);
    // 点内容区中部建立光标，然后输入
    const midBox = await ev(`
      const c = document.querySelector(".cm-content");
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    if (midBox) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", { type, x: midBox.x, y: midBox.y, button: "left", clickCount: 1 });
      }
      await sleep(300);
    }
    // 输入一个字符触发打字机
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: "a", unmodifiedText: "a" });
    await cdp.send("Input.dispatchKeyEvent", { type: "char", key: "a", code: "KeyA", text: "a", unmodifiedText: "a" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await sleep(700);
    const sc1 = await ev(`
      const ed = document.querySelector(".cm-editor");
      const sc = ed && ed.querySelector(".cm-scroller");
      if (!sc) return null;
      return { scrollTop: Math.round(sc.scrollTop) };
    `);
    log(`[probe] 打字机：输入前 scrollTop=${sc0?.scrollTop} → 输入后 ${sc1?.scrollTop}`);
    add(
      "5",
      "打字机是否真正居中滚动（报告判定：CM6 下不工作）",
      sc1 && sc0 && sc1.scrollTop !== sc0.scrollTop ? "PASS" : "KNOWN",
      sc1 && sc0
        ? (sc1.scrollTop !== sc0.scrollTop
            ? `scrollTop 已调整 ${sc0.scrollTop}→${sc1.scrollTop}（打字机生效）`
            : `scrollTop 未变（${sc0.scrollTop}）—— 与报告判定「CM6 下打字机不工作」一致`)
        : "无法读取 scrollTop",
    );

    log("");
    const fails = results.filter((r) => r.status === "FAIL");
    log(`[probe] PASS=${results.filter((r) => r.status === "PASS").length} KNOWN=${results.filter((r) => r.status === "KNOWN").length} FAIL=${fails.length}`);
  } catch (err) {
    log(`[probe] 异常：${err?.message || String(err)}`);
    results.push({ id: "E", name: "探针执行", status: "FAIL", detail: err?.message || String(err) });
  } finally {
    try { cdp?.close(); } catch { }
    try { child?.kill(); } catch { }
    await sleep(400);
    try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { }
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 1), "utf8");
    log(`[probe] 产物：${OUT_JSON}`);
    if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
  }
}

main();
