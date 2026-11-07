/**
 * LightMD v0.16.0 —— Tab / 缩进体系**实机探针**（真实 WebView2 + CDP 真实按键）
 *
 * 验证目标：USER_GUIDE「#### Tab 与缩进行为（0.16.0 起统一口径）」的 12 项口径。
 *
 * ─── 为什么必须走真实按键 ───
 * v0.15.6 的焦点逃逸（`ProseMirror → sidebar-toggle-btn`）只在**浏览器默认 Tab**
 * 生效时出现；`Input.insertText` 或直接 `view.dispatch(...)` 都绕开
 * `handleKeyDown` 与 `preventDefault`，测不到「命令是否接住了这个键」。
 * 本探针一律用 `Input.dispatchKeyEvent` 派发 keyDown → keyUp（真实链路）。
 *
 * ─── 光标如何落位（重要，便于复现）───
 * 1. 先通过既有 NodeView 反查 EditorView：本项目给 code_block / table / task_item /
 *    mermaid_block / math_block / image 都挂了 `nodeViews`，PM 把 NodeView **实例**
 *    挂在 `element.pmViewDesc.spec` 上，实例的 `.view` 就是 EditorView。
 *    因此测试文档必须**至少包含一个**上述块（本探针文档带代码块 + 表格 + 任务项）。
 * 2. 光标位置用 `view.posAtDOM(textNode, offset)` 精确换算。注意代码块/公式块/图表块
 *    的 DOM 里**有多份同名文本**（高亮层 `code.prism-highlighted`、预览层 SVG、
 *    PM 编辑层 `contentDOM`），`TreeWalker` 会先命中非 PM 文本 → `posAtDOM` 抛错。
 *    因此查找函数对每个候选节点**试算 posAtDOM**，抛错就跳过，天然只认 PM 管理的文本。
 * 3. 每次按键后读回 `view.state.selection.$from` 的祖先链与文本块名做**自检**，
 *    确认光标确实落在目标块内 —— 否则先怀疑探针，不怀疑产品。
 *
 * ─── 读回文档用的是哪一层 ───
 * 断言一律读 **ProseMirror 文档层**（`view.state.doc`：文本块 `textContent`、
 * 选区祖先链），不读 `innerText`。原因：代码块的 NodeView 把正文渲染在 `contentDOM`
 * （`<code>`）、另有高亮层与行号层，`innerText` 会混入行号与重复文本。
 *
 * ─── 依据（口径来源，勿自行发明预期）───
 * · lightmd/USER_GUIDE.md「Tab 与缩进行为（0.16.0 起统一口径）」表格
 * · src/core/indentCommands.ts 文件头分派表（indent/outdent 除表格外永不 false）
 * · src/core/keymap.ts:513 `Tab: chainCommands(pairTabOut, tableTab, indent)`
 *                        :514 `"Shift-Tab": chainCommands(tableShiftTab, outdent)`
 * · src/core/plugins/code-indent.ts（B2 逐行实现：inCodeLikeBlock / outdentLen）
 * · src/core/plugins/auto-pair.ts（pairTabOut：光标夹配对符号中间 → 跳到闭符号右侧）
 * · src/stores/useSettingsStore.ts `indentUnit` / `indentUnitString()`（默认 "2"）
 * · 单测：src/__tests__/v0160-b1-b3-indent-dispatch.test.ts、v0160-b2-code-indent.test.ts、
 *        v0160-b4-source-indent.test.ts
 *
 * ⚠️ 判定项 10 的口径说明（探针实测时同时记录对照组）：
 * 单测用 `undoDepth()`（prosemirror-history 自己的栈）验证 `closeHistory` 的效果；
 * 但**实机 Ctrl+Z 不走 PM history**，而是 `core/keymap.ts` 的 `hostUndoCommand`
 * → `EditorContainer.doLocalUndo` → `editorHistory/coordinator` → **统一时间线**
 * （`services/documentHistory`）。统一时间线由 `pmAdapter` 以 **350ms 防抖** 归并
 * 连续编辑（见 pmAdapter 文件头 ②），且**不读取** `closeHistoryKey`。
 * 因此判定项 10 除了「两次 Tab（间隔 180ms）后 Ctrl+Z」还跑一组
 * 「两次 Tab 间隔 > 防抖窗口」对照，用于区分「产品缺陷」与「按键太快被归并」。
 *
 * 用法：node scripts/v0160-probe-tab-indent.mjs
 * 环境变量：V0160_TAB_PORT（默认 9430）、V0160_TAB_EXE（默认 release/lightmd.exe）
 *
 * 产物：_verify-out/v0160-tab-indent.txt / .json（有 FAIL 时退出码 1）
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = process.env.V0160_TAB_EXE || path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = Number(process.env.V0160_TAB_PORT || 9430);
const OUT_DIR = path.join(ROOT, "_verify-out");
const OUT_TXT = path.join(OUT_DIR, "v0160-tab-indent.txt");
const OUT_JSON = path.join(OUT_DIR, "v0160-tab-indent.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = [];
const log = (text = "") => {
  lines.push(text);
  console.log(text);
};

/** exe 内联 dist 校验：防止测到旧二进制（照抄 v0160-probe-sidebar-ui.mjs 的 verifyExe） */
function verifyExe() {
  if (!fs.existsSync(EXE)) throw new Error(`请先执行 npx tauri build --no-bundle（找不到 ${EXE}）`);
  const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  const match = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!match) throw new Error("dist/index.html 找不到入口 hash");
  const hash = match[1];
  if (!fs.readFileSync(EXE).includes(Buffer.from(hash))) {
    throw new Error(`exe 内联 dist 与当前 dist 不一致（找不到 ${hash}）→ 请重新打包`);
  }
  const processes = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  if (/^"lightmd\.exe"/im.test(processes)) {
    throw new Error("检测到已有 LightMD 进程（单实例插件会抢锁）。请先关闭后重跑探针。");
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
            }, 20000);
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
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${url}`)));
  });
}

/**
 * 测试文档：每个判定项一个唯一标记块，互不干扰。
 * 必须包含代码块 / 表格 / 任务项 —— 它们挂了 NodeView，是反查 EditorView 的唯一入口。
 */
const DOC = [
  "# HDMARK 标题一",
  "",
  "PMARK 普通段落文本",
  "",
  "- LMARKA 列表首项",
  "- LMARKB 列表第二项",
  "",
  "- [ ] TMARKA 任务首项",
  "- [ ] TMARKB 任务第二项",
  "",
  "> QMARK 引用段落",
  "",
  "```ts",
  "CMARK line one",
  "CMARK line two",
  "```",
  "",
  "$$",
  "MMARK x + y",
  "$$",
  "",
  "```mermaid",
  "graph TD",
  "DMMARK --> B",
  "```",
  "",
  "| H1MARK | H2MARK |",
  "| --- | --- |",
  "| A1MARK | A2MARK |",
  "| A3MARK | A4MARK |",
  "",
  "PAIRMARK () 配对段落",
  "",
  "UMARK 缩进单位段落",
  "",
  "```",
  "ZMARK undo granularity",
  "```",
  "",
  "SMARK 源码模式段落",
  "",
].join("\n");

