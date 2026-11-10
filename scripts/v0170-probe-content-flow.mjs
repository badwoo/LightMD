/**
 * LightMD v0.17.0 探针：**CM6 编辑 → 预览 → 导出 的内容贯通**
 *
 * ## 为什么这条最重要
 * 换源码面（textarea → CM6）最大的风险不是"能不能打字"，而是
 * **打进去的字有没有真正进入下游管线**：
 * - 预览 iframe 用 `sourceContent`（React state）渲染；
 * - 导出用同一份 markdown；
 * - 而 CM6 的编辑**不产生 React onChange**（它是 contenteditable），
 *   靠 `SourceSurface.onDidChange` 转成 `applySourceInput` 才进 state。
 *
 * 这条链一旦断了，表现是：**打字看着正常，但预览不更新、导出拿到旧内容** ——
 * 典型的"看不见的坏"，比崩溃更危险（用户以为保存了）。
 *
 * v0.17.0 装配期确实踩过同类问题（"CM6 编辑不上报 → 时间线为空"），
 * 修完后**从未端到端验证过预览/导出侧的内容是否同步**。
 *
 * ## 判定方式
 * 1. 在 CM6 里输入一个唯一标记词（如 `SYNCMARK`）；
 * 2. 等防抖（300ms）后读**预览 iframe** 的正文，断言含该标记；
 * 3. 读**应用内部 markdown 状态**（通过导出链路可观测的部分），断言含该标记。
 *
 * 用法：node scripts/v0170-probe-content-flow.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9486;
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-content-flow.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-content-flow.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

const MARK = "SYNCMARK";
const DOC = [
  "# 内容贯通测试",
  "",
  "起始段落。",
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
  "尾部段落",
  "",
].join("\n");

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.addEventListener("open", () => res({
      send(m, q) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method: m, params: q }));
        return new Promise((a, b) => { pending.set(i, { a, b }); setTimeout(() => { if (pending.delete(i)) b(new Error("timeout " + m)); }, 20000); });
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-flow-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "flow.md");
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
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
      return r.result?.result?.value;
    };

    let loaded = false;
    for (let i = 0; i < 25 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await sleep(600);
      loaded = await ev(`const pm = document.querySelector(".editor-container .ProseMirror"); return !!pm && (pm.textContent || "").indexOf("内容贯通测试") >= 0;`);
    }
    if (!loaded) throw new Error("文档未装入");

    // 进编辑模式 + 打开分屏预览（view.edit 会顺带打开）
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`);
    await sleep(2500);

    const impl = await ev(`return document.querySelector(".cm-editor") ? "cm6" : "textarea";`);
    add("1", "CM6 已启用", impl === "cm6" ? "PASS" : "FAIL", `impl=${impl}`);
    if (impl !== "cm6") throw new Error("CM6 未启用");

    const hasSplit = await ev(`return !!document.querySelector("iframe.split-preview");`);
    add("2", "分屏预览已打开", hasSplit ? "PASS" : "FAIL", hasSplit ? "" : "找不到 iframe.split-preview");
    if (!hasSplit) throw new Error("分屏未打开，无法验证预览同步");

    await ev(`
      window.__ERRS = [];
      window.addEventListener("error", (e) => window.__ERRS.push(String(e.message || e)));
      return true;
    `);

    /** 读预览 iframe 正文 */
    const readPreviewText = () => ev(`
      const f = document.querySelector("iframe.split-preview");
      const d = f && f.contentDocument;
      if (!d || !d.body) return "";
      return (d.body.textContent || "").replace(/\\s+/g, " ").trim();
    `);

    const beforePreview = await readPreviewText();
    log("[probe] 编辑前预览长度=" + (beforePreview || "").length);
    add(
      "3",
      "预览初始内容正确（含文档标题）",
      (beforePreview || "").indexOf("内容贯通测试") >= 0 ? "PASS" : "FAIL",
      `预览前 60 字：${JSON.stringify((beforePreview || "").slice(0, 60))}`,
    );

    // 在 CM6 里输入唯一标记
    const box = await ev(`
      const c = document.querySelector(".cm-content");
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(400);

    // 光标到文档末尾，然后输入标记
    await ev(`const c = document.querySelector(".cm-content"); if (c) c.focus(); return true;`);
    await sleep(200);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 });
    await sleep(25);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "End", code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 });
    await sleep(300);
    await cdp.send("Input.insertText", { text: MARK });
    await sleep(400);
    // 逐字符兜底：若 insertText 未生效，再逐字符输入一次
    if (((await ev(`return Array.from(document.querySelectorAll(".cm-line")).map(l => l.textContent || "").join("")`)) || "").indexOf(MARK) < 0) {
      for (const ch of MARK) {
        await ev(`const c = document.querySelector(".cm-content"); if (c && document.activeElement !== c) c.focus(); return true;`);
        await sleep(60);
        const up = ch.toUpperCase();
        await cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, code: "Key" + up, text: ch, unmodifiedText: ch });
        await sleep(150);
      }
    }
    await sleep(1500); // 等防抖（300ms）+ 渲染

    const cmText = await ev(`return Array.from(document.querySelectorAll(".cm-line")).map(l => l.textContent || "").join(String.fromCharCode(10));`);
    add(
      "4",
      "标记已进入 CM6 编辑器",
      (cmText || "").indexOf(MARK) >= 0 ? "PASS" : "FAIL",
      `CM6 文本含标记 = ${(cmText || "").indexOf(MARK) >= 0}`,
    );

    /**
     * ── 核心判定 1：预览是否同步 ──
     * 预览走 `debouncedSourceContent`（300ms 防抖）→ renderMarkdownHtml。
     * 若 CM6 的编辑没进 state，这里就读不到标记。
     */
    let previewText = "";
    let previewSynced = false;
    for (let i = 0; i < 12; i++) {
      previewText = await readPreviewText();
      if ((previewText || "").indexOf(MARK) >= 0) { previewSynced = true; break; }
      await sleep(500);
    }
    add(
      "5",
      "★ CM6 编辑的内容出现在**分屏预览**里",
      previewSynced ? "PASS" : "FAIL",
      previewSynced
        ? `预览已含 ${MARK}`
        : `预览长度=${(previewText || "").length}，不含 ${MARK}（预览与编辑内容脱节）`,
    );

    /**
     * ── 核心判定 2：文档状态是否同步 ──
     * 通过"切换模式后再切回"来间接验证 state 里存的是新内容：
     * 若 state 未更新，切到阅读模式会看到旧内容。
     */
    await ev(`
      const b = document.querySelector(".mode-switch-btn");
      if (b) b.click();
      return true;
    `);
    await sleep(1800);
    const previewModeText = await ev(`
      const pm = document.querySelector(".editor-container .ProseMirror");
      return pm ? (pm.textContent || "").replace(/\\s+/g, " ") : "";
    `);
    add(
      "6",
      "★ CM6 编辑的内容出现在**阅读模式**（PM 面）",
      (previewModeText || "").indexOf(MARK) >= 0 ? "PASS" : "FAIL",
      (previewModeText || "").indexOf(MARK) >= 0
        ? `阅读面已含 ${MARK}`
        : `阅读面长度=${(previewModeText || "").length}，不含 ${MARK}（state 未同步 → 导出也会拿到旧内容）`,
    );

    const errs = await ev(`return window.__ERRS || []`);
    add("7", "全程无未捕获异常", errs.length === 0 ? "PASS" : "FAIL", errs.length ? JSON.stringify(errs.slice(0, 2)) : "无");

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
    fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), mark: MARK, results }, null, 1), "utf8");
    log(`[probe] 产物：${OUT_JSON}`);
    if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
  }
}

main();
