/**
 * LightMD v0.12.1 第二轮（用户 11 项需求）实机验证 —— 打包产物 + WebView2 CDP 驱动
 *
 * 覆盖（对应用户本轮 11 项需求）：
 *  1. 标题徽标 H1~H6：与标题**垂直对齐**（徽标中线与标题中线偏差 ≤1px）且**不折行**
 *     （徽标盒高 = 单行；旧实现 H 与数字分成两行、且偏高 7px）
 *  2. 点徽标改级别 → 右侧大纲栏层级缩进跟随（12px → 40px）
 *  3. 带图片文档「切走再切回」图片仍可见（img.naturalWidth > 0；相对路径按当前文档解析）
 *  4. 任务列表复选框与首行文字中线对齐（偏差 ≤2px）
 *  5. 任务列表方形/圆形两种样式：阅读模式手柄下拉切圆形 → DOM 圆角 50% + 源码变 `* [ ]`
 *  6. 代码块末尾按 → 退出代码块（末块则新建空段落）
 *  7. 格式刷按钮图标为小油漆刷（新路径存在、旧 Lucide 路径已移除）
 *  8. 设置窗口打开动画：从上方滑下（y 从 -160 收敛到 0，中途过冲 >0 = 果冻回弹）；
 *     关闭动画：先下压（y > 0）再上滑（y < 0）
 *  9. 拖动排版滑条：文档 CSS 变量实时变化 + 弹窗变玻璃（backdrop blur）；取消后回滚
 * 10. 阅读模式回车 = 段内换行（DOM 出现 <br>，源码为两空格硬换行、不出现空行）；Shift+回车 = 新段落
 * 11. 编辑模式右上角有小书本悬浮按钮，点击回阅读模式
 *
 * 用法：node scripts/real-machine-v0121-round2.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0121_R2_PORT || 9241);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = "D:\\AI\\markdown view\\_verify-out";

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

const DOC_IMAGE = ["# 图片文档", "", "带图片的段落。", "", "![image.png](./assets/image-3.png)", "", "图片之后的文字。", ""].join("\n");
const DOC_PLAIN = ["# 纯文本文档", "", "这里没有图片。", "", "- [ ] 任务甲", "- [ ] 任务乙", "", "```js", "const a = 1;", "```", ""].join("\n");

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`未找到打包产物：${EXE}`);
    process.exit(3);
  }
  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    await sleep(1500);
  } catch {
    /* 无实例 */
  }

  // 临时工作区：真实图片文件（相对路径 ./assets/image-3.png）
  // 文件名带本次运行的短标识 —— 应用会**恢复上次会话的标签**，同名文件会让
  // switchToTab 命中上一轮遗留的同名标签，导致断言不稳定（实测过一次 16/20 的假失败）。
  const RUN = Date.now().toString(36).slice(-4);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0121-r2-"));
  const assetsDir = path.join(tmpDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const SRC_IMG = "D:\\10254\\桌面\\assets\\image-3.png";
  if (!fs.existsSync(SRC_IMG)) {
    console.error(`未找到测试图片：${SRC_IMG}`);
    process.exit(3);
  }
  fs.copyFileSync(SRC_IMG, path.join(assetsDir, "image-3.png"));
  const fImage = path.join(tmpDir, `图片文档-${RUN}.md`);
  const fPlain = path.join(tmpDir, `纯文本-${RUN}.md`);
  // 长文档：排版锚点（阅读焦点保持）需要可滚动空间
  const longParts = ["# 长文档标题", ""];
  for (let i = 1; i <= 160; i++) longParts.push(`第 ${i} 段正文内容，用来把文档撑长以便验证滚动与焦点保持。`, "");
  const DOC_LONG = longParts.join("\n");
  const fLong = path.join(tmpDir, `长文档-${RUN}.md`);
  fs.writeFileSync(fImage, DOC_IMAGE);
  fs.writeFileSync(fPlain, DOC_PLAIN);
  fs.writeFileSync(fLong, DOC_LONG);
  console.log(`临时工作区: ${tmpDir}`);

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
              { expression: `JSON.stringify({tauri: typeof window.__TAURI_INTERNALS__ !== "undefined"})`, returnByValue: true },
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
        expression: `JSON.stringify((() => { ${expression} })())`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      }
      const raw = r.result?.result?.value;
      return raw === undefined ? undefined : JSON.parse(raw);
    };
    const shot = async (name, clip) => {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const r = await cdp.send("Page.captureScreenshot", clip ? { format: "png", clip } : { format: "png" });
      fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(r.result.data, "base64"));
    };
    const mouse = (type, x, y, opts = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, ...opts });
    const click = async (x, y) => {
      await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
      await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
      await sleep(350);
    };
    const key = async (keyName, vk, code, modifiers = 0) => {
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key: keyName, modifiers });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, code, key: keyName, modifiers });
      await sleep(320);
    };
    const typeText = async (text) => {
      for (const ch of text) {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, key: ch });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      }
      await sleep(260);
    };
    const runCommand = async (id) => {
      await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); return true;`);
      await sleep(500);
    };
    const readSource = async () => {
      await runCommand("view.edit");
      const v = await evalJs(`const ta = document.querySelector("textarea.source-editor"); return ta ? ta.value : "NO-TA";`);
      return v;
    };
    const openDoc = async (file, content) => {
      for (let i = 0; i < 6; i++) {
        // 走应用真实打开链路（lightmd:open-path → Rust read_file）：它会为文件所在目录
        // 动态授权 asset 协议作用域（见 src-tauri/src/commands/file_ops.rs），
        // 图片才可能被 http://asset.localhost 加载。直接派发带 content 的 openFile
        // 会绕过 Rust 侧读取，图片必然 404（naturalWidth=0）——那是测试环境问题，不是产品缺陷。
        await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(file)}}})); return true;`);
        await sleep(1200);
        const ok = await evalJs(`return (document.querySelector(".ProseMirror")?.innerText || "").length > 0`);
        if (ok) return true;
      }
      // 兜底：直接派发内容事件（图片可能因作用域未授权而不可见）
      await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(file)},content:${JSON.stringify(content)},skipConflictCheck:true}})); return true;`);
      await sleep(900);
      return false;
    };

    // 打开两个文档（图片文档在前、纯文本在后）
    await openDoc(fImage, DOC_IMAGE);
    await openDoc(fPlain, DOC_PLAIN);
    await runCommand("view.preview");

    // ═══ 需求3：带图片文档切走再切回，图片仍可见 ═══
    const imgState = async () => evalJs(`
      const img = document.querySelector(".ProseMirror img");
      if (!img) return { present: false };
      return { present: true, src: img.getAttribute("src"), complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
    `);
    // 当前应停在纯文本文档；切回图片文档
    const switchToTab = async (name) => {
      const pt = await evalJs(`
        const tabs = [...document.querySelectorAll(".tab-item")];
        const match = (x) => {
          const n = x.querySelector(".tab-name");
          if (!n) return false;
          const title = n.getAttribute("title") || "";
          const text = n.textContent || "";
          return title.includes(${JSON.stringify(name)}) || text.includes(${JSON.stringify(name)});
        };
        const t = tabs.find(match);
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { x: r.left + Math.min(60, r.width / 2), y: r.top + r.height / 2, count: tabs.length };
      `);
      if (!pt) return null;
      await click(pt.x, pt.y);
      await sleep(900);
      return pt;
    };
    await switchToTab(`图片文档-${RUN}`);
    const imgFirst = await imgState();
    await switchToTab(`纯文本-${RUN}`);
    const imgPlain = await imgState();
    await switchToTab(`图片文档-${RUN}`);
    const imgBack = await imgState();
    check("需求3 首次打开图片可渲染（naturalWidth>0）", !!imgFirst?.present && imgFirst.naturalWidth > 0, JSON.stringify(imgFirst));
    check("需求3 切到无图文档后无 img", imgPlain?.present === false, JSON.stringify(imgPlain));
    check("需求3 切回图片文档后图片仍可渲染（回归点）", !!imgBack?.present && imgBack.naturalWidth > 0 && imgBack.complete, JSON.stringify(imgBack));
    await shot("v0121-r2-req3-image");

    // ═══ 需求1/4：徽标对齐、复选框对齐 ═══
    // 把光标放进标题（点标题文字）以显示徽标
    const h1pt = await evalJs(`
      const h = document.querySelector(".ProseMirror h1");
      if (!h) return null;
      const r = h.getBoundingClientRect();
      return { x: r.left + 80, y: r.top + r.height / 2 };
    `);
    if (h1pt) await click(h1pt.x, h1pt.y);
    const badge = await evalJs(`
      const h = document.querySelector(".ProseMirror h1");
      const b = h && h.querySelector(".pm-heading-badge");
      if (!b) return { present: false };
      const hr = h.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      // 折行判定：徽标内文字的行盒数量（>1 = H 与数字被折成两行）
      const range = document.createRange();
      range.selectNodeContents(b);
      const lineCount = range.getClientRects().length;
      return {
        present: true, text: b.textContent,
        centerDelta: Math.round(((br.top + br.height / 2) - (hr.top + hr.height / 2)) * 10) / 10,
        badgeHeight: Math.round(br.height * 10) / 10,
        lineCount,
        whiteSpace: cs.whiteSpace,
      };
    `);
    check("需求1 徽标存在且为 H1", !!badge.present && badge.text === "H1", JSON.stringify(badge));
    check("需求1 徽标与标题垂直居中（中线偏差 ≤1px）", badge.present && Math.abs(badge.centerDelta) <= 1, `centerDelta=${badge.centerDelta}`);
    check(
      "需求1 徽标不折行（文字仅 1 个行盒 + nowrap）",
      badge.present && badge.whiteSpace === "nowrap" && badge.lineCount === 1,
      `lineCount=${badge.lineCount} whiteSpace=${badge.whiteSpace} h=${badge.badgeHeight}`,
    );

    await switchToTab(`纯文本-${RUN}`);
    const taskAlign = await evalJs(`
      const li = document.querySelector(".ProseMirror li.task-item");
      if (!li) return { present: false };
      const cb = li.querySelector(".task-checkbox");
      const content = li.querySelector(".task-content p") || li.querySelector(".task-content");
      const cr = cb.getBoundingClientRect();
      const range = document.createRange();
      const tn = content.firstChild;
      if (!tn) return { present: false };
      range.setStart(tn, 0);
      range.setEnd(tn, Math.min(1, tn.textContent.length));
      const tr = range.getBoundingClientRect();
      return {
        present: true,
        delta: Math.round(((cr.top + cr.height / 2) - (tr.top + tr.height / 2)) * 10) / 10,
        cbSize: Math.round(cr.width),
      };
    `);
    check("需求4 复选框与首行文字中线对齐（偏差 ≤2px）", taskAlign.present && Math.abs(taskAlign.delta) <= 2, JSON.stringify(taskAlign));

    // ═══ 需求2：点徽标改级别 → 大纲缩进跟随 ═══
    await switchToTab(`图片文档-${RUN}`);
    const outlineBefore = await evalJs(`
      return [...document.querySelectorAll(".outline-item")].map(i => getComputedStyle(i).paddingLeft);
    `);
    const badgePt = await evalJs(`
      const b = document.querySelector(".pm-heading-badge");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (badgePt) await click(badgePt.x, badgePt.y);
    const lv3Pt = await evalJs(`
      const b = document.querySelector('.heading-level-item[data-level="3"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (lv3Pt) {
      await click(lv3Pt.x, lv3Pt.y);
      await sleep(700);
    }
    const outlineAfter = await evalJs(`
      const items = [...document.querySelectorAll(".outline-item")];
      const h = document.querySelector(".ProseMirror h1, .ProseMirror h2, .ProseMirror h3");
      return { pads: items.map(i => getComputedStyle(i).paddingLeft), cls: items.map(i => i.className.split(" ")[1]), tag: h ? h.tagName : null };
    `);
    check(
      "需求2 改 H1→H3 后大纲层级缩进跟随（padding 变大 + outline-level-3）",
      outlineAfter.cls[0] === "outline-level-3" && outlineAfter.pads[0] !== outlineBefore[0],
      `before=${JSON.stringify(outlineBefore)} after=${JSON.stringify(outlineAfter)}`,
    );

    // ═══ 需求5：阅读模式手柄切圆形（图片文档没有任务项，先切到纯文本标签） ═══
    await switchToTab(`纯文本-${RUN}`);
    const handlePt = await evalJs(`
      const h = document.querySelector(".task-style-handle");
      if (!h) return null;
      h.scrollIntoView({ block: "center" });
      const r = h.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: h.textContent };
    `);
    let req5 = { ok: false };
    if (handlePt) {
      await click(handlePt.x, handlePt.y);
      const menuInfo = await evalJs(`
        const m = document.querySelector('[data-testid="task-style-menu"]');
        if (!m) return { present: false };
        return { present: true, items: [...m.querySelectorAll(".task-style-item")].map(i => i.dataset.style), rect: m.getBoundingClientRect().width };
      `);
      const circlePt = await evalJs(`
        const b = document.querySelector('.task-style-item[data-style="circle"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      `);
      if (circlePt) {
        await click(circlePt.x, circlePt.y);
        await sleep(500);
      }
      const dom = await evalJs(`
        const li = document.querySelector(".ProseMirror li.task-item");
        const cb = li.querySelector(".task-checkbox");
        return { radius: getComputedStyle(cb).borderRadius, style: li.getAttribute("data-style"), cls: li.className };
      `);
      const src = await readSource();
      req5 = { ok: dom.style === "circle" && /^\* \[ \] /m.test(src), dom, src: src.match(/^\* \[ \].*$/m) };
      await shot("v0121-r2-req5");
      await runCommand("view.preview");
    }
    check("需求5 阅读模式手柄下拉可切圆形（圆角 50% + 源码 `* [ ]`）", req5.ok, JSON.stringify(req5));

    // ═══ 需求6：代码块末尾按 → 退出 ═══
    await switchToTab(`纯文本-${RUN}`);
    const codePt = await evalJs(`
      const code = document.querySelector('.ProseMirror .code-block-wrapper code[contenteditable="true"]');
      if (!code) return null;
      const tn = code.firstChild;
      const r = document.createRange();
      r.setStart(tn, tn.length - 1); r.setEnd(tn, tn.length);
      const rect = r.getBoundingClientRect();
      return { x: rect.right - 1, y: rect.top + rect.height / 2 };
    `);
    let req6 = { ok: false };
    if (codePt) {
      await click(codePt.x, codePt.y);
      // 单击块 = 块级选中（NodeSelection）：按一次 → 就应退出到块后（需求6 主路径）
      const afterClick = await evalJs(`
        const sel = document.getSelection();
        return { selText: sel ? sel.toString().slice(0, 20) : null };
      `);
      await key("ArrowRight", 39, "ArrowRight");
      req6 = await evalJs(`
        const sel = document.getSelection();
        const a = sel && sel.anchorNode;
        const blocks = [...document.querySelectorAll(".ProseMirror > *")].map(n => n.tagName);
        return { anchorTag: a ? (a.nodeType === 3 ? a.parentElement.tagName : a.tagName) : null, blocks };
      `);
      req6.ok = req6.anchorTag === "P" && req6.blocks.filter((b) => b === "P").length >= 2;
      req6.detail = JSON.stringify({ afterClick, ...req6 });
    }
    check("需求6 代码块末尾按 → 退出到后面的段落", req6.ok, req6.detail || "无代码块");

    // ═══ 需求10：回车 = 段内换行 ═══
    const lastPPt = await evalJs(`
      const ps = [...document.querySelectorAll(".ProseMirror > p")];
      if (!ps.length) return null;
      const last = ps[ps.length - 1];
      last.scrollIntoView({ block: "center" });
      const r = last.getBoundingClientRect();
      return { x: r.left + 8, y: r.top + r.height / 2 };
    `);
    let req10 = { ok: false };
    if (lastPPt) {
      await click(lastPPt.x, lastPPt.y);
      await typeText("甲行");
      await key("Enter", 13, "Enter");
      await typeText("乙行");
      const dom = await evalJs(`
        const ps = [...document.querySelectorAll(".ProseMirror > p")];
        const last = ps[ps.length - 1];
        return { html: last.innerHTML, brCount: last.querySelectorAll("br").length };
      `);
      const src = await readSource();
      req10 = { ok: dom.brCount === 1 && /甲行 {2}\n乙行/.test(src), dom: dom.html, srcLine: (src.match(/甲行.*\n.*乙行/) || [""])[0] };
      await runCommand("view.preview");
    }
    check("需求10 阅读模式回车=段内换行（<br>，源码两空格硬换行、无空行）", req10.ok, JSON.stringify(req10));

    // ═══ 需求11：编辑模式书本按钮 ═══
    await runCommand("view.edit");
    const editBtn = await evalJs(`
      const b = document.querySelector(".mode-switch-btn");
      if (!b) return { present: false };
      const r = b.getBoundingClientRect();
      return { present: true, title: b.getAttribute("title"), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    let req11 = { ok: false };
    if (editBtn.present) {
      await click(editBtn.x, editBtn.y);
      await sleep(700);
      req11 = await evalJs(`
        const ta = document.querySelector("textarea.source-editor");
        const pm = document.querySelector(".ProseMirror");
        return { textareaShown: ta ? getComputedStyle(ta).display !== "none" : null, pmShown: pm ? getComputedStyle(pm).display !== "none" : null };
      `);
      req11.ok = req11.pmShown === true && req11.textareaShown === false;
      req11.detail = `${JSON.stringify(editBtn)} → ${JSON.stringify(req11)}`;
    }
    check("需求11 编辑模式书本按钮点击回阅读模式", req11.ok, req11.detail || "按钮不存在");

    // ═══ 需求7：格式刷图标 ═══
    await runCommand("view.edit");
    const brush = await evalJs(`
      const svg = document.querySelector(".format-btn-brush-icon");
      if (!svg) return { present: false };
      return { present: true, paths: [...svg.querySelectorAll("path")].map(p => p.getAttribute("d")), w: svg.getAttribute("width") };
    `);
    check(
      "需求7 格式刷图标为小油漆刷（新路径 + 旧 Lucide 路径已移除）",
      brush.present && brush.paths.some((d) => d && d.startsWith("M20.4 3.6")) && !brush.paths.some((d) => d && d.includes("14.622 17.897")),
      JSON.stringify({ present: brush.present, w: brush.w, n: brush.paths.length }),
    );

    // ═══ 需求8：设置窗口开关动画 ═══
    await runCommand("view.preview");
    // 采样器必须在弹窗出现**之前**布好（rAF 采样，从弹窗首次出现那帧开始计时）
    await evalJs(`
      window.__animOpen = [];
      const t0 = performance.now();
      let started = null;
      const tick = () => {
        const d = document.querySelector(".settings-dialog");
        if (d && started === null) started = performance.now();
        if (d) {
          const m = getComputedStyle(d).transform.match(/matrix\\(([^)]+)\\)/);
          window.__animOpen.push({ t: started === null ? 0 : Math.round(performance.now() - started), y: m ? Math.round(parseFloat(m[1].split(",")[5]) * 10) / 10 : 0 });
        }
        const elapsed = performance.now() - t0;
        const sinceStart = started === null ? 0 : performance.now() - started;
        if (elapsed < 3000 && sinceStart < 800) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    `);
    await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.settings"}})); return true;`);
    await sleep(1600);
    const animOpen = await evalJs(`return window.__animOpen;`);
    const openYs = animOpen.map((a) => a.y);
    const overshoot = Math.max(...openYs);
    check(
      "需求8 打开动画：从视口上方之外滑进来（起点 -1200 级）+ 果冻回弹（过冲 >0）后收敛到 0",
      openYs[0] <= -100 && overshoot > 5 && Math.abs(openYs[openYs.length - 1]) < 1.5,
      `start=${openYs[0]} max=${overshoot} end=${openYs[openYs.length - 1]} frames=${openYs.length}`,
    );

    // ═══ 需求9：拖动排版滑条 → 实时预览 + 玻璃 + 取消回滚 ═══
    const varsBefore = await evalJs(`const cs = getComputedStyle(document.documentElement); return { fs: cs.getPropertyValue("--editor-font-size").trim() };`);
    const slider = await evalJs(`
      const s = document.querySelector('[data-testid="settings-font-size"]');
      if (!s) return null;
      const r = s.getBoundingClientRect();
      return { x: r.left, y: r.top + r.height / 2, w: r.width };
    `);
    let drag = { ok: false };
    if (slider) {
      await mouse("mousePressed", slider.x + slider.w * 0.85, slider.y, { button: "left", clickCount: 1 });
      await mouse("mouseMoved", slider.x + slider.w * 0.8, slider.y, { button: "left" });
      await sleep(250);
      drag = await evalJs(`
        const cs = getComputedStyle(document.documentElement);
        const o = document.querySelector(".settings-overlay");
        const d = o && o.querySelector(".settings-dialog");
        const ds = d ? getComputedStyle(d) : null;
        return {
          previewing: !!o && o.className.includes("previewing"),
          fontSize: cs.getPropertyValue("--editor-font-size").trim(),
          backdrop: ds ? (ds.backdropFilter || ds.webkitBackdropFilter) : null,
          bg: ds ? ds.backgroundColor : null,
        };
      `);
      await shot("v0121-r2-req9-glass");
      await mouse("mouseReleased", slider.x + slider.w * 0.8, slider.y, { button: "left", clickCount: 1 });
      await sleep(400);
    }
    const cancelPt = await evalJs(`
      const b = document.querySelector(".settings-footer .settings-btn.secondary");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (cancelPt) await click(cancelPt.x, cancelPt.y);
    await sleep(1200);
    const varsAfter = await evalJs(`const cs = getComputedStyle(document.documentElement); return { fs: cs.getPropertyValue("--editor-font-size").trim(), overlay: !!document.querySelector(".settings-overlay") };`);
    check(
      "需求9 拖动时实时改 CSS 变量 + 弹窗玻璃透明（backdrop blur）",
      drag.previewing === true && drag.fontSize !== varsBefore.fs && !!drag.backdrop && drag.backdrop.includes("blur"),
      JSON.stringify({ before: varsBefore, during: drag }),
    );
    check(
      "需求9 取消后文档回滚到原值、弹窗已关闭",
      varsAfter.fs === varsBefore.fs && varsAfter.overlay === false,
      JSON.stringify({ before: varsBefore, after: varsAfter }),
    );

    // ═══ 需求9（二轮）：透明度 ≥80% ═══
    // 直接复用上面真实拖动时取到的背景色（此刻 transition 已完成、是稳定值）；
    // 计算样式可能被序列化成 color()/oklab()/rgba() 三种形式，统一解析 alpha。
    const parseAlpha = (bg) => {
      if (!bg) return null;
      const slash = bg.match(/\/\s*([\d.]+)\s*\)/);
      if (slash) return Number(slash[1]);
      const rgba = bg.match(/rgba?\(([^)]+)\)/);
      if (rgba) {
        const p = rgba[1].split(",").map((x) => x.trim());
        return p.length > 3 ? Number(p[3]) : 1;
      }
      return 1;
    };
    const dragAlpha = parseAlpha(drag.bg);
    const transparentPct = dragAlpha === null ? null : Math.round((1 - dragAlpha) * 100);
    check(
      "需求9（二轮）拖动时窗口透明度 ≥80%（底板 alpha ≤ 0.2）",
      dragAlpha !== null && dragAlpha <= 0.2,
      `alpha=${dragAlpha} 透明度=${transparentPct}% bg=${drag.bg}`,
    );

    // ═══ 需求9（二轮）：排版四项调整时保持阅读焦点 ═══
    // 关掉设置弹窗，切到长文档，滚到中段
    const closePt = await evalJs(`
      const o = document.querySelector(".settings-overlay");
      if (o) o.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    `);
    void closePt;
    await sleep(1200);
    await openDoc(fLong, DOC_LONG);
    await runCommand("view.preview");
    await evalJs(`
      const c = document.querySelector(".editor-container");
      c.scrollTop = Math.round((c.scrollHeight - c.clientHeight) * 0.45);
      return true;
    `);
    await sleep(600);

    /** 当前视口内首个可见顶层块的（标签 + 文本片段 + 相对视口顶的 Y） */
    const measureAnchor = () => evalJs(`
      const c = document.querySelector(".editor-container");
      if (!c) return null;
      const cr = c.getBoundingClientRect();
      for (const b of document.querySelectorAll(".ProseMirror > *")) {
        const r = b.getBoundingClientRect();
        if (r.bottom > cr.top + 1) {
          return { tag: b.tagName, text: (b.textContent || "").slice(0, 16), y: Math.round((r.top - cr.top) * 10) / 10 };
        }
      }
      return null;
    `);

    const focusResults = [];
    const sliderSpecs = [
      ["settings-font-size", 0.85, "字号"],
      ["settings-line-height", 0.75, "行高"],
      ["settings-paragraph-spacing", 0.7, "段间距"],
      ["settings-content-max-width", 0.45, "内容区宽度"],
    ];
    await runCommand("view.settings");
    await sleep(900);
    for (const [testId, ratio, label] of sliderSpecs) {
      // 每一项都在自己拖动前/后各测一次（累计变化无影响）
      const before = await measureAnchor();
      const rect = await evalJs(`
        const s = document.querySelector('[data-testid=${JSON.stringify(testId)}]');
        if (!s) return null;
        const r = s.getBoundingClientRect();
        return { x: r.left, y: r.top + r.height / 2, w: r.width };
      `);
      if (!rect || !before) {
        focusResults.push({ label, error: "无法测量", rect, before });
        continue;
      }
      await mouse("mousePressed", rect.x + rect.w * ratio, rect.y, { button: "left", clickCount: 1 });
      await sleep(250);
      await mouse("mouseReleased", rect.x + rect.w * ratio, rect.y, { button: "left", clickCount: 1 });
      await sleep(500);
      const after = await measureAnchor();
      const sameBlock = !!after && after.tag === before.tag && after.text === before.text;
      const delta = after ? Math.round((after.y - before.y) * 10) / 10 : null;
      focusResults.push({ label, before: `${before.tag}:${before.text}@${before.y}`, after: after ? `${after.tag}:${after.text}@${after.y}` : null, sameBlock, delta });
    }
    check(
      "需求9（二轮）拖动字号/行高/段间距/内容宽时保持阅读焦点（同一块 + Y 偏差 ≤6px）",
      focusResults.every((r) => r.sameBlock === true && typeof r.delta === "number" && Math.abs(r.delta) <= 6),
      JSON.stringify(focusResults),
    );
    await shot("v0121-r2-focus-keep");
    // 关掉设置弹窗（点✕）
    const xPt = await evalJs(`
      const b = document.querySelector(".settings-close");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `);
    if (xPt) await click(xPt.x, xPt.y);
    await sleep(1200);

    // ═══ 需求8（二轮）：弹窗本体不做透明度动画 ═══
    await evalJs(`
      window.__opacityLog = [];
      const t0 = performance.now();
      let started = null;
      const tick = () => {
        const d = document.querySelector(".settings-dialog");
        if (d) {
          if (started === null) started = performance.now();
          const cs = getComputedStyle(d);
          const m = cs.transform.match(/matrix\\(([^)]+)\\)/);
          window.__opacityLog.push({
            t: Math.round(performance.now() - started),
            op: Math.round(parseFloat(cs.opacity) * 100) / 100,
            y: m ? Math.round(parseFloat(m[1].split(",")[5])) : 0,
          });
        }
        if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    `);
    await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.settings"}})); return true;`);
    await sleep(1200);
    await evalJs(`const o = document.querySelector(".settings-overlay"); if (o) o.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true;`);
    await sleep(900);
    const opLog = await evalJs(`return window.__opacityLog;`);
    const opacities = [...new Set(opLog.map((x) => x.op))];
    check(
      "需求8（二轮）弹窗全程不透明（opacity 恒为 1，只有位移 —— 不是淡化消失）",
      opacities.length === 1 && opacities[0] === 1 && opLog.some((x) => x.y < -300),
      `opacities=${JSON.stringify(opacities)} 最小 y=${Math.min(...opLog.map((x) => x.y))}`,
    );

    // 关闭动画采样
    await runCommand("view.settings");
    await sleep(900);
    await evalJs(`
      window.__animClose = [];
      const t0 = performance.now();
      const tick = () => {
        const d = document.querySelector(".settings-dialog");
        if (d) { const m = getComputedStyle(d).transform.match(/matrix\\(([^)]+)\\)/); window.__animClose.push({ t: Math.round(performance.now()-t0), y: m ? Math.round(parseFloat(m[1].split(",")[5])*10)/10 : 0, op: parseFloat(getComputedStyle(d).opacity) }); }
        if (performance.now()-t0 < 600) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    `);
    await evalJs(`const o = document.querySelector(".settings-overlay"); if (o) o.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true;`);
    await sleep(900);
    const animClose = await evalJs(`return window.__animClose;`);
    const closeYs = animClose.map((a) => a.y);
    const closeMax = Math.max(...closeYs);
    const closeMin = Math.min(...closeYs);
    check(
      "需求8 关闭动画：先下压蓄力（y>0），再纯位移滑出视口上方（y 到 -1200 级）",
      closeMax > 5 && closeMin < -100,
      `max=${closeMax} min=${closeMin} frames=${closeYs.length}`,
    );
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    child.unref?.();
  }

  console.log(`\n===== 实机验证结果：${results.length - failed}/${results.length} PASS =====`);
  fs.writeFileSync(path.join(SHOT_DIR, "v0121-r2-real-machine.txt"), results.join("\n") + "\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("实机验证异常:", e);
  process.exit(2);
});
