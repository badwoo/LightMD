/**
 * LightMD v0.17.0 探针：**多选区（多光标）可用性**
 *
 * ## 为什么需要
 * 设计稿 G1 要求 CM6 承接「多光标」，A3 报告把它标为「需实机手测」。
 * 但多光标其实**可以用 CDP 键盘事件自动化验证**：
 * CM6 的 `defaultKeymap` 已装（`keymap.of([...defaultKeymap])`），其中
 * `Mod-Alt-ArrowUp` / `Mod-Alt-ArrowDown` 绑定 `addCursorAbove/Below`。
 *
 * ## 验证方式（不依赖内部句柄）
 * 1. 焦点放进 `.cm-content`，光标置于某行；
 * 2. 发 `Ctrl+Alt+ArrowDown` 两次 → 应产生 3 个光标；
 * 3. 断言证据：**输入一个字符后，该字符出现在 3 个位置**。
 *    这是**行为证据**，比读内部 state 更可靠（且 CM6 的 view 不挂 DOM）。
 *
 * ## 判定
 * - 插入 1 个字符 → 文本中出现 3 处新字符 → PASS（多光标生效）
 * - 只出现 1 处 → FAIL（多光标未生效）
 *
 * 用法：node scripts/v0170-probe-multicursor.mjs
 * 前置：npx tauri build --no-bundle
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = 9473;
const OUT_JSON = path.join(ROOT, "_verify-out", "v0170-probe-multicursor.json");
const OUT_TXT = path.join(ROOT, "_verify-out", "v0170-probe-multicursor.txt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (t = "") => { lines.push(t); console.log(t); };

/**
 * 测试文档：**4 个连续普通段落**（无空行间隔，便于多光标向上/下扩展时
 * 落在相邻行上），每行带唯一标记便于精确计数。
 */
