/**
 * 聚焦探针：v0.14.0 续修 —— **左侧栏上下拖拽调整区域大小失效**。
 *
 * 用户原话：「左侧栏没法上下拖动调整区域大小了，请修复该问题」。
 *
 * 本探针不猜测，只测行为，把"拖不动"拆成三种可能分别判定：
 *   A. 拖拽**根本没反应**（mousedown 没进入 beginSectionDrag / 没写高度）
 *   B. 拖拽**有反应但被弹回**（mousemove 期间高度变了，mouseup 后又回到原值）
 *   C. 拖拽**只在某些栏位之间**生效（例如只有 temp↔recent 能拖，folder↔temp 不能）
 *
 * 三个场景（每个独立临时工作区 + 独立 profile，互不污染）：
 *   R1 打开文件夹 + 打开 3 个文件 → 拖 folder/temp 之间的分隔条（向下 60px、再向上回来）
 *   R2 同上 → 拖「打开的文件」栏的**标题栏**（标题栏拖拽与分隔条同一套 beginSectionDrag）
 *   R3 打开文件夹文件夹 + 打开 3 个文件 + 展开收藏 → 拖 temp 与 favorites 之间的分隔条
 *
 * 每个场景记录：
 *   - 拖拽期间高度序列（每 40px 一步，读实际 getBoundingClientRect 高）
 *   - mouseup 后 100ms / 800ms 的高度（判断是否被布局 effect 弹回）
 *   - 是否出现 body.section-dragging（CSS 关闭过渡的开关，beginSectionDrag 会加）
 *   - mousedown 处 elementFromPoint 命中的是谁（判断分隔条是否被别的元素盖住）
 *
 * 用法：node scripts/v0140-probe-sidebar-resize.mjs
 * 环境变量：V0140RS_PORT（默认 9296）
 * 报告：_verify-out/v0140-probe-sidebar-resize.txt
 *
 * ⚠️ 本脚本会 taskkill lightmd.exe，运行前抢 _verify-out/probe.lock（跑完释放）。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140RS_PORT || 9296);
const CDP = `http://127.0.0.1:${PORT}`;
const OUT = "D:\\AI\\markdown view\\_verify-out\\v0140-probe-sidebar-resize.txt";
const SHOTS = "D:\\AI\\markdown view\\_verify-out";
const LOCK = path.join(SHOTS, "probe.lock");
const LOCK_STALE_MS = 6 * 60 * 1000;
const LOCK_WAIT_MS = 6 * 60 * 1000;

const lines = [];
let failed = 0;
const log = (s = "") => {
  console.log(s);
  lines.push(s);
};
const check = (name, ok, detail = "") => {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`;
  log(line);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 抢互斥锁：只删自己 pid 的锁；任何退出路径都释放 */
async function acquireLock() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const started = Date.now();
  let fh = null;
  const release = async () => {
    try { await fh?.close(); } catch {}
    fh = null;
    // 只删自己写的锁（别误删别人的 lead-build 锁）
    try {
      const raw = fs.readFileSync(LOCK, "utf-8");
      if (raw.includes(`"pid":${process.pid}`)) fs.unlinkSync(LOCK);
    } catch {}
  };
  process.on("exit", () => {
    try {
      const raw = fs.readFileSync(LOCK, "utf-8");
      if (raw.includes(`"pid":${process.pid}`)) fs.unlinkSync(LOCK);
    } catch {}
  });
  for (;;) {
    try {
      fh = await fs.promises.open(LOCK, "wx");
      await fh.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString(), script: "v0140-probe-sidebar-resize" }),
        "utf-8",
      );
      return release;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const st = await fs.promises.stat(LOCK).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        log(`[lock] 陈旧锁（${Math.round((Date.now() - st.mtimeMs) / 1000)}s），删除重试`);
        await fs.promises.unlink(LOCK).catch(() => {});
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error("等锁超时");
      await sleep(3000);
    }
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
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({
        ws,
        send(method, params, timeoutMs = 30000) {
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
          try { ws.close(); } catch {}
        },
      });
  });
}

async function attach() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      for (const t of list) {
        if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
        let c = null;
        try {
          c = await connect(t.webSocketDebuggerUrl);
          await c.send("Runtime.enable");
          const r = await c.send(
            "Runtime.evaluate",
            { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true },
            15000,
          );
          if (r.result?.result?.value === true) {
            await c.send("Page.enable");
            return c;
          }
          c.close();
        } catch {
          try { c?.close(); } catch {}
        }
      }
    } catch {}
    await sleep(400);
  }
  throw new Error("连不上 CDP");
}

