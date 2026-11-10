/**
 * LightMD v0.17.0 探针：**搜索高亮位置**（设计稿 V 清单最后一项）
 *
 * ## 为什么需要
 * 设计稿 §3.4 V 阶段要求探针覆盖「搜索高亮位置」。此前主探针里这项被**移除**了，
 * 原因是当时的实现用 `set value + dispatch input` 直接写搜索框，
 * 把应用状态搞坏了（`.cm-editor` 被销毁）—— 那是**探针自伤**，不是产品问题。
 *
 * 本探针改用**真实键盘输入**（CDP `Input.dispatchKeyEvent` + `char`），
 * 走完整输入链路，不绕过任何 React/受控逻辑。
 *
 * ## 判定项（对应 A3 报告的预期「比 textarea 更准」）
 * 1. 搜索面板能打开（`edit.find` 命令）
 * 2. 输入关键词后，CM6 侧出现 `cm-source-search-hit` Decoration
 * 3. Decoration 数量 == 实际命中数
 * 4. **高亮位置精确**：Decoration 覆盖的文本 == 搜索词（这是"位置准确"的直接证据）
 * 5. 高亮不写进文档（`getText()` 不含标记）
 *
 * 用法：node scripts/v0170-probe-search-highlight.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9477;
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-search-highlight.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-search-highlight.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

/** 搜索词在文档中出现 3 次，且周围文本可区分，便于验证"位置精确" */
const NEEDLE = "SEARCHNEEDLE";
const DOC = [
  "# 搜索高亮测试",
  "",
  `第一处 ${NEEDLE} 前缀文本`,
  "",
  "普通段落，不含关键词。",
  "",
  `第二处 ${NEEDLE} 中间`,
  "",
  "```ts",
  "const x = 1;",
  "```",
  "",
  `第三处 ${NEEDLE} 结尾`,
  "",
  "尾部段落",
  "",
].join("\n");
const EXPECTED_HITS = 3;

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-search-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "search.md");
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

    const errors = [];
    cdp.send("Runtime.enable");
    (function hook(){ const ws=null; })();
  const ev = async (body) => {
      const r = await cdp.send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
      return r.result?.result?.value;
    };

    // 打开 + 编辑模式（不要分屏）
    let loaded = false;
    for (let i = 0; i < 25 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await sleep(650);
      loaded = await ev(`const pm = document.querySelector(".editor-container .ProseMirror"); return !!pm && (pm.textContent || "").indexOf("搜索高亮测试") >= 0;`);
    }
    if (!loaded) throw new Error("文档未装入");
    await ev(`
      const b = document.querySelector(".mode-switch-btn");
      if (b && (b.getAttribute("aria-label") || "").indexOf("编辑") >= 0) b.click();
      return true;
    `);
    await sleep(1800);
    if (await ev(`return !!document.querySelector("iframe.split-preview");`)) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
      await sleep(1200);
    }

    const impl = await ev(`return document.querySelector(".cm-editor") ? "cm6" : "textarea";`);
    add("1", "CM6 已启用", impl === "cm6" ? "PASS" : "FAIL", `impl=${impl}`);
    if (impl !== "cm6") throw new Error("CM6 未启用");

    const textBefore = await ev(`return Array.from(document.querySelectorAll(".cm-line")).map(l => l.textContent || "").join(String.fromCharCode(10));`);
    if (textBefore.indexOf(NEEDLE) < 0) throw new Error("文档未渲染进 CM6");

    // ── 打开搜索面板（命令总线，正式入口）──
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "edit.find" } })); return true;`);
    await sleep(900);

    const panelInfo = await ev(`
      const inp = document.querySelector(".search-row .search-input");
      if (!inp) return { found: false };
      inp.focus();
      return { found: true, active: document.activeElement === inp, placeholder: inp.getAttribute("placeholder") || "" };
    `);
    add("2", "搜索面板已打开且输入框获得焦点", panelInfo.found && panelInfo.active ? "PASS" : "FAIL", JSON.stringify(panelInfo));
    if (!panelInfo.found) throw new Error("搜索面板未打开");

    /**
     * ── 用**真实键盘输入**填写搜索词 ──
     * 不要用 `set value + dispatch input`（此前主探针就是这么把应用状态搞坏的）。
     * 逐字符发 keyDown/char/keyUp，走完整输入链路。
     */
    await ev(`window.__ERRS=[];window.addEventListener("error",function(e){window.__ERRS.push(String(e.message||e)+ (e.error&&e.error.stack?" | STACK: "+String(e.error.stack).split(String.fromCharCode(10)).slice(0,4).join(" << "):""))});window.onunhandledrejection=function(e){window.__ERRS.push("rejection:"+String(e.reason))};return true;`);
    log("[probe] 输入前状态=" + JSON.stringify(await ev(`return { cmEditor: !!document.querySelector(".cm-editor"), inputs: document.querySelectorAll(".search-input").length, active: (document.activeElement&&(document.activeElement.className||document.activeElement.tagName))||"" }`)));
    /**
     * 输入搜索词。
     *
     * 时序说明：搜索框是受控 input，每个字符触发搜索 + 重渲染，焦点可能被抢。
     * 做法：逐字符输入，**每字符后校验当前值**，不一致就重来整词（最多 5 轮）。
     * 这比"猜一个 sleep 值"稳 —— 实测 90ms 仍会偶发丢字符。
     */
    const readVal = () => ev(`const i = document.querySelector(".search-row .search-input"); return i ? i.value : null;`);
    // 先清空
    await ev(`
      const i = document.querySelector(".search-row .search-input");
      if (i) { i.focus(); i.select(); }
      return true;
    `);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
    await sleep(400);

    let typed = "";
    for (let round = 0; round < 5 && typed !== NEEDLE; round++) {
      // 清空重来
      await ev(`
        const i = document.querySelector(".search-row .search-input");
        if (i) { i.focus(); i.select(); }
        return true;
      `);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
      await sleep(350);

      for (const ch of NEEDLE) {
        await ev(`const i = document.querySelector(".search-row .search-input"); if (i && document.activeElement !== i) i.focus(); return true;`);
        await sleep(50);
        const upper = ch.toUpperCase();
        const code = "Key" + upper;
        const vk = upper.charCodeAt(0);
        await cdp.send("Input.dispatchKeyEvent", { type: "char", key: ch, code, text: ch, unmodifiedText: ch });
        await sleep(130);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        await sleep(60);
      }
      await sleep(900);
      typed = (await readVal()) ?? "";
      log(`[probe] 第 ${round + 1} 轮输入结果：${JSON.stringify(typed)}`);
    }
    await sleep(900);

    const diag = await ev(`
      return {
        cmEditor: !!document.querySelector(".cm-editor"),
        cmLines: document.querySelectorAll(".cm-line").length,
        searchRows: document.querySelectorAll(".search-row").length,
        inputs: document.querySelectorAll(".search-input").length,
        srchValue: (document.querySelector(".search-row .search-input") || {}).value ?? "(无元素)",
        active: (document.activeElement && (document.activeElement.className || document.activeElement.tagName)) || "",
      };
    `);
    /**
     * ── 判定：应用**未崩溃**（本探针最重要的产出）──
     *
     * 本探针最初就是因为这项而存在的：搜索定位当前项曾经调用
     * `textarea.setSelectionRange(...)`，而 A3 之后 `sourceTextareaRef`
     * 在 CM6 下是中性 div → `TypeError: setSelectionRange is not a function`
     * → 错误边界接管整个界面，用户看到「界面渲染出错」。
     * 随后还暴露第二处：`AiAssistPane` 的 beforeinput 把 div 当 textarea 读 `.value`
     * → `isInCodeBlock(undefined)` → `undefined.substring` 抛异常。
     *
     * 两条都已修。本断言确保**不会回归**：只要编辑器还在、且没有未捕获异常，
     * 就说明这两个崩溃点保持修好状态。
     */
    const pageErrors = await ev(`return window.__ERRS || []`);
    const stillAlive = await ev(`
      return {
        cmEditor: !!document.querySelector(".cm-editor"),
        cmLines: document.querySelectorAll(".cm-line").length,
        errorBoundary: (document.body.textContent || "").indexOf("界面渲染出错") >= 0,
      };
    `);
    add(
      "2b",
      "★ 输入搜索词后应用未崩溃（曾因 setSelectionRange/substring 崩溃）",
      pageErrors.length === 0 && stillAlive.cmEditor && !stillAlive.errorBoundary ? "PASS" : "FAIL",
      pageErrors.length > 0
        ? `未捕获异常 ${pageErrors.length} 个：${JSON.stringify(pageErrors.slice(0, 2))}`
        : `编辑器存活=${stillAlive.cmEditor} 错误边界=${stillAlive.errorBoundary}`,
    );
    if (pageErrors.length > 0) log("[probe] 页面错误明细：" + JSON.stringify(pageErrors.slice(0, 3)));

    const inputValue = await ev(`const inp = document.querySelector(".search-row .search-input"); return inp ? inp.value : null;`);
    add(
      "3",
      "搜索词已输入搜索框",
      inputValue === NEEDLE ? "PASS" : "FAIL",
      `实际值=${JSON.stringify(inputValue)}`,
    );

    /**
     * ── 核心：CM6 侧 Decoration 高亮 ──
     * 类名来自 CmSourceSurface：`searchMark = Decoration.mark({ class: "cm-source-search-hit" })`
     */
    const hl = await ev(`
      const hits = Array.from(document.querySelectorAll(".cm-source-search-hit"));
      const actives = Array.from(document.querySelectorAll(".cm-source-search-hit-active"));
      // 每段高亮的实际文本 —— 位置精确性的直接证据
      const texts = hits.map((el) => el.textContent || "");
      const editor = document.querySelector(".cm-editor");
      return {
        hitCount: hits.length,
        activeCount: actives.length,
        texts,
        docTextLen: (editor ? editor.textContent || "" : "").length,
      };
    `);
    log("[probe] 高亮明细：" + JSON.stringify({ hitCount: hl.hitCount, activeCount: hl.activeCount, texts: hl.texts }));

    add(
      "4",
      `CM6 Decoration 高亮出现（预期 ${EXPECTED_HITS} 处）`,
      hl.hitCount === EXPECTED_HITS ? "PASS" : "FAIL",
      `命中=${hl.hitCount} 当前项=${hl.activeCount}`,
    );

    /**
     * ── 判定 5（关键）：高亮**位置精确** ──
     * 每段高亮覆盖的文本必须恰好等于搜索词。
     * 这是报告「Decoration 用真实文档范围，比 textarea 的 mirror 逐像素对齐更准」的直接证据。
     */
    if (hl.hitCount > 0) {
      const allExact = hl.texts.every((t) => t === NEEDLE);
      add(
        "5",
        "高亮位置精确（每段高亮文本 === 搜索词）",
        allExact ? "PASS" : "FAIL",
        allExact ? `${hl.hitCount} 段全部精确匹配` : `实际文本=${JSON.stringify(hl.texts)}`,
      );
    }

    /**
     * ── 判定 6：高亮不写进文档 ──
     * Decoration 是视图层，绝不能改动文档文本。
     */
    const textAfter = await ev(`return Array.from(document.querySelectorAll(".cm-line")).map(l => l.textContent || "").join(String.fromCharCode(10));`);
    add(
      "6",
      "高亮不写入文档（Decoration 纯视图层）",
      textAfter === textBefore ? "PASS" : "FAIL",
      textAfter === textBefore ? "文档文本未变" : `文本被改动（${textBefore.length}→${textAfter.length}）`,
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
    fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), needle: NEEDLE, expectedHits: EXPECTED_HITS, results }, null, 1), "utf8");
    log(`[probe] 产物：${OUT_JSON}`);
    if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
  }
}

main();