/**
 * 页面内工具（一次性注入 window.__ti*）。
 *
 * 只读 ProseMirror **文档层**与必要 DOM；唯一「侵入」是 `__tiWrapDispatch()`
 * 给 `view.dispatch` 套一层**只计数**的壳（用于「标题不发事务」取证），
 * 可用 `__tiUnwrapDispatch()` 原样还原。
 */
const PAGE_TOOLS = String.raw`
/**
 * 反查 EditorView：本项目挂了 nodeViews，PM 把 NodeView 实例挂在
 * element.pmViewDesc.spec 上（见 prosemirror-view NodeViewDesc.create / CustomNodeViewDesc）。
 */
window.__tiView = function () {
  if (window.__tiViewCache && window.__tiViewCache.dom && document.contains(window.__tiViewCache.dom)) {
    return window.__tiViewCache;
  }
  const selectors = [
    ".code-block-wrapper",
    ".table-wrapper",
    ".mermaid-block-wrapper",
    ".math-block-wrapper",
    "li.task-item",
    ".image-wrapper",
  ];
  for (const selector of selectors) {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const spec = el.pmViewDesc && el.pmViewDesc.spec;
      if (spec && spec.view) {
        window.__tiViewCache = spec.view;
        return spec.view;
      }
    }
  }
  return null;
};

window.__tiPm = function () {
  return document.querySelector(".editor-container .ProseMirror") || document.querySelector(".ProseMirror");
};

/**
 * 找到包含 needle 的**ProseMirror 管理的文本节点**，并换算出文档位置。
 *
 * 关键：代码块 / 公式块 / 图表块的 DOM 里有多份同名文本（高亮层 prism-highlighted、
 * 预览层 SVG / 渲染结果、PM 编辑层 contentDOM）。TreeWalker 会先命中**非 PM 文本**：
 * · 仅靠 posAtDOM 抛错**不够** —— 实测 mermaid 预览层的文本经 nearestDesc 落到
 *   CustomNodeViewDesc.localPosFromDOM，contentDOM 不含它时会**返回 posAtStart 而不是抛错**
 *   （见 prosemirror-view 的 localPosFromDOM 回退分支），于是光标被静默放到块首，
 *   表现为「按 Tab 缩进到了第一行而不是目标行」。
 * 因此这里用**显式判据** + posAtDOM 试算双保险：
 *   ① 向上找最近的带 pmViewDesc 的祖先，取其 ViewDesc；
 *   ② 若该 ViewDesc 有 contentDOM → 文本必须落在 contentDOM 内（NodeView 块：wrapper 的
 *      contentDOM 才是 PM 真正编辑的那层 code 元素，高亮层/预览层都不在其中）；
 *      普通段落/标题的 contentDOM 就是 p / h1 自身，同样成立；
 *   ③ 若没有 contentDOM（理论上不会出现在本探针的块里）→ 退化为「祖先链上不得出现
 *      contenteditable="false"」，排除各 NodeView 显式标记的只读层；
 *   ④ 最后仍用 posAtDOM 试算，抛错就跳过（兜底）。
 *
 * 为什么不用 docView.nearestDesc（更直接）：它是 prosemirror-view 的**内部**成员，
 * 不是公开 API；而 element.pmViewDesc 是本项目既有探针已依赖的落点
 * （见 scripts/v0140-table-size-persistence-probe-r2.mjs 读 node.attrs 的做法）。
 */
window.__tiIsPmText = function (node, view) {
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el && !el.pmViewDesc) el = el.parentElement;
  if (!el) return false;
  const desc = el.pmViewDesc;
  if (desc.contentDOM) return desc.contentDOM.contains(node);
  for (let p = node.parentElement; p && p !== view.dom; p = p.parentElement) {
    if (p.getAttribute && p.getAttribute("contenteditable") === "false") return false;
  }
  return true;
};

window.__tiFindText = function (needle) {
  const view = window.__tiView();
  const pm = window.__tiPm();
  if (!view || !pm) return { ok: false, reason: "no view/pm" };
  const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT, null);
  let node = walker.nextNode();
  let skippedNonPm = 0;
  let skippedPos = 0;
  while (node) {
    const value = node.nodeValue || "";
    const index = value.indexOf(needle);
    if (index >= 0) {
      // ①②③ 显式判据：只认 PM 真正管理的那层文本
      if (!window.__tiIsPmText(node, view)) {
        skippedNonPm++;
      } else {
        try {
          const pos = view.posAtDOM(node, index);
          return { ok: true, node, index, value, pos, skippedNonPm, skippedPos };
        } catch (e) {
          skippedPos++;
        }
      }
    }
    node = walker.nextNode();
  }
  return {
    ok: false,
    reason: "PM 内找不到标记：" + needle,
    skippedNonPm,
    skippedPos,
  };
};

/** 光标所在文本块的祖先链（自内向外）+ 文本（**PM 文档层**，非 innerText） */
window.__tiSel = function () {
  const view = window.__tiView();
  if (!view) return { ok: false, reason: "no view" };
  const { selection } = view.state;
  const $from = selection.$from;
  const chain = [];
  for (let d = $from.depth; d > 0; d--) chain.push($from.node(d).type.name);
  return {
    ok: true,
    from: selection.from,
    to: selection.to,
    empty: selection.empty,
    chain,
    blockName: $from.parent.type.name,
    blockText: $from.parent.textContent,
    depth: $from.depth,
  };
};

/** 把光标放到「needle 内部偏移 offset」处（只落位选区，不产生任何编辑） */
window.__tiPlace = function (needle, offset) {
  const view = window.__tiView();
  if (!view) return { ok: false, reason: "no view" };
  const found = window.__tiFindText(needle);
  if (!found.ok) return found;
  const pos = found.pos + (offset || 0);
  const TS = view.state.selection.constructor;
  try {
    view.dispatch(view.state.tr.setSelection(TS.create(view.state.doc, pos)));
  } catch (e) {
    return { ok: false, reason: "设置选区失败：" + String(e && e.message), pos };
  }
  view.focus();
  return Object.assign({ ok: true, pos }, window.__tiSel());
};

/**
 * 读取 needle 所在**文本块**的文本（PM 文档层）。
 * 与 __tiSel 的区别：不看选区，直接按文档内容定位（避免选区漂移影响读数）。
 */
window.__tiSeg = function (needle) {
  const view = window.__tiView();
  if (!view) return { ok: false, reason: "no view" };
  let hit = null;
  view.state.doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.isText && node.text && node.text.indexOf(needle) >= 0) {
      try {
        const $pos = view.state.doc.resolve(pos + node.text.indexOf(needle));
        hit = { ok: true, text: $pos.parent.textContent, blockName: $pos.parent.type.name, pos };
      } catch (e) {
        /* 继续找 */
      }
      return false;
    }
    return true;
  });
  return hit || { ok: false, reason: "文档内找不到标记：" + needle };
};

/** needle 所在位置的祖先链（不看选区，按文档内容定位） */
window.__tiChain = function (needle) {
  const view = window.__tiView();
  if (!view) return { ok: false, reason: "no view" };
  let hit = null;
  view.state.doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.isText && node.text && node.text.indexOf(needle) >= 0) {
      try {
        const $pos = view.state.doc.resolve(pos + node.text.indexOf(needle));
        const chain = [];
        for (let d = $pos.depth; d > 0; d--) chain.push($pos.node(d).type.name);
        hit = { ok: true, chain, blockName: $pos.parent.type.name, blockText: $pos.parent.textContent };
      } catch (e) {
        /* 继续找 */
      }
      return false;
    }
    return true;
  });
  return hit || { ok: false, reason: "文档内找不到标记：" + needle };
};

/** 给 view.dispatch 套只计数壳（不改变行为），供「标题不派发事务」取证 */
window.__tiWrapDispatch = function () {
  const view = window.__tiView();
  if (!view) return false;
  if (!window.__tiOrigDispatch) window.__tiOrigDispatch = view.dispatch;
  window.__tiTxs = [];
  view.dispatch = function (tr) {
    try {
      // closeHistoryKey 的 meta 键是 PluginKey("\"closeHistory\"") 的 .key，
      // 而 createKey 会追加 "$"/"$N" 后缀 → 实际键名是 "closeHistory$"。
      // 这里同时读两种写法，避免因键名细节漏采证据。
      const meta = tr.meta || {};
      const metaKeys = Object.keys(meta);
      window.__tiTxs.push({
        steps: tr.steps ? tr.steps.length : -1,
        docChanged: !!tr.docChanged,
        closeHistory: !!(meta["closeHistory$"] || meta["closeHistory"]),
        metaKeys,
        t: Math.round(performance.now()),
      });
    } catch (e) {
      /* ignore */
    }
    return window.__tiOrigDispatch(tr);
  };
  return true;
};

window.__tiUnwrapDispatch = function () {
  const view = window.__tiView();
  if (view && window.__tiOrigDispatch) view.dispatch = window.__tiOrigDispatch;
  return true;
};

window.__tiTxCount = function () {
  return (window.__tiTxs || []).length;
};

window.__tiTxReset = function () {
  window.__tiTxs = [];
  return true;
};

window.__tiTxDump = function () {
  return (window.__tiTxs || []).slice();
};

/**
 * 焦点是否仍在编辑器内（判定项 9 的唯一判据）。
 * 同时给出源码模式 textarea 的判定（判定项 12 用同一读数，避免两套口径）。
 */
window.__tiFocus = function () {
  const pm = window.__tiPm();
  const ta = document.querySelector("textarea.source-editor");
  const active = document.activeElement;
  return {
    insidePm: !!(pm && active && (pm === active || pm.contains(active))),
    insideTextarea: !!(ta && active === ta),
    tag: active ? active.tagName : null,
    id: active ? active.id || "" : "",
    cls: active ? String(active.className || "").slice(0, 120) : "",
    outer: active ? String(active.outerHTML || "").slice(0, 160) : "",
    pmPresent: !!pm,
    textareaPresent: !!ta,
  };
};

/** 通知条文本（判定项 4：列表首项提示） */
window.__tiToast = function () {
  const box = document.querySelector(".notification-toast-container");
  return box ? box.textContent : "";
};

/** 设置对话框里缩进单位 select 的当前值（null = 对话框未打开） */
window.__tiIndentSelect = function () {
  const el = document.querySelector('[data-testid="settings-indent-unit"]');
  return el ? el.value : null;
};

/** 用真实 UI 路径改缩进单位：原生 value setter + 冒泡 change（React 受控 select 的常规落点） */
window.__tiSetIndentUnit = function (value) {
  const el = document.querySelector('[data-testid="settings-indent-unit"]');
  if (!el) return { ok: false, reason: "设置对话框未打开 / 找不到缩进单位 select" };
  const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  desc.set.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, now: el.value };
};

/** 源码模式 textarea（可见才算） */
window.__tiTextarea = function () {
  const ta = document.querySelector("textarea.source-editor");
  return ta && ta.clientHeight > 0 ? ta : null;
};
`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const distHash = verifyExe();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0160-tab-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "tab-indent.md");
  fs.writeFileSync(docFile, DOC, "utf8");
  log(`[probe] 端口=${PORT}`);
  log(`[probe] 临时 profile=${profile}`);
  log(`[probe] 测试文档=${docFile}（${DOC.length} 字符）`);

  let child = null;
  let cdp = null;
  const checks = [];
  const focusPm = [];
  const focusSource = [];
  const paraSoftNotes = [];
  let settingsReport = { original: null, restored: null, method: "" };
  let undoDetail = {};

  const check = (id, name, ok, detail = "") => {
    checks.push({ id, name, ok: !!ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    child = spawn(EXE, [], {
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
        WEBVIEW2_USER_DATA_FOLDER: profile,
      },
      stdio: "ignore",
    });

    for (let attempt = 0; attempt < 140 && !cdp; attempt++) {
      try {
        const targets = await (
          await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })
        ).json();
        for (const target of targets) {
          if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
          const candidate = await connect(target.webSocketDebuggerUrl);
          await candidate.send("Runtime.enable");
          const ready = await candidate.send("Runtime.evaluate", {
            expression: `typeof window.__TAURI_INTERNALS__ !== "undefined" && !!document.querySelector(".app-sidebar, .filetree")`,
            returnByValue: true,
          });
          if (ready.result?.result?.value) {
            cdp = candidate;
            break;
          }
          candidate.close();
        }
      } catch {
        /* WebView2 尚未就绪 */
      }
      if (!cdp) await sleep(350);
    }
    if (!cdp) throw new Error("找不到 LightMD WebView2 CDP target（端口被占 / 单实例抢锁？）");
    log("[probe] CDP target 已连接");

    const evaluate = async (body) => {
      const result = await cdp.send("Runtime.evaluate", {
        expression: `(async () => { ${PAGE_TOOLS}\n${body} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.result?.exceptionDetails) {
        throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 1200));
      }
      return result.result?.result?.value;
    };
    const waitFor = async (expression, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await evaluate(`return (${expression});`);
        if (value) return value;
        await sleep(150);
      }
      throw new Error(`等待超时：${expression}`);
    };

    // ─── 真实按键（keydown → keyup 完整链路）────────────────────────────────
    const pressTab = async (shift = false) => {
      const base = {
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
        modifiers: shift ? 8 : 0,
      };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
      await sleep(25);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    };
    const pressCtrlZ = async () => {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        windowsVirtualKeyCode: 17,
        nativeVirtualKeyCode: 17,
        code: "ControlLeft",
        key: "Control",
        modifiers: 2,
      });
      await sleep(20);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        windowsVirtualKeyCode: 90,
        nativeVirtualKeyCode: 90,
        code: "KeyZ",
        key: "z",
        modifiers: 2,
      });
      await sleep(25);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: 90,
        nativeVirtualKeyCode: 90,
        code: "KeyZ",
        key: "z",
        modifiers: 2,
      });
      await sleep(20);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: 17,
        nativeVirtualKeyCode: 17,
        code: "ControlLeft",
        key: "Control",
      });
      await sleep(450);
    };

    /** 记录一次 PM 焦点判定（聚合为判定项 9；源码模式单独进 focusSource） */
    const noteFocusPm = async (context) => {
      const state = await evaluate(`return __tiFocus();`);
      focusPm.push({ context, ...state });
      return state;
    };

    // 统一缩进单位到默认 "2"（localStorage 清空 → store 默认值）
    await evaluate(`localStorage.clear(); location.reload(); return true;`);
    await sleep(2700);
    await waitFor(`!!document.querySelector(".app-sidebar, .filetree")`);

    // 打开测试文档（真实入口：App.tsx 的 lightmd:openFile 事件）
    let loaded = false;
    for (let attempt = 0; attempt < 25 && !loaded; attempt++) {
      await evaluate(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(DOC)} } }));
        return true;
      `);
      await sleep(650);
      loaded = await evaluate(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        return !!pm && (pm.textContent || "").indexOf("PAIRMARK") >= 0;
      `);
    }
    if (!loaded) throw new Error("测试文档未装入（PM 里找不到 PAIRMARK）");
    await sleep(1000);
    log("[probe] 测试文档已装入阅读（PM）模式");

    const viewReady = await evaluate(`return !!__tiView();`);
    if (!viewReady) throw new Error("反查不到 EditorView（文档里没有挂 NodeView 的块？）");
    await evaluate(`__tiWrapDispatch(); return true;`);

    log("");
    log("════════════ 判定项 1：表格单元格导航 ════════════");
    {
      const before = await evaluate(`return __tiPlace("A1MARK", 0);`);
      await noteFocusPm("表格 cell Tab");
      await pressTab(false);
      await sleep(200);
      const after = await evaluate(`return __tiSel();`);
      const cellMoved = before.ok && after.ok && after.chain.includes("table_cell") && after.from !== before.from;

      // 末格 Tab → 追加一行
      await evaluate(`return __tiPlace("A4MARK", 0);`);
      const rowsBefore = await evaluate(`
        const t = document.querySelector(".table-wrapper table");
        return t ? t.querySelectorAll("tr").length : -1;
      `);
      await pressTab(false);
      await sleep(280);
      const rowsAfter = await evaluate(`
        const t = document.querySelector(".table-wrapper table");
        return t ? t.querySelectorAll("tr").length : -1;
      `);

      // 首格 Shift+Tab → 不动
      const firstBefore = await evaluate(`return __tiPlace("H1MARK", 0);`);
      await noteFocusPm("表格首格 Shift+Tab");
      await pressTab(true);
      await sleep(200);
      const firstAfter = await evaluate(`return __tiSel();`);
      const firstStayed = firstBefore.ok && firstAfter.ok && firstBefore.from === firstAfter.from;

      check(
        "1",
        "表格单元格：Tab=下一格、末格自动追加一行、首格 Shift+Tab 不动",
        cellMoved && rowsAfter === rowsBefore + 1 && firstStayed,
        `Tab 换格=${cellMoved}（${before.from}→${after.from}，块=${after.blockName}）行数 ${rowsBefore}→${rowsAfter} 首格不动=${firstStayed}（${firstBefore.from}→${firstAfter.from}）`,
      );
      log(`      光标落位自检：chain=${JSON.stringify(after.chain)}`);
    }

    log("");
    log("════════════ 判定项 2：代码块 / 公式块 / 图表块 ════════════");
    {
      /**
       * ⚠️ 光标口径（决定「Shift+Tab 还原」这一步怎么按）：
       * `insertText(unit, $from.pos)` 把缩进插在**光标处**，事务映射后光标**停在插入内容之前**
       * （单测 v0160-b2 的「两次 Tab 得到 `"    x"` 而不是 `"x    "`」正是这个证据）。
       * 而 outdent 只删「光标到行首之间全是空白」的情形 —— 光标在缩进之前时该区间为空，
       * 按契约应当**吞键不删**。因此测「行首减一个单位」必须先把光标移到缩进区**之后**，
       * 否则测到的是"按契约不动"，会误判成产品缺陷。
       */
      const codeBefore = await evaluate(`return __tiSeg("CMARK line one");`);
      const placed = await evaluate(`return __tiPlace("CMARK line one", 0);`);
      await noteFocusPm("代码块 Tab");
      await pressTab(false);
      await sleep(200);
      const codeAfterTab = await evaluate(`return __tiSeg("CMARK line one");`);

      // 光标移到刚插入的缩进区**之后**（即标记本身的起点 = 行首 2 空格之后），再按 Shift+Tab
      // ⚠️ 必须用 offset 0：`__tiPlace("CMARK line one", 2)` 会落到 "CM|ARK"（行中有字符），
      // 按 outdent 契约属「非行首缩进区」→ 吞键不删，会误判成产品缺陷。
      await evaluate(`return __tiPlace("CMARK line one", 0);`);
      const outdentPlaced = await evaluate(`return __tiSel();`);
      const outdentLineIndent = await evaluate(`
        const view = __tiView();
        const f = __tiFindText("CMARK line one");
        if (!f.ok) return null;
        const $from = view.state.selection.$from;
        const before = view.state.doc.textBetween($from.start(), $from.pos, "\\n", "\\n");
        return JSON.stringify(before.slice(before.lastIndexOf("\\n") + 1));
      `);
      await pressTab(true);
      await sleep(200);
      const codeAfterOut = await evaluate(`return __tiSeg("CMARK line one");`);

      // 行中 Shift+Tab 不删字符（此时文本已还原成单行原样）
      await evaluate(`return __tiPlace("CMARK line one", 9);`);
      const midBefore = await evaluate(`return __tiSeg("CMARK line one");`);
      const midPlaced = await evaluate(`return __tiSel();`);
      await pressTab(true);
      await sleep(200);
      const midAfter = await evaluate(`return __tiSeg("CMARK line one");`);

      // 公式块 + 图表块行首 Tab
      await evaluate(`return __tiPlace("MMARK x + y", 0);`);
      const mathPlaced = await evaluate(`return __tiSel();`);
      await noteFocusPm("公式块 Tab");
      await pressTab(false);
      await sleep(200);
      const mathAfter = await evaluate(`return __tiSeg("MMARK x + y");`);

      await evaluate(`return __tiPlace("DMMARK", 0);`);
      const mermaidPlaced = await evaluate(`return __tiSel();`);
      await noteFocusPm("图表块 Tab");
      await pressTab(false);
      await sleep(200);
      const mermaidAfter = await evaluate(`return __tiSeg("DMMARK");`);

      const tabOk =
        codeBefore.ok && codeAfterTab.ok &&
        codeAfterTab.text === "  " + codeBefore.text &&
        codeAfterTab.blockName === "code_block";
      const outOk = codeAfterOut.ok && codeBefore.ok && codeAfterOut.text === codeBefore.text;
      const midOk = midBefore.ok && midAfter.ok && midAfter.text === midBefore.text;
      const mathOk = mathAfter.ok && mathAfter.blockName === "math_block" && mathAfter.text === "  MMARK x + y";
      const mermaidOk =
        mermaidAfter.ok &&
        mermaidAfter.blockName === "mermaid_block" &&
        /\n  DMMARK/.test(mermaidAfter.text);
      check(
        "2",
        "代码/公式/图表块：Tab=行首插缩进单位、Shift+Tab=行首减一单位且行中不删字符",
        tabOk && outOk && midOk && mathOk && mermaidOk,
        `代码块 Tab=${tabOk}(${JSON.stringify(codeAfterTab.text)}) Shift+Tab 还原=${outOk}(${JSON.stringify(codeAfterOut.text)}；光标在缩进区后=${outdentPlaced.ok} depth=${outdentPlaced.depth}) 行中不删=${midOk}(${JSON.stringify(midAfter.text)}) 公式块=${mathOk}(${JSON.stringify(mathAfter.text)}) 图表块=${mermaidOk}(${JSON.stringify(mermaidAfter.text)})`,
      );
      log(`      光标落位自检：代码块=${placed.blockName} 公式块=${mathPlaced.blockName} 图表块=${mermaidPlaced.blockName} 行中=${midPlaced.blockName}`);
    }

    log("");
    log("════════════ 判定项 3：列表 / 任务列表（非首项）嵌套 ════════════");
    {
      const listBefore = await evaluate(`return __tiChain("LMARKB");`);
      const listPlaced = await evaluate(`return __tiPlace("LMARKB", 0);`);
      await noteFocusPm("列表非首项 Tab");
      await pressTab(false);
      await sleep(220);
      const listAfter = await evaluate(`return __tiChain("LMARKB");`);
      await pressTab(true);
      await sleep(220);
      const listBack = await evaluate(`return __tiChain("LMARKB");`);

      const taskBefore = await evaluate(`return __tiChain("TMARKB");`);
      const taskPlaced = await evaluate(`return __tiPlace("TMARKB", 0);`);
      await noteFocusPm("任务列表非首项 Tab");
      await pressTab(false);
      await sleep(220);
      const taskAfter = await evaluate(`return __tiChain("TMARKB");`);
      await pressTab(true);
      await sleep(220);
      const taskBack = await evaluate(`return __tiChain("TMARKB");`);

      const sunk = listBefore.ok && listAfter.ok && listAfter.chain.length === listBefore.chain.length + 2;
      const lifted = listBefore.ok && listBack.ok && listBack.chain.join("/") === listBefore.chain.join("/");
      const taskSunk = taskBefore.ok && taskAfter.ok && taskAfter.chain.length === taskBefore.chain.length + 2;
      check(
        "3",
        "列表 / 任务列表非首项：Tab=嵌套一层、Shift+Tab=提升一层",
        sunk && lifted && taskSunk,
        `列表 ${JSON.stringify(listBefore.chain)}→${JSON.stringify(listAfter.chain)}→${JSON.stringify(listBack.chain)}；任务 ${JSON.stringify(taskBefore.chain)}→${JSON.stringify(taskAfter.chain)}→${JSON.stringify(taskBack.chain)}；落位=${listPlaced.blockName}/${taskPlaced.blockName}`,
      );
    }

    log("");
    log("════════════ 判定项 4：列表首项 Tab = 不嵌套 + 提示 ════════════");
    {
      const headBefore = await evaluate(`return __tiChain("LMARKA");`);
      await evaluate(`return __tiPlace("LMARKA", 0);`);
      await noteFocusPm("列表首项 Tab");
      await pressTab(false);
      await sleep(320);
      const headAfter = await evaluate(`return __tiChain("LMARKA");`);
      const toast = await evaluate(`return __tiToast();`);
      const unchanged = headBefore.ok && headAfter.ok && headBefore.chain.join("/") === headAfter.chain.join("/");
      const toastOk = String(toast || "").includes("列表首项无法再缩进");
      check(
        "4",
        "列表首项：Tab 不嵌套并提示「列表首项无法再缩进」",
        unchanged && toastOk,
        `结构不变=${unchanged}(${JSON.stringify(headAfter.chain)}) 提示=${toastOk}（toast="${String(toast || "").slice(0, 80)}"）`,
      );
    }

    log("");
    log("════════════ 判定项 5：引用块加/减一层 ════════════");
    {
      const quoteBefore = await evaluate(`return __tiChain("QMARK");`);
      await evaluate(`return __tiPlace("QMARK", 0);`);
      await noteFocusPm("引用块 Tab");
      await pressTab(false);
      await sleep(240);
      const quoteAfter = await evaluate(`return __tiChain("QMARK");`);
      await pressTab(true);
      await sleep(240);
      const quoteBack = await evaluate(`return __tiChain("QMARK");`);
      const countQuote = (value) => (value.ok ? value.chain.filter((x) => x === "blockquote").length : -1);
      const added = countQuote(quoteAfter) === countQuote(quoteBefore) + 1;
      const removed = countQuote(quoteBack) === countQuote(quoteBefore);
      check(
        "5",
        "引用块：Tab=增加一层引用、Shift+Tab=减少一层",
        added && removed,
        `${JSON.stringify(quoteBefore.chain)}→${JSON.stringify(quoteAfter.chain)}→${JSON.stringify(quoteBack.chain)}`,
      );
    }

    log("");
    log("════════════ 判定项 6：普通段落插/删缩进单位 ════════════");
    {
      await evaluate(`return __tiPlace("UMARK", 0);`);
      const paraBefore = await evaluate(`return __tiSeg("UMARK");`);
      await noteFocusPm("段落 Tab");
      await pressTab(false);
      await sleep(200);
      const paraAfter = await evaluate(`return __tiSeg("UMARK");`);
      await pressTab(true);
      await sleep(200);
      const paraBack = await evaluate(`return __tiSeg("UMARK");`);
      const inserted = paraBefore.ok && paraAfter.ok && paraAfter.text === "  " + paraBefore.text;
      const removed = paraBefore.ok && paraBack.ok && paraBack.text === paraBefore.text;

      // ── 口径备注（不参与判定）：Tab 是**插在光标处**，不是"缩进到行首" ──
      // USER_GUIDE 写的是「插入缩进单位（视觉缩进）」，容易被读成"行首缩进"。
      // 实测取证：把光标移到段落内容中间再按 Tab，缩进插在中间而非行首。
      // ⚠️ 读数必须用 __tiSeg("PMARK")（插入点在 PMARK 之后，标记保持连续）；
      //    若用 __tiSeg("普通段落文本")，插了 2 个空格后该串不再连续 → 查不到，读到 undefined。
      const midPlace = await evaluate(`return __tiPlace("普通段落文本", 3);`);
      const midParaBefore = await evaluate(`return __tiSeg("PMARK");`);
      await pressTab(false);
      await sleep(220);
      const midParaAfter = await evaluate(`return __tiSeg("PMARK");`);
      // 期望：在「普通段落文本」第 3 字符后插入 2 个空格 → "PMARK 普通段  落文本"
      const anchor = midParaBefore.ok ? midParaBefore.text.indexOf("普通段落文本") : -1;
      const expectMid =
        anchor >= 0
          ? midParaBefore.text.slice(0, anchor + 3) + "  " + midParaBefore.text.slice(anchor + 3)
          : null;
      const midInserted = midParaAfter.ok && expectMid !== null && midParaAfter.text === expectMid;
      log(
        `      口径备注（不计入判定）：光标在「普通段落文本」第 3 字符处按 Tab → ` +
          `${JSON.stringify(midParaBefore.text)} → ${JSON.stringify(midParaAfter.text)}；` +
          `插在光标处=${midInserted}（期望 ${JSON.stringify(expectMid)}）；` +
          `USER_GUIDE「视觉缩进」措辞是否需补「插在光标处」待定`,
      );
      // 还原：此处**不能**用 Shift+Tab —— outdent 的契约是「光标到行首之间必须全是空白」
      // （见 code-indent.ts / indentCommands.ts 的 lineIndent 判定）。光标前有正文
      // （"PMARK 普通段"），故 Shift+Tab 按契约应吞键不删；这是正确行为，不是缺陷。
      // 因此这里用 Ctrl+Z 还原，并如实记录「Shift+Tab 在该位置不删」这一契约表现。
      await pressTab(true);
      await sleep(220);
      const midAfterOutdent = await evaluate(`return __tiSeg("PMARK");`);
      const outdentSwallowed =
        midAfterOutdent.ok && midParaAfter.ok && midAfterOutdent.text === midParaAfter.text;
      await pressCtrlZ();
      const midParaBack = await evaluate(`return __tiSeg("PMARK");`);
      const midRestored = midParaBack.ok && midParaBefore.ok && midParaBack.text === midParaBefore.text;
      log(
        `      口径备注：该位置 Shift+Tab 按契约吞键不删=${outdentSwallowed}（光标前有正文，非行首缩进区）；` +
          `Ctrl+Z 还原=${midRestored}（${JSON.stringify(midParaBack.text)}）`,
      );
      paraSoftNotes.push({
        midTextBefore: midParaBefore.text,
        midTextAfter: midParaAfter.text,
        midExpected: expectMid,
        midInserted,
        outdentSwallowedAtMid: outdentSwallowed,
        midRestoredByUndo: midRestored,
        placement: midPlace.ok ? "内容第3字符" : midPlace.reason,
      });

      check(
        "6",
        "普通段落：Tab 插入缩进单位（视觉缩进）、Shift+Tab 移除",
        inserted && removed,
        `块=${paraBefore.blockName} 插入=${inserted}(${JSON.stringify(paraBefore.text)}→${JSON.stringify(paraAfter.text)}) 移除=${removed}(${JSON.stringify(paraBack.text)})；光标位置=${midPlace.ok ? "内容起点" : midPlace.reason}`,
      );
    }

    log("");
    log("════════════ 判定项 7：标题不缩进且不派发事务 ════════════");
    {
      const headSel = await evaluate(`return __tiPlace("HDMARK", 0);`);
      const headBefore = await evaluate(`return __tiSeg("HDMARK");`);
      await evaluate(`__tiTxReset(); return true;`);
      await noteFocusPm("标题 Tab");
      await pressTab(false);
      await sleep(220);
      const txsTab = await evaluate(`return __tiTxDump();`);
      await evaluate(`__tiTxReset(); return true;`);
      await noteFocusPm("标题 Shift+Tab");
      await pressTab(true);
      await sleep(220);
      const txsShift = await evaluate(`return __tiTxDump();`);
      const headAfter = await evaluate(`return __tiSeg("HDMARK");`);
      const blockOk = headSel.ok && headSel.blockName === "heading";
      const unchanged = headBefore.ok && headAfter.ok && headAfter.text === headBefore.text;
      check(
        "7",
        "标题：Tab / Shift+Tab 不缩进且不派发事务",
        blockOk && unchanged && txsTab.length === 0 && txsShift.length === 0,
        `落位块=${headSel.blockName} 文本不变=${unchanged}(${JSON.stringify(headAfter.text)}) Tab 事务=${txsTab.length} Shift+Tab 事务=${txsShift.length}`,
      );
    }

    log("");
    log("════════════ 判定项 8：光标夹在配对符号中间 → Tab 跳到闭符号右侧 ════════════");
    {
      const placed = await evaluate(`
        const view = __tiView();
        const found = __tiFindText("PAIRMARK ()");
        if (!found.ok) return found;
        const TS = view.state.selection.constructor;
        view.dispatch(view.state.tr.setSelection(TS.create(view.state.doc, found.pos + "PAIRMARK (".length)));
        view.focus();
        return Object.assign({ ok: true }, __tiSel());
      `);
      const beforeText = await evaluate(`return __tiSeg("PAIRMARK");`);
      const beforeSel = await evaluate(`return __tiSel();`);
      await noteFocusPm("配对符号 Tab");
      await pressTab(false);
      await sleep(220);
      const afterSel = await evaluate(`return __tiSel();`);
      const afterText = await evaluate(`return __tiSeg("PAIRMARK");`);
      const jumped = beforeSel.ok && afterSel.ok && afterSel.from === beforeSel.from + 1 && afterSel.empty;
      const noInsert = beforeText.ok && afterText.ok && afterText.text === beforeText.text;
      check(
        "8",
        "光标夹在 () 中间：Tab 跳到闭符号右侧（不插入缩进）",
        placed.ok && jumped && noInsert,
        `落位=${placed.ok} 选区 ${beforeSel.from}→${afterSel.from}（期望 +1）文本不变=${noInsert}(${JSON.stringify(beforeText.text)})`,
      );
    }

    log("");
    log("════════════ 判定项 9：任何块类型下焦点都不逃出编辑器 ════════════");
    {
      // 补两个最易逃逸的场景：列表首项 Shift+Tab、整块选不中的空段落边界
      await evaluate(`return __tiPlace("LMARKA", 0);`);
      await noteFocusPm("列表首项 Shift+Tab");
      await pressTab(true);
      await sleep(200);
      await evaluate(`return __tiPlace("PAIRMARK", 0);`);
      await noteFocusPm("配对段落 Shift+Tab");
      await pressTab(true);
      await sleep(200);

      const escaped = focusPm.filter((item) => !item.insidePm);
      check(
        "9",
        "任意块类型下 Tab / Shift+Tab 都不把焦点移出编辑器",
        escaped.length === 0,
        escaped.length === 0
          ? `共 ${focusPm.length} 次按键，焦点始终在 .ProseMirror 内（${focusPm.map((x) => x.context).join(" / ")}）`
          : `逃逸 ${escaped.length} 次：${escaped.map((x) => `${x.context}→${x.tag}.${x.cls}`).join(" | ")}`,
      );
      for (const item of focusPm) {
        log(`      [${item.context}] insidePm=${item.insidePm} activeElement=${item.tag}${item.id ? "#" + item.id : ""}.${item.cls}`);
      }
    }

    log("");
    log("════════════ 判定项 10：每次缩进独立成一步撤销 ════════════");
    {
      /**
       * 口径：光标置于 `ZMARK` 的**内容起点**，按 Tab = 在光标处插一个缩进单位
       * （code-indent.ts 的 empty 分支 `tr.insertText(unit, from)`，与单测
       * 「两次 Tab 得到 `"    x"`（不是 `"x    "`）」同源）。
       * 因此两次 Tab 后文本应为 `"    " + 原文`；一次 Ctrl+Z 退回一步应为 `"  " + 原文`。
       * 用「文本前缀」判据而不是「行首空白长度」：后者在光标不在行首时会被误导。
       */
      const prefixCase = async (marker) => {
        const seg = await evaluate(`return __tiSeg(${JSON.stringify(marker)});`);
        return seg.ok ? seg.text : null;
      };

      // ── 主测：两次 Tab（间隔 180ms，落在 pmAdapter 350ms 防抖窗口内）→ 一次 Ctrl+Z ──
      await evaluate(`return __tiPlace("ZMARK", 0);`);
      await evaluate(`__tiTxReset(); return true;`);
      const fastBefore = await prefixCase("ZMARK");
      await noteFocusPm("撤销粒度 Tab#1");
      await pressTab(false);
      await sleep(180);
      await noteFocusPm("撤销粒度 Tab#2");
      await pressTab(false);
      await sleep(180);
      const fastTwo = await prefixCase("ZMARK");
      const txs = await evaluate(`return __tiTxDump();`);
      await noteFocusPm("撤销粒度 Ctrl+Z");
      await pressCtrlZ();
      const fastUndo = await prefixCase("ZMARK");

      const fastTwoOk = fastBefore !== null && fastTwo === "    " + fastBefore;
      const fastOneStep = fastTwoOk && fastUndo === "  " + fastBefore;

      // ── 对照组：两次 Tab 间隔 > 防抖窗口（560ms），验证「慢速两次 = 两步」──
      // 先复位：撤销已回退一步，再按 Tab 恢复到两次状态后再撤，避免状态污染。
      await pressTab(false);
      await sleep(600);
      await evaluate(`return __tiPlace("ZMARK", 0);`);
      await sleep(600);
      const slowBefore = await prefixCase("ZMARK");
      await pressTab(false);
      await sleep(600);
      await pressTab(false);
      await sleep(600);
      const slowTwo = await prefixCase("ZMARK");
      await pressCtrlZ();
      const slowUndo = await prefixCase("ZMARK");
      const slowTwoOk = slowBefore !== null && slowTwo === "    " + slowBefore;
      const slowOneStep = slowTwoOk && slowUndo === "  " + slowBefore;

      undoDetail = {
        fast: { before: fastBefore, afterTwo: fastTwo, afterUndo: fastUndo, txs: txs.length, txDump: txs },
        slow: { before: slowBefore, afterTwo: slowTwo, afterUndo: slowUndo },
        note:
          "fast=两次 Tab 间隔 180ms（pmAdapter DEBOUNCE_MS=350 窗口内）；slow=间隔 600ms（窗口外）。" +
          "两次 Tab 事务均带 closeHistory meta（prosemirror-history 视角），但实机 Ctrl+Z 走统一时间线，不读该 meta。",
      };

      check(
        "10",
        "两次缩进 → 一次 Ctrl+Z 只退回一步",
        fastOneStep,
        `快速两次(180ms)：${JSON.stringify(fastBefore)}→${JSON.stringify(fastTwo)}→(Ctrl+Z)${JSON.stringify(fastUndo)}（期望后两者为 "    "/"  " 前缀）；` +
          `两次 Tab 事务数=${txs.length}（closeHistory=${txs.filter((t) => t.closeHistory).length}）；` +
          `对照组慢速两次(600ms)：一步=${slowOneStep}（${JSON.stringify(slowTwo)}→${JSON.stringify(slowUndo)}）`,
      );
      if (!fastOneStep) {
        if (slowOneStep) {
          log("      ⚠️ 判读：慢速两次是两步、快速两次被合并 → 归并在 pmAdapter 防抖窗口（DEBOUNCE_MS=350），非 closeHistory 失效");
        } else {
          log("      ⚠️ 判读：慢速两次也不是两步 → 需要检查统一时间线是否根本不按缩进边界分组（产品缺陷嫌疑）");
        }
      }

      // ─── 判定项10附：合并窗口边界扫描（补充取证，不改变判定项 10 的结论）───
      log("");
      log("──────── 判定项10附：合并窗口边界扫描 ────────");
      log("  方法：每档用干净起点（Ctrl+Z 撤净 → 校验回到零缩进），两次 Tab 间隔 N ms，");
      log("        再按一次 Ctrl+Z，看剩几个缩进单位（2=合并成一步 / 1=独立两步）。");
      const scan = [];
      // 先撤净 ZMARK 段（前面两组实验可能留下缩进）
      for (let i = 0; i < 8; i++) {
        const seg = await evaluate(`return __tiSeg("ZMARK");`);
        if (seg.ok && !seg.text.startsWith("  ")) break;
        await pressCtrlZ();
        await sleep(120);
      }
      for (const gap of [150, 250, 400, 500, 700]) {
        // 每档起点：确保无缩进
        for (let i = 0; i < 8; i++) {
          const seg = await evaluate(`return __tiSeg("ZMARK");`);
          if (seg.ok && !seg.text.startsWith("  ")) break;
          await pressCtrlZ();
          await sleep(140);
        }
        await sleep(420); // 让上一次 Ctrl+Z 的防抖/节流彻底结算
        await evaluate(`return __tiPlace("ZMARK", 0);`);
        const seg0 = await evaluate(`return __tiSeg("ZMARK");`);

        await pressTab(false);
        await sleep(gap);
        await pressTab(false);
        await sleep(420); // 等 pmAdapter 防抖窗口（350ms）结算后再撤销
        const segTwo = await evaluate(`return __tiSeg("ZMARK");`);

        await pressCtrlZ();
        const segUndo = await evaluate(`return __tiSeg("ZMARK");`);

        const leadOf = (text) => {
          const m = /^ +/.exec(text || "");
          return m ? m[0].length : 0;
        };
        const base = seg0.ok ? leadOf(seg0.text) : -1;
        const two = segTwo.ok ? leadOf(segTwo.text) : -1;
        const undo = segUndo.ok ? leadOf(segUndo.text) : -1;
        const twoApplied = two === base + 4;
        const merged = twoApplied && undo === base; // 一步撤掉两次 → 合并
        const split = twoApplied && undo === base + 2; // 只退一步 → 独立
        scan.push({ gap, base, two, undo, twoApplied, merged, split });
        log(
          `  gap=${String(gap).padStart(3)}ms → 前导空白 ${base} → 两次后 ${two} → Ctrl+Z 后 ${undo}` +
            `　结果=${merged ? "合并为一步" : split ? "独立两步" : "异常/未生效"}`,
        );
      }
      const mergedGaps = scan.filter((s) => s.merged).map((s) => s.gap);
      const splitGaps = scan.filter((s) => s.split).map((s) => s.gap);
      log(`  合并档：${mergedGaps.length ? mergedGaps.join(", ") + "ms" : "（无）"}`);
      log(`  独立档：${splitGaps.length ? splitGaps.join(", ") + "ms" : "（无）"}`);
      if (mergedGaps.length && splitGaps.length) {
        const lastMerged = Math.max(...mergedGaps);
        const firstSplit = Math.min(...splitGaps);
        log(`  ⇒ 阈值落在 ${lastMerged}ms ~ ${firstSplit}ms 之间（与 pmAdapter DEBOUNCE_MS=350 的预期一致）`);
      }
      undoDetail.windowScan = scan;
      undoDetail.windowScanSummary = {
        mergedGaps,
        splitGaps,
        thresholdBetween:
          mergedGaps.length && splitGaps.length
            ? `${Math.max(...mergedGaps)}ms ~ ${Math.min(...splitGaps)}ms`
            : null,
      };
    }

    log("");
    log("════════════ 判定项 11：缩进单位可配（Tab / 2 空格 / 4 空格）即时生效 ════════════");
    {
      const openSettings = async () => {
        await evaluate(
          `window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.settings" } })); return true;`,
        );
        await waitFor(`!!document.querySelector('[data-testid="settings-indent-unit"]')`);
      };
      const closeSettings = async () => {
        await evaluate(`const b = document.querySelector(".settings-close"); if (b) b.click(); return true;`);
        await waitFor(`!document.querySelector('[data-testid="settings-indent-unit"]')`, 8000).catch(() => null);
        await sleep(420);
      };

      await openSettings();
      const original = await evaluate(`return __tiIndentSelect();`);
      settingsReport.original = original;
      settingsReport.method =
        "真实命令总线 lightmd:command{view.settings} 打开设置 → 对 [data-testid=settings-indent-unit] 用原生 value setter + 冒泡 change 改值（React 受控 select 常规落点）→ .settings-close 关闭 → 段落上行首按真实 Tab 量插入字符数 → 最后重新打开设置把原值写回并读回确认";

      const results = [];
      for (const [unit, expectChars] of [
        ["2", 2],
        ["4", 4],
        ["tab", 1],
      ]) {
        const setRes = await evaluate(`return __tiSetIndentUnit(${JSON.stringify(unit)});`);
        await sleep(300);
        await closeSettings();
        await evaluate(`return __tiPlace("UMARK", 0);`);
        const before = await evaluate(`return __tiSeg("UMARK");`);
        await pressTab(false);
        await sleep(220);
        const after = await evaluate(`return __tiSeg("UMARK");`);
        const insertedCount = after.ok && before.ok ? after.text.length - before.text.length : -1;
        const insertedText = after.ok && before.ok ? after.text.slice(0, Math.max(0, insertedCount)) : "";
        const charsOk =
          unit === "tab" ? insertedText === "\t" : insertedText === " ".repeat(expectChars);
        results.push({ unit, ok: insertedCount === expectChars && charsOk, insertedCount, insertedText, set: setRes });
        await pressTab(true); // 反缩进还原
        await sleep(200);
        await openSettings();
      }

      if (original) {
        await evaluate(`return __tiSetIndentUnit(${JSON.stringify(original)});`);
        await sleep(260);
      }
      const restored = await evaluate(`return __tiIndentSelect();`);
      settingsReport.restored = restored;
      await closeSettings();

      check(
        "11",
        "缩进单位设置（Tab / 2 空格 / 4 空格）即时生效，插入字符数与设置一致",
        results.every((r) => r.ok) && restored === original,
        `原值=${original} 各档=${JSON.stringify(results.map((r) => ({ unit: r.unit, ok: r.ok, insertedCount: r.insertedCount, insertedText: r.insertedText })))} 还原=${restored}`,
      );
    }

    log("");
    log("════════════ 判定项 12：源码模式 textarea 的 Tab 插入同一缩进单位 ════════════");
    {
      await evaluate(
        `window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } })); return true;`,
      );
      await waitFor(`!!document.querySelector("textarea.source-editor")`, 12000);
      await sleep(700);

      const setup = await evaluate(`
        const ta = __tiTextarea();
        if (!ta) return { ok: false, reason: "源码 textarea 不可见" };
        ta.focus();
        const idx = ta.value.indexOf("SMARK");
        if (idx < 0) return { ok: false, reason: "textarea 里找不到 SMARK" };
        ta.setSelectionRange(idx, idx);
        return { ok: true, idx, valueLength: ta.value.length, focused: document.activeElement === ta };
      `);
      await sleep(220);
      const focusState = await evaluate(`return __tiFocus();`);
      focusSource.push({ context: "源码模式 Tab", ...focusState });

      await pressTab(false);
      await sleep(260);
      const afterTab = await evaluate(`
        const ta = __tiTextarea();
        if (!ta) return { ok: false, reason: "Tab 后 textarea 消失" };
        const idx = ta.value.indexOf("SMARK");
        const lead = idx >= 0 ? /[ \\t]*$/.exec(ta.value.slice(0, idx))[0] : null;
        return {
          ok: true,
          valueLength: ta.value.length,
          lead,
          focused: document.activeElement === ta,
          activeTag: document.activeElement ? document.activeElement.tagName : null,
          activeCls: document.activeElement ? String(document.activeElement.className || "") : "",
          selStart: ta.selectionStart,
          preventedHint: null,
        };
      `);
      await pressTab(true);
      await sleep(260);
      const afterOut = await evaluate(`
        const ta = __tiTextarea();
        return ta ? { ok: true, valueLength: ta.value.length } : { ok: false };
      `);

      const insertedChars = setup.ok && afterTab.ok ? afterTab.valueLength - setup.valueLength : -1;
      const unitOk = afterTab.ok && afterTab.lead === "  " && insertedChars === 2;
      const focusOk = afterTab.ok && afterTab.focused === true;
      const restoreOk = setup.ok && afterOut.ok && afterOut.valueLength === setup.valueLength;
      check(
        "12",
        "源码模式 textarea：Tab 插入同一缩进单位且焦点不离开 textarea",
        unitOk && focusOk && restoreOk,
        `插入字符数=${insertedChars}（期望 2）行首缩进=${JSON.stringify(afterTab.lead)} 焦点仍在 textarea=${focusOk}(activeElement=${afterTab.activeTag}.${afterTab.activeCls}) Shift+Tab 还原=${restoreOk}(${setup.valueLength}→${afterOut.valueLength})`,
      );
      if (!focusOk) {
        log(`      ⚠️ 焦点读数：${JSON.stringify(focusSource[0])}`);
      }
    }

    await evaluate(`__tiUnwrapDispatch(); return true;`).catch(() => {});

    const failed = checks.filter((item) => !item.ok);
    log("");
    log("════════════ 汇总 ════════════");
    log(`判定项总数=${checks.length}  PASS=${checks.length - failed.length}  FAIL=${failed.length}`);
    for (const item of checks) log(`  ${item.ok ? "PASS" : "FAIL"}  [${item.id}] ${item.name}`);
    if (failed.length) log(`失败项编号：${failed.map((x) => x.id).join(", ")}`);
    log(`产物：${OUT_TXT} / ${OUT_JSON}`);

    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          exe: EXE,
          distHash,
          port: PORT,
          docFile,
          total: checks.length,
          passed: checks.length - failed.length,
          failed: failed.length,
          checks,
          focusPm,
          focusSource,
          settings: settingsReport,
          undoGranularity: undoDetail,
          paragraphSoftNotes: paraSoftNotes,
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf8");
    if (failed.length) process.exitCode = 1;
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    // 只杀自己启动的进程树（不 taskkill /IM，避免误杀他人会话）
    if (child?.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* ignore */
      }
    }
    await sleep(700);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((error) => {
  log(`探针中止：${error.stack || error}`);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf8");
  } catch {
    /* ignore */
  }
  process.exitCode = 2;
});
