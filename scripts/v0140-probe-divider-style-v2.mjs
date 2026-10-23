/**
 * 需求5 实机取证：分割线竖排小字「新风格」的实际渲染（打包产物 + WebView2 CDP）
 *
 * 用户第三批原话：「竖排小字艺术化再换个字体样式和风格，简单的呼吸渐变就行，
 * 不要求金属光泽了。」本脚本只做取证（量 + 截图），不做断言式验收：
 *   1. 量 computed style：font-family（应含 Cascadia Code/Consolas + 雅黑/PingFang）、
 *      font-weight（400）、letter-spacing（3px）、font-variant（full-width）、
 *      color（color-mix 半透明）、-webkit-text-fill-color、background-image 层数
 *   2. 量动画：animationName + getKeyframes() 里到底动了哪些属性（只允许 opacity/transform）
 *   3. 量几何：关闭态 18px 宽下，竖排四字是否溢出（label 宽 ≤ 18px、高 ≤ 半屏）
 *   4. 截图：悬停右屏让文字浮现后，裁切分割线区域落盘，肉眼核对新风格
 *
 * 用法：node scripts/v0140-probe-divider-style-v2.mjs
 * 落盘：_verify-out/v0140-probe-divider-style-v2.txt + *.png
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_DIVIDER_PORT || 9377);
const CDP = `http://127.0.0.1:${PORT}`;
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const OUT = path.join(OUT_DIR, "v0140-probe-divider-style-v2.txt");
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

const main = async () => {
  if (!fs.existsSync(EXE)) {
    console.error(`缺少打包产物：${EXE}`);
    process.exit(3);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-divider-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const fDoc = path.join(tmp, "divider-probe.md");
  fs.writeFileSync(fDoc, ["# 分割线探针", "", "正文。", "", ...Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段。`)].join("\n"));

  log(`LightMD v0.14.0 需求5 竖排小字风格实机取证`);
  log(`时间：${new Date().toISOString()}`);
  log(`产物：${EXE}（mtime=${fs.statSync(EXE).mtime.toISOString()}）`);
  log(`dist CSS 是否含新风格：见报告末尾（由构建产物抽查）`);

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
  if (!cdp) {
    try {
      child.kill();
    } catch {}
    throw new Error("no CDP target");
  }
  await cdp.send("Page.enable");

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };
  const mouse = async (type, x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type, x, y });
    await sleep(150);
  };
  const shootRect = async (name, rect) => {
    const r = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: Math.max(0, rect.x - 24), y: Math.max(0, rect.y - 24), width: rect.w + 48, height: rect.h + 48, scale: 1 },
    });
    const p = path.join(OUT_DIR, `v0140-probe-divider-style-v2-${name}.png`);
    fs.writeFileSync(p, Buffer.from(r.result.data, "base64"));
    return p;
  };

  try {
    log("\n═══ 打开文档并进入编辑模式（分屏） ═══");
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(fDoc)}}})); return 1;`);
    await sleep(2000);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.edit"}})); return 1;`);
    await sleep(1800);

    // ── 关闭态：常驻 18px，先量几何与样式 ──
    const closed = await ev(`
      const lb = document.querySelector(".split-divider-label");
      const dv = document.querySelector(".split-divider");
      if (!lb) return { error: "no label" };
      const r = lb.getBoundingClientRect(), dr = dv.getBoundingClientRect();
      const cs = getComputedStyle(lb);
      const kf = (lb.getAnimations() || []).flatMap((a) => {
        if (!a.effect || !a.effect.getKeyframes) return [];
        return a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((x) => !["offset","computedOffset","easing","composite"].includes(x)));
      });
      return {
        text: (lb.textContent||"").trim(),
        writingMode: cs.writingMode, textOrientation: cs.textOrientation,
        fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
        fontVariant: cs.fontVariant, letterSpacing: cs.letterSpacing,
        color: cs.color, webkitTextFill: cs.webkitTextFillColor,
        backgroundImage: (cs.backgroundImage||"").slice(0,240),
        backgroundClip: cs.backgroundClip || cs.webkitBackgroundClip,
        textShadow: cs.textShadow, filter: cs.filter,
        animationName: cs.animationName, animationDuration: cs.animationDuration,
        willChange: cs.willChange,
        animatedProps: [...new Set(kf)],
        labelRect: { w: +r.width.toFixed(2), h: +r.height.toFixed(2), left: +r.left.toFixed(2), top: +r.top.toFixed(2) },
        dividerRect: { w: +dr.width.toFixed(2), h: +dr.height.toFixed(2), left: +dr.left.toFixed(2) },
        dividerClass: dv.className,
        labelOpacity: cs.opacity,
      };
    `);
    log("\n─── 关闭态（常驻半可见）的 computed style ───");
    for (const [k, v] of Object.entries(closed)) {
      if (k === "backgroundImage") log(`  ${k}: ${v}`);
      else log(`  ${k}: ${JSON.stringify(v)}`);
    }

    log("\n─── 判据核对 ───");
    const fam = closed.fontFamily || "";
    log(`  [字体] 等宽西文在栈中：${/Cascadia Code|Consolas/.test(fam)}`);
    log(`  [字体] 中文无衬线在栈中：${/Microsoft YaHei|微软雅黑|PingFang SC|Hiragino Sans GB/.test(fam)}`);
    log(`  [字体] 衬线族名已退出（Palatino/Georgia/宋体）：${!/Palatino|Georgia|Songti|SimSun|华文中宋|STZhongsong/i.test(fam)}`);
    log(`  [风格] font-weight=${closed.fontWeight}（期望 400）`);
    log(`  [风格] letter-spacing=${closed.letterSpacing}（期望 3px，上限）`);
    log(`  [风格] font-variant=${closed.fontVariant}（期望含 full-width）`);
    log(`  [去金属] 无 text-shadow：${closed.textShadow === "none"}`);
    log(`  [去金属] 无 filter：${closed.filter === "none"}`);
    log(`  [简单渐变] 只有线性渐变、无径向：${!/radial-gradient/.test(closed.backgroundImage || "")}（层数=${(closed.backgroundImage.match(/linear-gradient|radial-gradient/g) || []).length}；第 2 层是同色药丸底，承载背景不透出）`);
    log(`  [简单渐变] 无 radial-gradient：${!/radial-gradient/.test(closed.backgroundImage || "")}`);
    log(`  [性能] 动画属性白名单 = ${JSON.stringify(closed.animatedProps)}（应为 ["opacity","transform"]）`);
    log(`  [18px] 标签宽=${closed.labelRect.w}px ≤ 18px：${closed.labelRect.w <= 18}`);
    log(`  [18px] 标签高=${closed.labelRect.h}px ≤ 视口半高：${closed.labelRect.h <= 400}`);

    const openShot = await shootRect("closed-18px", { x: closed.dividerRect.left - 10, y: closed.labelRect.top, w: 40, h: closed.labelRect.h });

    // ── 悬停右屏：文字浮现 + 呼吸动画挂上 ──
    // ⚠️ 关键：.split-divider-label 默认 opacity:0，只有右屏 hover（:has(...)）或分割条 hover 才浮现；
    //    而 WebView2 在 Page.captureScreenshot 期间会**丢 hover** → opacity 立刻回 0 → 截到白图。
    //    所以截图前先在捕获阶段钉住 hover 态：给右屏外壳补一个"等价 class"不现实（选择器是 :hover），
    //    改用最稳的办法——直接给 label 加内联 opacity/animation 覆盖（只影响探针截图，不改源码），
    //    几何/颜色/字体/渐变全部照常由真实 CSS 决定，只是把"可见性开关"固定住。
    log("\n─── 悬停右侧预览区，让竖排小字浮现 ───");
    const shell = await ev(`
      const sh = document.querySelector(".split-preview-shell");
      if (!sh) return null;
      const r = sh.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height };
    `);
    const hoverPoke = async () => {
      if (!shell) return;
      await mouse("mouseMoved", shell.x, shell.y);
      await mouse("mouseMoved", shell.x + 8, shell.y + 8);
    };
    if (shell) await hoverPoke();
    let raised = null;
    for (let i = 0; i < 20; i++) {
      raised = await ev(`return Number(getComputedStyle(document.querySelector(".split-divider-label")).opacity);`);
      if (raised > 0.3) break;
      await hoverPoke();
      await sleep(250);
    }
    await sleep(300);
    const hover = await ev(`
      const lb = document.querySelector(".split-divider-label");
      const cs = getComputedStyle(lb);
      const a = (lb.getAnimations() || [])[0];
      const r = lb.getBoundingClientRect();
      return {
        opacity: cs.opacity, animationName: cs.animationName, color: cs.color,
        fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing,
        rect: { x: +r.left.toFixed(2), y: +r.top.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
        keyframeProps: a && a.effect ? [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((x) => !["offset","computedOffset","easing","composite"].includes(x))))] : null,
      };
    `);
    log(`  浮现后 opacity=${hover.opacity} animation=${hover.animationName} 色=${hover.color}`);
    log(`  字体=${hover.fontFamily.slice(0, 60)}… weight=${hover.fontWeight} spacing=${hover.letterSpacing}`);
    log(`  运行中的关键帧属性=${JSON.stringify(hover.keyframeProps)}（只允许 opacity/transform）`);

    // 截图：钉住可见性（内联 opacity:1 + animation:none，让呼吸不把截图瞬间压暗），
    // 其余视觉全部来自真实 CSS；截完立刻还原。
    await ev(`
      const lb = document.querySelector(".split-divider-label");
      lb.setAttribute("data-probe-prev-opacity", getComputedStyle(lb).opacity);
      lb.style.setProperty("opacity", "1", "important");
      lb.style.setProperty("animation", "none", "important");
      return 1;
    `);
    await sleep(350);
    const shotRect = { x: hover.rect.x - 26, y: hover.rect.y - 26, w: Math.max(hover.rect.w, 20) + 52, h: hover.rect.h + 52 };
    const hoverShot = await shootRect("hover-label", shotRect);
    const shotB64 = fs.readFileSync(hoverShot).toString("base64");
    const dark = await ev(`
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + ${JSON.stringify(shotB64)}; });
      const cv = document.createElement("canvas");
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2] < 200) dark++;
      }
      return { dark, total: d.length/4, size: [cv.width, cv.height] };
    `);
    log(`  截图（可见性已钉住）：非白像素=${dark.dark}/${dark.total}（${dark.size[0]}×${dark.size[1]}）→ ${dark.dark > 20 ? "文字已画出 ✔" : "仍是空白 ✘"}`);
    await ev(`
      const lb = document.querySelector(".split-divider-label");
      lb.style.removeProperty("opacity");
      lb.style.removeProperty("animation");
      const prev = lb.getAttribute("data-probe-prev-opacity");
      if (prev) lb.style.setProperty("opacity", prev);
      lb.removeAttribute("data-probe-prev-opacity");
      return 1;
    `);
    await sleep(200);

    // ── 呼吸：隔 600ms 再量一次 opacity，确认真的在动 ──
    const samples = [];
    for (let i = 0; i < 5; i++) {
      samples.push(await ev(`return Number(getComputedStyle(document.querySelector(".split-divider-label")).opacity);`));
      await sleep(500);
    }
    log(`\n─── 呼吸采样（每 500ms 一次 opacity）───`);
    log(`  ${samples.map((v) => v.toFixed(2)).join(" → ")}`);
    const varies = new Set(samples.map((v) => v.toFixed(2))).size > 1;
    log(`  opacity 是否真的在变化（呼吸生效）：${varies}`);

    log(`\n─── 截图 ───`);
    log(`  关闭态 18px：${openShot}`);
    log(`  悬停浮现：  ${hoverShot}`);
  } finally {
    try {
      cdp.close();
    } catch {}
    try {
      child.kill();
    } catch {}
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {}
  }

  // ── 构建产物抽查：确认命令行打进去的 CSS 就是新风格 ──
  log("\n─── 构建产物（dist CSS）抽查 ───");
  try {
    const distDir = "D:\\AI\\markdown view\\lightmd\\dist\\assets";
    const cssFile = fs.readdirSync(distDir).find((f) => f.endsWith(".css"));
    const css = fs.readFileSync(path.join(distDir, cssFile), "utf8");
    log(`  文件：${cssFile}`);
    log(`  Cascadia Code 在产物里：${/Cascadia Code/.test(css)}`);
    log(`  --label-sheen 在产物里：${/--label-sheen/.test(css)}`);
    log(`  --label-metal 已从产物消失：${!/--label-metal/.test(css)}`);
    // 注意：radial-gradient 在别处合法存在（.fullscreen-hint::before 的压暗层），
    // 所以只断言「标签自己那段规则里没有 radial-gradient」。
    const labelRule = (css.match(/\.split-divider-label\{[^}]*\}/) || [""])[0];
    log(`  标签规则内无 radial-gradient：${!/radial-gradient/.test(labelRule)}`);
    log(`  标签规则内 background-clip=${(labelRule.match(/background-clip:[^;}]*/) || ["n/a"])[0]}`);
  } catch (e) {
    log(`  抽查失败：${e.message}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf-8");
  log(`\n报告：${OUT}`);
};

main().catch((e) => {
  console.error("探针异常：", e);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT, `探针异常：${e?.stack || e}\n`, "utf-8");
  } catch {}
  process.exit(2);
});
