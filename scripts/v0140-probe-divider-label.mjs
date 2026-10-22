/**
 * 探针：分割线上「关闭预览」竖排小字的 hover 可见性 / 可点击性实测。
 * 目的：先确认 CSS :hover 在 WebView2 里真的生效，再决定测试与实现怎么改。
 * 用法：node scripts/v0140-probe-divider-label.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";

const EXE = "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0140_PROBE_PORT || 9271);

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
      });
  });
}

const main = async () => {
  const tmp = fs.mkdtempSync("D:\\AI\\markdown view\\_verify-out\\probe-");
  const f = `${tmp}\\probe.md`;
  fs.writeFileSync(f, "# 标题\n\n正文。\n");
  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {}
  await sleep(1200);
  const child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
  });
  let cdp = null;
  try {
    for (let i = 0; i < 40 && !cdp; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        for (const t of list) {
          if (t.type !== "page" || !t.webSocketDebuggerUrl) continue;
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
        }
      } catch {}
      if (!cdp) await sleep(500);
    }
    if (!cdp) throw new Error("no target");
    await cdp.send("Page.enable");

    const ev = async (body) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => { ${body} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result?.result?.value;
    };
    const mouse = (type, x, y, opts = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, ...opts });
    const click = async (x, y) => {
      await mouse("mousePressed", x, y, { button: "left", clickCount: 1, buttons: 1 });
      await mouse("mouseReleased", x, y, { button: "left", clickCount: 1, buttons: 0 });
      await sleep(400);
    };

    await ev(`window.dispatchEvent(new CustomEvent("lightmd:open-path",{detail:{path:${JSON.stringify(f)}}})); return 1;`);
    await sleep(1400);
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:"view.edit"}})); return 1;`);
    await sleep(900);

    const geom = await ev(`
      const d = document.querySelector(".split-divider");
      const lb = document.querySelector(".split-divider-label");
      const sh = document.querySelector(".split-preview-shell");
      const r1 = d?.getBoundingClientRect(), r2 = lb?.getBoundingClientRect(), r3 = sh?.getBoundingClientRect();
      return {
        divider: r1 && { x: r1.left + r1.width/2, y: r1.top + r1.height/2, w: r1.width, h: r1.height },
        label: r2 && { x: r2.left + r2.width/2, y: r2.top + r2.height/2, w: r2.width, h: r2.height, left: r2.left },
        shell: r3 && { x: r3.left + r3.width/2, y: r3.top + r3.height/2, w: r3.width },
        labelText: lb?.textContent?.trim(),
      };
    `);
    console.log("几何:", JSON.stringify(geom, null, 2));

    const state = (tag) =>
      ev(`
        const lb = document.querySelector(".split-divider-label");
        const d = document.querySelector(".split-divider");
        const cs = lb && getComputedStyle(lb);
        return {
          tag: ${JSON.stringify(tag)},
          dividerHover: d ? d.matches(":hover") : null,
          labelHover: lb ? lb.matches(":hover") : null,
          opacity: cs ? Number(cs.opacity) : null,
          pointerEvents: cs ? cs.pointerEvents : null,
          animation: cs ? cs.animationName : null,
          under: (() => { const el = document.elementFromPoint(${geom.divider.x}, ${geom.divider.y}); return el ? el.className || el.tagName : null; })(),
        };
      `);

    console.log("初始:", JSON.stringify(await state("initial")));

    // 1) 鼠标移到分割条中心
    await mouse("mouseMoved", geom.divider.x, geom.divider.y);
    await sleep(600);
    console.log("移到分割条:", JSON.stringify(await state("hover-divider")));

    // 2) 鼠标移到右屏正中（验证 :has 规则）
    await mouse("mouseMoved", geom.shell.x, geom.shell.y);
    await sleep(600);
    console.log("移到右屏:", JSON.stringify(await state("hover-shell")));

    // 3) 回到分割条并点击（真实用户手势序列：先移入再按下）
    await mouse("mouseMoved", geom.divider.x, geom.divider.y);
    await sleep(400);
    await click(geom.divider.x, geom.divider.y);
    const afterClick = await ev(`
      const lb = document.querySelector(".split-divider-label");
      const sh = document.querySelector(".split-preview-shell");
      return { labelText: lb?.textContent?.trim(), shellW: sh ? Math.round(sh.getBoundingClientRect().width) : -1 };
    `);
    console.log("点击分割条后:", JSON.stringify(afterClick));

    // 4) 若未关闭，再移到右屏 hover 后再点 label 元素矩形中心
    const lbRect = await ev(`
      const lb = document.querySelector(".split-divider-label");
      if (!lb) return null;
      const r = lb.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height };
    `);
    console.log("label 矩形:", JSON.stringify(lbRect));
    if (lbRect) {
      await mouse("mouseMoved", lbRect.x, lbRect.y);
      await sleep(500);
      console.log("hover label 中心:", JSON.stringify(await state("hover-label")));
      await click(lbRect.x, lbRect.y);
      const after2 = await ev(`
        const lb = document.querySelector(".split-divider-label");
        const sh = document.querySelector(".split-preview-shell");
        return { labelText: lb?.textContent?.trim(), shellW: sh ? Math.round(sh.getBoundingClientRect().width) : -1 };
      `);
      console.log("点 label 后:", JSON.stringify(after2));
    }
  } finally {
    try { cdp?.close(); } catch {}
    try { child.kill(); } catch {}
    try { execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" }); } catch {}
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
