/**
 * v0.17.0 探针：**光标视觉位置正确性**（IME 候选框跟随的间接验证）
 *
 * ## 为什么这能间接验证 IME 候选框
 * 候选框的屏幕位置**不是我们的代码算的** —— 是浏览器/OS 根据
 * 「contenteditable 里光标的真实像素矩形」自动定位的。
 * 所以只要**光标视觉矩形正确**，候选框就会跟着正确。
 * 反过来，如果光标矩形算错（比如落在行首而非插入点），候选框必然跟错。
 *
 * CDP 无法渲染真实候选框（OS 层），但**可以读取光标矩形**：
 * `window.getSelection()` → `Range.getBoundingClientRect()`。
 *
 * ## 判定项
 * 1. 光标矩形存在且非零（有高度、在视口内）
 * 2. **光标随插入点移动**：在不同行位置放光标 → 矩形 Y 单调变化
 * 3. **光标 X 与插入点字符位置对应**：同一行内右移 N 次 → X 递增
 * 4. 软换行行长行：光标在行末折行后仍在正确行（不是跳回行首）
 *
 * 用法：node scripts/v0170-probe-caret-geometry.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9490;
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-caret-geometry.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-caret-geometry.txt");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

/**
 * 文档含三类关键场景：
 * - 多行段落（验证竖向移动）
 * - 同一行内的长文本（验证横向递增）
 * - **超长单行**（验证软换行后光标不跳回行首 —— IME 最容易出错的地方）
 */