async function openSession(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0140rs-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const workDir = path.join(tmp, "工作区");
  fs.mkdirSync(workDir, { recursive: true });
  for (let i = 1; i <= 12; i++) {
    fs.writeFileSync(
      path.join(workDir, `笔记-${String(i).padStart(2, "0")}.md`),
      `# 笔记 ${i}\n\n第 ${i} 篇内容。\n`,
      "utf-8",
    );
  }
  log(`── 会话「${label}」 ──`);
  log(`   临时工作区：${workDir}`);
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1200);
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });
  let cdp = await attach();
  const S = {
    child,
    workDir,
    get cdp() { return cdp; },
    async ev(body) {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await cdp.send(
            "Runtime.evaluate",
            { expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise: true },
            40000,
          );
          if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
          return r.result?.result?.value;
        } catch (e) {
          lastErr = e;
          try { cdp.close(); } catch {}
          try { cdp = await attach(); } catch {}
          await sleep(600);
        }
      }
      throw lastErr;
    },
    async shot(name) {
      try {
        const r = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, "base64"));
      } catch {}
    },
    async close() {
      try { cdp.close(); } catch {}
      try { child.kill(); } catch {}
      try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
      await sleep(900);
    },
  };
  await sleep(2600);
  return S;
}

const openFolder = async (S, dir) => {
  await S.ev(
    `window.dispatchEvent(new CustomEvent("lightmd:openFolder",{detail:{path:${JSON.stringify(dir)}}})); return 1;`,
  );
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    if (await S.ev(`return !!document.querySelector(".filetree-folder-section .filetree-node");`)) return true;
  }
  return false;
};

