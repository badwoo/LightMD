/**
 * LightMD v0.14.0 第三批 需求6 探针 —— 标题栏「新建 / 窗口」下拉菜单是否被编辑区盖住
 *
 * 用户原话：
 *   「新打开软件，鼠标滑动到"打开"或"窗口"下栏的菜单会被中间的编辑区挡住，
 *     请检查和修复这个问题，要保证菜单栏上的操作和显示是置顶的。」
 *
 * 为什么这个探针不能只靠 elementFromPoint：
 *   `elementFromPoint` **跳过 pointer-events:none 的元素**。新开软件时，
 *   `.editor-empty-state`（整块不透明白底、z-index:10）恰好是 pointer-events:none，
 *   于是指针能"穿过"它点到菜单 → elementFromPoint 报"没问题"，但像素上它可能画在菜单之上。
 *   这正是用户看到的"菜单被编辑区挡住"。所以本探针做三层取证：
 *
 *   ① stacking-context 链：从 .titlebar-dropdown 往上，找出它最近的 z-index 祖先
 *      —— z-index 只在最近 stacking context 内比较，被 `.titlebar-left { z-index:1 }`
 *      夹住的话，dropdown 自己的 z-index:1000 只在这个"小上下文"里有效。
 *   ② 绘制顺序：document.elementsFromPoint（含 pointer-events:none 的层）+ 逐元素背景/opacity。
 *   ③ **像素证据（决定性）**：
 *      · 菜单矩形截图 A
 *      · 把"嫌疑层"临时 display:none，同位置再截一张 B
 *      · 在页面 canvas 里逐像素 diff A/B：菜单本身不透明，若 B 与 A 有差异，
 *        说明该层确实被画在菜单**之上**（正确实现下，隐藏菜单背后的任何层都不该改变菜单矩形内 1 个像素）
 *      · 顺带统计暗色像素数（文字是否真的被画出来了：被白底盖住时文字像素会消失）
 *
 * 用法：
 *   node scripts/v0140-probe-titlebar-menu.mjs before     # 打包产物（旧版）复现缺陷
 *   node scripts/v0140-probe-titlebar-menu.mjs after      # 修复后重新打包再跑，作对比
 *
 * 落盘：D:\AI\markdown view\_verify-out\v0140-probe-titlebar-menu.txt
 *       D:\AI\markdown view\_verify-out\v0140-probe-titlebar-menu-<label>-*.png
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_TITLEBAR_PORT || 9331);
const CDP = `http://127.0.0.1:${PORT}`;
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT = path.join(OUT_DIR, "v0140-probe-titlebar-menu.txt");
const LABEL = (process.argv[2] || "run").replace(/[^\w-]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (s) => {
  console.log(s);
  lines.push(s);
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
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        send(method, params, timeoutMs = 60000) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method, params }));
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs);
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
          } catch {}
        },
      });
  });
}

async function launch(profile) {
  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {}
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
  for (let i = 0; i < 80 && !cdp; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
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
        } catch {}
      }
    } catch {}
    if (!cdp) await sleep(400);
  }
  if (!cdp) throw new Error("no CDP target");
  await cdp.send("Page.enable");
  return { child, cdp };
}

const mk = (cdp) => {
  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result?.result?.value;
  };
  const mouseMove = async (x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sleep(120);
  };
  /** 真实左键单击（用于"点击保持展开"把菜单钉住，不依赖 hover 存活） */
  const cdpClick = async (x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
    await sleep(160);
  };
  /** 截取页面某矩形（CSS 像素）。返回 {base64, width, height}（宽高已是设备像素） */
  const shootRect = async (rect) => {
    const r = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, scale: 1 },
      captureBeyondViewport: false,
    });
    return { base64: r.result.data };
  };
  const saveBase64 = (name, b64) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const p = path.join(OUT_DIR, `v0140-probe-titlebar-menu-${LABEL}-${name}.png`);
    fs.writeFileSync(p, Buffer.from(b64, "base64"));
    return p;
  };
  return { ev, mouseMove, cdpClick, shootRect, saveBase64 };
};