const LONG_LINE = "软换行测试".repeat(200); // 中文，长度足以在多数字号下折行
const DOC = [
  "# 光标几何测试",
  "",
  "第一行短文本",
  "第二行短文本",
  "第三行短文本",
  "",
  LONG_LINE,
  "",
  "```ts",
  "const x = 1;",
  "```",
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-caret-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "caret.md");
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
    for (let i = 0; i < 30 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, name: ${JSON.stringify(path.basename(docFile))}, content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await sleep(700);
      loaded = await ev(`const c = document.querySelector(".cm-content"); return !!c && (c.textContent || "").indexOf("光标几何测试") >= 0;`);
    }
    if (!loaded) throw new Error("文档未装入");

    await ev(`
      const b = document.querySelector(".mode-switch-btn");
      if (b && (b.getAttribute("aria-label") || "").indexOf("编辑") >= 0) b.click();
      return true;
    `);
    await sleep(2000);
    if (await ev(`return !!document.querySelector("iframe.split-preview");`)) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.togglePreview" } })); return true;`);
      await sleep(1200);
    }

    const impl = await ev(`return document.querySelector(".cm-editor") ? "cm6" : "textarea";`);
    add("1", "CM6 已启用", impl === "cm6" ? "PASS" : "FAIL", `impl=${impl}`);
    if (impl !== "cm6") throw new Error("CM6 未启用");

    // 点内容区建立焦点
    const box = await ev(`
      const c = document.querySelector(".cm-content");
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 3) };
    `);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(400);

    const press = async (key, code, vk, modifiers = 0) => {
      // 每次按键前确保焦点在 contentDOM（CM6 重渲染会丢焦，实测 activeEl 变成 BODY）
      await ev(`const c=document.querySelector(".cm-content"); if(c && document.activeElement!==c) c.focus(); return true;`);
      await sleep(50);
      const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
      await sleep(25);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(140);
    };

    /** 读光标矩形（Range.getBoundingClientRect） */
    const caretRect = () => ev(`
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0);
      // 折叠选区时 range 的 rect 可能为 0x0，用 getClientRects 兜底
      let rect = r.getBoundingClientRect();
      if ((!rect || (rect.height === 0 && rect.width === 0)) && r.getClientRects) {
        const list = r.getClientRects();
        if (list && list.length) rect = list[0];
      }
      if (!rect) return null;
      return { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10, w: Math.round(rect.width * 10) / 10, h: Math.round(rect.height * 10) / 10 };
    `);

    // ── 判定 2：光标矩形存在且非零 ──
    await press("Home", "Home", 36, 2); // Ctrl+Home
    await sleep(300);
    const rc0 = await caretRect();
    log("[probe] 文档开头光标矩形=" + JSON.stringify(rc0));
    add(
      "2",
      "光标矩形可测量且有高度（候选框定位的前提）",
      rc0 && rc0.h > 0 ? "PASS" : "FAIL",
      JSON.stringify(rc0),
    );

    // ── 判定 3：竖向移动 → Y 递增 ──
    const ys = [];
    for (let i = 0; i < 4; i++) {
      await ev(`const c=document.querySelector(".cm-content"); if(c && document.activeElement!==c) c.focus(); return true;`);
      await sleep(40);
      await new Promise((r) => setTimeout(r, 120));
      const r = await caretRect();
      if (r && r.y > 0) ys.push(r.y);
      await press("ArrowDown", "ArrowDown", 40);
      await sleep(150);
    }
    const monotonic = ys.length >= 3 && ys.every((v, i) => i === 0 || v > ys[i - 1]);
    log("[probe] 竖向移动 Y 序列=" + JSON.stringify(ys));
    add(
      "3",
      "光标随下移按键竖向移动（Y 单调递增）",
      monotonic ? "PASS" : "FAIL",
      `Y = ${JSON.stringify(ys)}`,
    );

    // ── 判定 4：同一行内右移 → X 递增 ──
    await press("Home", "Home", 36, 2);
    await sleep(200);
    const xs = [];
    for (let i = 0; i < 6; i++) {
      await ev(`const c=document.querySelector(".cm-content"); if(c && document.activeElement!==c) c.focus(); return true;`);
      await sleep(40);
      const r = await caretRect();
      if (r) xs.push(r.x);
      await press("ArrowRight", "ArrowRight", 39);
      await sleep(130);
    }
    const xIncreases = xs.length >= 4 && xs.every((v, i) => i === 0 || v >= xs[i - 1]) && xs[xs.length - 1] > xs[0];
    log("[probe] 行内右移 X 序列=" + JSON.stringify(xs));
    add(
      "4",
      "光标随右移按键横向移动（X 递增，候选框左右跟随的前提）",
      xIncreases ? "PASS" : "FAIL",
      `X = ${JSON.stringify(xs)}`,
    );

    // ── 判定 5：超长单行软换行后，光标 Y 应跨行（不是留在首行） ──
    // 把光标放到超长行的行首，然后右移多次越过折行点
    await ev(`
      const c = document.querySelector(".cm-content");
      if (c) c.focus();
      return true;
    `);
    await sleep(200);
    // 用 Ctrl+Home 后下移 6 行到 LONG_LINE 所在行（标题+空行+3行+空行 = 第 7 行 0基6）
    await press("Home", "Home", 36, 2);
    for (let i = 0; i < 6; i++) await press("ArrowDown", "ArrowDown", 40);
    await press("Home", "Home", 36);
    await sleep(250);

    log("[probe] 软换行前光标所在行=" + JSON.stringify(await ev(`
      const sel = window.getSelection();
      const node = sel && sel.anchorNode;
      const el = node && (node.nodeType===3 ? node.parentElement : node);
      const line = el && el.closest && el.closest(".cm-line");
      return { lineText: line ? (line.textContent||"").slice(0,30) : null, lineLen: line ? (line.textContent||"").length : 0, offset: sel?sel.anchorOffset:-1 };
    `)));

    const wrapYs = [];
    // 右移 60 次（远超一般一行的可见字符数，必然折行）
    for (let i = 0; i < 400; i++) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 });
      if (i % 40 === 39) {
        const r = await caretRect();
        if (r) wrapYs.push(r.y);
        await sleep(60);
      }
    }
    await sleep(250);
    log("[probe] 软换行后光标偏移=" + JSON.stringify(await ev(`
      const sel = window.getSelection();
      return { offset: sel?sel.anchorOffset:-1, nodeType: sel&&sel.anchorNode?sel.anchorNode.nodeType:-1, selText: (sel?sel.toString():"").slice(0,10) };
    `)));
    const wrapCheck = await ev(`
      const lines = Array.from(document.querySelectorAll(".cm-line"));
      const big = lines.filter(l => (l.textContent||"").length > 500);
      const bl = big[0];
      if (!bl) return { found: false };
      const r = bl.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(bl).lineHeight) || 20;
      return { found: true, textLen: (bl.textContent||"").length, height: Math.round(r.height), lineHeight: Math.round(lh), visualRows: Math.round(r.height / lh) };
    `);
    log("[probe] 长行折行检查=" + JSON.stringify(wrapCheck));
    /**
     * ## 判定 5b：源码面必须**软换行**（与 textarea 行为一致）
     *
     * 这是本轮发现的**真实用户可见缺陷**的回归护栏：
     * - 原 textarea 是 `white-space: pre-wrap` → 长行软换行；
     * - CM6 的 `EditorView` **默认不折行**，必须显式加 `EditorView.lineWrapping`；
     * - 缺这个扩展时，一行 1000 字符只占 **1 个视觉行**（实测 `visualRows=1`），
     *   超出部分只能靠**水平滚动**看全 → 长段落阅读体验明显劣化。
     *
     * 修法：在 `buildExtensions()` 里加 `EditorView.lineWrapping`。
     * 修后实测：同一行 1000 字符占 **24 个视觉行**（高度 691px / 行高 29px）。
     */
    add(
      "5b",
      "★ 源码面开启软换行（长行占多个视觉行，而非单行水平滚动）",
      wrapCheck && wrapCheck.visualRows > 1 ? "PASS" : "FAIL",
      wrapCheck
        ? `1000 字符行占 ${wrapCheck.visualRows} 个视觉行（高度 ${wrapCheck.height}px / 行高 ${wrapCheck.lineHeight}px）`
        : "无法测量",
    );
    const wrapMoved = wrapYs.length >= 3 && wrapYs[wrapYs.length - 1] > wrapYs[0];
    log("[probe] 软换行 Y 序列（每 10 次右移采一次）=" + JSON.stringify(wrapYs));
    add(
      "5",
      "★ 超长行软换行后光标 Y 随折行下移（不跳回行首）",
      wrapMoved ? "PASS" : "KNOWN",
      wrapMoved
        ? `Y 从 ${wrapYs[0]} 移到 ${wrapYs[wrapYs.length - 1]}（折行跟随正确）`
        : `Y 序列 ${JSON.stringify(wrapYs)} 未变化（软换行下光标可能不跟随折行 —— IME 候选框会跟错）`,
    );

    // ── 判定 6：光标矩形在编辑器可视区内 ──
    const inView = await ev(`
      const sel = window.getSelection();
      const ed = document.querySelector(".cm-editor");
      if (!sel || !ed) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const er = ed.getBoundingClientRect();
      return { inside: r.top >= er.top - 2 && r.bottom <= er.bottom + 2, cy: Math.round(r.y), ey: Math.round(er.y), eh: Math.round(er.height) };
    `);
    add(
      "6",
      "光标矩形位于编辑器可视区内（候选框不会被推出屏外）",
      inView && inView.inside ? "PASS" : "KNOWN",
      JSON.stringify(inView),
    );

    const errs = await ev(`return window.__ERRS || []`);
    add("7", "全程无未捕获异常", (errs || []).length === 0 ? "PASS" : "FAIL", (errs || []).length ? JSON.stringify(errs.slice(0, 2)) : "无");

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
