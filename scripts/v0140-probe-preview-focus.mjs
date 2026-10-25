/**
 * v0.14.0 第七批：预览开合的「阅读焦点」专项探针。
 *
 * 用法：node scripts/v0140-probe-preview-focus.mjs
 * 可选：V0140_EXE=<安装版或构建版 lightmd.exe>（默认 target/release）
 *
 * 验证：
 *  1. 非底部时，把指定小节放在左屏视口中央；关闭/重开预览后仍是同一小节、同一位置；
 *  2. 重开预览后，右屏 scrollTop 应自动回到第一次打开时的对应位置，不需手动滚动；
 *  3. 反复开合不得累积漂移（底部用例另由 drift 探针覆盖）。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = process.env.V0140_EXE || "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_FOCUS_PORT || 9311);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
    };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      send(method, params, timeoutMs = 60000) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, params }));
        return new Promise((res, rej) => {
          const t = setTimeout(() => { pending.delete(i); rej(new Error("CDP timeout " + method)); }, timeoutMs);
          pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); } });
        });
      },
      close() { try { ws.close(); } catch {} },
    });
  });
}

function makeDoc() {
  const out = ["# 阅读焦点验证文档", ""];
  for (let chapter = 1; chapter <= 12; chapter++) {
    for (let section = 1; section <= 4; section++) {
      out.push(`## ${chapter}.${section} 小章节`, "");
      for (let p = 1; p <= 5; p++) {
        out.push(`${chapter}.${section}.${p} 这是用于验证预览开合阅读焦点的长段落。文字必须足够长，让左栏在分屏与全宽之间产生软换行差异，从而暴露按像素保存滚动位置导致的内容跳转。`.repeat(4), "");
      }
    }
  }
  out.push("## 文档末尾", "", "最后一段用于确认文档边界。", "");
  return out.join("\n");
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error("找不到 exe：" + EXE);
  const html = fs.readFileSync("dist/index.html", "utf8");
  const hash = html.match(/index-[A-Za-z0-9_-]+\.js/)?.[0];
  if (!hash || !fs.readFileSync(EXE).includes(Buffer.from(hash))) {
    throw new Error(`exe 内联 dist 不是当前版本（${hash}），请先 npx tauri build --no-bundle`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lm-focus-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmp, "focus.md");
  const docText = makeDoc();
  fs.writeFileSync(docFile, docText, "utf8");
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(900);
  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile },
    stdio: "ignore",
  });
  let cdp = null;
  try {
    for (let i = 0; i < 70 && !cdp; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        for (const t of list) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          try {
            const c = await connect(t.webSocketDebuggerUrl);
            await c.send("Runtime.enable");
            const r = await c.send("Runtime.evaluate", { expression: 'typeof window.__TAURI_INTERNALS__!=="undefined"', returnByValue: true });
            if (r.result?.result?.value === true) { cdp = c; break; }
            c.close();
          } catch {}
        }
      } catch {}
      if (!cdp) await sleep(400);
    }
    if (!cdp) throw new Error("未连接到 WebView2 CDP");
    const ev = async (body) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(()=>{${body}})()`, returnByValue: true, awaitPromise: true,
      });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
      return r.result?.result?.value;
    };
    const command = async (id) => {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}}));return true`);
    };

    // 页面内 mirror 测量：得到指定文字在 textarea 视口中的真实 Y，支持将焦点放到视口中央。
    await ev(`
      window.__focusMeasure = (needle) => {
        const ta = document.querySelector("textarea.source-editor");
        if (!ta) return null;
        const offset = ta.value.indexOf(needle);
        if (offset < 0) return null;
        const cs = getComputedStyle(ta);
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const br = parseFloat(cs.borderRightWidth) || 0;
        const mirror = document.createElement("div");
        mirror.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;white-space:pre-wrap;overflow:hidden;";
        mirror.style.width = (ta.clientWidth + bl + br) + "px";
        mirror.style.padding = cs.padding;
        mirror.style.borderStyle = "solid";
        mirror.style.borderWidth = cs.borderWidth;
        mirror.style.fontFamily = cs.fontFamily;
        mirror.style.fontSize = cs.fontSize;
        mirror.style.fontWeight = cs.fontWeight;
        mirror.style.lineHeight = cs.lineHeight;
        mirror.style.letterSpacing = cs.letterSpacing;
        mirror.style.wordBreak = cs.wordBreak;
        mirror.style.tabSize = cs.tabSize;
        mirror.textContent = ta.value;
        document.body.appendChild(mirror);
        const node = mirror.firstChild;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, Math.min(offset + needle.length, ta.value.length));
        const rect = range.getBoundingClientRect();
        const mrect = mirror.getBoundingClientRect();
        const paddingTop = parseFloat(cs.paddingTop) || 0;
        const viewportY = rect.top - mrect.top - paddingTop - ta.scrollTop;
        mirror.remove();
        return { offset, viewportY, height: rect.height, centerY: ta.clientHeight / 2,
                 scrollTop: ta.scrollTop, max: Math.max(0, ta.scrollHeight - ta.clientHeight) };
      };
      window.__focusState = (needle) => {
        const ta = document.querySelector("textarea.source-editor");
        const m = window.__focusMeasure(needle);
        const shell = document.querySelector(".split-preview-shell");
        const iframe = document.querySelector(".split-preview-shell iframe");
        const doc = iframe && iframe.contentDocument;
        const scroller = doc && (doc.scrollingElement || doc.documentElement);
        let rightHeading = null;
        if (doc) {
          const hs = Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6"));
          const h = hs.find((x) => x.textContent && x.textContent.trim() === needle);
          if (h) rightHeading = h.getBoundingClientRect().top + (scroller ? scroller.scrollTop : 0) - (scroller ? scroller.scrollTop : 0);
        }
        return {
          open: !!(shell && shell.classList.contains("split-preview-open")),
          width: ta ? ta.clientWidth : 0,
          leftTop: ta ? +ta.scrollTop.toFixed(3) : null,
          leftMax: m ? +m.max.toFixed(3) : null,
          focusViewportY: m ? +m.viewportY.toFixed(3) : null,
          focusDeltaFromCenter: m ? +(m.viewportY - m.centerY).toFixed(3) : null,
          rightTop: scroller ? +scroller.scrollTop.toFixed(3) : null,
          rightMax: scroller ? +Math.max(0, scroller.scrollHeight - scroller.clientHeight).toFixed(3) : null,
          rightHeadingViewportY: rightHeading === null ? null : +rightHeading.toFixed(3),
        };
      };
      return true;
    `);

    let ready = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(docFile)},content:${JSON.stringify(docText)}}}));return true`);
      await sleep(1200);
      await command("view.edit");
      await sleep(900);
      const state = await ev(`const ta=document.querySelector("textarea.source-editor");return ta?{len:ta.value.length,max:ta.scrollHeight-ta.clientHeight}:null`);
      if (state && state.len === docText.length && state.max > 100) { ready = true; break; }
    }
    if (!ready) throw new Error("文档未成功加载到编辑区");

    const state = (needle) => ev(`return window.__focusState(${JSON.stringify(needle)})`);
    const center = async (needle) => {
      await ev(`
        const ta=document.querySelector("textarea.source-editor");
        for(let i=0;i<3;i++){
          const m=window.__focusMeasure(${JSON.stringify(needle)});
          if(!m) break;
          ta.scrollTop=Math.max(0,Math.min(m.max,ta.scrollTop+m.viewportY-m.centerY));
        }
        return true;
      `);
      await sleep(2200);
      return state(needle);
    };
    const openPreview = async () => {
      const s = await ev(`return {open:!!document.querySelector(".split-preview-open")}`);
      if (!s.open) await command("view.togglePreview");
      await sleep(2400);
    };
    const closePreview = async () => {
      const s = await ev(`return {open:!!document.querySelector(".split-preview-open")}`);
      if (s.open) await command("view.togglePreview");
      await sleep(2400);
    };

    const results = [];
    for (const needle of ["3.1 小章节", "7.3 小章节"]) {
      await openPreview();
      const before = await center(needle);
      const closed = await closePreview();
      const afterClosed = await state(needle);
      await openPreview();
      const afterReopen = await state(needle);
      const row = {
        needle,
        beforeCenterDelta: before.focusDeltaFromCenter,
        closedCenterDelta: afterClosed.focusDeltaFromCenter,
        reopenCenterDelta: afterReopen.focusDeltaFromCenter,
        leftDriftOnClose: +(afterClosed.focusDeltaFromCenter - before.focusDeltaFromCenter).toFixed(3),
        leftDriftOnReopen: +(afterReopen.focusDeltaFromCenter - before.focusDeltaFromCenter).toFixed(3),
        rightTopBefore: before.rightTop,
        rightTopAfterReopen: afterReopen.rightTop,
        rightDrift: afterReopen.rightTop === null || before.rightTop === null ? null : +(afterReopen.rightTop - before.rightTop).toFixed(3),
        before, afterClosed, afterReopen,
      };
      results.push(row);
      console.log("\n用例：" + needle);
      console.log("  打开（中央基线）左Δ=" + row.beforeCenterDelta + " 右=" + before.rightTop);
      console.log("  关闭后           左Δ=" + row.closedCenterDelta + " 左屏焦点偏移=" + row.leftDriftOnClose);
      console.log("  重开后           左Δ=" + row.reopenCenterDelta + " 右=" + afterReopen.rightTop + " 右屏偏移=" + row.rightDrift);
    }
    const focusOk = results.every((r) => Math.abs(r.leftDriftOnClose) <= 2 && Math.abs(r.leftDriftOnReopen) <= 2);
    const rightOk = results.every((r) => r.rightDrift !== null && Math.abs(r.rightDrift) <= 2);

    // ── 追加：阅读模式 ↔ 编辑/分屏 的进度联动（内容级，不只看百分比）──
    await ev(`
      window.__readingState = () => {
        const c = document.querySelector(".editor-container");
        if (!c) return null;
        const max = Math.max(0, c.scrollHeight - c.clientHeight);
        return { percent: max > 0 ? +(c.scrollTop / max).toFixed(6) : 0, max: +max.toFixed(2) };
      };
      window.__centerReading = (needle) => {
        const c = document.querySelector(".editor-container");
        if (!c) return null;
        const hs = Array.from(c.querySelectorAll(".ProseMirror h1,.ProseMirror h2,.ProseMirror h3,.ProseMirror h4,.ProseMirror h5,.ProseMirror h6"));
        const h = hs.find((x) => (x.textContent || "").trim() === needle);
        if (!h) return null;
        for (let i = 0; i < 3; i++) {
          const cr = c.getBoundingClientRect();
          const hr = h.getBoundingClientRect();
          c.scrollTop += (hr.top - cr.top) - (c.clientHeight - hr.height) / 2;
        }
        const cr2 = c.getBoundingClientRect();
        const hr2 = h.getBoundingClientRect();
        const max = Math.max(0, c.scrollHeight - c.clientHeight);
        return { percent: max > 0 ? +(c.scrollTop / max).toFixed(6) : 0,
                 centerDelta: +(hr2.top - cr2.top - (c.clientHeight - hr2.height) / 2).toFixed(2),
                 max: +max.toFixed(2) };
      };
      return true;
    `);
    const modeResults = [];
    for (const needle of ["5.2 小章节", "9.1 小章节"]) {
      await command("view.preview");
      await sleep(1500);
      const reading = await ev(`return window.__centerReading(${JSON.stringify(needle)})`);
      await sleep(700);
      await command("view.edit");
      await sleep(2600);
      const editing = await state(needle);
      await command("view.preview");
      await sleep(2600);
      const readingBack = await ev(`return window.__readingState()`);
      const row = {
        needle,
        readingPercent: reading?.percent,
        editPercent: editing?.leftMax ? +(editing.leftTop / editing.leftMax).toFixed(6) : null,
        backPercent: readingBack?.percent,
        readingCenterDelta: reading?.centerDelta,
        editCenterDelta: editing?.focusDeltaFromCenter,
      };
      modeResults.push(row);
      console.log("\n模式进度：" + needle);
      console.log("  阅读 " + (row.readingPercent * 100).toFixed(2) + "% 中央Δ=" + row.readingCenterDelta);
      console.log("  编辑/分屏 " + (row.editPercent * 100).toFixed(2) + "% 中央Δ=" + row.editCenterDelta);
      console.log("  返回阅读 " + (row.backPercent * 100).toFixed(2) + "%");
    }
    const modeOk = modeResults.every((r) =>
      r.readingPercent != null && r.editPercent != null && r.backPercent != null &&
      Math.abs(r.editPercent - r.readingPercent) <= 0.01 &&
      Math.abs(r.backPercent - r.readingPercent) <= 0.01 &&
      // 源码/阅读两种排版的标题盒高度与行距不同，同一阅读百分比下标题会有
      // 数行几何差（实测 ≤108px，约一个段落内），只要仍在中央附近即同一小节。
      Math.abs(r.editCenterDelta) <= 150);

    console.log("\n════════ 判定 ════════");
    console.log((focusOk ? "PASS" : "FAIL") + "  非底部开合预览保持视口中央阅读焦点（≤2px）");
    console.log((rightOk ? "PASS" : "FAIL") + "  重开预览右屏自动回到原对应位置（≤2px）");
    console.log((modeOk ? "PASS" : "FAIL") + "  阅读↔编辑/分屏进度与中央小节一致（≤1pp / 中央小节附近）");
    fs.mkdirSync("D:\\AI\\markdown view\\_verify-out", { recursive: true });
    fs.writeFileSync("D:\\AI\\markdown view\\_verify-out\\v0140-preview-focus.json", JSON.stringify({ focusOk, rightOk, modeOk, results, modeResults }, null, 2));
    if (!focusOk || !rightOk || !modeOk) process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch {}
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error(e);
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  process.exit(2);
});
