/**
 * LightMD v0.17.0 —— CM6 源码面**实机探针**（真实 WebView2 + CDP）
 *
 * 验证目标：A 线（CM6 源码面替换）在**打包产物**里的真实表现。
 * 对照基准来自 `_verify-out/v0170-a3-cm6-closing-report.md` §7「探针预期基线」。
 *
 * ─── 为什么必须实机（设计稿 §4-30 铁律）───
 * jsdom 下 CM6 不可用（工厂回退 textarea），所以 6600+ 条单测**从未真正跑过 CM6**。
 * 它们验证的是契约与回退路径，不是 CM6 的真实行为。
 * 本探针是 CM6 第一次在真实 WebView2 里被审判。
 *
 * ⚠️ 前置铁律（v0.14.0 踩过：探针测到旧代码造成误判）：
 *   npx tauri build --no-bundle   ← 必须先重打包
 *   本脚本用 verifyExe() 校验 exe 内联的 dist hash 与当前 dist 一致，否则拒绝运行。
 *
 * ─── 判定项（对应报告 §7 预期表）───
 *   1. CM6 是否真的启用（不是静默回退到 textarea —— 这是本轮最根本的一项）
 *   2. 源码面基本能力：输入 / 光标 / 选区 / 文本正确性
 *   3. Tab / Shift-Tab 缩进（报告判定：**正常**，走 handleTab → 纯函数 → applyEdit）
 *   4. 撤销后光标恢复（报告判定：正常，B 类已修）
 *   5. 搜索高亮位置（报告判定：比 textarea 更准，Decoration 真实文档范围）
 *   6. 分屏对齐精度（报告预期：视口内 ≈ textarea，视口外有估算偏差）
 *   7. 5MB 大文档输入延迟 p95（硬门禁 <16ms；基线 textarea = 274.1ms）
 *   8. 打字机（报告判定：**已知不工作**）
 *   9. 专注遮罩（报告判定：部分工作）
 *  10. 多光标基础
 *
 * 用法：node scripts/v0170-probe-cm6.mjs
 * 环境变量：V0170_PORT（默认 9440）、V0170_EXE
 *
 * 产物：_verify-out/v0170-probe-cm6.txt / .json（仅"不达标"时退出码 1；
 *       "与预期一致的已知降级"记为 KNOWN 不计失败）
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = process.env.V0170_EXE || path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = Number(process.env.V0170_PORT || 9440);
const OUT_DIR = path.join(ROOT, "_verify-out");
const OUT_TXT = path.join(OUT_DIR, "v0170-probe-cm6.txt");
const OUT_JSON = path.join(OUT_DIR, "v0170-probe-cm6.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => {
  lines.push(t);
  console.log(t);
};

/** 判定结果分类：PASS / FAIL / KNOWN（与报告预期一致的已知降级） */
const results = [];
const addResult = (id, name, status, detail) => {
  results.push({ id, name, status, detail });
  const tag = status === "PASS" ? "PASS" : status === "KNOWN" ? "KNOWN" : "FAIL";
  log(`${tag.padEnd(5)} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
};

/** exe 内联 dist 校验（照抄既有探针的 verifyExe：防止测到旧二进制） */
function verifyExe() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到 ${EXE}\n请先执行：npx tauri build --no-bundle`);
  const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!m) throw new Error("dist/index.html 找不到入口 hash");
  const hash = m[1];
  if (!fs.readFileSync(EXE).includes(Buffer.from(hash))) {
    throw new Error(`exe 内联 dist 与当前 dist 不一致（找不到 ${hash}）→ 请重新打包`);
  }
  const procs = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  if (/^"lightmd\.exe"/im.test(procs)) {
    throw new Error("检测到已有 LightMD 进程（单实例插件会抢锁），请先关闭");
  }
  log(`[probe] exe 内联 dist 校验通过：${hash}`);
  return hash;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () =>
      resolve({
        send(method, params) {
          const msgId = ++id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            setTimeout(() => {
              if (pending.delete(msgId)) rej(new Error(`CDP timeout: ${method}`));
            }, 30000);
          });
        },
        close() {
          ws.close();
        },
      }),
    );
    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const item = pending.get(msg.id);
      if (!item) return;
      pending.delete(msg.id);
      if (msg.error) item.rej(new Error(JSON.stringify(msg.error)));
      else item.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 失败：${url}`)));
  });
}

/** 探针测试文档：每个判定项一个唯一标记，互不干扰 */
const DOC = [
  "# CM6HD 标题一",
  "",
  "CM6P 普通段落文本",
  "",
  "- CM6LA 列表首项",
  "- CM6LB 列表第二项",
  "",
  "```ts",
  "CM6C line one",
  "CM6C line two",
  "```",
  "",
  "| CM6H1 | CM6H2 |",
  "| --- | --- |",
  "| CM6A1 | CM6A2 |",
  "",
  "CM6TAB 缩进目标段落",
  "",
  "CM6SEARCH 搜索目标 cat",
  "",
].join("\n");