/** 菜单打开后，测量几何 + stacking-context 链 + 绘制顺序 */
const DIAG_JS = `
  const dd = document.querySelector(".titlebar-dropdown");
  if (!dd) return { ok: false, reason: "no .titlebar-dropdown in DOM" };
  const r = dd.getBoundingClientRect();
  const ddCS = getComputedStyle(dd);

  const scInfo = (el) => {
    const s = getComputedStyle(el);
    const reasons = [];
    if (s.position !== "static" && s.zIndex !== "auto") reasons.push("positioned+z-index(" + s.zIndex + ")");
    if (Number(s.opacity) < 1) reasons.push("opacity<1");
    if (s.transform !== "none") reasons.push("transform");
    if (s.filter !== "none") reasons.push("filter");
    if (s.isolation === "isolate") reasons.push("isolation");
    if (s.position === "fixed") reasons.push("fixed");
    if (s.zoom !== "" && s.zoom !== "1" && s.zoom !== "normal") reasons.push("zoom(" + s.zoom + ")");
    if (s.willChange !== "auto") reasons.push("will-change");
    return reasons;
  };
  const cls = (el) => ((typeof el.className === "string" ? el.className : "").trim().slice(0, 48) || el.tagName.toLowerCase());

  // ① dropdown 向上的祖先链 + 最近 z-index 祖先
  const chain = [];
  let nearestZ = null;
  for (let cur = dd; cur && cur !== document.documentElement; cur = cur.parentElement) {
    const s = getComputedStyle(cur);
    const reasons = scInfo(cur);
    chain.push({ cls: cls(cur), position: s.position, zIndex: s.zIndex, createsSC: reasons.join("+") || "-" });
    if (!nearestZ && cur !== dd && s.zIndex !== "auto") nearestZ = { cls: cls(cur), zIndex: s.zIndex };
  }

  // ② 采样点：矩形内 7 列 × 5 行（避开最外 3px 边框）
  const pts = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 7; col++) {
      pts.push({
        x: Math.round(r.left + 3 + ((r.width - 6) * col) / 6),
        y: Math.round(r.top + 3 + ((r.height - 6) * row) / 4),
      });
    }
  }
  const inMenu = (el) => !!(el && el.closest && el.closest(".titlebar-dropdown"));
  const desc = (el) => (el ? cls(el) : "null");
  const samples = pts.map((p) => {
    const paint = (document.elementsFromPoint(p.x, p.y) || []).map((el) => ({ el, d: desc(el), inMenu: inMenu(el) }));
    return {
      x: p.x,
      y: p.y,
      hit: desc(document.elementFromPoint(p.x, p.y)),
      hitInMenu: inMenu(document.elementFromPoint(p.x, p.y)),
      // 绘制顺序第一层是否就是菜单（或其子元素）
      menuPaintedFirst: !!(paint[0] && paint[0].inMenu),
      paintChain: paint.slice(0, 5).map((x) => x.d + (x.inMenu ? "[menu]" : "")),
    };
  });

  // ③ 菜单矩形内、画序"在菜单之前"（即更上层）的非菜单元素（去重）
  const aboveLayers = [];
  for (const s of samples) {
    for (const c of s.paintChain) {
      const name = c.replace("[menu]", "");
      const isMenu = c.includes("[menu]");
      if (isMenu) break; // 到这里都是菜单之上的层
      if (!aboveLayers.includes(name)) aboveLayers.push(name);
    }
  }

  // ④ 候选"遮挡层"：几何覆盖菜单中心、有不透明背景、**且脱离文档流**（absolute/fixed）。
  //    只取脱流元素：隐藏它们不会引起重排（隐藏 .app-sidebar 这类 flex 项会让整个布局位移，
  //    像素对比就失去意义）。给每个候选打 data-probe-id，供后续"假设隐藏"像素实验使用。
  const menuCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const candidates = [];
  let probeId = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (el === dd || el.contains(dd) || dd.contains(el)) continue;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") continue;
    if (s.position !== "absolute" && s.position !== "fixed") continue;
    if (s.backgroundColor === "rgba(0, 0, 0, 0)" && s.backgroundImage === "none" && Number(s.opacity) >= 1) continue;
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    const covers = !(menuCenter.x < b.left || menuCenter.x > b.right || menuCenter.y < b.top || menuCenter.y > b.bottom);
    if (!covers) continue;
    const id = "probe" + probeId++;
    el.setAttribute("data-probe-cand", id);
    candidates.push({
      id,
      cls: cls(el),
      zIndex: s.zIndex,
      position: s.position,
      pointerEvents: s.pointerEvents,
      backgroundColor: s.backgroundColor,
      opacity: s.opacity,
      createsSC: scInfo(el).join("+") || "-",
      rect: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) },
    });
  }

  return {
    ok: true,
    rect: { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom },
    dropdown: { zIndex: ddCS.zIndex, position: ddCS.position, backgroundColor: ddCS.backgroundColor, pointerEvents: ddCS.pointerEvents },
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    chain,
    nearestZAncestor: nearestZ,
    samples,
    sampleStats: {
      total: samples.length,
      hitInMenu: samples.filter((s) => s.hitInMenu).length,
      menuPaintedFirst: samples.filter((s) => s.menuPaintedFirst).length,
    },
    aboveLayers,
    overlappers: candidates,
  };
`;