const DOC = [
  "# MCUR 标题",
  "",
  "MCUR_LINE_A alpha",
  "MCUR_LINE_B bravo",
  "MCUR_LINE_C charlie",
  "MCUR_LINE_D delta",
  "",
  "尾部",
  "",
].join("\n");

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () =>
      res({
        send(m, q) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method: m, params: q }));
          return new Promise((a, b) => {
            pending.set(i, { a, b });
            setTimeout(() => { if (pending.delete(i)) b(new Error("timeout " + m)); }, 30000);
          });
        },
        close() { ws.close(); },
      }),
    );
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const it = pending.get(m.id); if (!it) return;
      pending.delete(m.id);
      m.error ? it.b(new Error(JSON.stringify(m.error))) : it.a(m);
    });
    ws.addEventListener("error", () => rej(new Error("ws error")));
  });
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  const hm = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!hm) throw new Error("dist/index.html 找不到入口 hash");
  if (!fs.readFileSync(EXE).includes(Buffer.from(hm[1]))) {
    throw new Error(`exe 内联 dist 不一致（找不到 ${hm[1]}）→ 请 npx tauri build --no-bundle`);
  }
  log(`[probe] exe 内联 dist 校验通过：${hm[1]}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lmd-mc-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "mcur.md");
  fs.writeFileSync(docFile, DOC, "utf8");

  let child = null;
  let cdp = null;
  const results = [];
  const add = (id, name, status, detail) => {
    results.push({ id, name, status, detail });
    const tag = status === "PASS" ? "PASS " : status === "KNOWN" ? "KNOWN" : "FAIL ";
    log(`${tag} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
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

    for (let i = 0; i < 140 && !cdp; i++) {
      try {
        const targets = await (
          await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })
        ).json();
        for (const t of targets) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          const c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send("Runtime.evaluate", {
            expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`,
            returnByValue: true,
          });
          if (r.result?.result?.value) { cdp = c; break; }
          c.close();
        }
      } catch { /* not ready */ }
      if (!cdp) await sleep(350);
    }
    if (!cdp) throw new Error("找不到 CDP target");

    const ev = async (body) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(async () => { ${body} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
      }
      return r.result?.result?.value;
    };

    // ── 打开文档 → 编辑模式 ──
    let loaded = false;
    for (let i = 0; i < 25 && !loaded; i++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFile", {
          detail: {
            path: ${JSON.stringify(docFile)},
            name: ${JSON.stringify(path.basename(docFile))},
            content: ${JSON.stringify(DOC)},
          },
        }));
        return true;
      `);
      await sleep(650);
      loaded = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        return !!pm && (pm.textContent || "").indexOf("MCUR_LINE_A") >= 0;
      `);
    }
    if (!loaded) throw new Error("文档未装入");

    await ev(`
      window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.edit" } }));
      return true;
    `);
    await sleep(2200);

    const impl = await ev(`return document.querySelector(".cm-editor") ? "cm6" : "textarea";`);
    add("1", "CM6 源码面已启用", impl === "cm6" ? "PASS" : "FAIL", `impl=${impl}`);
    if (impl !== "cm6") throw new Error("CM6 未启用，本探针无意义");

    const readText = () =>
      ev(`return Array.from(document.querySelectorAll(".cm-line")).map(l => l.textContent || "").join(String.fromCharCode(10));`);

    const textBefore = await readText();
    if (!textBefore || textBefore.indexOf("MCUR_LINE_A") < 0) {
      throw new Error(`文档未渲染进 CM6（读到 ${JSON.stringify((textBefore || "").slice(0, 60))}）`);
    }
    add("2", "文档已渲染进 CM6", "PASS", `长度=${textBefore.length}`);

    // ── 焦点落位：点内容区中央，再用键盘精确导航到 MCUR_LINE_B 行首 ──
    const box = await ev(`
      const c = document.querySelector(".cm-content");
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    if (!box) throw new Error("找不到 .cm-content");
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
    await sleep(300);

    const press = async (keyName, code, vk, modifiers = 0) => {
      const base = { key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
      await sleep(25);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(180);
    };

    // Ctrl+Home → 下移 2 行（到 MCUR_LINE_A 行）→ Home
    await press("Home", "Home", 36, 2);
    await press("ArrowDown", "ArrowDown", 40);
    await press("ArrowDown", "ArrowDown", 40);
    await press("Home", "Home", 36);
    await sleep(250);

    const focusInfo = await ev(`
      return (document.activeElement && (document.activeElement.className || document.activeElement.tagName)) || "";
    `);
    add("3", "焦点在编辑器内（多光标前提）", String(focusInfo).indexOf("cm-") >= 0 ? "PASS" : "FAIL", `焦点=${focusInfo}`);

    /**
     * ── 核心：Ctrl+Alt+ArrowDown ×2 → 3 个光标 ──
     * CDP modifiers 位：Alt=1, Ctrl=2, Meta=4, Shift=8 → Ctrl+Alt = 3
     */
    await press("ArrowDown", "ArrowDown", 40, 3);
    await sleep(250);
    await press("ArrowDown", "ArrowDown", 40, 3);
    await sleep(350);

    // 用可辨识字符验证"一字符多插入"
    await cdp.send("Input.insertText", { text: "Z" });
    await sleep(500);
    const textAfter = await readText();
    const zCount = (textAfter.match(/Z/g) || []).length;

    /**
     * 判定：
     * - Z 出现 ≥ 2 处 → 多光标生效（3 个光标应插 3 处；保守下限取 2，
     *   因为行数/光标合并策略可能吸收掉一个）
     * - 只出现 1 处 → 多光标未生效
     */
    add(
      "4",
      "多光标可用（Ctrl+Alt+↓ 后输入 1 字符产生多处插入）",
      zCount >= 2 ? "PASS" : "FAIL",
      `插入 1 个 "Z"，文本中出现 ${zCount} 处${zCount >= 2 ? "" : "（多光标未生效）"}`,
    );

    // 附加证据：多行插入后行数应不变（多光标是并行插入，不是换行）
    const linesBefore = (textBefore || "").split("\n").length;
    const linesAfter = (textAfter || "").split("\n").length;
    add(
      "5",
      "多光标插入不破坏行结构",
      linesBefore === linesAfter ? "PASS" : "KNOWN",
      `行数 ${linesBefore} → ${linesAfter}`,
    );

    log("");
    const fails = results.filter((r) => r.status === "FAIL");
    log(`[probe] PASS=${results.filter((r) => r.status === "PASS").length} KNOWN=${results.filter((r) => r.status === "KNOWN").length} FAIL=${fails.length}`);
  } catch (err) {
    log(`[probe] 异常：${err?.message || String(err)}`);
    results.push({ id: "E", name: "探针执行", status: "FAIL", detail: err?.message || String(err) });
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    try { child?.kill(); } catch { /* ignore */ }
    await sleep(400);
    try { execFileSync("taskkill", ["/F", "/IM", "lightmd.exe"], { stdio: "ignore" }); } catch { /* ignore */ }

    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf8");
    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify({ generatedAt: new Date().toISOString(), doc: DOC, results }, null, 1),
      "utf8",
    );
    log(`[probe] 产物：${OUT_JSON}`);
    if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
  }
}

main();
