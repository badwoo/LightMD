/**
 * v0.11.0 返修实机验证：B3-2（源码快捷键） / B3-4（转义噪音） / B2-1 ④（securityLevel）
 *
 * 覆盖：
 *  A. B3-2 源码模式 Ctrl+Shift+8 / 9 / . 必须真的产生 列表 / 有序列表 / 引用
 *     （返修前 sourceFormat 缺映射 → parseShortcut 返回 null → 完全无反应）
 *  B. B3-4 富文本编辑后序列化不得给 `x^2 + y^2` 凭空加反斜杠
 *     （返修前按「≥2 次」判定 → 会输出 `x\^2 + y\^2`）
 *  C. B2-1 ④ 分屏预览 iframe 的 mermaid securityLevel 应为 strict（返修前 loose）
 *
 * 用法：node scripts/real-machine-v0110-fixverify.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0110_FIXVERIFY_PORT || 9232);
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

async function listTargets() {
  try {
    return await (await fetch(`${CDP_BASE}/json/list`)).json();
  } catch {
    return [];
  }
}

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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0110-fixv-"));
  const fSrc = path.join(tmpDir, "快捷键.md");
  const fEsc = path.join(tmpDir, "转义.md");
  const fMmd = path.join(tmpDir, "图表.md");
  const SRC = "alpha\n\nbeta\n";
  const ESC = "x^2 + y^2\n";
  const MMD = "# 图表\n\n```mermaid\ngraph TD; A-->B;\n```\n";
  fs.writeFileSync(fSrc, SRC);
  fs.writeFileSync(fEsc, ESC);
  fs.writeFileSync(fMmd, MMD);
  console.log(`临时目录: ${tmpDir}`);

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
  });

  let cdp;
  try {
    // 选到带 Tauri IPC 的 page target
    let picked = null;
    for (let i = 0; i < 40 && !picked; i++) {
      for (const t of await listTargets()) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        try {
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send(
            "Runtime.evaluate",
            {
              expression: `JSON.stringify({tauri: typeof window.__TAURI_INTERNALS__ !== "undefined", pm: !!document.querySelector(".ProseMirror")})`,
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
          /* 下一个 */
        }
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
      await sleep(500);
      return evalJs(
        `(() => { const ta = document.querySelector('textarea.source-editor') || document.querySelector('textarea'); return ta ? ta.value : "NO-TEXTAREA"; })()`,
      );
    };
    const openAndVerify = async (p, content, marker) => {
      for (let i = 0; i < 6; i++) {
        await evalJs(
          `window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(p)},content:${JSON.stringify(content)}}})); true`,
        );
        await sleep(900);
        const v = await readSource();
        if (typeof v === "string" && v.includes(marker)) return true;
        await sleep(600);
      }
      return false;
    };
    /** 真实按键（只发 rawKeyDown + keyUp，不发 char） */
    const pressKey = async (code, key, vk, modifiers = 0) => {
      const base = {
        modifiers,
        code,
        key,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(400);
    };
    /** 在源码 textarea 内放置光标 */
    const focusSourceCaret = async (pos = 0) =>
      evalJs(`(() => {
        const ta = document.querySelector('textarea.source-editor') || document.querySelector('textarea');
        if (!ta) return 'no-textarea';
        ta.focus();
        ta.setSelectionRange(${pos}, ${pos});
        return 'ok';
      })()`);

    // ═══════════ A. B3-2 源码模式 Ctrl+Shift+8 / 9 / . ═══════════
    const cases = [
      { name: "Ctrl+Shift+8 → 无序列表", code: "Digit8", key: "*", vk: 56, expect: "- 列表项" },
      { name: "Ctrl+Shift+9 → 有序列表", code: "Digit9", key: "(", vk: 57, expect: "1. 列表项" },
      {
        name: "Ctrl+Shift+. → 引用",
        code: "Period",
        key: ">",
        vk: 190,
        expect: "> 引用文本",
      },
    ];
    for (const c of cases) {
      const ok = await openAndVerify(fSrc, SRC, "alpha");
      if (!ok) {
        check(`A 前置：源码文档就绪（${c.name}）`, false, "openAndVerify 失败");
        continue;
      }
      await focusSourceCaret(0);
      await pressKey(c.code, c.key, c.vk, 2 | 8 /* Ctrl+Shift */);
      const v = await readSource();
      check(
        `A B3-2 ${c.name}`,
        typeof v === "string" && v.includes(c.expect),
        `期望含 ${JSON.stringify(c.expect)}；实际=${JSON.stringify(String(v).slice(0, 80))}`,
      );
    }

    // ═══════════ B. B3-4 富文本编辑后序列化不得加反斜杠 ═══════════
    const okEsc = await openAndVerify(fEsc, ESC, "x^2 + y^2");
    check("B 前置：转义样本文档就绪", okEsc, `openAndVerify=${okEsc}`);
    if (okEsc) {
      await runCommand("view.preview");
      await sleep(500);
      // 把光标放进段落末尾并敲一个字符再删掉 → 该块脱离「原文保留」，强制走真实序列化
      await evalJs(`(() => {
        const p = document.querySelector('.ProseMirror p');
        if (!p) return 'no-p';
        p.click();
        return 'ok';
      })()`);
      await sleep(300);
      await pressKey("End", "End", 35, 0);
      // 输入 z（char 事件）再退格
      await cdp.send("Input.dispatchKeyEvent", {
        type: "char",
        text: "z",
        key: "z",
        code: "KeyZ",
        windowsVirtualKeyCode: 90,
      });
      await sleep(300);
      await pressKey("Backspace", "Backspace", 8, 0);
      const after = await readSource();
      // 判据是「没有反斜杠-carets」，注意正则是 \\\^（反斜杠+^），
      // 写成 /\^/ 会匹配裸 ^ 从而把正确结果误判为失败。
      const hasBackslashBeforeCaret = typeof after === "string" && /\\\^/.test(after);
      check(
        "B B3-4 编辑后 `x^2 + y^2` 未产生反斜杠污染",
        typeof after === "string" && after.includes("x^2 + y^2") && !hasBackslashBeforeCaret,
        `实际=${JSON.stringify(String(after).slice(0, 80))}`,
      );
    }

    // ═══════════ C. B2-1 ④ 分屏预览 securityLevel ═══════════
    const okMmd = await openAndVerify(fMmd, MMD, "mermaid");
    if (!okMmd) {
      check("C 前置：图表文档就绪", false, "openAndVerify 失败");
    } else {
      await runCommand("view.split");
      await sleep(1600);
      const scripts = await evalJs(`(() => {
        const f = document.querySelector('iframe');
        if (!f || !f.contentDocument) return 'no-iframe';
        const out = [];
        f.contentDocument.querySelectorAll('script').forEach(s => out.push(s.textContent || ''));
        return out.join('\\n');
      })()`);
      const strict = typeof scripts === "string" && /securityLevel:\s*'strict'/.test(scripts);
      const loose = typeof scripts === "string" && /securityLevel:\s*'loose'/.test(scripts);
      check(
        "C B2-1 ④ 分屏预览 iframe 的 mermaid securityLevel 已收紧为 strict",
        strict && !loose,
        `strict=${strict} loose=${loose}`,
      );
      const svgRendered = await evalJs(`(() => {
        const f = document.querySelector('iframe');
        if (!f || !f.contentDocument) return 'no-iframe';
        return String(f.contentDocument.querySelectorAll('pre.mermaid svg, .mermaid svg').length);
      })()`);
      check(
        "C 收紧后 mermaid 仍能正常渲染为 svg（无功能回归）",
        Number(svgRendered) > 0,
        `svg 数=${svgRendered}`,
      );
    }

    console.log("");
    console.log(`=== 返修实机验证结果：共 ${results.length} 项，失败 ${failed} 项 ===`);
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("返修验证脚本执行失败:", e);
  process.exit(2);
});