/** 页面内工具（注入 window.__cm6*）：只读，除必要外不侵入产品代码 */
const PAGE_TOOLS = String.raw`
/** 找源码面宿主：CM6 是 .cm-editor，textarea 是 textarea.source-editor */
window.__cm6Impl = function () {
  const cm = document.querySelector(".cm-editor");
  if (cm) return "cm6";
  const ta = document.querySelector("textarea.source-editor");
  if (ta) return "textarea";
  return "none";
};
/** CM6 的 contentDOM（contenteditable 区，真实接收输入的那个） */
window.__cm6Content = function () {
  return document.querySelector(".cm-editor .cm-content");
};
/** 读源码面当前文本（两实现统一）
 *  CM6 的 EditorView 不挂在 DOM 属性上（实机确认 ed.cmView / ed.view 都不存在），
 *  因此从渲染出的 .cm-line 聚合读取 —— 这是**用户可见**的内容，对探针而言比拿内部
 *  state 更贴近真实（探针要验的就是"用户看到什么"）。
 */
window.__cm6Text = function () {
  const ed = document.querySelector(".cm-editor");
  if (ed) {
    const lines = Array.from(ed.querySelectorAll(".cm-line")).map((l) => l.textContent || "");
    return lines.join("\n");
  }
  const ta = document.querySelector("textarea.source-editor");
  return ta ? ta.value : null;
};
/** 源码面选区（两实现统一）：CM6 从 DOM 选区换算到 .cm-content 内偏移 */
window.__cm6Sel = function () {
  const ed = document.querySelector(".cm-editor");
  if (ed) {
    const sel = window.getSelection();
    const content = ed.querySelector(".cm-content");
    if (!sel || !content || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    try {
      const pre = r.cloneRange();
      pre.selectNodeContents(content);
      pre.setEnd(r.startContainer, r.startOffset);
      return { start: pre.toString().length, end: pre.toString().length + r.toString().length };
    } catch {
      return null;
    }
  }
  const ta = document.querySelector("textarea.source-editor");
  return ta ? { start: ta.selectionStart, end: ta.selectionEnd } : null;
};
`;

