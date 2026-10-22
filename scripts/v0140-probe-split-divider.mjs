/**
 * LightMD v0.14.0 需求3 —— 只读实机探针：分屏分割线「往左拖能改，往右拖拖不回来」
 *
 * 目的：用**真实打包产物 + WebView2 CDP 真实鼠标手势**取证，回答三个问题：
 *   1. 往左拖（指针进入左侧 textarea 区域）父文档是否持续收到 mousemove？→ 能改
 *   2. 往右拖（指针立刻进入右侧 iframe.split-preview）父文档是否还收到 mousemove？
 *      若收不到：拖拽链路断在「iframe 吞事件」上 → 单向右的根因
 *   3. 给 iframe 加 pointer-events:none（只在本次运行的 DOM 里，不改代码）后，
 *      同一个「左拖→松手→右拖」手势是否立即恢复双向可拖？
 *
 * 本脚本**不修改任何产品代码/文件**，只在一次性的应用实例里读 DOM、读 localStorage、
 * 临时给 iframe 打一个内联样式（进程退出即消失）。
 *
 * 用法：node scripts/v0140-probe-split-divider.mjs
 * 输出：控制台逐行证据 + _verify-out/v0140-probe-split-divider.txt
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_PROBE_PORT || 9251);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = "D:\\AI\\markdown view\\_verify-out";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = [];
function log(s) {
  lines.push(s);
  console.log(s);
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

const DOC = ["# 分屏分割线探针", "", "用来驱动分屏模式的手势取证。", "", "- 甲", "- 乙", ""].join("\n");

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0140-probe-"));
  const fDoc = path.join(tmpDir, `探针-${RUN}.md`);
  fs.writeFileSync(fDoc, DOC);
  log(`临时文档: ${fDoc}`);

  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
  });

  let cdp;
  try {
    // ── 连接带 Tauri IPC 的 page target ──
    let picked = null;
    for (let i = 0; i < 60 && !picked; i++) {
      try {
        const list = await (await fetch(`${CDP_BASE}/json/list`)).json();
        for (const t of list) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
          try {
            const c = await connect(t.webSocketDebuggerUrl);
            await c.send("Runtime.enable");
            const r = await c.send(
              "Runtime.evaluate",
              { expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`, returnByValue: true },
              20000,
            );
            if (r.result?.result?.value === true) {
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
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
      const raw = r.result?.result?.value;
      return raw === undefined ? undefined : JSON.parse(raw);
    };
    const mouse = (type, x, y, opts = {}) =>
      cdp.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: type === "mouseMoved" ? "left" : "left",
        buttons: 1,
        clickCount: type === "mouseMoved" ? 0 : 1,
        ...opts,
      });

    // ── 打开文档 + 切分屏 ──
    await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(fDoc)}}})); return true;`);
    await sleep(1600);
    await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.split"}})); return true;`);
    await sleep(1200);

    const env = await evalJs(`
      return {
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        hasDivider: !!document.querySelector(".split-divider"),
        hasIframe: !!document.querySelector("iframe.split-preview"),
        hasTextarea: !!document.querySelector("textarea.source-editor"),
        dpr: window.devicePixelRatio,
        viewModeClass: document.querySelector(".split-divider") ? "split" : "not-split",
      };
    `);
    log(`\n环境: ${JSON.stringify(env)}`);
    if (!env.hasDivider) throw new Error("分屏模式未生效（找不到 .split-divider）");

    /** 读当前几何 + 持久化比例 */
    const snap = async (label) => {
      const s = await evalJs(`
        const d = document.querySelector(".split-divider");
        const ta = document.querySelector("textarea.source-editor");
        const fr = document.querySelector("iframe.split-preview");
        const dr = d ? d.getBoundingClientRect() : null;
        const tr = ta ? ta.getBoundingClientRect() : null;
        const rr = fr ? fr.getBoundingClientRect() : null;
        let ratio = null;
        try { ratio = JSON.parse(localStorage.getItem("lightmd-settings") || "{}")?.state?.splitRatio ?? null; } catch {}
        return {
          dividerLeft: dr ? Math.round(dr.left * 10) / 10 : null,
          dividerWidth: dr ? Math.round(dr.width * 10) / 10 : null,
          leftWidth: tr ? Math.round(tr.width * 10) / 10 : null,
          rightWidth: rr ? Math.round(rr.width * 10) / 10 : null,
          storeRatio: ratio,
          bodyCursor: document.body.style.cursor,
          bodyUserSelect: document.body.style.userSelect,
          bodyClass: document.body.className,
        };
      `);
      log(`[${label}] dividerLeft=${s.dividerLeft} divW=${s.dividerWidth} 左栏=${s.leftWidth} 右栏=${s.rightWidth} store.splitRatio=${s.storeRatio} body.cursor="${s.bodyCursor}" body.class="${s.bodyClass}"`);
      return s;
    };

    /** 装事件计数器（capture 阶段挂 document，能收到就说明事件确实到了父文档） */
    const armProbe = async (tag) => {
      await evalJs(`
        window.__probe = { tag: ${JSON.stringify(tag)}, moves: [], downs: [], ups: [], pointerMoves: [] };
        if (!window.__probeHooked) {
          window.__probeHooked = true;
          document.addEventListener("mousemove", (e) => {
            if (!window.__probe) return;
            window.__probe.moves.push({ x: Math.round(e.clientX), y: Math.round(e.clientY), buttons: e.buttons });
          }, true);
          document.addEventListener("pointermove", (e) => {
            if (!window.__probe) return;
            window.__probe.pointerMoves.push({ x: Math.round(e.clientX), buttons: e.buttons });
          }, true);
          document.addEventListener("mouseup", (e) => {
            if (!window.__probe) return;
            window.__probe.ups.push({ x: Math.round(e.clientX), buttons: e.buttons });
          }, true);
          document.addEventListener("pointerup", (e) => {
            if (!window.__probe) return;
            window.__probe.ups.push({ x: Math.round(e.clientX), by: "pointer" });
          }, true);
        }
        return true;
      `);
    };
    const readProbe = async () => evalJs(`return window.__probe || null;`);

    /** 真实手势：按下 → 分步移动（每步读几何）→ 松手 */
    const gesture = async (label, startX, y, offsets) => {
      const steps = [];
      await armProbe(label);
      await mouse("mousePressed", startX, y);
      await sleep(120);
      const afterDown = await snap(`${label} 按下`);
      steps.push({ step: "mousePressed", x: startX, ...afterDown });
      let x = startX;
      for (const off of offsets) {
        const nx = startX + off;
        await mouse("mouseMoved", nx, y);
        await sleep(90);
        const s = await snap(`${label} move→x=${nx}`);
        // 当前鼠标位置下方到底是什么元素（证明指针是否已进入 iframe）
        const under = await evalJs(`
          const el = document.elementFromPoint(${nx}, ${y});
          return { tag: el ? el.tagName : null, cls: el ? String(el.className).slice(0, 60) : null };
        `);
        steps.push({ step: "mouseMoved", x: nx, under: under?.tag + "." + (under?.cls || ""), ...s });
        x = nx;
      }
      await mouse("mouseReleased", x, y);
      await sleep(200);
      const probe = await readProbe();
      const after = await snap(`${label} 松手后`);
      const received = { moves: probe.moves.length, pointerMoves: probe.pointerMoves.length, ups: probe.ups.length };
      log(`[${label}] 父文档收到：mousemove=${probe.moves.length} pointermove=${probe.pointerMoves.length} mouseup/pointerup=${probe.ups.length}（发出 mouseMoved ${offsets.length} 次）`);
      log(`[${label}] 收到的事件坐标: ${JSON.stringify(probe.moves.map((m) => m.x))}`);
      return { steps, after, received, probe };
    };

    // ═══ 阶段 0：基线 ═══
    const base = await snap("基线");
    const divRect = await evalJs(`
      const d = document.querySelector(".split-divider").getBoundingClientRect();
      const fr = document.querySelector("iframe.split-preview").getBoundingClientRect();
      return { x: d.left + d.width / 2, y: d.top + Math.min(d.height / 2, 300), iframeLeft: fr.left, iframeRight: fr.right };
    `);
    const Y = Math.round(divRect.y);
    log(`分割条中心 x=${divRect.x}, 采样 y=${Y}; iframe 横向范围 [${divRect.iframeLeft}, ${divRect.iframeRight}]`);

    // ═══ 阶段 1：往左拖（指针留在左侧 textarea 区域） ═══
    const gLeft = await gesture("A 往左拖", Math.round(divRect.x), Y, [-40, -80, -120, -160, -200, -240]);
    const afterLeft = gLeft.after;

    // ═══ 阶段 2：往右拖（指针很快进入右侧 iframe 区域） ═══
    const rightStart = { x: Math.round(afterLeft.dividerLeft + afterLeft.dividerWidth / 2), y: Y };
    const gRight = await gesture("B 往右拖", rightStart.x, Y, [30, 60, 90, 120, 150, 180]);
    const afterRight = gRight.after;

    // ═══ 阶段 3：失联态确认（松手后 body 是否还处于拖拽态） ═══
    const stuck = await evalJs(`
      return {
        bodyCursor: document.body.style.cursor,
        bodyUserSelect: document.body.style.userSelect,
        // 再发一次纯 mousemove（不带按键），看是否仍在改写比例（说明 mousemove 监听器残留）
      };
    `);
    log(`\n阶段3 松手后残留状态: ${JSON.stringify(stuck)}`);

    // 残留监听器探针：不带按键的 mousemove 若仍改写左栏宽度，说明监听器没解绑
    const leakTest = await evalJs(`
      const ta = document.querySelector("textarea.source-editor");
      const before = Math.round(ta.getBoundingClientRect().width * 10) / 10;
      return { before };
    `);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rightStart.x + 200, y: Y, button: "none", buttons: 0 });
    await sleep(200);
    const leakAfter = await evalJs(`
      const ta = document.querySelector("textarea.source-editor");
      return { after: Math.round(ta.getBoundingClientRect().width * 10) / 10 };
    `);
    log(`阶段3 残留监听器检测：无按键移出 200px 后左栏 ${leakTest.before} → ${leakAfter.after}（相等=监听器已解绑；不等=仍在改写）`);

    // ═══ 阶段 4：给 iframe 打 pointer-events:none（只在本次运行 DOM），复跑同一手势 ═══
    const patched = await evalJs(`
      const fr = document.querySelector("iframe.split-preview");
      fr.style.pointerEvents = "none";
      return { pointerEvents: fr.style.pointerEvents };
    `);
    log(`\n阶段4 给 iframe.split-preview 内联 ${JSON.stringify(patched)}（仅本次运行，进程退出即消失）`);
    // 先把比例拖回接近 0.5 作为对照起点：往左拖回到 0.5 附近
    const gBack = await gesture("C 打补丁后往左拖", Math.round(afterRight.dividerLeft + afterRight.dividerWidth / 2), Y, [-40, -80, -120]);
    // 再往右拖——关键对照
    const rightStart2 = Math.round(gBack.after.dividerLeft + gBack.after.dividerWidth / 2);
    const gRight2 = await gesture("D 打补丁后往右拖", rightStart2, Y, [30, 60, 90, 120, 150, 180]);
    const afterRight2 = gRight2.after;

    // ═══ 阶段 5：评估「只改用 pointer 事件 + setPointerCapture」能否单独解决 ═══
    // 只在本次运行的 DOM 上挂钩子（不改产品代码）：pointerdown 时对分割条 setPointerCapture，
    // 统计 pointermove 是否还能到达分割条——若到达，说明 pointer capture 能在 WebView2 下
    // 把事件从 iframe 手里抢回来；若不到达，说明单靠 pointer capture 不够。
    await evalJs(`
      const d = document.querySelector(".split-divider");
      window.__pc = { captured: false, dividerMoves: 0, docMoves: 0, docPointerMoves: 0, targets: [] };
      d.addEventListener("pointerdown", (e) => {
        try { d.setPointerCapture(e.pointerId); window.__pc.captured = true; } catch (err) { window.__pc.err = String(err); }
      });
      d.addEventListener("pointermove", (e) => { window.__pc.dividerMoves++; window.__pc.targets.push(e.target === d ? "divider" : "other"); });
      document.addEventListener("mousemove", () => { window.__pc.docMoves++; }, true);
      document.addEventListener("pointermove", () => { window.__pc.docPointerMoves++; }, true);
      return true;
    `);
    // 指针从分割条往右进入 iframe（不带任何产品监听器：此时 iframe 已 pointer-events:none 会干扰，
    // 所以先把阶段 4 的内联样式撤掉，恢复"有问题"的原始 DOM 状态）
    await evalJs(`
      const fr = document.querySelector("iframe.split-preview");
      fr.style.pointerEvents = "";
      window.__pc = { captured: false, dividerMoves: 0, docMoves: 0, docPointerMoves: 0, targets: [] };
      return true;
    `);
    const pcStart = Math.round(afterRight2.dividerLeft + afterRight2.dividerWidth / 2);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pcStart, y: Y, button: "left", buttons: 1, clickCount: 1 });
    await sleep(120);
    for (const off of [30, 60, 90, 120]) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pcStart + off, y: Y, button: "left", buttons: 1 });
      await sleep(80);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pcStart + 120, y: Y, button: "left", buttons: 1, clickCount: 1 });
    await sleep(200);
    const pc = await evalJs(`return window.__pc;`);
    log(`\n阶段5 只靠 pointerdown+setPointerCapture（未改代码、iframe 恢复 pointer-events 正常）:`);
    log(`   setPointerCapture 调用成功=${pc.captured}${pc.err ? ` 错误=${pc.err}` : ""}；分割条收到 pointermove=${pc.dividerMoves} 次（发出 4 次）；document 收到 pointermove=${pc.docPointerMoves} 次 / mousemove=${pc.docMoves} 次`);
    log(`   → ${pc.dividerMoves > 0 ? "pointer capture 能把事件从 iframe 手里抢回来（可行）" : "pointer capture 也没用：指针进入 iframe 后父文档连 pointermove 都收不到（单独用 pointer 事件不足以修复）"}`);

    // ═══ 结论判定 ═══
    log("\n===== 判定 =====");
    const leftMoved = afterLeft.leftWidth !== base.leftWidth;
    log(`1) 往左拖是否生效: ${leftMoved ? "是" : "否"}（左栏 ${base.leftWidth} → ${afterLeft.leftWidth}，store ${base.storeRatio} → ${afterLeft.storeRatio}）`);
    const rightMoved = afterRight.leftWidth !== afterLeft.leftWidth;
    log(`2) 往右拖是否生效（未打补丁）: ${rightMoved ? "是" : "否"}（左栏 ${afterLeft.leftWidth} → ${afterRight.leftWidth}，store ${afterLeft.storeRatio} → ${afterRight.storeRatio}）`);
    log(`   往右拖时父文档收到的 mousemove 次数=${gRight.received.moves}（发出 6 次），最远收到 x=${Math.max(...gRight.probe.moves.map((m) => m.x), -1)}，起点 x=${rightStart.x}`);
    log(`   往右拖每步 elementFromPoint: ${JSON.stringify(gRight.steps.filter((s) => s.under).map((s) => `${s.x}:${s.under}`))}`);
    log(`   往左拖时父文档收到的 mousemove 次数=${gLeft.received.moves}（发出 6 次）`);
    const rightMoved2 = afterRight2.leftWidth > gBack.after.leftWidth;
    log(`3) 打补丁(iframe pointer-events:none)后往右拖是否生效: ${rightMoved2 ? "是" : "否"}（左栏 ${gBack.after.leftWidth} → ${afterRight2.leftWidth}，store ${gBack.after.storeRatio} → ${afterRight2.storeRatio}）`);
    log(`   打补丁后往右拖父文档收到 mousemove=${gRight2.received.moves} 次，坐标 ${JSON.stringify(gRight2.probe.moves.map((m) => m.x))}`);

    // 存盘
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "v0140-probe-split-divider.txt"), lines.join("\n") + "\n");
    fs.writeFileSync(
      path.join(OUT_DIR, "v0140-probe-split-divider.json"),
      JSON.stringify({ env, base, gLeft, gRight, stuck, leak: { before: leakTest.before, after: leakAfter.after }, gBack, gRight2 }, null, 2),
    );
    console.log(`\n证据已写入 ${path.join(OUT_DIR, "v0140-probe-split-divider.txt")}`);
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
}

main().catch((e) => {
  console.error("探针异常:", e);
  process.exit(2);
});