/**
 * 页内 PNG 解码 + 像素 diff。
 * 两张截图都是 data:image/png;base64，同源（data URL 不污染 canvas），可直接 getImageData。
 * 返回：像素总数、差异像素数、A 的暗色像素数（文字是否被画出来）、B 的暗色像素数。
 */
const PIXDIFF_JS = (a, b) => `
  const load = (dataUrl) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = dataUrl;
  });
  const [ia, ib] = await Promise.all([load(${JSON.stringify(a)}), load(${JSON.stringify(b)})]);
  if (ia.width !== ib.width || ia.height !== ib.height) return { error: "size mismatch", a: [ia.width, ia.height], b: [ib.width, ib.height] };
  const cv = document.createElement("canvas");
  cv.width = ia.width; cv.height = ia.height;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(ia, 0, 0);
  const da = ctx.getImageData(0, 0, ia.width, ia.height).data;
  ctx.clearRect(0, 0, ia.width, ia.height);
  ctx.drawImage(ib, 0, 0);
  const db = ctx.getImageData(0, 0, ia.width, ia.height).data;
  let diff = 0, darkA = 0, darkB = 0, maxDelta = 0;
  const firstDiffs = [];
  for (let i = 0; i < da.length; i += 4) {
    const delta = Math.abs(da[i] - db[i]) + Math.abs(da[i+1] - db[i+1]) + Math.abs(da[i+2] - db[i+2]);
    if (delta > 24) {
      diff++;
      if (firstDiffs.length < 6) firstDiffs.push({ px: (i / 4) % ia.width, py: Math.floor((i / 4) / ia.width), a: [da[i], da[i+1], da[i+2]], b: [db[i], db[i+1], db[i+2]] });
    }
    if (delta > maxDelta) maxDelta = delta;
    const lumA = 0.299 * da[i] + 0.587 * da[i+1] + 0.114 * da[i+2];
    const lumB = 0.299 * db[i] + 0.587 * db[i+1] + 0.114 * db[i+2];
    if (lumA < 140) darkA++;
    if (lumB < 140) darkB++;
  }
  const total = da.length / 4;
  return { total, diff, diffRatio: +(diff / total).toFixed(4), darkA, darkB, maxDelta, firstDiffs, size: [ia.width, ia.height] };
`;

