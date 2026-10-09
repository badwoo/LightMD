/**
 * LightMD v0.12.0 第三轮返修实机验证（打包产物 + WebView2 CDP 驱动）
 *
 * 覆盖（用户本轮 6 项）：
 *  1. 阅读模式右键**按需接管**：有选区/选中块 → 应用菜单；无选区 → 交回原生菜单
 *     （v0.12.0 曾无差别接管，把原生「表情符号/书写方向/更多工具」挤掉）
 *  2. 拖拽手柄对**所有可拖块**可见：代码块/图表/公式 wrapper 也要有 `⋮⋮`
 *     （此前 only 表格可见：wrapper 的 ::before 被语言角标规则 display:none、且 overflow:hidden 裁掉）
 *  3. 页面缩放时阅读焦点不偏移（Ctrl+滚轮 后滚动百分比守恒）
 *  4. 内容区宽度（--editor-content-max-width）对**编辑模式**生效（wrapper 与 textarea 同宽居中）
 *  6. 编辑模式右键菜单文案为中文（不再回显 `menu.table` 这类英文 key）
 *  （第 5 项「格式刷 10 次」为常量值，已由单测 v0120-format-painter 锁定）
 *
 * 用法：node scripts/real-machine-v0120-round3.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0120_R3_PORT || 9234);
const CDP_BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`;
  results.push(line);
  console.log(line);
  if (!ok) failed++;
}
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
    ws.onerror = (e) => reject(e);
    ws.onopen = () =>
      resolve({
        ws,
        send(method, params, timeoutMs = 60000) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method, params }));
          return new Promise((res, rej) => {
            const t = setTimeout(() => {
              pending.delete(i);
              rej(new Error(`CDP ${method} 超时`));
            }, timeoutMs);
            pending.set(i, {
              resolve: (v) => {
                clearTimeout(t);
                res(v);
              },
            });
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      });
  });
}

/** 生成长文档：足够滚动 + 一个代码块 + 一个表格 */
function buildLongDoc() {
  const parts = ["# 文档标题", "", "开头段落，用于光标定位。", ""];
  parts.push("```js", "const a = 1;", "const b = 2;", "```", "");
  parts.push("| A | B |", "| --- | --- |", "| 1 | 2 |", "");
  for (let i = 1; i <= 120; i++) parts.push(`第 ${i} 段正文内容，用来把文档撑长以便测试滚动与缩放。`, "");
  return parts.join("\n");
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`未找到打包产物：${EXE}`);
    process.exit(3);
  }
  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    await sleep(1200);
  } catch {
    /* 无实例 */
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0120-r3-"));
  const fDoc = path.join(tmpDir, "长文档.md");
  const DOC = buildLongDoc();
  fs.writeFileSync(fDoc, DOC);
  console.log(`临时文件: ${fDoc}`);

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
  });

  let cdp;
  try {
    let picked = null;
    for (let i = 0; i < 40 && !picked; i++) {
      try {
        const list = await (await fetch(`${CDP_BASE}/json/list`)).json();
        for (const t of list) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          try {
            const c = await connect(t.webSocketDebuggerUrl);
            await c.send("Runtime.enable");
            const r = await c.send(
              "Runtime.evaluate",
              {
                expression: `JSON.stringify({tauri: typeof window.__TAURI_INTERNALS__ !== "undefined"})`,
                returnByValue: true,
              },
              20000,
            );
            if (JSON.parse(r.result?.result?.value || "{}").tauri) {
              picked = c;
              break;
            }
            c.close();
          } catch {
            /* 下一个 target */
          }
        }
      } catch {
        /* 端口未就绪 */
      }
      if (!picked) await sleep(500);
    }
    if (!picked) throw new Error("未找到带 Tauri IPC 的 page target");
    cdp = picked;
    await cdp.send("Page.enable");

    const evalJs = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
      }
      return r.result?.result?.value;
    };
    const runCommand = async (id) => {
      await evalJs(
        `window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); true`,
      );
      await sleep(350);
    };
    const readSource = async () => {
      await runCommand("view.edit");
      await sleep(450);
      return evalJs(
        `(() => { const ta = document.querySelector('textarea.source-editor'); return ta ? ta.value : "NO-TEXTAREA"; })()`,
      );
    };
    const openDoc = async () => {
      for (let i = 0; i < 6; i++) {
        await evalJs(
          `window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(fDoc)},content:${JSON.stringify(DOC)}}})); true`,
        );
        await sleep(900);
        const v = await readSource();
        if (typeof v === "string" && v.includes("第 120 段正文")) {
          await runCommand("view.preview");
          await sleep(500);
          return true;
        }
        await sleep(500);
      }
      return false;
    };

    /** 取元素中心坐标 */
    const centerOf = async (selector, nth = 0) => {
      const s = await evalJs(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}];
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      })()`);
      return s ? JSON.parse(s) : null;
    };
    const mouse = async (type, x, y, opts = {}) =>
      cdp.send("Input.dispatchMouseEvent", { type, x, y, ...opts });

    const leftClickAt = async (pt, clickCount = 1) => {
      await mouse("mousePressed", pt.x, pt.y, { button: "left", clickCount });
      await mouse("mouseReleased", pt.x, pt.y, { button: "left", clickCount });
      await sleep(320);
    };
    const rightClickAt = async (pt) => {
      await mouse("mousePressed", pt.x, pt.y, { button: "right", clickCount: 1 });
      await mouse("mouseReleased", pt.x, pt.y, { button: "right", clickCount: 1 });
      await sleep(400);
    };
    const caretText = async () =>
      evalJs(`(() => { const s = document.getSelection(); return s ? (s.toString() || "").slice(0, 40) : "NO-SEL"; })()`);
    const pmMenuInfo = async () =>
      JSON.parse(
        await evalJs(`(() => {
          const m = document.querySelector('[data-testid="pm-context-menu"]');
          if (!m) return JSON.stringify({ present: false });
          const labels = [...m.querySelectorAll('.context-menu-label')].map(n => (n.textContent || '').trim());
          return JSON.stringify({ present: true, labels });
        })()`),
      );

    const okDoc = await openDoc();
    check("前置：长文档就绪（阅读模式）", okDoc);

    // ═════════ 问题1：阅读模式右键按需接管 ═════════
    if (okDoc) {
      // 1-A 有选区（双击选词）→ 应用菜单
      const para = await centerOf(".ProseMirror p", 1);
      if (para) {
        await leftClickAt(para, 2); // 双击选词
        const sel = await caretText();
        await rightClickAt(para);
        const menu = await pmMenuInfo();
        check(
          "1A 【核心】有文本选区右键 → 应用菜单出现（含「格式刷」中文项）",
          menu.present === true && (menu.labels || []).includes("格式刷"),
          `选区="${sel}" 菜单=${JSON.stringify(menu)}`,
        );
        // 关闭菜单
        await leftClickAt(para, 1);
        await sleep(300);
      } else {
        check("1A 前置：找到段落", false);
      }

      // 1-B 无选区（单击后为折叠光标）→ 不接管（原生菜单）
      const para0 = await centerOf(".ProseMirror p", 0);
      if (para0) {
        await leftClickAt(para0, 1); // 折叠光标
        const sel2 = await caretText();
        // 先点一次空白（PM 底部 padding）确保不是"双击"误判
        await sleep(600);
        await rightClickAt(para0);
        const menu2 = await pmMenuInfo();
        check(
          "1B 【核心】无选区右键 → 不出现自定义菜单（交回 WebView2 原生菜单）",
          menu2.present === false,
          `选区="${sel2}" 菜单=${JSON.stringify(menu2)}`,
        );
        // 关掉可能出现的原生菜单
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "Escape", key: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", code: "Escape", key: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
        await sleep(300);
      } else {
        check("1B 前置：找到段落", false);
      }
    }

    // ═════════ 问题2：代码块/表格的拖拽手柄可见 ═════════
    if (okDoc) {
      const codePt = await centerOf(".ProseMirror .code-block-wrapper", 0);
      if (codePt) {
        await leftClickAt(codePt, 1);
        const info = JSON.parse(
          await evalJs(`(() => {
            const el = document.querySelector('.ProseMirror .code-block-wrapper');
            if (!el) return JSON.stringify({ found: false });
            const cs = getComputedStyle(el, '::after');
            return JSON.stringify({
              found: true,
              cls: el.className,
              selected: el.classList.contains('pm-block-selected') || el.classList.contains('ProseMirror-selectednode'),
              content: cs.content,
              leverOverflow: getComputedStyle(el).overflow,
            });
          })()`),
        );
        check(
          "2A 【核心】代码块被选中 → wrapper 带选中 class 且 ::after 手柄内容为 ⋮⋮",
          info.found === true && info.selected === true && String(info.content || "").includes("⋮⋮"),
          `cls="${info.cls}" content=${info.content}`,
        );
        check(
          "2B 【核心】选中态放开 overflow，手柄不被 wrapper 裁剪",
          info.leverOverflow === "visible",
          `overflow=${info.leverOverflow}`,
        );
      } else {
        check("2A 前置：找到代码块", false);
      }

      // 表格也要有手柄（回归保护）：点单元格（th）建立表格 NodeSelection
      const tablePt = await centerOf(".ProseMirror .table-wrapper th", 0);
      if (tablePt) {
        await leftClickAt(tablePt, 1);
        const tinfo = JSON.parse(
          await evalJs(`(() => {
            const root = document.querySelector('.ProseMirror > .table-wrapper');
            if (!root) return JSON.stringify({ found: false });
            const cs = getComputedStyle(root, '::after');
            return JSON.stringify({
              found: true,
              selected: root.classList.contains('pm-block-selected') || root.classList.contains('ProseMirror-selectednode'),
              content: cs.content,
            });
          })()`),
        );
        check(
          "2C 表格手柄仍可见（回归保护）",
          tinfo.found === true && tinfo.selected === true && String(tinfo.content || "").includes("⋮⋮"),
          JSON.stringify(tinfo),
        );
      } else {
        check("2C 前置：找到表格单元格", false);
      }
    }

    // ═════════ 问题3：缩放保持阅读焦点 ═════════
    if (okDoc) {
      const box = await evalJs(`(() => {
        const c = document.querySelector('.editor-container');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + Math.min(200, r.height / 2) });
      })()`);
      const pt = box ? JSON.parse(box) : null;
      const percent = async () =>
        evalJs(`(() => {
          const c = document.querySelector('.editor-container');
          const denom = c.scrollHeight - c.clientHeight;
          return denom <= 0 ? -1 : c.scrollTop / denom;
        })()`);
      if (pt) {
        // 先滚到 35% 附近
        await evalJs(`(() => {
          const c = document.querySelector('.editor-container');
          c.scrollTop = (c.scrollHeight - c.clientHeight) * 0.35;
          return true;
        })()`);
        await sleep(500);
        const p1 = await percent();
        // Ctrl+滚轮 放大 4 步
        for (let i = 0; i < 4; i++) {
          await mouse("mouseWheel", pt.x, pt.y, { deltaX: 0, deltaY: -120, modifiers: 2 });
          await sleep(220);
        }
        await sleep(600);
        const p2 = await percent();
        const zoomAfterIn = await evalJs(`getComputedStyle(document.documentElement).getPropertyValue('--doc-zoom')`);
        check(
          "3A 【核心】放大后阅读滚动百分比基本守恒（焦点不跑）",
          typeof p1 === "number" && typeof p2 === "number" && p1 > 0.2 && Math.abs(p2 - p1) <= 0.05,
          `before=${Number(p1).toFixed(3)} after=${Number(p2).toFixed(3)} docZoom=${String(zoomAfterIn).trim()}`,
        );
        // Ctrl+滚轮 缩小 4 步
        for (let i = 0; i < 4; i++) {
          await mouse("mouseWheel", pt.x, pt.y, { deltaX: 0, deltaY: 120, modifiers: 2 });
          await sleep(220);
        }
        await sleep(600);
        const p3 = await percent();
        check(
          "3B 【核心】缩小后阅读滚动百分比基本守恒",
          typeof p3 === "number" && Math.abs(p3 - p1) <= 0.05,
          `before=${Number(p1).toFixed(3)} after=${Number(p3).toFixed(3)}`,
        );
      }
    }

    // ═════════ 问题4：内容区宽度对编辑模式生效 ═════════
    await runCommand("view.edit");
    await sleep(600);
    {
      const readWidths = async () =>
        JSON.parse(
          await evalJs(`(() => {
            const ta = document.querySelector('textarea.source-editor');
            const wrap = document.querySelector('.source-editor-wrapper');
            if (!ta || !wrap) return JSON.stringify({ found: false });
            return JSON.stringify({
              found: true,
              taMax: getComputedStyle(ta).maxWidth,
              wrapMax: getComputedStyle(wrap).maxWidth,
              taW: Math.round(ta.getBoundingClientRect().width),
              wrapW: Math.round(wrap.getBoundingClientRect().width),
            });
          })()`),
        );
      const def = await readWidths();
      // 变量可能已被用户在设置里持久化（如 1240px），故期望值从 :root 变量推导：
      // 未设置 → CSS 兜底 960px；已设置 → 该值。关键是 wrapper 与 textarea 必须同宽。
      const rootVar = String(
        await evalJs(`getComputedStyle(document.documentElement).getPropertyValue('--editor-content-max-width')`),
      ).trim();
      const expected = rootVar ? rootVar : "960px";
      check(
        "4A 编辑模式宽度生效（wrapper 与 textarea 同宽 = :root 变量或 960px 兜底）",
        def.found === true && def.taMax === expected && def.wrapMax === expected && def.taW === def.wrapW,
        `rootVar="${rootVar}" expect=${expected} ${JSON.stringify(def)}`,
      );
      // 模拟用户在设置里调宽度 → EditorContainer 会把变量写到 :root
      await evalJs(`document.documentElement.style.setProperty('--editor-content-max-width', '620px'); true`);
      await sleep(400);
      const w = await readWidths();
      check(
        "4B 【核心】编辑模式响应 --editor-content-max-width（wrapper 与 textarea 同为 620px）",
        w.found === true && w.taMax === "620px" && w.wrapMax === "620px" && w.taW === w.wrapW,
        JSON.stringify(w),
      );
      await evalJs(`document.documentElement.style.removeProperty('--editor-content-max-width'); true`);
      await sleep(300);
    }

    // ═════════ 问题6：编辑模式右键菜单中文 ═════════
    {
      const taPt = await centerOf("textarea.source-editor", 0);
      if (taPt) {
        await rightClickAt(taPt);
        const labels = JSON.parse(
          await evalJs(`(() => {
            const m = document.querySelector('.editor-context-menu');
            if (!m) return JSON.stringify({ present: false });
            return JSON.stringify({ present: true, labels: [...m.querySelectorAll('.context-menu-label')].map(n => (n.textContent||'').trim()) });
          })()`),
        );
        const arr = labels.labels || [];
        const hasChinese = arr.includes("插入表格") && arr.includes("插入图片") && arr.includes("插入代码块");
        const noRawKey = arr.every((s) => !/^menu\./.test(s));
        check(
          "6A 【核心】编辑模式右键菜单为中文（插入表格/图片/代码块）",
          labels.present === true && hasChinese,
          JSON.stringify(labels),
        );
        check("6B 无英文 key 回显（menu.xxx）", noRawKey, JSON.stringify(arr));
        // 关闭菜单
        await leftClickAt({ x: 5, y: 5 }, 1);
        await sleep(300);
      } else {
        check("6A 前置：找到 textarea", false);
      }
    }
  } finally {
    try {
      if (cdp) cdp.close();
    } catch {
      /* ignore */
    }
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    void child;
  }

  console.log("\n================ 汇总 ================");
  const total = results.length;
  console.log(`PASS ${total - failed}/${total}${failed ? `，FAIL ${failed}` : ""}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("验证脚本异常：", e);
  process.exit(2);
});