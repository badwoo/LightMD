/**
 * LightMD v0.14.0 实机验收（打包产物 + WebView2 CDP 驱动）
 *
 * 覆盖用户本轮 3 条需求：
 * 【需求1】三模式合并为二模式 + 编辑模式内预览面板滑出/滑回
 *  - 标题栏只剩「阅读 / 编辑」两格
 *  - 点「编辑」→ 编辑模式 + 右侧预览展开（= 旧分屏观感）
 *  - 分割线上有竖排（writing-mode: vertical-rl）、呼吸（animation）的「关闭预览」
 *  - 鼠标移到右屏 → 该竖排字浮现（computed opacity > 0）
 *  - 点「关闭预览」→ 右屏宽度收到 0、文案变「打开预览」、模式仍是编辑
 *  - 点「打开预览」→ 宽度恢复
 *  - 双击 Shift → 阅读模式下进编辑并开预览；编辑模式下只切预览
 *  - 双击 Ctrl → 阅读 ↔ 编辑
 * 【需求2】搜索增强
 *  - 四个勾选框默认全不勾
 *  - 全词匹配 / 匹配大小写组合下的匹配数逐级收敛
 *  - 「选取范围内」只在选区内命中；替换也只改选区内
 *  - 「查找所有打开文件」条幅：文件名 + 命中行 + <mark> 高亮；点击跳到对应文件
 *  - 阅读模式下同样生效（PM 路径）
 * 【需求3】分屏分割线左拖后仍能右拖回来
 *
 * 用法：node scripts/real-machine-v0140.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_PORT || 9261);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT_LOG = path.join(SHOT_DIR, "v0140-real-machine.txt");

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

const DOC_A = [
  "# 搜索测试文档",
  "",
  "cat 单独出现",
  "concat 包含 cat 但不是全词",
  "cats 是复数",
  "Cat 首字母大写",
  "CAT 全大写",
  "",
  "第二段用来验证跨段。",
  "",
].join("\n");

const DOC_B = ["# 另一个文件", "", "这里也有 cat 出现一次。", "", "末尾一行。", ""].join("\n");

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

  const RUN = Date.now().toString(36).slice(-4);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0140-"));
  const fA = path.join(tmpDir, `搜索-${RUN}.md`);
  const fB = path.join(tmpDir, `另一个-${RUN}.md`);
  fs.writeFileSync(fA, DOC_A);
  fs.writeFileSync(fB, DOC_B);
  console.log(`临时工作区: ${tmpDir}`);

  // ⚠️ WEBVIEW2_USER_DATA_FOLDER：独立 profile = 干净的 localStorage。
  // 不这么做的话，应用会恢复上次会话遗留的一堆历史标签，活跃标签根本不是你刚打开的文件
  // （上一轮 13 个 FAIL 里有 10 个是这个原因：搜索跑在了上一个临时文件上）。
  const profileDir = path.join(tmpDir, "webview2-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profileDir,
    },
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
            /* next */
          }
        }
      } catch {
        /* port not ready */
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
        throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
      }
      const raw = r.result?.result?.value;
      return raw === undefined ? undefined : JSON.parse(raw);
    };
    /**
     * 求值并直接返回原始值（非 JSON 包装）。
     * ⚠️ 表达式体里写 `return ...` 时**必须**包进 IIFE —— 裸顶层 `return` 会抛
     * `SyntaxError: Illegal return statement`（真实踩过）。这里统一包一层。
     */
    const text = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => { ${expression} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) {
        throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
      }
      return r.result?.result?.value;
    };
    const shot = async (name) => {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const r = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(r.result.data, "base64"));
    };
    const mouse = (type, x, y, opts = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, ...opts });
    const rect = (sel) =>
      evalJs(`
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, right: r.right };
      `);
    const clickSel = async (sel, waitMs = 350) => {
      const r = await rect(sel);
      if (!r) throw new Error(`找不到元素: ${sel}`);
      await mouse("mousePressed", r.x, r.y, { button: "left", clickCount: 1 });
      await mouse("mouseReleased", r.x, r.y, { button: "left", clickCount: 1 });
      await sleep(waitMs);
      return r;
    };
    const hoverSel = async (sel, waitMs = 500) => {
      const r = await rect(sel);
      if (!r) throw new Error(`找不到元素: ${sel}`);
      await mouse("mouseMoved", r.x, r.y);
      await sleep(waitMs);
      return r;
    };
    const clickXY = async (x, y) => {
      await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
      await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
      await sleep(350);
    };
    const runCommand = async (id) => {
      await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); return true;`);
      await sleep(500);
    };
    /** 当前活跃标签名 */
    const currentTab = () =>
      text(`return (document.querySelector(".tab-item.tab-active .tab-name")?.textContent || "").trim();`);
    /**
     * 切到名字包含 keyword 的标签（点标签栏）。
     * 为什么不用 openDoc：应用会恢复上次会话的标签，同名前缀的临时文件会残留，
     * 只靠"打开"无法保证活跃标签就是目标（上一轮实测踩过：搜的是上一个临时文件）。
     */
    const switchToTab = async (keyword) => {
      // ⚠️ 用 page 内 el.click() 而不是 CDP 鼠标点击：标签栏可能横向滚动，
      // 排在视口外的标签用坐标点击会打空（上一轮实测：连点 5 次都没切过去，
      // 结果整组搜索用例都跑在上一个遗留标签上）。
      for (let i = 0; i < 5; i++) {
        const res = await evalJs(`
          const tabs = [...document.querySelectorAll(".tab-item")];
          const el = tabs.find((x) => (x.querySelector(".tab-name")?.textContent || "").includes(${JSON.stringify(keyword)}));
          if (!el) return { ok: false, reason: "not-found", names: tabs.map((x) => (x.querySelector(".tab-name")?.textContent || "").trim()) };
          const name = (el.querySelector(".tab-name")?.textContent || "").trim();
          el.click();
          return { ok: true, name };
        `);
        if (!res.ok) {
          await sleep(600);
          continue;
        }
        await sleep(1000);
        const now = await currentTab();
        if (now === res.name) return res.name;
      }
      return null;
    };
    const openDoc = async (file) => {
      for (let i = 0; i < 6; i++) {
        await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(file)}}})); return true;`);
        await sleep(1200);
        const base = path.basename(file);
        const opened = await evalJs(`
          const tabs = [...document.querySelectorAll(".tab-item .tab-name")].map((x) => (x.textContent || "").trim());
          return { tabs, hit: tabs.some((n) => n.includes(${JSON.stringify(base)})) };
        `);
        if (opened.hit) return base;
      }
      return null;
    };

    // ═══════════════════════════════════════════════════════════
    // 需求1：二模式 + 预览面板
    // ═══════════════════════════════════════════════════════════
    console.log("\n=== 需求1：三模式 → 二模式 + 预览面板 ===\n");
    await openDoc(fA);
    await openDoc(fB);
    // ⚠️ 必须显式切回 A：应用会恢复上次会话的标签（历史临时文件一大把），
    // 只靠 openDoc 无法保证活跃标签就是 A（上一轮实测：搜索全跑在了 B 上，
    // 于是「cat 应命中 5 处」只得到 1 处）。这里用文件名关键字点标签栏切换。
    const tabA = await switchToTab(path.basename(fA).replace(/\.md$/, ""));
    await sleep(600);
    const activeName = await currentTab();
    check("已切到目标文档 A", !!tabA && activeName.includes("-"), `active=${activeName}`);
    await runCommand("view.preview");
    await sleep(600);

    const modeButtons = await evalJs(`
      const g = document.querySelector(".titlebar-mode-switch");
      if (!g) return null;
      return [...g.querySelectorAll("button")].map((b) => ({ text: (b.textContent || "").trim(), title: b.title }));
    `);
    check("标题栏只有两个模式按钮", modeButtons?.length === 2, JSON.stringify(modeButtons));
    check(
      "两个按钮分别是「阅读 / 编辑」且无「分屏」",
      modeButtons?.[0]?.text === "阅读" && modeButtons?.[1]?.text === "编辑" &&
        !modeButtons.some((b) => b.text === "分屏"),
      modeButtons?.map((b) => b.text).join(" | "),
    );

    // 点「编辑」→ 编辑模式 + 预览展开
    const editBtn = await rect(".titlebar-mode-switch button:nth-child(2)");
    await clickXY(editBtn.x, editBtn.y);
    await sleep(600);

    const modeState = await evalJs(`
      const shell = document.querySelector(".split-preview-shell");
      const ta = document.querySelector("textarea.source-editor");
      const label = document.querySelector('[data-testid="split-preview-toggle"]');
      return {
        shellW: shell ? Math.round(shell.getBoundingClientRect().width) : -1,
        shellAriaHidden: shell?.getAttribute("aria-hidden") ?? null,
        taVisible: ta ? ta.getBoundingClientRect().width > 0 : false,
        labelText: label ? (label.textContent || "").trim() : null,
        previewDivider: !!document.querySelector(".split-divider"),
      };
    `);
    check("点「编辑」→ 源码区可见", modeState.taVisible === true, JSON.stringify(modeState));
    check("点「编辑」→ 右侧预览默认展开（= 旧分屏）", modeState.shellW > 200, `shell 宽 ${modeState.shellW}px`);
    check("分割线上显示「关闭预览」", modeState.labelText === "关闭预览", String(modeState.labelText));
    await shot("v0140-req1-edit-default-split");

    // 竖排 + 呼吸（computed style）
    // ⚠️ 必须**先真的把鼠标移到右屏**再读 computed style。踩过两次：
    // ① 一开始没移鼠标就断言 opacity>0 → 恒为 0（默认就是隐藏的，符合"隐约"设计）；
    // ② 只移一次 mouseMoved 到 shell 中心，Chromium 只在**指针进入新元素**时才更新
    //    :hover 链，若指针本来就在别处也够用；但若上一步刚点过按钮（指针在按钮上），
    //    单次 move 仍会正确切换。故这里 move 两次（中间留间隔）确保 hover 稳定生效。
    const shellRect = await rect(".split-preview-shell");
    await mouse("mouseMoved", shellRect.x, shellRect.y);
    await sleep(300);
    await mouse("mouseMoved", shellRect.x + 5, shellRect.y + 5);
    await sleep(600);
    const labelStyle = await evalJs(`
      const el = document.querySelector(".split-divider-label");
      if (!el) return null;
      const cs = getComputedStyle(el);
      const d = document.querySelector(".split-divider");
      return {
        writingMode: cs.writingMode,
        textOrientation: cs.textOrientation,
        animationName: cs.animationName,
        opacity: Number(cs.opacity),
        shellHover: !!document.querySelector(".split-preview-shell")?.matches(":hover"),
        dividerHover: d ? d.matches(":hover") : null,
      };
    `);
    check("竖排：writing-mode = vertical-rl", labelStyle?.writingMode === "vertical-rl", labelStyle?.writingMode);
    check("竖排：text-orientation = upright", labelStyle?.textOrientation === "upright", labelStyle?.textOrientation);
    check(
      "鼠标移到右屏 → 竖排小字浮现（opacity > 0）",
      labelStyle !== null && labelStyle.opacity > 0,
      `opacity=${labelStyle?.opacity} shellHover=${labelStyle?.shellHover}`,
    );
    check(
      "呼吸律动：hover 态挂上 splitDividerLabelBreathe 动画",
      String(labelStyle?.animationName || "").includes("splitDividerLabelBreathe"),
      labelStyle?.animationName,
    );

    // 点「关闭预览」→ 右屏滑出
    // 注意：clickSel 会先取按钮矩形中心再点，点击前指针已在该按钮上（hover 已生效）。
    await clickSel('[data-testid="split-preview-toggle"]', 700);
    const closedState = await evalJs(`
      const shell = document.querySelector(".split-preview-shell");
      const label = document.querySelector('[data-testid="split-preview-toggle"]');
      const ta = document.querySelector("textarea.source-editor");
      const wrap = document.querySelector(".source-editor-wrapper");
      return {
        shellW: shell ? Math.round(shell.getBoundingClientRect().width) : -1,
        labelText: label ? (label.textContent || "").trim() : null,
        taW: ta ? Math.round(ta.getBoundingClientRect().width) : -1,
        wrapW: wrap ? Math.round(wrap.getBoundingClientRect().width) : -1,
        dividerCls: document.querySelector(".split-divider")?.className ?? "",
        tabCount: document.querySelectorAll(".tab-item").length,
        stillSource: !!document.querySelector("textarea.source-editor").offsetParent,
      };
    `);
    check("点「关闭预览」→ 右屏宽度收到 0", closedState.shellW <= 1, `shell 宽 ${closedState.shellW}px`);
    check("文案变为「打开预览」", closedState.labelText === "打开预览", String(closedState.labelText));
    check("关闭预览后仍是编辑模式（源码区仍在）", closedState.stillSource === true, `textarea 宽 ${closedState.taW}px`);
    check("关闭后源码区铺满（宽度接近整区）", closedState.wrapW >= closedState.taW, `wrap=${closedState.wrapW} ta=${closedState.taW}`);
    check("关闭态分割条降级为 rail（split-divider-closed）", closedState.dividerCls.includes("split-divider-closed"), closedState.dividerCls);
    await shot("v0140-req1-preview-closed");

    // 再点「打开预览」→ 滑回
    await clickSel('[data-testid="split-preview-toggle"]', 700);
    const reopened = await evalJs(`
      const shell = document.querySelector(".split-preview-shell");
      const label = document.querySelector('[data-testid="split-preview-toggle"]');
      return { shellW: shell ? Math.round(shell.getBoundingClientRect().width) : -1, labelText: (label?.textContent || "").trim() };
    `);
    check("点「打开预览」→ 右屏滑回", reopened.shellW > 200, `shell 宽 ${reopened.shellW}px`);
    check("文案回到「关闭预览」", reopened.labelText === "关闭预览", String(reopened.labelText));

    // 双击 Shift：编辑模式内切预览
    const dblShift = async () => {
      for (let i = 0; i < 2; i++) {
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, code: "ShiftLeft", key: "Shift", modifiers: 8 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, code: "ShiftLeft", key: "Shift" });
        await sleep(80);
      }
      await sleep(600);
    };
    const beforeShift = await evalJs(`const s=document.querySelector(".split-preview-shell"); return s?Math.round(s.getBoundingClientRect().width):-1;`);
    await dblShift();
    const afterShift = await evalJs(`
      const s=document.querySelector(".split-preview-shell");
      return { w: s?Math.round(s.getBoundingClientRect().width):-1, mode: document.querySelector("textarea.source-editor")?.offsetParent ? "edit" : "preview" };
    `);
    check(
      "双击 Shift：编辑模式内切换预览（宽度变化、模式不变）",
      afterShift.mode === "edit" && afterShift.w !== beforeShift,
      `${beforeShift}px → ${afterShift.w}px, mode=${afterShift.mode}`,
    );
    await dblShift(); // 切回展开，便于后续测试
    await sleep(400);

    // 双击 Ctrl 回到阅读模式
    const dblCtrl = async () => {
      for (let i = 0; i < 2; i++) {
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, code: "ControlLeft", key: "Control", modifiers: 2 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, code: "ControlLeft", key: "Control" });
        await sleep(80);
      }
      await sleep(600);
    };
    await dblCtrl();
    const inPreview = await evalJs(`
      const pm = document.querySelector(".ProseMirror");
      return { hasPm: !!pm, taHidden: !document.querySelector("textarea.source-editor")?.offsetParent };
    `);
    check("双击 Ctrl：编辑 → 阅读（PM 可见、源码区隐藏）", inPreview.hasPm && inPreview.taHidden, JSON.stringify(inPreview));

    // 阅读模式下双击 Shift：进编辑并开预览
    await dblShift();
    const afterShiftFromPreview = await evalJs(`
      const s=document.querySelector(".split-preview-shell");
      const label=document.querySelector('[data-testid="split-preview-toggle"]');
      return { w: s?Math.round(s.getBoundingClientRect().width):-1, label: (label?.textContent||"").trim() };
    `);
    check(
      "阅读模式双击 Shift → 进编辑且预览展开",
      afterShiftFromPreview.w > 200 && afterShiftFromPreview.label === "关闭预览",
      JSON.stringify(afterShiftFromPreview),
    );

    // ═══════════════════════════════════════════════════════════
    // 需求3：分割线左拖后能右拖回来（编辑模式 + 预览展开）
    // ═══════════════════════════════════════════════════════════
    console.log("\n=== 需求3：分割线双向拖拽 ===\n");
    const dragDivider = async (fromX, fromY, toX) => {
      await mouse("mousePressed", fromX, fromY, { button: "left", clickCount: 1, buttons: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = fromX + ((toX - fromX) * i) / steps;
        await mouse("mouseMoved", x, fromY, { button: "left", buttons: 1 });
        await sleep(40);
      }
      await mouse("mouseReleased", toX, fromY, { button: "left", clickCount: 1, buttons: 0 });
      await sleep(500);
    };
    const shellWidth = () => evalJs(`const s=document.querySelector(".split-preview-shell"); return s?Math.round(s.getBoundingClientRect().width):-1;`);
    const divRect = await rect(".split-divider");
    // ⚠️ 拖拽起点必须避开分割条正中的竖排开关按钮：那里按下是"切换预览"，
    // 不是拖拽热区（实现里 onMouseDown 对 .split-divider-label 直接放行）。
    // 真实用户也是从分割条上/下段拖动，故这里取距顶 200px 的位置。
    const dragY = divRect.y - Math.min(300, divRect.h / 2 - 120);
    const w0 = await shellWidth();
    await dragDivider(divRect.x, dragY, divRect.x - 220);
    const w1 = await shellWidth();
    await dragDivider(divRect.x - 220, dragY, divRect.x + 40);
    const w2 = await shellWidth();
    check("分割线往左拖 → 右屏变宽（左栏变窄）", w1 > w0 + 40, `${w0} → ${w1}px`);
    check("松手后往右拖 → 右屏能变窄回来（缺陷点）", w2 < w1 - 40, `${w1} → ${w2}px`);
    const cursorClean = await evalJs(`
      return { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect, cls: document.body.className.includes("split-resizing") };
    `);
    check(
      "拖拽结束后无残留（光标/选区/split-resizing 均已复原）",
      cursorClean.cursor === "" && cursorClean.userSelect === "" && cursorClean.cls === false,
      JSON.stringify(cursorClean),
    );

    // ═══════════════════════════════════════════════════════════
    // 需求2：搜索增强
    // ═══════════════════════════════════════════════════════════
    console.log("\n=== 需求2：搜索增强（编辑模式）===\n");
    // 搜索必须落在文档 A 上：先显式切回 A，再确认源码区内容确实是 A 的文本
    await switchToTab(path.basename(fA).replace(/\.md$/, ""));
    await sleep(700);
    await runCommand("view.edit");
    await sleep(600);
    const srcOk = await text(`
      const ta = document.querySelector("textarea.source-editor");
      return { has: !!ta, head: (ta?.value || "").slice(0, 30), catCount: ((ta?.value || "").match(/cat/gi) || []).length };
    `);
    // DOC_A 里 cat/gi 实际命中 6 处：cat / concat / cat（同一条里的第二处）/ cats / Cat / CAT
    check(
      "编辑模式源码区内容 = 文档 A（cat/gi 共 6 处）",
      srcOk.has && srcOk.catCount === 6,
      `cat/gi 命中 ${srcOk.catCount}，开头「${srcOk.head}」`,
    );
    await runCommand("edit.find");
    await sleep(700);
    const panelOpen = await evalJs(`return !!document.querySelector(".search-replace");`);
    check("Ctrl+F / edit.find 打开搜索面板", panelOpen === true);

    const defaultChecks = await evalJs(`
      const ids = ["search-whole-word","search-match-case","search-in-selection","search-use-regex"];
      const out = {};
      for (const id of ids) {
        const el = document.querySelector('[data-testid="' + id + '"]');
        out[id] = el ? el.checked : "MISSING";
      }
      return out;
    `);
    check(
      "四个勾选框默认全部不勾",
      Object.values(defaultChecks).every((v) => v === false),
      JSON.stringify(defaultChecks),
    );

    // 输入搜索词
    const searchInput = await rect(".search-row .search-input");
    await clickXY(searchInput.x, searchInput.y);
    await cdp.send("Input.insertText", { text: "cat" });
    await sleep(800);
    const countOf = async () => {
      const t = await text(`return (document.querySelector('[data-testid="search-count"]')?.textContent || "").trim();`);
      const m = /(\d+)\s*\/\s*(\d+)/.exec(t) || [];
      return { raw: t, cur: Number(m[1] || 0), total: Number(m[2] || 0) };
    };
    const c0 = await countOf();
    check("默认（不勾任何项）：cat 命中 6 处（cat/concat×2/cats/Cat/CAT）", c0.total === 6, JSON.stringify(c0));

    await clickSel('[data-testid="search-match-case"]', 600);
    const c1 = await countOf();
    check("勾「匹配大小写」→ 4 处（cat/concat×2/cats，排除 Cat/CAT）", c1.total === 4, JSON.stringify(c1));

    await clickSel('[data-testid="search-whole-word"]', 600);
    const c2 = await countOf();
    // ⚠️ 期望值必须按**真实文本**算，不能想当然：DOC_A 里「concat 包含 cat 但不是全词」
    // 这一行除了 concat 里的 cat，还有一个**独立的 cat**（整词）。所以
    // 「大小写敏感 + 全词」= 2 处（第 3 行的 cat、第 4 行末尾的 cat），不是 1 处。
    check("再勾「全词匹配」（大小写敏感）→ 2 处（两处独立 cat）", c2.total === 2, JSON.stringify(c2));
    await shot("v0140-req2-wholeword-case");

    // 取消大小写，保留全词 → 4 处（2 处 cat + Cat + CAT）
    await clickSel('[data-testid="search-match-case"]', 600);
    const c3 = await countOf();
    check("取消大小写（保留全词）→ 4 处（cat×2 + Cat + CAT）", c3.total === 4, JSON.stringify(c3));
    await clickSel('[data-testid="search-whole-word"]', 500);
    await clickSel('[data-testid="search-match-case"]', 500);

    // 选取范围内：在源码里选中 "concat 包含 cat 但不是全词" 这一行
    const selInfo = await evalJs(`
      const ta = document.querySelector("textarea.source-editor");
      if (!ta) return null;
      const lines = ta.value.split("\\n");
      const idx = lines.findIndex((l) => l.startsWith("concat"));
      if (idx < 0) return null;
      let start = 0;
      for (let i = 0; i < idx; i++) start += lines[i].length + 1;
      const end = start + lines[idx].length;
      ta.focus();
      ta.setSelectionRange(start, end);
      return { start, end, text: lines[idx] };
    `);
    check("源码里成功选中 concat 行", !!selInfo, JSON.stringify(selInfo && { text: selInfo.text }));
    await clickSel('[data-testid="search-in-selection"]', 800);
    const c4 = await countOf();
    // 选区是整行「concat 包含 cat 但不是全词」，行内有 2 处 cat（concat 内 + 独立词），
    // 且此时全词/大小写都已取消 → 范围内命中 2 处才是正确的。
    check("勾「选取范围内」→ 只在选区内命中 2 处（行内两处 cat）", c4.total === 2, JSON.stringify(c4));

    // 范围内替换：把 cat 换成 DOG，应当只改选区那一行
    const toggleReplace = await rect(".search-toggle-btn");
    await clickXY(toggleReplace.x, toggleReplace.y);
    await sleep(400);
    const replaceInput = await rect(".replace-row .search-input");
    await clickXY(replaceInput.x, replaceInput.y);
    await cdp.send("Input.insertText", { text: "DOG" });
    await sleep(500);
    const replaceAllBtn = await evalJs(`
      const btns = [...document.querySelectorAll(".replace-row .replace-btn")];
      const el = btns[btns.length - 1];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: (el.textContent || "").trim() };
    `);
    await clickXY(replaceAllBtn.x, replaceAllBtn.y);
    await sleep(900);
    const afterReplace = await text(`return document.querySelector("textarea.source-editor")?.value || "";`);
    const linesAfter = afterReplace.split("\n");
    // 范围内两处 cat 都会换成 DOG：concat → conDOG，末尾独立 cat → DOG。
    // 所以这一行已经不再以 "concat" 开头（这正是替换生效的证据），要按 DOG 找它。
    const replacedLine = linesAfter.find((l) => l.includes("DOG")) || "";
    const catLine = linesAfter.find((l) => l.startsWith("cat ")) || "";
    check(
      "范围内替换：选区内两处 cat → DOG（concat → conDOG）",
      replacedLine === "conDOG 包含 DOG 但不是全词",
      JSON.stringify(replacedLine),
    );
    check("范围内替换：选区外未被改写（第 3 行 cat 仍在）", catLine === "cat 单独出现", catLine);
    check(
      "范围内替换未越界（全文恰好 2 处 DOG，= 选区内命中数）",
      (afterReplace.match(/DOG/g) || []).length === 2,
      `DOG 出现 ${(afterReplace.match(/DOG/g) || []).length} 次`,
    );
    await shot("v0140-req2-in-selection-replace");

    // 恢复原文：不依赖 Ctrl+Z。
    //
    // 为什么：搜索/替换走的是 `onSourceContentChange`（程序化写回），**不进**源码模式的
    // 自建 diff 撤销栈（那是给用户键入/自动配对用的），所以 Ctrl+Z 撤不回替换结果——
    // 这是 v0.4.2 起就有的既有语义，不是本版改动。这里改用「反向全部替换」恢复，
    // 顺便验证「不勾选取范围内」时替换作用于全文。
    await clickSel('[data-testid="search-in-selection"]', 500);
    const sInput = await rect(".search-row .search-input");
    await clickXY(sInput.x, sInput.y);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a" });
    await cdp.send("Input.insertText", { text: "DOG" });
    await sleep(700);
    const rInput = await rect(".replace-row .search-input");
    await clickXY(rInput.x, rInput.y);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a" });
    await cdp.send("Input.insertText", { text: "cat" });
    await sleep(700);
    const allBtn = await evalJs(`
      const btns = [...document.querySelectorAll(".replace-row .replace-btn")];
      const el = btns[btns.length - 1];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: el.disabled };
    `);
    await clickXY(allBtn.x, allBtn.y);
    await sleep(1000);
    const restored = await text(`return document.querySelector("textarea.source-editor")?.value || "";`);
    check("反向全部替换（不勾范围内）恢复原文", restored === DOC_A, restored === DOC_A ? "逐字节一致" : `实际：${JSON.stringify(restored.slice(0, 80))}`);

    // 复位搜索词，供「查找所有打开文件」用
    const sInput2 = await rect(".search-row .search-input");
    await clickXY(sInput2.x, sInput2.y);
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, code: "KeyA", key: "a" });
    await cdp.send("Input.insertText", { text: "cat" });
    await sleep(800);

    // 查找所有打开文件
    await clickSel('[data-testid="search-find-in-open-files"]', 900);
    const banner = await evalJs(`
      const box = document.querySelector('[data-testid="search-results"]');
      if (!box) return null;
      const items = [...box.querySelectorAll('[data-testid="search-result-item"]')]
        .filter((el) => getComputedStyle(el).display !== "none")
        .map((el) => ({
          file: (el.querySelector('[data-testid="search-result-file"]')?.textContent || "").trim(),
          line: (el.querySelector('[data-testid="search-result-line"]')?.textContent || "").trim(),
          marks: el.querySelectorAll('[data-testid="search-result-match"]').length,
        }))
        .filter((x) => x.file);
      const summary = (box.querySelector('[data-testid="search-results-summary"]')?.textContent || "").trim();
      return { count: items.length, items, summary };
    `);
    check("「查找所有打开文件」展开条幅且有结果", !!banner && banner.count > 0, banner ? `条目 ${banner.count}` : "无条幅");
    check("条幅含文件名前缀", banner?.items?.every((it) => it.file.length > 0), JSON.stringify(banner?.items?.slice(0, 2)));
    check("条幅含命中行内容", banner?.items?.some((it) => it.line.includes("cat")), JSON.stringify(banner?.items?.slice(0, 2)));
    check("命中行内关键字被高亮标记（<mark>）", banner?.items?.some((it) => it.marks > 0), JSON.stringify(banner?.items?.map((i) => i.marks)));
    check("条幅有汇总文案", (banner?.summary || "").length > 0, banner?.summary);
    const hasOtherFile = banner?.items?.some((it) => it.file.startsWith("另一个"));
    check("条幅列出「其他打开文件」的命中", hasOtherFile === true, banner?.items?.map((i) => i.file).join(" | "));
    await shot("v0140-req2-find-in-open-files");

    // 点击其他文件的结果 → 跳转
    const otherIdx = banner.items.findIndex((it) => it.file.startsWith("另一个"));
    if (otherIdx >= 0) {
      const itemRect = await evalJs(`
        const box = document.querySelector('[data-testid="search-results"]');
        const items = [...box.querySelectorAll('[data-testid="search-result-item"]')].filter((el) => getComputedStyle(el).display !== "none");
        const el = items[${otherIdx}];
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + Math.min(80, r.width / 2), y: r.top + r.height / 2 };
      `);
      await clickXY(itemRect.x, itemRect.y);
      await sleep(1400);
      const activeTab = await text(`return (document.querySelector(".tab-item.tab-active .tab-name")?.textContent || "").trim();`);
      check("点击其他文件的命中 → 切到该文件标签", activeTab.startsWith("另一个"), activeTab);
    } else {
      check("点击其他文件的命中 → 切到该文件标签", false, "条幅里没有其他文件条目");
    }

    // 阅读模式下的搜索（PM 路径）
    await runCommand("view.preview");
    await sleep(800);
    await runCommand("edit.find");
    await sleep(700);
    const inReading = await evalJs(`
      const pm = document.querySelector(".ProseMirror");
      return { hasPm: !!pm, textLen: (pm?.innerText || "").length };
    `);
    check("阅读模式：PM 渲染正常", inReading.hasPm === true && inReading.textLen > 0, JSON.stringify(inReading));
    const countReading = await countOf();
    check("阅读模式搜索同样生效（有匹配数）", countReading.total > 0, JSON.stringify(countReading));
    await shot("v0140-req2-reading-mode");

    // 汇总
    console.log("\n──────────────────────────────");
    console.log(`结果：${results.length - failed} PASS / ${failed} FAIL（共 ${results.length}）`);
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(OUT_LOG, ["LightMD v0.14.0 实机验收", `时间：${new Date().toISOString()}`, "", ...results, "", `结果：${results.length - failed} PASS / ${failed} FAIL`, ""].join("\n"), "utf-8");
    console.log(`报告：${OUT_LOG}`);
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
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("实机验收异常：", e);
  process.exit(2);
});