const main = async () => {
  if (!fs.existsSync(EXE)) {
    console.error(`缺少打包产物：${EXE}`);
    process.exit(3);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-titlebar-probe-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const fDoc = path.join(tmp, "probe-doc.md");
  fs.writeFileSync(
    fDoc,
    ["# 探针文档", "", "正文用于撑开编辑区。", "", ...Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段。`)].join("\n"),
  );

  log(`LightMD v0.14.0 需求6 探针（label=${LABEL}）`);
  log(`时间：${new Date().toISOString()}`);
  log(`产物：${EXE}（mtime=${fs.statSync(EXE).mtime.toISOString()}）`);
  log("");

  const session = await launch(profile);
  const { ev, mouseMove, cdpClick, shootRect, saveBase64 } = mk(session.cdp);

  /**
   * 把菜单"钉住"（**只在探针运行期间生效，不改应用源码**）。
   *
   * 为什么必须这样做：TitleBar 的下拉菜单是 hover 展开（onMouseEnter）、
   * `onMouseLeave` 收起；而 WebView2 在 `Page.captureScreenshot` 期间会丢 hover，
   * React 收到 mouseout 就把菜单收起了 → 截到的是"菜单根本没打开"的空白图。
   * 这会让"被编辑区挡住"与"菜单没打开"无法区分（实测既产生过假 FAIL 也产生过假 PASS）。
   *
   * 做法：React 17+ 把 onMouseLeave 委托为原生 `mouseout`（冒泡到 root 容器），
   * 因此在 root 的**捕获阶段**拦掉源自 `.titlebar-new-menu` 子树的
   * mouseout/mouseleave，不让它们到达 React 的委托监听器 → 菜单稳定保持展开。
   * 探针结束前 unpin 恢复真实行为，并用"移开鼠标菜单能收起"验证未破坏原逻辑。
   */
  const pinMenu = async () =>
    ev(`
      if (window.__menuPinned) return true;
      const root = document.getElementById("root") || document.body;
      window.__pinHandler = (e) => {
        const t = e.target;
        if (t && t.closest && t.closest(".titlebar-new-menu")) e.stopPropagation();
      };
      for (const type of ["mouseout", "mouseleave"]) root.addEventListener(type, window.__pinHandler, true);
      window.__menuPinned = true;
      return true;
    `);
  const unpinMenu = async () =>
    ev(`
      if (!window.__menuPinned) return true;
      const root = document.getElementById("root") || document.body;
      for (const type of ["mouseout", "mouseleave"]) root.removeEventListener(type, window.__pinHandler, true);
      delete window.__pinHandler;
      window.__menuPinned = false;
      return true;
    `);

  /**
   * 打开菜单（hover 进入 + 点击保持展开，双保险；配合 pinMenu 后截图稳定）。
   */
  const openMenu = async (which) => {
    const info = await ev(`
      const btns = [...document.querySelectorAll(".titlebar-menu-btn")];
      const btn = ${which === "new"}
        ? btns[0]
        : btns.find((b) => b.getAttribute("data-testid") === "titlebar-window-menu-btn");
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (btn.textContent || "").trim() };
    `);
    if (!info) throw new Error(`找不到菜单按钮：${which}`);
    await mouseMove(info.x - 40, info.y);
    await mouseMove(info.x, info.y);
    await cdpClick(info.x, info.y);
    await sleep(320);
    return info;
  };

  /**
   * 「修复前」状态的等价构造（**只改运行时内联样式，不动源码、不动产物**）：
   * 修复前 .titlebar 是 `position:relative; z-index:auto` ——
   * 这里用 `z-index:auto !important` 精确复原那一刻的层叠条件，
   * 于是同一个 exe 上就能做出「修复前 vs 修复后」的 A/B 对比。
   * 这正是根因验证：唯一的差异就是标题栏是否建立高层级 stacking context。
   */
  const setFixState = async (on) =>
    ev(`
      const on = ${on ? "true" : "false"};
      const tb = document.querySelector(".titlebar");
      if (!tb) return null;
      if (on) {
        tb.style.removeProperty("z-index");
        tb.removeAttribute("data-probe-before");
      } else {
        tb.style.setProperty("z-index", "auto", "important");
        tb.setAttribute("data-probe-before", "1");
      }
      return getComputedStyle(tb).zIndex;
    `);

  /**
   * 像素证明：假设隐藏 selector 指向的层，看菜单矩形内像素有没有变化。
   * 菜单是不透明面板（background: var(--bg-primary)），正确分层下隐藏"菜单背后"的层
   * 不该改变菜单矩形内**任何一个像素**；若有差异 ⇒ 该层被画在菜单之上。
   *
   * ⚠️ 用 visibility:hidden 而不是 display:none —— 后者会移除盒子、可能触发重排，
   *    布局一动像素对比就没有意义了（候选层都是脱流 absolute/fixed，visibility 只影响绘制）。
   *    前提：调用方已 pinMenu()，否则截图期间 WebView2 丢 hover 会截到空白图。
   */
  const pixelProof = async (rect, hideSelector, tag) => {
    const before = await shootRect(rect);
    const openA = await ev(`return !!document.querySelector(".titlebar-dropdown");`);
    const pathBefore = saveBase64(`${tag}-A-before`, before.base64);

    const hidden = await ev(`
      const el = document.querySelector(${JSON.stringify(hideSelector)});
      if (!el) return { ok: false };
      el.setAttribute("data-probe-prev-visibility", getComputedStyle(el).visibility);
      el.style.setProperty("visibility", "hidden", "important");
      return { ok: true };
    `);
    await sleep(280);
    const after = await shootRect(rect);
    const openB = await ev(`return !!document.querySelector(".titlebar-dropdown");`);
    const pathAfter = saveBase64(`${tag}-B-${hideSelector.replace(/[^\w]/g, "").slice(1, 24)}`, after.base64);

    await ev(`
      const el = document.querySelector(${JSON.stringify(hideSelector)});
      if (!el) return 0;
      const prev = el.getAttribute("data-probe-prev-visibility");
      el.style.removeProperty("visibility");
      if (prev && prev !== "visible") el.style.setProperty("visibility", prev);
      el.removeAttribute("data-probe-prev-visibility");
      return 1;
    `);
    await sleep(200);
    const diff = await ev(PIXDIFF_JS(`data:image/png;base64,${before.base64}`, `data:image/png;base64,${after.base64}`));
    return { hidden, openA, openB, diff, pathBefore, pathAfter, trustworthy: openA && openB };
  };

  const probe = async (which, stateTag) => {
    const name = which === "new" ? "新建" : "窗口";
    log(`\n──── ${stateTag}：${name} 菜单 ────`);
    const btn = await openMenu(which);
    const diag = await ev(DIAG_JS);
    if (!diag.ok) {
      log(`  ⚠️ 菜单未展开：${diag.reason}`);
      return null;
    }
    log(`  按钮=${btn.text}（${Math.round(btn.x)},${Math.round(btn.y)}）`);
    log(`  菜单矩形：left=${diag.rect.left.toFixed(1)} top=${diag.rect.top.toFixed(1)} w=${diag.rect.width.toFixed(1)} h=${diag.rect.height.toFixed(1)}  position=${diag.dropdown.position} z-index=${diag.dropdown.zIndex} bg=${diag.dropdown.backgroundColor}`);
    log(`  视口 ${diag.viewport.w}×${diag.viewport.h} dpr=${diag.viewport.dpr}`);
    log(`  ★ 最近的 z-index 祖先（决定 dropdown 的 z-index 在哪个上下文里比较）：${JSON.stringify(diag.nearestZAncestor)}`);
    log(`  祖先链（自菜单向上）：`);
    for (const c of diag.chain) log(`    · ${c.cls.padEnd(30)} position=${String(c.position).padEnd(9)} z-index=${String(c.zIndex).padEnd(5)} 创建SC=${c.createsSC}`);
    log(`  采样 ${diag.sampleStats.total} 点：命中菜单 ${diag.sampleStats.hitInMenu}，绘制顺序菜单排第一 ${diag.sampleStats.menuPaintedFirst}`);
    log(`  画在菜单之上的层（按 elementsFromPoint 绘制顺序，去重）：${diag.aboveLayers.length ? diag.aboveLayers.join(" | ") : "无"}`);
    for (const s of diag.samples) {
      log(`    (${s.x},${s.y}) elementFromPoint=${s.hit} inMenu=${s.hitInMenu} menuFirst=${s.menuPaintedFirst} paint=${s.paintChain.join(" > ")}`);
    }
    log(`  几何覆盖菜单中心、脱流且有不透明背景的层：${diag.overlappers.length}`);
    for (const o of diag.overlappers) {
      log(`    · [${o.id}] ${o.cls.padEnd(26)} z-index=${String(o.zIndex).padEnd(5)} pos=${String(o.position).padEnd(9)} pe=${String(o.pointerEvents).padEnd(6)} opacity=${String(o.opacity).padEnd(4)} SC=${o.createsSC.padEnd(22)} bg=${o.backgroundColor} rect=${JSON.stringify(o.rect)}`);
    }

    // ① 像素证明：逐个"假设隐藏"HIDE 候选层，看菜单矩形内像素是否变化。
    //    隐藏方式不能改布局 → 用 visibility:hidden（脱流元素，不改几何）而非 display:none。
    log(`  ── 像素证明（假设隐藏候选层；正确分层下菜单矩形内应为 0 差异）──`);
    const proofs = [];
    const hideTargets = [
      ...diag.overlappers.map((o) => ({ key: o.id, sel: `[data-probe-cand="${o.id}"]`, label: o.cls })),
      { key: "empty", sel: ".editor-empty-state", label: ".editor-empty-state（空状态白底）" },
    ];
    for (const t of hideTargets) {
      const exists = await ev(`return !!document.querySelector(${JSON.stringify(t.sel)});`);
      if (!exists) {
        log(`    · ${t.label.padEnd(34)} 不存在，跳过`);
        continue;
      }
      const p = await pixelProof(diag.rect, t.sel, `${stateTag}-${which}-${t.key}`);
      if (!p.diff || p.diff.error) {
        log(`    · ${t.label.padEnd(34)} 像素对比失败：${JSON.stringify(p.diff)}`);
        continue;
      }
      if (!p.trustworthy) {
        log(`    · ${t.label.padEnd(34)} 对比不可信（截图期间菜单被收起），丢弃该样本`);
        continue;
      }
      const verdict = p.diff.diff === 0 ? "✔ 在菜单之下（隐藏后像素无变化）" : `✘ 画在菜单之上（${p.diff.diff} 像素改变，占比 ${(p.diff.diffRatio * 100).toFixed(1)}%）`;
      log(`    · ${t.label.padEnd(34)} 差异=${String(p.diff.diff).padStart(6)}/${p.diff.total} 暗色像素(可见/A-B)=${p.diff.darkA}/${p.diff.darkB} → ${verdict}`);
      if (p.diff.diff > 0) log(`        首差异像素：${JSON.stringify(p.diff.firstDiffs)}`);
      proofs.push({ target: t.label, ...p.diff, verdict, trustworthy: true });
    }
    // 清掉为实验加的标记属性，避免污染后续状态
    await ev(`document.querySelectorAll("[data-probe-cand]").forEach((e) => e.removeAttribute("data-probe-cand")); return 1;`);

    // ② 基线：不隐藏任何东西连拍两张，验证截图确定性（差异必须 0）
    const b1 = await shootRect(diag.rect);
    await sleep(220);
    const b2 = await shootRect(diag.rect);
    const b1open = await ev(`return !!document.querySelector(".titlebar-dropdown");`);
    const baseline = await ev(PIXDIFF_JS(`data:image/png;base64,${b1.base64}`, `data:image/png;base64,${b2.base64}`));
    log(`  ── 基线：连拍两张差异=${baseline.diff}（应 0，证明对比可信）；菜单内暗色像素=${baseline.darkA}（文字是否真的画出来）；截后菜单仍在=${b1open}`);
    saveBase64(`${stateTag}-${which}-menu-area`, b1.base64);

    const full = await cdp_screenshotFull();
    return { diag, proofs, baseline, fullScreenshot: full };
  };

  const cdp_screenshotFull = async () => {
    const r = await session.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    return saveBase64(`full-${Date.now()}`, r.result.data);
  };

  try {
    log("═══ 状态 A：新打开软件（未打开文档）═══");
    await sleep(2000);
    const st = await ev(`
      const tb = document.querySelector(".titlebar");
      const shell = document.querySelector(".app-shell");
      const empty = document.querySelector(".editor-empty-state");
      const s = (el) => el ? getComputedStyle(el) : null;
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
      return {
        hasEmptyState: !!empty,
        emptyState: empty ? { zIndex: s(empty).zIndex, position: s(empty).position, pointerEvents: s(empty).pointerEvents, bg: s(empty).backgroundColor, rect: rect(empty) } : null,
        titlebar: tb ? { position: s(tb).position, zIndex: s(tb).zIndex, overflow: s(tb).overflow, rect: rect(tb) } : null,
        appShell: shell ? { position: s(shell).position, zIndex: s(shell).zIndex, overflow: s(shell).overflow } : null,
        appMain: (() => { const el = document.querySelector(".app-main"); return el ? { position: s(el).position, zIndex: s(el).zIndex } : null; })(),
        editorMainArea: (() => { const el = document.querySelector(".editor-main-area"); return el ? { position: s(el).position, zIndex: s(el).zIndex, isolation: s(el).isolation } : null; })(),
      };
    `);
    log(`  .editor-empty-state 存在=${st.hasEmptyState} 样式=${JSON.stringify(st.emptyState)}`);
    log(`  .titlebar：position=${st.titlebar?.position} z-index=${st.titlebar?.zIndex} overflow=${st.titlebar?.overflow}`);
    log(`  .app-shell：position=${st.appShell?.position} z-index=${st.appShell?.zIndex}`);
    log(`  .editor-main-area：position=${st.editorMainArea?.position} z-index=${st.editorMainArea?.zIndex} isolation=${st.editorMainArea?.isolation}`);
    log(`  （对照：.editor-empty-state 的 z-index=${st.emptyState?.zIndex}，是"菜单被挡住"的嫌疑层）`);

    // 钉住下拉菜单（只影响探针期间，不动源码）
    await pinMenu();
    log("  已 pinMenu()：拦截 root 捕获阶段的 mouseout，避免截图时 hover 丢失把菜单收起");

    log("\n★★★ A/B 对照实验：同一个 exe，只切换 .titlebar 的 z-index ★★★");
    const ab = {};
    for (const [phase, fixOn] of [["BEFORE（修复前等价：.titlebar z-index:auto）", false], ["AFTER（修复后：.titlebar z-index:100）", true]]) {
      log(`\n════════ ${phase} ════════`);
      const actualZ = await setFixState(fixOn);
      log(`  .titlebar 实际 z-index = ${actualZ}`);
      for (const which of ["new", "window"]) {
        const r = await probe(which, fixOn ? "AFTER" : "BEFORE");
        if (r) ab[`${fixOn ? "after" : "before"}_${which}`] = r;
      }
    }
    // 恢复真实状态（去掉内联覆盖，让 CSS 生效）
    const restoredZ = await setFixState(true);
    log(`\n恢复真实样式后 .titlebar z-index = ${restoredZ}`);

    log("\n══════════ A/B 结论（判据：菜单区域内「菜单文字暗色像素」与「隐藏空状态后的像素变化」）══════════");
    const summarize = (which, name) => {
      const before = ab[`before_${which}`];
      const after = ab[`after_${which}`];
      if (!before || !after) return log(`  ${name}：缺少数据`);
      const b = before.baseline, a = after.baseline;
      const bProof = before.proofs.find((p) => /editor-empty-state/.test(p.target));
      const aProof = after.proofs.find((p) => /editor-empty-state/.test(p.target));
      log(`  ${name}：`);
      log(`    · 修复前：菜单内文字暗色像素=${b?.darkA}，隐藏空状态后像素变化=${bProof ? bProof.diff : "n/a"}（>0 表示空状态画在菜单之上）→ ${b?.darkA === 0 && bProof && bProof.diff > 0 ? "缺陷复现 ✔" : "未复现"}`);
      log(`    · 修复后：菜单内文字暗色像素=${a?.darkA}，隐藏空状态后像素变化=${aProof ? aProof.diff : "n/a"} → ${a?.darkA > 0 && aProof && aProof.diff === 0 ? "缺陷消失 ✔" : "仍有问题 ✘"}`);
    };
    summarize("new", "新建菜单");
    summarize("window", "窗口菜单");

    log("\n═══ 状态 B：已打开文档（验证修复不依赖空状态）═══");
    await unpinMenu();
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(fDoc)}}})); return 1;`);
    await sleep(2200);
    const hasEmptyB = await ev(`return !!document.querySelector(".editor-empty-state");`);
    log(`  .editor-empty-state 存在=${hasEmptyB}（已打开文档时应为 false）`);
    await pinMenu();
    await probe("new", "B-doc");
    await probe("window", "B-doc");

    // 收尾 1：unpin 后确认菜单仍能正常收起（证明探针没有破坏真实 hover 逻辑）
    await unpinMenu();
    await mouseMove(5, 5);
    await ev(`document.body.click(); return 1;`);
    await sleep(400);
    const stillOpen = await ev(`return !!document.querySelector(".titlebar-dropdown");`);
    log(`\n解除钉住 + 移开鼠标后菜单收起：${!stillOpen}`);
    const leftoverPin = await ev(`return !!(window.__menuPinned);`);
    log(`探针未留下任何钉住标记：${!leftoverPin}`);
    const leftoverStyle = await ev(`return document.querySelector(".titlebar")?.getAttribute("style") || "";`);
    log(`探针未在 .titlebar 留下内联样式残留：${!leftoverStyle || !/z-index/.test(leftoverStyle)}（style="${leftoverStyle}"）`);
  } finally {
    try {
      session.cdp.close();
    } catch {}
    try {
      session.child.kill();
    } catch {}
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {}
  }

  log("\n──────────────────────────────");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf-8");
  log(`报告：${OUT}`);
};

main().catch((e) => {
  console.error("探针异常：", e);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT, `探针异常：${e?.stack || e}\n`, "utf-8");
  } catch {}
  process.exit(2);
});