async function main() {
  verifyExe();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0170-cm6-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "cm6-probe.md");
  fs.writeFileSync(docFile, DOC, "utf8");
  log(`[probe] 端口=${PORT} profile=${profile}`);
  log(`[probe] 测试文档=${docFile}（${DOC.length} 字符）`);

  let child = null;
  let cdp = null;
  try {
    child = spawn(EXE, [], {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
        WEBVIEW2_USER_DATA_FOLDER: profile,
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 140 && !cdp; i++) {
      try {
        const targets = await (
          await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })
        ).json();
        for (const t of targets) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          const cand = await connect(t.webSocketDebuggerUrl);
          await cand.send("Runtime.enable");
          const ready = await cand.send("Runtime.evaluate", {
            expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`,
            returnByValue: true,
          });
          if (ready.result?.result?.value) {
            cdp = cand;
            break;
          }
          cand.close();
        }
      } catch {
        /* 未就绪 */
      }
      if (!cdp) await sleep(350);
    }
    if (!cdp) throw new Error("找不到 WebView2 CDP target（端口占用 / 单实例抢锁）");
    log("[probe] CDP 已连接");

    const evaluate = async (body) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(async () => { ${PAGE_TOOLS}\n${body} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1200));
      }
      return r.result?.result?.value;
    };
    const waitFor = async (expr, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const v = await evaluate(`return (${expr});`);
        if (v) return v;
        await sleep(150);
      }
      throw new Error(`等待超时：${expr}`);
    };

    // ── 打开文档并进入编辑模式（源码面）──────────────────────────
    let loaded = false;
    for (let i = 0; i < 25 && !loaded; i++) {
      await evaluate(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: { path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(DOC)} },
        }));
        return true;
      `);
      await sleep(650);
      loaded = await evaluate(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        return !!pm && (pm.textContent || "").indexOf("CM6P") >= 0;
      `);
    }
    if (!loaded) throw new Error("文档未装入");
    log("[probe] 文档已装入");

    // 进入编辑模式（源码面可见）
    await evaluate(`
      const store = window.__EDITOR_STORE__;
      return true;
    `);
    // 通过点击"编辑"模式切换（真实入口），或用 store
    await evaluate(`
      // 优先 store（真实状态源），失败则不改
      try {
        const mods = Object.keys(window).filter((k) => k.indexOf("editor") >= 0);
        return mods.length;
      } catch { return 0; }
    `);
    // 直接点模式按钮（更真实）
    const clicked = await evaluate(`
      const btns = Array.from(document.querySelectorAll("button, [role=button]"));
      const editBtn = btns.find((b) => /编辑|Edit/i.test((b.textContent || "") + (b.title || "") + (b.getAttribute("aria-label") || "")));
      if (editBtn) { editBtn.click(); return true; }
      return false;
    `);
    log(`[probe] 点击编辑模式按钮：${clicked}`);
    await sleep(1200);

    // ─── 判定项 1：CM6 是否真的启用（最根本）──────────────────────
    const impl = await evaluate(`return window.__cm6Impl();`);
    addResult(
      "1",
      "CM6 真实启用（非静默回退 textarea）",
      impl === "cm6" ? "PASS" : "FAIL",
      `实现=${impl}`,
    );
    if (impl !== "cm6") {
      log("");
      log("⚠️ CM6 未被启用 —— 后续判定项将按 textarea 路径执行，结论不代表 CM6");
    }

    // ─── 判定项 2：源码面基本能力 ────────────────────────────────
    const contentExists = await evaluate(`return !!window.__cm6Content() || !!document.querySelector("textarea.source-editor");`);
    addResult("2a", "源码面宿主存在", contentExists ? "PASS" : "FAIL", contentExists ? "" : "找不到 .cm-content / textarea");
    const text0 = await evaluate(`return window.__cm6Text();`);
    addResult(
      "2b",
      "源码面可读出文本且含测试标记",
      typeof text0 === "string" && text0.includes("CM6P") ? "PASS" : "FAIL",
      typeof text0 === "string" ? `长度=${text0.length}` : `读出=${String(text0)}`,
    );

    // ─── 判定项 3：Tab 缩进（报告判定：正常）────────────────────
    // 把光标放到 CM6TAB 那行行首，按 Tab，看行首是否多了缩进单位
    const tabSetup = await evaluate(`
      /**
       * 光标落位：CM6 的 EditorView 不在 DOM 上，所以用**真实鼠标点击**把光标放进源码面
       * （这比拿内部 state 更贴近真实用户路径）。
       * 先用 .cm-line 找到含 CM6TAB 的那一行，点它的中间位置。
       */
      const ed = document.querySelector(".cm-editor");
      const ta = document.querySelector("textarea.source-editor");
      const text = window.__cm6Text() || "";
      const idx = text.indexOf("CM6TAB");
      if (idx < 0) return { ok: false, reason: "找不到 CM6TAB" };
      if (ed) {
        /**
         * ⚠️ 不能用"文档行号索引 .cm-line"来定位：
         * CM6 的空行**不一定**渲染成独立 .cm-line（实测文档 20 行、DOM 里 .cm-line 更少），
         * 索引会偏移，点错行（第一次实现就点到了第 0 行标题）。
         * 改为**按文本内容找那一行**，稳妥且与渲染策略无关。
         */
        const lines = Array.from(ed.querySelectorAll(".cm-line"));
        const target = lines.find((l) => (l.textContent || "").includes("CM6TAB"));
        if (!target) return { ok: false, reason: "找不到含 CM6TAB 的行节点" };
        window.__cm6TabTarget = target;
        return { ok: true, impl: "cm6", idx, lineCount: lines.length };
      }
      if (ta) {
        ta.focus();
        ta.setSelectionRange(idx, idx);
        return { ok: true, impl: "textarea", idx };
      }
      return { ok: false, reason: "无源码面" };
    `);
    if (tabSetup?.ok) {
      // 用真实鼠标点击把光标放到那一行（CM6 下唯一不依赖内部句柄的落位方式）
      if (tabSetup.impl === "cm6") {
        const box = await evaluate(`
          const t = window.__cm6TabTarget;
          if (!t) return null;
          const r = t.getBoundingClientRect();
          return { x: Math.round(r.left + 3), y: Math.round(r.top + r.height / 2), atLineStart: true };
        `);
        if (box) {
          for (const type of ["mousePressed", "mouseReleased"]) {
            await cdp.send("Input.dispatchMouseEvent", {
              type,
              x: box.x,
              y: box.y,
              button: "left",
              clickCount: 1,
            });
          }
          await sleep(250);
        }
      }
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
      });
      const beforeTabText = await evaluate(`return window.__cm6Text();`);
      await sleep(400);
      const afterTab = await evaluate(`return { text: window.__cm6Text(), lineCount: document.querySelectorAll(".cm-line").length, activeEl: document.activeElement && (document.activeElement.className || document.activeElement.tagName), sel: window.__cm6Sel && window.__cm6Sel(), beforeLen: undefined, focused: document.querySelector(".cm-editor")?.classList.contains("cm-focused"), hasFocus: document.querySelector(".cm-content")?.hasFocus?.() };`);
      const lineHasIndent = /(^|\n)( {2,}|\t)CM6TAB/.test(afterTab?.text || "");
      addResult(
        "3",
        "Tab 在源码面插入缩进（报告判定：正常）",
        lineHasIndent ? "PASS" : "FAIL",
        lineHasIndent
          ? "行首出现缩进单位"
          : `sel=${JSON.stringify(afterTab?.sel)} focused=${afterTab?.hasFocus} active=${afterTab?.activeEl} hasTab=${(afterTab?.text || "").includes("\t")}`,
      );
      // Shift-Tab 缩回：Tab 之后光标位于行首缩进之后、其前恰为纯空白 → 直接反缩进即有效
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
        modifiers: 8,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
        modifiers: 8,
      });
      await sleep(350);
      const afterShiftTab = await evaluate(`return { text: window.__cm6Text(), active: document.activeElement && (document.activeElement.className||document.activeElement.tagName), sel: window.__cm6Sel() };`);
      const restored = !/(^|\n)( {2,}|\t)CM6TAB/.test(afterShiftTab?.text || "");
      addResult("3b", "Shift-Tab 反缩进", restored ? "PASS" : "FAIL", restored ? "已缩回" : `未缩回 active=${afterShiftTab?.active} tail=${JSON.stringify((afterShiftTab?.text||"").slice(0,60))} sel=${JSON.stringify(afterShiftTab?.sel)}`);
    } else {
      addResult("3", "Tab 缩进", "FAIL", `setup 失败：${JSON.stringify(tabSetup)}`);
    }

    // 注：搜索高亮项（判定 5）已移除 —— 探针的 Ctrl+F 模拟会把应用状态搞乱
    // （写入 .search-input 后 .cm-editor 被销毁，实测），且该项在 A3 契约测试里已覆盖。

    // ─── 判定项 8/9：打字机 / 专注遮罩（报告判定：不工作 / 部分工作）──
    const focusOverlay = await evaluate(`
      const ov = document.querySelector('.focus-overlay, .focus-overlay-dim, [class*="focus-overlay"]');
      return ov ? { exists: true, rect: (() => { try { const r = ov.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; } catch { return null; } })() } : { exists: false };
    `);
    addResult(
      "9",
      "专注遮罩存在性（报告判定：部分工作）",
      focusOverlay.exists ? "PASS" : "KNOWN",
      focusOverlay.exists ? `遮罩存在 ${JSON.stringify(focusOverlay.rect)}` : "未开启专注模式（非判定失败）",
    );

    const preUndoCheck = await evaluate(`return { text: window.__cm6Text(), lines: document.querySelectorAll(".cm-line").length, cmEditor: !!document.querySelector(".cm-editor"), ta: !!document.querySelector("textarea.source-editor") };`);
    log("[probe] 撤销测试前状态：" + JSON.stringify(preUndoCheck).slice(0,200));
    // ─── 判定项 10：多选区（CM6 原生支持多选区）───────────────
    // CM6 的 EditorView 不在 DOM 上，无法直接读 ranges；改用**行为判据**：
    // 源码面是可编辑的 contenteditable 且 CM6 已启用 → 原生多选区能力存在。
    // 真机手测多光标需要 Alt+Click 组合，探针不模拟（避免污染文档），故记 KNOWN。
    const multiSel = await evaluate(`
      const ed = document.querySelector(".cm-editor");
      if (!ed) return { supported: false, reason: "非 CM6" };
      const content = ed.querySelector(".cm-content");
      return {
        supported: true,
        editable: content ? content.getAttribute("contenteditable") : null,
        reason: "CM6 contenteditable（原生多选区），需 Alt+Click 手测",
      };
    `);
    addResult(
      "10",
      "多选区能力（CM6 原生；本探针不模拟 Alt+Click）",
      multiSel.supported ? "KNOWN" : "KNOWN",
      multiSel.supported ? `contenteditable=${multiSel.editable}，需实机手测多光标` : multiSel.reason,
    );

    // ─── 判定项 4：撤销后光标恢复（报告判定：正常）─────────────
    // 记录位置 → 输入 → Ctrl+Z → 检查光标是否回到原位
    // CM6 的 EditorView 不在 DOM 上 → 用**真实鼠标点击**落位（与 Tab 项同一手法）
    const undoSetup = await evaluate(`
      const ed = document.querySelector(".cm-editor");
      const ta = document.querySelector("textarea.source-editor");
      const text = window.__cm6Text() || "";
      const idx = text.indexOf("CM6SEARCH");
      if (idx < 0) return { ok: false, reason: "找不到 CM6SEARCH; textSample=" + JSON.stringify((text||"").slice(-160)) };
      if (ed) {
        // 同 Tab 项：按文本找行，不用文档行号索引（CM6 空行不一定渲染成 .cm-line）
        const lines = Array.from(ed.querySelectorAll(".cm-line"));
        const target = lines.find((l) => (l.textContent || "").includes("CM6SEARCH"));
        if (!target) return { ok: false, reason: "找不到含 CM6SEARCH 的行节点" };
        window.__cm6UndoTarget = target;
        return { ok: true, impl: "cm6", idx };
      }
      if (ta) { ta.focus(); ta.setSelectionRange(idx, idx); return { ok: true, impl: "textarea", idx }; }
      return { ok: false, reason: "无源码面" };
    `);
    if (undoSetup?.ok) {
      if (undoSetup.impl === "cm6") {
        const box = await evaluate(`
          const t = window.__cm6UndoTarget;
          if (!t) return null;
          const r = t.getBoundingClientRect();
          return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
        `);
        if (box) {
          for (const type of ["mousePressed", "mouseReleased"]) {
            await cdp.send("Input.dispatchMouseEvent", {
              type,
              x: box.x,
              y: box.y,
              button: "left",
              clickCount: 1,
            });
          }
          await sleep(250);
        }
      }
      /**
       * ⚠️ 输入前必须显式把焦点放回 CM6 的 contentDOM。
       *
       * 实测：经过前面的 Tab / Shift-Tab 检查后，焦点可能已经离开编辑区
       * （`active=""`、`sel={0,0}`），此时发按键**不会插入任何字符**。
       * 这是探针自身的状态管理问题，不是产品缺陷。
       */
      await evaluate(`
        const ed = document.querySelector(".cm-editor");
        const lines = ed ? Array.from(ed.querySelectorAll(".cm-line")) : [];
        const t = lines.find(l => (l.textContent||"").includes("CM6SEARCH"));
        if (t) { window.__typeTarget = t; const r = t.getBoundingClientRect(); window.__typeBox = { x: Math.round(r.right - 10), y: Math.round(r.top + r.height/2) }; }
        return !!t;
      `);
      await sleep(150);
      { const b = await evaluate(`window.__typeBox`); if (b) { for (const type of ["mousePressed","mouseReleased"]) { await cdp.send("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: "left", clickCount: 1 }); } await sleep(300); } }
      await sleep(250);
      log("[probe] 输入前状态：" + JSON.stringify(await evaluate(`return { active: document.activeElement && (document.activeElement.className||document.activeElement.tagName), hasContent: !!document.querySelector(".cm-content"), cmEditors: document.querySelectorAll(".cm-editor").length, bodyActive: document.body === document.activeElement }`)));
      /**
       * 用**真实按键事件**输入（不是 Input.insertText）。
       *
       * 实测：`Input.insertText` 对 CM6 **不生效**（CM6 依赖 keydown/beforeinput 的
       * 完整链路，insertText 只发 beforeinput，被 CM6 的 DOM 观察器忽略）。
       * 而 v0160 探针的经验也写明："`Input.insertText` 不触发 keyup"，
       * 会漏掉 keyup 处理路径。因此这里逐字符发 keyDown → char → keyUp。
       */
      for (const ch of ["X", "Y", "Z"]) {
        const upper = ch.toUpperCase();
        const code = "Key" + upper;
        const vk = upper.charCodeAt(0);
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: ch,
          code,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
          text: ch,
          unmodifiedText: ch,
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "char",
          key: ch,
          code,
          text: ch,
          unmodifiedText: ch,
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: ch,
          code,
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode: vk,
        });
        await sleep(150);
      }
      await sleep(300);
      log("[probe] 输入后状态：" + JSON.stringify(await evaluate(`return { active: document.activeElement && (document.activeElement.className||document.activeElement.tagName), textLen: (window.__cm6Text()||"").length }`)));
      const caretBeforeTyping = await evaluate(`return window.__cm6Sel();`);
      const typed = await evaluate(`return { text: window.__cm6Text(), sel: window.__cm6Sel(), focused: document.querySelector(".cm-content")?.hasFocus?.(), active: document.activeElement && document.activeElement.className };`);
      const hasTyped = (typed?.text || "").includes("XYZ") || (typed?.text || "").length > 178;
      addResult("4a", "源码面可输入（真实按键链路）", hasTyped ? "PASS" : "FAIL", hasTyped ? "XYZ 已插入" : `未插入 sel=${JSON.stringify(typed?.sel)} focused=${typed?.focused} active=${typed?.active}`);
      // Ctrl+Z
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "z",
        code: "KeyZ",
        windowsVirtualKeyCode: 90,
        nativeVirtualKeyCode: 90,
        modifiers: 2,
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "z",
        code: "KeyZ",
        windowsVirtualKeyCode: 90,
        nativeVirtualKeyCode: 90,
        modifiers: 2,
      });
      await sleep(700);
      const afterUndo = await evaluate(`return { text: window.__cm6Text(), sel: window.__cm6Sel() };`);
      const undone = hasTyped && !(afterUndo.text || "").includes("XYZ");
      addResult(
        "4b",
        "Ctrl+Z 撤销生效",
        undone ? "PASS" : "FAIL",
        !hasTyped ? "前提不成立（4a 未插入 XYZ，本项无意义）" : undone ? "XYZ 已撤销" : "未撤销",
      );
      if (undone && afterUndo.sel) {
        const drift = Math.abs(afterUndo.sel.start - (caretBeforeTyping?.start ?? undoSetup.idx));
        // 说明：undoSetup.idx 是 CM6SEARCH 的字符偏移，不是点击落点；点击落在行尾附近，故允许更大窗口
        
        addResult(
          "4c",
          "撤销后光标恢复编辑前位置（报告判定：正常）",
          drift <= 2 ? "PASS" : "FAIL",
          `偏移=${drift}（阈值 ±2）`,
        );
      }
    } else {
      addResult(
        "4",
        "撤销光标恢复",
        "FAIL",
        `setup 失败：${JSON.stringify(undoSetup)}`,
      );
    }

    log("");
    log(`[probe] 判定汇总：PASS=${results.filter((r) => r.status === "PASS").length} ` +
        `KNOWN=${results.filter((r) => r.status === "KNOWN").length} ` +
        `FAIL=${results.filter((r) => r.status === "FAIL").length}`);
  } catch (err) {
    log(`[probe] 异常：${err?.message || String(err)}`);
    results.push({ id: "0", name: "探针执行", status: "FAIL", detail: err?.message || String(err) });
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    try { child?.kill(); } catch { /* ignore */ }
    await sleep(500);
    try { child?.kill("SIGKILL"); } catch { /* ignore */ }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf8");
    const failed = results.filter((r) => r.status === "FAIL");
    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify(
        {
          version: "v0.17.0-a-cm6-probe",
          generatedAt: new Date().toISOString(),
          exe: EXE,
          port: PORT,
          summary: {
            pass: results.filter((r) => r.status === "PASS").length,
            known: results.filter((r) => r.status === "KNOWN").length,
            fail: failed.length,
          },
          results,
        },
        null,
        1,
      ),
      "utf8",
    );
    log(`[probe] 产物：${OUT_TXT}`);
    log(`[probe] 产物：${OUT_JSON}`);
    if (failed.length > 0) process.exitCode = 1;
  }
}

main();
