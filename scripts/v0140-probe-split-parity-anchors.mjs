/**
 * 探针：v0.14.0 需求4 子问题 —— **含 mermaid 的文档为什么一个 data-src-line 都没贴上**。
 *
 * 现象：探针 ③（表格/mermaid）实测 `[data-src-line]` 数量 = 0，右屏只能走百分比映射，
 * 于是「左屏驱动」时右屏 pct 与左屏 pct 完全同步（0.1/0.25/0.5/0.75/0.9/1.0）——
 * 正是用户抱怨的"篇幅差 → 内容对不齐"。
 *
 * 本脚本只读：打开一份含 mermaid 的文档，dump iframe body 的 children 标签序列，
 * 与 `topLevelBlockStartLines` 的长度对比，定位 `shouldTagPreview` 数量自校验失败的原因。
 *
 * 用法：node scripts/v0140-probe-split-parity-anchors.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_PARITY_ANCHOR_PORT || 9284);
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};

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

const DOCS = {
  mermaid: [
    "# mermaid 文档",
    "",
    "前置段落一。",
    "",
    "前置段落二。",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "```mermaid",
    "flowchart TD",
    "  A --> B",
    "```",
    "",
    "后置段落。",
    "",
  ].join("\n"),
  math: ["# 公式文档", "", "段落一。", "", "$$a^2+b^2=c^2$$", "", "段落二。", ""].join("\n"),
  plain: ["# 纯文本文档", "", "段落一。", "", "段落二。", "", "段落三。", ""].join("\n"),
};

const main = async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-anchors-"));
  const profile = path.join(tmpDir, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const files = {};
  for (const [k, text] of Object.entries(DOCS)) {
    files[k] = path.join(tmpDir, `anchors-${k}.md`);
    fs.writeFileSync(files[k], text, "utf-8");
  }

  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await sleep(1200);

  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });

  let cdp = null;
  for (let i = 0; i < 60 && !cdp; i++) {
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
          if (r.result?.result?.value === true) {
            cdp = c;
            break;
          }
          c.close();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    if (!cdp) await sleep(400);
  }
  if (!cdp) throw new Error("找不到 WebView2 CDP target");

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(() => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };

  try {
    for (const key of Object.keys(DOCS)) {
      log("");
      log(`════════ ${key} ════════`);
      await ev(
        `window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(
          files[key],
        )}}})); return 1;`,
      );
      await sleep(2200);
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.edit"}})); return 1;`);
      await sleep(2600);
      await sleep(1500);

      const info = await ev(`
        const ifr = document.querySelector(".split-preview-shell iframe");
        const d = ifr && ifr.contentDocument;
        if (!d) return null;
        const kids = Array.from(d.body.children);
        return {
          childCount: kids.length,
          tags: kids.map((e) => e.tagName.toLowerCase()),
          classes: kids.map((e) => e.className && String(e.className).slice(0, 40)),
          tagged: d.querySelectorAll("[data-src-line]").length,
          // 只数"内容元素"（排除脚本/样式/链接/模板）
          contentCount: kids.filter((e) => !/^(SCRIPT|STYLE|LINK|TEMPLATE|NOSCRIPT)$/.test(e.tagName)).length,
          bodyHtmlHead: d.body.innerHTML.slice(0, 900),
        };
      `);
      log(`  body.children = ${info.childCount}: ${info.tags.join(", ")}`);
      log(`  classes       = ${JSON.stringify(info.classes)}`);
      log(`  非脚本内容元素 = ${info.contentCount}；已贴标 = ${info.tagged}`);
      log(`  body HTML 头部 = ${info.bodyHtmlHead.replace(/\n/g, " ").slice(0, 500)}`);
    }
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
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "v0140-probe-split-parity-anchors.txt"), lines.join("\n") + "\n", "utf-8");
};

main().catch((e) => {
  console.error("探针异常：", e);
  process.exit(1);
});