const openPaths = async (S, paths, gap = 600) => {
  for (const p of paths) {
    await S.ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(p)}}})); return 1;`);
    await sleep(gap);
  }
};

/** 布局快照：各 section 的 key / top / height / inline height，以及分隔条位置 */
const layout = (S) =>
  S.ev(`
    const secs = [...document.querySelectorAll(".filetree-scroll [data-section-key]")].map(el => {
      const r = el.getBoundingClientRect();
      return { key: el.dataset.sectionKey, top: +r.top.toFixed(1), h: +r.height.toFixed(1), inline: el.style.height || null };
    });
    const rs = [...document.querySelectorAll(".filetree-v-resizer")].map(el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      return {
        top: +r.top.toFixed(1), h: +r.height.toFixed(1),
        hitSelf: hit === el || (el.contains(hit) === true),
        hitClass: hit ? (hit.className || "").toString().slice(0, 40) : null,
      };
    });
    const sc = document.querySelector(".filetree-scroll");
    return {
      secs, resizers: rs,
      scroll: sc ? { top: sc.scrollTop, clientH: sc.clientHeight, scrollH: sc.scrollHeight } : null,
      bodyDragging: document.body.classList.contains("section-dragging"),
    };
  `);

/** 找一个 y 轴分隔条：默认取第 index 个 */
const resizerAt = (S, index = 0) =>
  S.ev(`
    const rs = [...document.querySelectorAll(".filetree-v-resizer")];
    const el = rs[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    return {
      x: r.left + r.width/2, y: r.top + r.height/2,
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      hitSelf: hit === el || (el && hit ? el.contains(hit) : false),
      hitTag: hit ? hit.tagName : null,
      hitClass: hit ? (hit.className || "").toString().slice(0, 60) : null,
      count: rs.length,
    };
  `);

const secHeights = (S) =>
  S.ev(`
    const out = {};
    for (const el of document.querySelectorAll(".filetree-scroll [data-section-key]")) {
      out[el.dataset.sectionKey] = +el.getBoundingClientRect().height.toFixed(1);
    }
    return out;
  `);

/**
 * 真实鼠标拖拽：mousedown → 分步 mousemove → 每步读高度 → mouseup → 再读两拍。
 * @returns 拖拽期间高度序列 + 松开后高度
 */
async function dragVertical(S, start, dy, steps = 6, label = "") {
  const before = await secHeights(S);
  await S.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: start.x, y: start.y, button: "left", clickCount: 1, buttons: 1,
  });
  await sleep(80);
  const draggingFlag = await S.ev(
    `return { bodyDragging: document.body.classList.contains("section-dragging"), cursor: document.body.style.cursor };`,
  );
  const seq = [];
  for (let i = 1; i <= steps; i++) {
    const y = start.y + (dy * i) / steps;
    await S.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y, button: "left", buttons: 1 });
    await sleep(70);
    seq.push({ dy: Math.round((dy * i) / steps), h: await secHeights(S) });
  }
  await S.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: start.x, y: start.y + dy, button: "left", clickCount: 1, buttons: 0,
  });
  await sleep(120);
  const after100 = await secHeights(S);
  await sleep(900);
  const after1000 = await secHeights(S);
  const releasedFlag = await S.ev(
    `return { bodyDragging: document.body.classList.contains("section-dragging"), cursor: document.body.style.cursor };`,
  );
  log(`    [${label}] 拖前=${JSON.stringify(before)}`);
  log(`    [${label}] 按下后=${JSON.stringify(draggingFlag)}`);
  log(`    [${label}] 拖动序列=${JSON.stringify(seq.map((s) => s.h))}`);
  log(`    [${label}] 松开+120ms=${JSON.stringify(after100)}`);
  log(`    [${label}] 松开+1000ms=${JSON.stringify(after1000)}`);
  log(`    [${label}] 松开后=${JSON.stringify(releasedFlag)}`);
  return { before, seq, after100, after1000, draggingFlag, releasedFlag };
}

const sumChanged = (a, b) => {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  let maxAbs = 0;
  for (const k of keys) maxAbs = Math.max(maxAbs, Math.abs((b?.[k] ?? 0) - (a?.[k] ?? 0)));
  return +maxAbs.toFixed(1);
};

/** R1：folder ↔ temp 之间的分隔条 */
async function scenarioResizer() {
  log("");
  log("═══ R1：拖 folder ↔ temp 之间的分隔条（向下 60px，再向上 60px）═══");
  const S = await openSession("resizer");
  try {
    log(`  打开文件夹 → ${await openFolder(S, S.workDir)}`);
    await openPaths(S, [1, 2, 3].map((i) => path.join(S.workDir, `笔记-0${i}.md`)));
    await sleep(1200);
    const L = await layout(S);
    log("  布局：" + JSON.stringify(L, null, 2).replace(/\n/g, "\n  "));
    const keys = L.secs.map((s) => s.key);
    check("R1 存在分隔条（两个及以上 section）", L.resizers.length >= 1, `count=${L.resizers.length}, keys=${JSON.stringify(keys)}`);

    const rz = await resizerAt(S, 0);
    log("  分隔条 0：" + JSON.stringify(rz));
    check("R1 分隔条可被指针命中（未被其它元素盖住）", !!rz && rz.hitSelf === true, JSON.stringify(rz));

    const d1 = await dragVertical(S, rz, 60, 6, "R1-down");
    const downOk = sumChanged(d1.before, d1.seq[d1.seq.length - 1].h) >= 30;
    check("R1 向下拖动时高度**有变化**（拖拽链路通）", downOk, `maxDelta=${sumChanged(d1.before, d1.seq[d1.seq.length - 1].h)}`);
    const keepDown = sumChanged(d1.seq[d1.seq.length - 1].h, d1.after1000) <= 2;
    check("R1 松开 1 秒后高度**保持**（没被布局 effect 弹回）", keepDown, `松开后变化=${sumChanged(d1.seq[d1.seq.length - 1].h, d1.after1000)}`);

    const rz2 = await resizerAt(S, 0);
    const d2 = await dragVertical(S, rz2, -60, 6, "R1-up");
    const upOk = sumChanged(d2.before, d2.seq[d2.seq.length - 1].h) >= 30;
    check("R1 反向（向上）拖动也能变化（双向都通）", upOk, `maxDelta=${sumChanged(d2.before, d2.seq[d2.seq.length - 1].h)}`);
    await S.shot("v0140rs-R1-after");

    return { L, rz, d1, d2 };
  } finally {
    await S.close();
  }
}

/** R2：拖「打开的文件」栏标题栏（与分隔条同一套 beginSectionDrag） */
async function scenarioHeader() {
  log("");
  log("═══ R2：拖「打开的文件」栏**标题栏**（向下 50px）═══");
  const S = await openSession("header");
  try {
    log(`  打开文件夹 → ${await openFolder(S, S.workDir)}`);
    await openPaths(S, [1, 2, 3].map((i) => path.join(S.workDir, `笔记-0${i}.md`)));
    await sleep(1200);
    const hp = await S.ev(`
      const el = document.querySelector(".filetree-temp-header");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 60, r.top + r.height/2);
      return { x: r.left + 60, y: r.top + r.height/2, h: +r.height.toFixed(1), hitClass: hit ? (hit.className||"").toString().slice(0,50) : null };
    `);
    log("  标题栏命中点：" + JSON.stringify(hp));
    check("R2 「打开的文件」标题栏存在", !!hp, JSON.stringify(hp));
    if (!hp) return null;
    const d = await dragVertical(S, hp, 50, 5, "R2-header");
    const ok = sumChanged(d.before, d.seq[d.seq.length - 1].h) >= 20;
    check("R2 拖标题栏能改变区域高度", ok, `maxDelta=${sumChanged(d.before, d.seq[d.seq.length - 1].h)}`);
    check("R2 拖拽期间 body.section-dragging 已挂上（说明进入了 beginSectionDrag）", d.draggingFlag?.bodyDragging === true, JSON.stringify(d.draggingFlag));
    check("R2 松开后 body.section-dragging 已移除", d.releasedFlag?.bodyDragging === false, JSON.stringify(d.releasedFlag));
    await S.shot("v0140rs-R2-after");
    return { hp, d };
  } finally {
    await S.close();
  }
}

/** R3：展开收藏后拖 temp ↔ favorites 分隔条 */
async function scenarioFav() {
  log("");
  log("═══ R3：打开收藏后拖 temp ↔ favorites 分隔条（向下 40px）═══");
  const S = await openSession("fav");
  try {
    log(`  打开文件夹 → ${await openFolder(S, S.workDir)}`);
    await openPaths(S, [1, 2, 3].map((i) => path.join(S.workDir, `笔记-0${i}.md`)));
    await sleep(800);
    // 点收藏按钮
    const btn = await S.ev(`
      const b = [...document.querySelectorAll(".filetree-btn")].find(x => (x.title||"").includes("收藏"));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    `);
    if (btn) {
      await S.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: btn.x, y: btn.y, button: "left", clickCount: 1, buttons: 1 });
      await S.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btn.x, y: btn.y, button: "left", clickCount: 1, buttons: 0 });
      await sleep(1600);
    }
    const L = await layout(S);
    log("  布局：" + JSON.stringify({ secs: L.secs, resizers: L.resizers }, null, 2).replace(/\n/g, "\n  "));
    if (L.resizers.length === 0) {
      check("R3 收藏展开后存在分隔条", false, "resizers=0");
      return null;
    }
    const rz = await resizerAt(S, 0);
    check("R3 分隔条可被指针命中", !!rz && rz.hitSelf === true, JSON.stringify(rz));
    const d = await dragVertical(S, rz, -40, 4, "R3-fav");
    const ok = sumChanged(d.before, d.seq[d.seq.length - 1].h) >= 20;
    check("R3 收藏态下拖拽能改变高度", ok, `maxDelta=${sumChanged(d.before, d.seq[d.seq.length - 1].h)}`);
    await S.shot("v0140rs-R3-after");
    return { L, rz, d };
  } finally {
    await S.close();
  }
}

const main = async () => {
  if (!fs.existsSync(EXE)) {
    console.error("缺少打包产物：" + EXE);
    process.exit(3);
  }
  const release = await acquireLock();
  try {
    log("LightMD v0.14.0 续修 —— 左侧栏上下拖拽调整区域大小 实机探针");
    log(`时间：${new Date().toISOString()}`);
    log(`产物：${EXE}`);
    log(`产物 mtime：${fs.statSync(EXE).mtime.toISOString()}`);
    await scenarioResizer();
    await scenarioHeader();
    await scenarioFav();
    log("");
    log(`结果：${failed === 0 ? "全部 PASS" : `${failed} 项 FAIL`}`);
  } finally {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf-8");
    await release();
    console.log(`\n报告：${OUT}`);
  }
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error("探针异常：", e);
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    lines.push("", "探针异常：" + String(e));
    fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf-8");
  } catch {}
  try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  process.exit(2);
});
