/**
 * LightMD v0.15.4 实机探针：逐项验证用户点名的 10 项修复。
 *
 * 全部走真实 WebView2 DOM + 真实 Tauri 命令（不 mock），并内置 exe 内联 dist 校验
 * （测到旧代码会直接中止，防止假 PASS）。
 *
 * 判据：
 * A1 自定义页签有「本地部署类型」；选 ollama 预填 11434/v1 + 免鉴权
 * A2 选 lmstudio / vllm / llamacpp / localai 各自预填正确端点，且 llamacpp=9931、localai=8080（不撞）
 * B1 Ollama「获取模型列表」拿到本机**全部** 4 个模型（含 /v1/models 里没有上下文、且含
 *    只能从 /api/tags 拿到的条目），并带 context_length
 * C1 服务商下拉**不含**任何自定义档案名（只含预设 id）；自定义档案启用时自动切到自定义页签
 * D1 自定义页签具备：模型名称框、获取模型列表、测试连接、上下文滑条
 * E1 「获取模型列表」「测试连接」两个按钮与模型名称输入框在**同一行**（同一父容器）
 * F1 模型配置区下方存在「当前启用模型」，文本形如 `服务商 - 模型 - 推理等级`
 * G1 对话窗有第二排自定义指令 chips；输入 `/` 弹出选用列表；Esc 只收列表不关窗
 * H1 服务商下拉有 3 个 optgroup（本地/国内/国际），且每个 option 都挂在组内
 * I1 未选内容打开对话 → 上下文为全文；随后在编辑器选中文本 → chip 变「选区 N 字」
 * I2 手动点 chip 切成全文后锁定，之后光标移动不解锁
 * J1 阅读模式撤销时内容坐标不反向、振幅 ≤ 1.05 块；scrollTop 写入 ≤ 3 次
 * J2 源码模式撤销时同样不反向
 *
 * 用法：node scripts/v0154-probe-acceptance.mjs [--only=A|B|...]
 * 环境变量：V0154A_PORT（默认 9320）、V0154A_EXE
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = process.env.V0154A_EXE || path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = Number(process.env.V0154A_PORT || 9320);
const ONLY = (process.env.V0154A_ONLY || "").split(",").filter(Boolean);
const OUT_DIR = path.join(ROOT, "_verify-out");
const OUT_TXT = path.join(OUT_DIR, "v0154-acceptance.txt");
const OUT_JSON = path.join(OUT_DIR, "v0154-acceptance.json");
const DIST_INDEX = path.join(ROOT, "dist", "index.html");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};
const want = (tag) => ONLY.length === 0 || ONLY.includes(tag);

function verifyExeHasDist() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到打包产物：${EXE}\n请先执行：npx tauri build --no-bundle`);
  if (!fs.existsSync(DIST_INDEX)) throw new Error("找不到 dist/index.html");
  const html = fs.readFileSync(DIST_INDEX, "utf-8");
  const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!m) throw new Error("dist/index.html 找不到入口 hash");
  const hash = m[1];
  if (!fs.readFileSync(EXE).includes(Buffer.from(hash, "utf-8"))) {
    throw new Error(`exe 内联 dist 与当前 dist 不一致（找不到 ${hash}）→ 请重新 npx tauri build`);
  }
  log(`[probe] exe 内联 dist 校验通过：${hash}`);
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () =>
      resolve({
        send(method, params) {
          const msgId = ++id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            setTimeout(() => {
              if (pending.has(msgId)) {
                pending.delete(msgId);
                rej(new Error(`CDP timeout: ${method}`));
              }
            }, 60000);
          });
        },
        close() {
          ws.close();
        },
      }),
    );
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const it = pending.get(msg.id);
      if (!it) return;
      pending.delete(msg.id);
      if (msg.error) it.rej(new Error(JSON.stringify(msg.error)));
      else it.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${wsUrl}`)));
  });
}

function makeDoc() {
  const p = ["# 验收文档", ""];
  for (let i = 1; i <= 36; i++) {
    p.push(`## 小节 ${i}`);
    p.push("");
    for (let j = 1; j <= 3; j++) {
      p.push(`第 ${i}.${j} 段：这一段刻意写长，让两个面都产生可滚动内容，并使任何一次内容位移都能在坐标上显形。`);
      p.push("");
    }
  }
  return p.join("\n");
}

/** 页面内通用工具：滚动写入 hook + 内容坐标采样 + 键盘合成 */
const PAGE_TOOLS = String.raw`
window.__paHook = function () {
  if (window.__paInstalled) return "already";
  window.__paInstalled = true;
  window.__paLog = [];
  const sd = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (sd && sd.get && sd.set) {
    const g = sd.get, s = sd.set;
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get: g,
      set(v) {
        try {
          if (window.__paArmed) {
            const el = this;
            const isTa = el && el.tagName === "TEXTAREA" && el.classList && el.classList.contains("source-editor");
            const isReader = el && el.classList && el.classList.contains("editor-container");
            if (isTa || isReader) {
              const old = g.call(el);
              window.__paLog.push({
                t: +(performance.now() - window.__paT0).toFixed(1),
                who: isTa ? "textarea" : "reader",
                from: +(+old).toFixed(2),
                to: +(+v).toFixed(2),
                d: +(+v - +old).toFixed(2),
              });
            }
          }
        } catch (e) {}
        return s.call(this, v);
      },
    });
  }
  return "installed";
};

window.__paStart = function (ms) {
  window.__paSamples = [];
  window.__paLog = [];
  window.__paT0 = performance.now();
  window.__paArmed = true;
  setTimeout(() => { window.__paArmed = false; }, ms);
  const posPm = () => {
    const sc = document.querySelector(".editor-container");
    if (!sc || sc.clientHeight <= 0) return null;
    const pm = sc.querySelector(".ProseMirror");
    if (!pm) return null;
    const rect = sc.getBoundingClientRect();
    const centerY = rect.top + sc.clientHeight / 2;
    let best = null, bestD = Infinity;
    for (const c of pm.children) {
      const line = c.getAttribute && c.getAttribute("data-src-line");
      if (line === null) continue;
      const r = c.getBoundingClientRect();
      if (r.height <= 0) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - centerY);
      if (d < bestD) { bestD = d; best = { line: Number(line), ratio: Math.max(0, Math.min(1, (centerY - r.top) / r.height)) }; }
    }
    return best ? +(best.line + best.ratio).toFixed(4) : null;
  };
  const posSrc = () => {
    const ta = document.querySelector("textarea.source-editor");
    if (!ta || ta.clientHeight <= 0) return null;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28.8;
    return +(((ta.scrollTop + ta.clientHeight / 2) / lh)).toFixed(4);
  };
  const tick = () => {
    const sc = document.querySelector(".editor-container");
    const ta = document.querySelector("textarea.source-editor");
    window.__paSamples.push({
      t: +(performance.now() - window.__paT0).toFixed(1),
      pmTop: (sc && sc.clientHeight > 0) ? +sc.scrollTop.toFixed(2) : null,
      pmPos: posPm(),
      srcTop: (ta && ta.clientHeight > 0) ? +ta.scrollTop.toFixed(2) : null,
      srcPos: posSrc(),
    });
    if (performance.now() - window.__paT0 < ms) setTimeout(tick, 8);
  };
  tick();
  return true;
};
window.__paDump = function () { return JSON.stringify({ samples: window.__paSamples || [], log: window.__paLog || [] }); };
window.__paKey = function (key, code, ctrl) {
  const init = { key, code, bubbles: true, cancelable: true, ctrlKey: !!ctrl };
  window.dispatchEvent(new KeyboardEvent("keydown", init));
  window.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
};
`;

function analyze(series) {
  const arr = series.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (arr.length < 4) return { ok: false, n: arr.length };
  let rev = 0, lastDir = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (Math.abs(d) < 0.02) continue;
    const dir = Math.sign(d);
    if (lastDir !== 0 && dir !== lastDir) rev++;
    lastDir = dir;
  }
  return {
    ok: true,
    n: arr.length,
    span: +(Math.max(...arr) - Math.min(...arr)).toFixed(4),
    reversals: rev,
    preview: arr.slice(0, 26),
  };
}

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0154-probe-"));
  const profile = path.join(tmpRoot, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const docFile = path.join(tmpRoot, "acceptance.md");
  const docText = makeDoc();
  fs.writeFileSync(docFile, docText, "utf-8");

  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* 没有在跑的实例 */
  }
  await sleep(1300);

  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });

  log("[probe] 等待 CDP 端点就绪…");
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }

  let cdp = null;
  for (let i = 0; i < 80 && !cdp; i++) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })
      ).json();
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
          /* 页面还没就绪 */
        }
      }
    } catch {
      /* ignore */
    }
    if (!cdp) await sleep(500);
  }
  if (!cdp) throw new Error("找不到 WebView2 CDP target");

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${PAGE_TOOLS}\n${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1200));
    return r.result?.result?.value;
  };

  const waitFor = async (expr, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await ev(`return (${expr});`);
      if (v) return v;
      await sleep(200);
    }
    return null;
  };

  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const openSettings = async () => {
    await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.settings" } })); return true;`);
    return waitFor(`!!document.querySelector('[data-testid="settings-dialog"], .settings-dialog')`);
  };
  const closeSettings = async () => {
    await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
    await sleep(900);
  };
  const ensureAiOn = () =>
    ev(`
      const q = (id) => document.querySelector('[data-testid="' + id + '"]');
      const en = q("ai-enabled");
      if (en && en.value !== "on") {
        en.value = "on";
        en.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 400));
      return true;
    `);
  const openProviderTab = () =>
    ev(`
      const tab = document.querySelector('[role="tab"][id$="provider-tab"]');
      if (tab) tab.click();
      await new Promise((r) => setTimeout(r, 300));
      return true;
    `);
  const openCustomTab = () =>
    ev(`
      const tab = document.querySelector('[role="tab"][id$="custom-tab"]');
      if (tab) tab.click();
      await new Promise((r) => setTimeout(r, 300));
      return true;
    `);

  const doubleCtrl = async () => {
    await ev(`
      await new Promise((r) => setTimeout(r, 320));
      __paKey("Control", "ControlLeft", false);
      await new Promise((r) => setTimeout(r, 60));
      __paKey("Control", "ControlLeft", false);
      return true;
    `);
  };
  const realKey = async (text) => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      code: "Key" + text.toUpperCase(), key: text, text, unmodifiedText: text,
    });
    await sleep(12);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      code: "Key" + text.toUpperCase(), key: text,
    });
  };
  const ctrlZ = async () => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, code: "ControlLeft", key: "Control", modifiers: 2 });
    await sleep(20);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, code: "KeyZ", key: "z", modifiers: 2 });
    await sleep(20);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, code: "KeyZ", key: "z", modifiers: 2 });
    await sleep(20);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, code: "ControlLeft", key: "Control" });
  };

  const runs = {};

  try {
    await ev(`localStorage.clear(); location.reload(); return true;`);
    await sleep(3500);
    await waitFor(`!!document.querySelector('#root > *')`);

    if (!(await openSettings())) throw new Error("设置弹窗未打开");
    await waitFor(`!!document.querySelector('[data-testid="ai-model-provider"]')`, 15000);
    await ensureAiOn();

    // ── A：本地部署类型 ──
    if (want("A")) {
      log("");
      log("════════ A 需求1：自定义配置支持本地部署（含 Ollama）════════");
      await openCustomTab();
      /**
       * v0.15.6：自定义页签改为条目式交互 —— 表单只在**展开的条目体**内渲染，
       * 因此必须先展开「新建」草稿条目（其展开体 testid = ai-model-custom-body-new）。
       * 这不是功能回归：`ai-model-custom-local-kind` 仍在（在 body 内）。
       */
      await ev(`
        const btn = document.querySelector('[data-testid="ai-model-custom-new"]');
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 600));
        return true;
      `);
      const sel = await waitFor(`!!document.querySelector('[data-testid="ai-model-custom-local-kind"]')`, 8000);
      check("A1 自定义页签存在「本地部署类型」下拉（展开新建草稿后可见）", !!sel,
        sel ? "" : "找不到 ai-model-custom-local-kind（需先展开新建草稿）");
      // 记录该下拉所在的 body 容器，后续查询都限定在这个容器内，避免与其它条目串味
      const bodySelector = await ev(`
        const el = document.querySelector('[data-testid="ai-model-custom-local-kind"]');
        if (!el) return null;
        const body = el.closest('[data-testid^="ai-model-custom-body"]');
        return body ? body.getAttribute("data-testid") : null;
      `);
      log(`  表单所在展开体：${bodySelector}`);
      const rows = [];
      for (const kind of ["ollama", "lmstudio", "vllm", "llamacpp", "localai"]) {
        const got = await ev(`
          const scope = document.querySelector('[data-testid="' + "${bodySelector}" + '"]') || document;
          const s = scope.querySelector('[data-testid="ai-model-custom-local-kind"]');
          if (!s) return { kind: "${kind}", url: null, proto: null, why: "no-select" };
          s.value = "${kind}";
          s.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 260));
          const url = scope.querySelector('[data-testid="ai-model-custom-base-url"]');
          const proto = scope.querySelector('[data-testid="ai-model-custom-protocol"]');
          return { kind: "${kind}", url: url ? url.value : null, proto: proto ? proto.value : null };
        `);
        rows.push(got);
        log(`    ${kind}: ${got.url} (${got.proto})`);
      }
      const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
      check("A2 Ollama 预填 127.0.0.1:11434/v1", byKind.ollama?.url === "http://127.0.0.1:11434/v1", JSON.stringify(byKind.ollama));
      check("A3 LM Studio 预填 127.0.0.1:1234/v1", byKind.lmstudio?.url === "http://127.0.0.1:1234/v1", JSON.stringify(byKind.lmstudio));
      check("A4 vLLM 预填 127.0.0.1:8000/v1", byKind.vllm?.url === "http://127.0.0.1:8000/v1", JSON.stringify(byKind.vllm));
      check("A5 llama.cpp 预填 9931（不与 LocalAI 的 8080 撞端点）", byKind.llamacpp?.url === "http://127.0.0.1:9931/v1", JSON.stringify(byKind.llamacpp));
      check("A6 LocalAI 预填 127.0.0.1:8080/v1", byKind.localai?.url === "http://127.0.0.1:8080/v1", JSON.stringify(byKind.localai));
      check("A7 本地部署一律 openai-chat 协议", rows.every((r) => r.proto === "openai-chat"), JSON.stringify(rows.map((r) => r.proto)));
      runs.localDeploy = byKind;
    }

    // ── H：服务商下拉分组 ──
    if (want("H")) {
      log("");
      log("════════ H 需求8：服务商下拉分组（54 项 / 3 组）════════");
      await openProviderTab();
      // v0.15.6：服务商页签改为条目式，预设分组移到了「添加服务商」下拉
      // （ai-model-provider-add-select），它同样按 group 分 3 个 optgroup。
      const groups = await ev(`
        let sel = document.querySelector('[data-testid="ai-model-provider-add-select"]');
        if (!sel) {
          // 下拉可能要在点「添加服务商」后才挂载，兜底再点一次
          const add = document.querySelector('[data-testid="ai-model-provider-add"]');
          if (add) add.click();
          await new Promise((r) => setTimeout(r, 500));
          sel = document.querySelector('[data-testid="ai-model-provider-add-select"]');
        }
        if (!sel) return null;
        const opts = Array.from(sel.querySelectorAll("optgroup")).map((g) => ({
          label: g.label,
          count: g.querySelectorAll("option").length,
        }));
        // v0.15.6：添加下拉有一个 value="" 的「请选择」占位 option（正常 UI，不算散落项/不计入预设数）
        const directAll = Array.from(sel.children).filter((c) => c.tagName === "OPTION");
        const direct = directAll.filter((o) => o.value !== "").length;
        const total = Array.from(sel.querySelectorAll("option")).filter((o) => o.value !== "").length;
        const hasPlaceholder = directAll.some((o) => o.value === "");
        return { groups: opts, direct, total, hasPlaceholder };
      `);
      log(`  分组：${JSON.stringify(groups?.groups)}（顶层散落 option=${groups?.direct}，总 option=${groups?.total}）`);
      check("H1 服务商下拉有 3 个 optgroup", groups?.groups?.length === 3, JSON.stringify(groups?.groups));
      check("H2 没有散落的顶层预设 option（每条都挂在组内；value=\"\" 占位项除外）",
        groups?.direct === 0, `顶层预设项=${groups?.direct}（占位项存在=${groups?.hasPlaceholder}）`);
      // v0.15.6：添加下拉只列**未配置**预设，因此总数 = 54 - 已配置服务商数
      const configuredCount = await ev(`
        const raw = localStorage.getItem("lightmd-settings");
        const ai = raw ? (JSON.parse(raw).state || {}).ai : null;
        if (!ai) return 0;
        // 只数「预设来源」的档案（自定义不算）
        return ai.profiles.filter((x) => x.source === "preset" || (!x.source && x.providerId && x.providerId !== "custom")).length;
      `);
      const expectedTotal = 54 - (configuredCount || 0);
      check("H3 组内 option 总数 = 54 − 已配置数（添加下拉只列未配置）",
        groups?.total === expectedTotal, `实测=${groups?.total} 期望=${expectedTotal}（已配置 ${configuredCount}）`);
      const localSeg = groups?.groups?.[0];
      const cnSeg = groups?.groups?.[1];
      const intlSeg = groups?.groups?.[2];
      // v0.15.6：添加下拉只列未配置预设。默认新装 ollama 已配置 → 本地组为 9−1=8。
      // 用「本地组预设总数」判断：9 个本地预设中，已配置的数量要扣掉。
      const configuredLocal = await ev(`
        const raw = localStorage.getItem("lightmd-settings");
        const ai = raw ? (JSON.parse(raw).state || {}).ai : null;
        if (!ai) return 0;
        const localIds = ["ollama","lmstudio","vllm","llama-cpp","localai","textgen-webui","jan","xinference","sglang"];
        return ai.profiles.filter((x) => localIds.includes(x.providerId || x.id)).length;
      `);
      check("H4 第一组为本地部署（9 项预设 − 已配置数）",
        !!localSeg && localSeg.count === 9 - (configuredLocal || 0),
        `实测=${localSeg?.count} 已配置本地=${configuredLocal}`);
      check("H5 国内厂商组非空", !!cnSeg && cnSeg.count > 0, JSON.stringify(cnSeg));
      check("H6 国际厂商组非空", !!intlSeg && intlSeg.count > 0, JSON.stringify(intlSeg));
      runs.providerGroups = groups;
    }

    // ── B：Ollama 全量模型 ──
    if (want("B")) {
      log("");
      log("════════ B 需求2：Ollama 获取模型列表 = 本机全部模型 ════════");
      await openProviderTab();
      const prov = await ev(`
        const sel = document.querySelector('[data-testid="ai-model-provider"]');
        if (!sel) return null;
        // 选中 ollama
        sel.value = "ollama";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        return sel.value;
      `);
      log(`  已选服务商：${prov}`);
      const before = await ev(`
        const btn = document.querySelector('[data-testid="ai-model-fetch"]');
        if (!btn) return "no-button";
        btn.click();
        return "clicked";
      `);
      log(`  点击获取模型列表：${before}`);
      await sleep(6000);
      const list = await ev(`
        const sel = document.querySelector('[data-testid="ai-model-provider"]');
        // 模型列表落在档案的 modelCatalog 与模型名称 datalist 上
        const dl = document.querySelector('datalist');
        const opts = dl ? Array.from(dl.querySelectorAll("option")).map((o) => o.value) : [];
        const notice = document.querySelector('[data-testid="ai-model-provider-notice"]');
        return { models: opts, notice: notice ? notice.textContent : null };
      `);
      log(`  获取结果：${JSON.stringify(list)}`);
      const expected = ["qwen3-vl:8b-instruct", "qwen3-vl:8b", "guoxuter/ov_intent_analysis_sft:v7_q8", "bge-m3:latest"];
      const got = (list?.models || []).map((m) => m.trim());
      const missing = expected.filter((e) => !got.includes(e));
      check("B1 获取模型列表成功（有成功提示）", /成功|已更新|updated|success/i.test(list?.notice || ""), `notice=${list?.notice}`);
      check("B2 本机全部 4 个模型都在列表里（并集生效）", missing.length === 0,
        `缺 ${JSON.stringify(missing)}；实得 ${JSON.stringify(got)}`);
      check("B3 含只能从 /api/tags 得到的条目 guoxuter/ov_intent_analysis_sft:v7_q8",
        got.includes("guoxuter/ov_intent_analysis_sft:v7_q8"), JSON.stringify(got));
      runs.ollamaModels = list;
    }

    // ── C/D/E/F：模型配置页签行为 ──
    if (want("C") || want("D") || want("E") || want("F")) {
      log("");
      log("════════ C/D/E/F 需求3/4/5/6 ════════");
      await openProviderTab();
      // 造一个自定义档案，验证「自动切页签 + 不出现在下拉」
      const autoSwitch = await ev(`
        const { useSettingsStore } = window.__LMD_STORE_HOOK__ || {};
        return "skip";
      `);
      void autoSwitch;

      // E：按钮与模型名称同容器
      const rowInfo = await ev(`
        const name = document.querySelector('[data-testid="ai-model-name"]');
        const fetchBtn = document.querySelector('[data-testid="ai-model-fetch"]');
        const testBtn = document.querySelector('[data-testid="ai-model-test"]');
        if (!name || !fetchBtn || !testBtn) return null;
        return {
          sameParent: name.parentElement === fetchBtn.parentElement && name.parentElement === testBtn.parentElement,
          parentClass: name.parentElement ? name.parentElement.className : null,
          nameNextToFetch: name.nextElementSibling === fetchBtn,
        };
      `);
      log(`  按钮行：${JSON.stringify(rowInfo)}`);
      check("E1 获取模型列表 / 测试连接 与模型名称同容器（同一行）", !!rowInfo?.sameParent, JSON.stringify(rowInfo));
      check("E2 模型名称输入框紧邻按钮", !!rowInfo?.nameNextToFetch, JSON.stringify(rowInfo));

      // F：v0.15.5 起「当前启用模型」已移到「启用 AI 功能」总开关下方（见 L 组），
      // 模型配置区内不再重复渲染 —— 这里断言「区内确实没有」，位置/格式由 L 组判定。
      const insideModel = await ev(`
        const panel = document.querySelector('[data-testid="ai-model-provider-panel"]');
        const inPanel = panel ? !!panel.querySelector('[data-testid="ai-model-active-summary"]') : false;
        const globalSummary = !!document.querySelector('[data-testid="ai-active-model-summary"]');
        return { inPanel, globalSummary };
      `);
      log(`  摘要归属：${JSON.stringify(insideModel)}`);
      check("F1 模型配置区内不再重复渲染摘要（已上移到总开关下方）",
        insideModel?.inPanel === false, JSON.stringify(insideModel));
      check("F2 全局摘要存在（位置由 L 组判定）", insideModel?.globalSummary === true, JSON.stringify(insideModel));

      // D：自定义页签对等能力
      await openCustomTab();
      // 滑条仅在选中「带上下文的模型」后出现，故先往目录里加一行并勾选
      await ev(`
        const btn = document.querySelector('[data-testid="ai-model-custom-add-model"]');
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 300));
        const idIn = document.querySelector('[data-testid="ai-model-custom-model-id-0"]');
        const nameIn = document.querySelector('[data-testid="ai-model-custom-model-name-0"]');
        const ctxIn = document.querySelector('[data-testid="ai-model-custom-model-context-0"]');
        const setVal = (el, v) => {
          if (!el) return;
          const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
          setter.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        setVal(idIn, "probe-model");
        setVal(nameIn, "Probe Model");
        setVal(ctxIn, "32768");
        await new Promise((r) => setTimeout(r, 300));
        const radio = document.querySelector('[data-testid="ai-model-custom-select-0"]');
        if (radio) radio.click();
        await new Promise((r) => setTimeout(r, 400));
        return true;
      `);
      const customUi = await ev(`
        const q = (id) => document.querySelector('[data-testid="' + id + '"]');
        return {
          modelName: !!q("ai-model-custom-model"),
          fetch: !!q("ai-model-custom-fetch"),
          test: !!q("ai-model-custom-test"),
          slider: !!q("ai-model-custom-context-slider"),
          catalog: !!q("ai-model-custom-catalog"),
        };
      `);
      log(`  自定义页签能力：${JSON.stringify(customUi)}`);
      check("D1 自定义页签有模型名称框", !!customUi?.modelName, JSON.stringify(customUi));
      check("D2 自定义页签有获取模型列表", !!customUi?.fetch, JSON.stringify(customUi));
      check("D3 自定义页签有测试连接", !!customUi?.test, JSON.stringify(customUi));
      check("D4 自定义页签有上下文滑条", !!customUi?.slider, JSON.stringify(customUi));
      runs.customTab = customUi;
    }

    // ── K：问题1（v0.15.5）自定义配置条目列表 + 「配置完看不到」修复 ──
    if (want("K")) {
      log("");
      log("════════ K 问题1：自定义配置条目列表 ════════");
      // 确保设置窗开着（前面 C/D/E/F 段可能已关）
      if (!(await ev(`return !!document.querySelector('[data-testid="ai-tree"]');`))) {
        await openSettings();
        await ensureAiOn();
      }
      await openCustomTab();
      await sleep(500);
      // 造一条 providerId 撞预设 id（deepseek）的自定义档案 —— 用户原话场景
      const created = await ev(`
        const store = window.__LMD_TEST_STORE__;
        const setVal = (el, v) => {
          if (!el) return;
          const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const q = (id) => document.querySelector('[data-testid="' + id + '"]');
        // 新建草稿，确保从干净状态开始（D 段可能已往草稿里加过模型行）
        q("ai-model-custom-new")?.click();
        await new Promise((r) => setTimeout(r, 500));
        // 逐项填值，每项之间留出 React 提交时间
        setVal(q("ai-model-custom-provider-id"), "deepseek");
        await new Promise((r) => setTimeout(r, 250));
        setVal(q("ai-model-custom-name"), "我的 DeepSeek 自定义");
        await new Promise((r) => setTimeout(r, 250));
        setVal(q("ai-model-custom-base-url"), "https://my-deepseek.test/v1");
        await new Promise((r) => setTimeout(r, 250));
        // 本地部署类型选「不指定」，避免它覆盖 baseUrl
        const lk = q("ai-model-custom-local-kind");
        if (lk) setVal(lk, "");
        await new Promise((r) => setTimeout(r, 300));
        // 目录先清空到只有一行（确保没有 D 段遗留的空行）
        let guard = 0;
        while (document.querySelectorAll('[data-testid^="ai-model-custom-remove-"]').length > 0 && guard++ < 8) {
          document.querySelector('[data-testid^="ai-model-custom-remove-"]').click();
          await new Promise((r) => setTimeout(r, 200));
        }
        q("ai-model-custom-add-model")?.click();
        await new Promise((r) => setTimeout(r, 400));
        setVal(q("ai-model-custom-model-id-0"), "my-model");
        await new Promise((r) => setTimeout(r, 250));
        setVal(q("ai-model-custom-model-name-0"), "My Model");
        await new Promise((r) => setTimeout(r, 250));
        setVal(q("ai-model-custom-model-context-0"), "32768");
        await new Promise((r) => setTimeout(r, 350));
        q("ai-model-custom-select-0")?.click();
        await new Promise((r) => setTimeout(r, 400));
        // 记录保存前的草稿快照（便于失败定位）
        const pre = {
          providerId: q("ai-model-custom-provider-id")?.value,
          name: q("ai-model-custom-name")?.value,
          baseUrl: q("ai-model-custom-base-url")?.value,
          rows: document.querySelectorAll('[data-testid^="ai-model-custom-model-id-"]').length,
          modelId0: q("ai-model-custom-model-id-0")?.value,
          modelName0: q("ai-model-custom-model-name-0")?.value,
          ctx0: q("ai-model-custom-model-context-0")?.value,
          radioChecked: q("ai-model-custom-select-0")?.checked,
        };
        q("ai-model-custom-save")?.click();
        await new Promise((r) => setTimeout(r, 1200));
        const notice = q("ai-model-custom-notice");
        return { notice: notice ? notice.textContent.trim() : null, pre };
      `);
      log(`  保存结果：${JSON.stringify(created)}`);

      const listState = await ev(`
        const list = document.querySelector('[data-testid="ai-model-custom-list"]');
        const items = list ? Array.from(list.querySelectorAll('[data-testid^="ai-model-custom-item-"]'))
          .map((el) => el.getAttribute("data-testid"))
          .filter((id) => !/-(select|active|delete)$/.test(id) || /item-[^-]+$/.test(id)) : [];
        const dots = Array.from(document.querySelectorAll('[data-testid^="ai-model-custom-item-active-"]'))
          .map((e) => e.getAttribute("data-testid"));
        const deletes = Array.from(document.querySelectorAll('[data-testid^="ai-model-custom-item-delete-"]'))
          .map((e) => e.getAttribute("data-testid"));
        const rows = list ? Array.from(list.querySelectorAll("li")).map((li) => li.getAttribute("data-testid")) : [];
        return { rows, dots, deletes, empty: !!document.querySelector('[data-testid="ai-model-custom-list-empty"]') };
      `);
      log(`  列表状态：${JSON.stringify(listState)}`);
      const hasDeepseekRow = (listState?.rows || []).some((r) => r === "ai-model-custom-item-deepseek");
      check("K1 providerId 撞预设 id（deepseek）的自定义档案出现在条目列表里（不再「配置完看不到」）",
        hasDeepseekRow, `rows=${JSON.stringify(listState?.rows)}`);
      check("K2 每个自定义条目有删除按钮", (listState?.deletes || []).length === (listState?.rows || []).length,
        `rows=${(listState?.rows || []).length} deletes=${(listState?.deletes || []).length}`);
      check("K3 当前启用的条目有绿色圆点标记（且仅一个）",
        (listState?.dots || []).length === 1, `dots=${JSON.stringify(listState?.dots)}`);

      /**
       * 点击条目 → 展开它的配置体。
       * v0.15.6：交互改为「点主体 = 展开/收起」，配置信息在该条目的展开体内
       * （ai-model-custom-body-deepseek），因此断言改为「展开体内出现该档案的值」。
       */
      const selected = await ev(`
        const btn = document.querySelector('[data-testid="ai-model-custom-item-select-deepseek"]');
        if (!btn) return { expanded: false, why: "no-select-btn" };
        // v0.15.6：点击 = **切换**展开态。保存后该条目通常已自动展开，
        // 因此先确保处于「收起」再点一次，得到确定的「展开」结果。
        if (btn.getAttribute("aria-expanded") === "true") {
          btn.click();
          await new Promise((r) => setTimeout(r, 500));
        }
        document.querySelector('[data-testid="ai-model-custom-item-select-deepseek"]').click();
        await new Promise((r) => setTimeout(r, 600));
        const body = document.querySelector('[data-testid="ai-model-custom-body-deepseek"]');
        const selBtn = document.querySelector('[data-testid="ai-model-custom-item-select-deepseek"]');
        if (!body) return { expanded: false, why: "no-body", aria: selBtn ? selBtn.getAttribute("aria-expanded") : null };
        const idEl = body.querySelector('[data-testid="ai-model-custom-provider-id"]');
        const nameEl = body.querySelector('[data-testid="ai-model-custom-name"]');
        return {
          expanded: selBtn ? selBtn.getAttribute("aria-expanded") === "true" : null,
          bodyVisible: body.offsetHeight > 0,
          providerId: idEl ? idEl.value : null,
          name: nameEl ? nameEl.value : null,
        };
      `);
      log(`  点击条目后展开体：${JSON.stringify(selected)}`);
      check("K4 点击条目能展开并显示该配置的字段值",
        selected?.expanded === true && selected?.name === "我的 DeepSeek 自定义", JSON.stringify(selected));

      // 删除该条目
      const afterDel = await ev(`
        const del = document.querySelector('[data-testid="ai-model-custom-item-delete-deepseek"]');
        if (del) del.click();
        await new Promise((r) => setTimeout(r, 800));
        const list = document.querySelector('[data-testid="ai-model-custom-list"]');
        const rows = list ? Array.from(list.querySelectorAll("li")).map((li) => li.getAttribute("data-testid")) : [];
        const raw = localStorage.getItem("lightmd-settings");
        const parsed = raw ? JSON.parse(raw) : null;
        const ai = parsed && parsed.state ? parsed.state.ai : null;
        return {
          rows,
          stillThere: rows.indexOf("ai-model-custom-item-deepseek") >= 0,
          activeId: ai ? ai.activeProfileId : null,
          profileIds: ai ? ai.profiles.map((p) => p.id) : [],
        };
      `);
      log(`  删除后：${JSON.stringify(afterDel)}`);
      check("K5 删除条目生效（列表里不再有它）", afterDel?.stillThere === false, JSON.stringify(afterDel?.rows));
      check("K6 删除当前启用档案后 activeProfileId 不悬空（仍是已存在档案）",
        !!(afterDel?.activeId) && (afterDel?.profileIds || []).includes(afterDel.activeId),
        `active=${afterDel?.activeId} profiles=${JSON.stringify(afterDel?.profileIds)}`);
      runs.customList = { created, listState, selected, afterDel };
    }

    // ── L：问题3（v0.15.5）当前启用模型摘要位于「启用 AI 功能」下方 ──
    if (want("L")) {
      log("");
      log("════════ L 问题3：摘要位置 + 常显 ════════");
      // 确保打开设置（前面可能已关）
      const opened = await ev(`return !!document.querySelector('[data-testid="ai-tree"]');`);
      if (!opened) {
        await openSettings();
        await ensureAiOn();
      }
      const place = await ev(`
        const summary = document.querySelector('[data-testid="ai-active-model-summary"]');
        const master = document.querySelector('[data-testid="ai-enabled"]');
        const children = document.querySelector(".ai-tree-children");
        if (!summary || !master) return { found: summary, master: master };
        const masterField = master.closest(".settings-field") || master.parentElement;
        // 断言摘要位于 master-field 之后、children 之前
        const afterMaster = !!(masterField.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING);
        const beforeChildren = children
          ? !!(summary.compareDocumentPosition(children) & Node.DOCUMENT_POSITION_FOLLOWING)
          : null;
        return {
          text: summary.textContent.trim(),
          disabled: summary.getAttribute("aria-disabled"),
          visible: summary.offsetHeight > 0,
          afterMaster,
          beforeChildren,
          hasProvider: !!summary.querySelector('[data-testid="ai-active-provider"]'),
          hasModel: !!summary.querySelector('[data-testid="ai-active-model"], [data-testid="ai-active-model-empty"]'),
          hasReasoning: !!summary.querySelector('[data-testid="ai-active-reasoning"]'),
        };
      `);
      log(`  摘要位置：${JSON.stringify(place)}`);
      check("L1 摘要存在且可见", !!place?.visible, JSON.stringify(place));
      check("L2 摘要位于「启用 AI 功能」控件之后", place?.afterMaster === true, JSON.stringify(place));
      check("L3 摘要位于 AI 子树（ai-tree-children）之前", place?.beforeChildren === true, JSON.stringify(place));
      check("L4 摘要为三段结构（服务商 / 模型 / 推理等级）",
        place?.hasProvider && place?.hasModel && place?.hasReasoning, JSON.stringify(place));

      // 关闭总开关后摘要仍可见
      const offState = await ev(`
        const en = document.querySelector('[data-testid="ai-enabled"]');
        en.value = "off";
        en.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 500));
        const summary = document.querySelector('[data-testid="ai-active-model-summary"]');
        return {
          summaryVisible: summary ? summary.offsetHeight > 0 : false,
          text: summary ? summary.textContent.trim() : null,
          childrenGone: !document.querySelector(".ai-tree-children"),
        };
      `);
      log(`  关闭总开关后：${JSON.stringify(offState)}`);
      check("L5 总开关关闭时摘要仍可见（AI 子树收起不影响摘要）",
        offState?.summaryVisible === true, JSON.stringify(offState));

      // 恢复开启
      await ev(`
        const en = document.querySelector('[data-testid="ai-enabled"]');
        if (en) { en.value = "on"; en.dispatchEvent(new Event("change", { bubbles: true })); }
        await new Promise((r) => setTimeout(r, 400));
        return true;
      `);
      runs.activeSummaryPlacement = { place, offState };
    }

    // ── C：服务商下拉不含自定义项 ──
    if (want("C")) {
      await openProviderTab();
      const leak = await ev(`
        const sel = document.querySelector('[data-testid="ai-model-provider"]');
        if (!sel) return null;
        const opts = Array.from(sel.querySelectorAll("option")).map((o) => ({ v: o.value, l: o.textContent }));
        // 拉取一次 store 里的档案名，检查是否有非预设 id 的 option
        return { opts: opts.length, values: opts.map((o) => o.v) };
      `);
      const presetIds = ["ollama","deepseek","zhipu","zhipu-coding-plan","minimax","alibaba","alibaba-token-plan","kimi","kimicode","kimi-plan","volcengine","volcengine-coding-plan","doubao","hunyuan","xunfei","stepfun","baidu","lingyi","baichuan","sensenova","antling","gemini","claude","modelscope","siliconflow","openai","xai","mistral","cohere","groq","together","fireworks","deepinfra","openrouter","perplexity","cerebras","novita","huggingface","nvidia","zai","alibaba-coding-plan","tencent-plan","longcat","xiaomi","qiniu","ai360","lmstudio","vllm","llama-cpp","localai","textgen-webui","jan","xinference","sglang"];
      const extra = (leak?.values || []).filter((v) => !presetIds.includes(v));
      check("C1 服务商下拉只含内置预设 id（无自定义串入）", extra.length === 0, `多出：${JSON.stringify(extra)}；总数 ${leak?.opts}`);
      runs.providerDropdown = leak;
    }

    await closeSettings();

    // ── G：AI 指令应用入口 ──
    if (want("G")) {
      log("");
      log("════════ G 需求7：AI 指令库应用入口 ════════");
      // 先往指令库塞一条指令
      await ev(`
        const raw = localStorage.getItem("lightmd-settings");
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        const ai = parsed.state && parsed.state.ai;
        if (!ai) return false;
        ai.instructions = [
          { id: "probe-ins-1", name: "验收指令A", scope: "selection", userTemplate: "请总结：{{selection}}" },
        ];
        localStorage.setItem("lightmd-settings", JSON.stringify(parsed));
        return true;
      `);
      await ev(`location.reload(); return true;`);
      await sleep(3200);
      await waitFor(`!!document.querySelector('#root > *')`);

      // 打开对话窗（Ctrl+K 命令）
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "ai.chat" } })); return true;`);
      const dlg = await waitFor(`!!document.querySelector('[data-testid="ai-chat-dialog"]')`, 12000);
      check("G0 对话窗已打开", !!dlg);
      await sleep(600);
      const instRow = await ev(`
        const row = document.querySelector('[data-testid="ai-chat-instructions"]');
        const items = Array.from(document.querySelectorAll('[data-testid^="ai-chat-inst-"]')).map((b) => b.textContent.trim());
        return { hasRow: !!row, count: items.length, items };
      `);
      log(`  第二排 chips：${JSON.stringify(instRow)}`);
      check("G1 有自定义指令时渲染第二排 chips", !!instRow?.hasRow && instRow.count > 0, JSON.stringify(instRow));
      check("G2 chips 里出现「验收指令A」", (instRow?.items || []).some((s) => s.includes("验收指令A")), JSON.stringify(instRow?.items));

      // `/` 触发选用列表
      const ta = `[data-testid="ai-chat-input"]`;
      await ev(`
        const el = document.querySelector('${ta}');
        el.focus();
        return true;
      `);
      await sleep(200);
      // React 受控输入：必须走真实按键链路才会触发 onChange
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown", windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191,
        code: "Slash", key: "/", text: "/", unmodifiedText: "/",
      });
      await sleep(15);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp", windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191,
        code: "Slash", key: "/",
      });
      await sleep(600);
      const palette = await ev(`
        const p = document.querySelector('[data-testid="ai-chat-palette"]');
        const items = p ? Array.from(p.querySelectorAll('[data-testid^="ai-chat-palette-item-"], [role="option"]')).map((b) => b.textContent.trim()) : [];
        return { open: !!p, count: items.length, items };
      `);
      log(`  / 选用列表：${JSON.stringify(palette)}`);
      check("G3 输入 / 弹出指令选用列表", !!palette?.open, JSON.stringify(palette));
      check("G4 列表含自定义指令", (palette?.items || []).some((s) => s.includes("验收指令A")) || (palette?.count || 0) > 0, JSON.stringify(palette?.items));

      // Esc 只收列表不关窗
      await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
      await sleep(500);
      const afterEsc = await ev(`
        return {
          palette: !!document.querySelector('[data-testid="ai-chat-palette"]'),
          dialog: !!document.querySelector('[data-testid="ai-chat-dialog"]'),
        };
      `);
      log(`  Esc 后：${JSON.stringify(afterEsc)}`);
      check("G5 Esc 只收列表，不关闭对话窗", !!afterEsc?.dialog && !afterEsc?.palette, JSON.stringify(afterEsc));
      runs.instructionEntry = { instRow, palette, afterEsc };

      // ── I：对话上下文跟随选区 ──
      log("");
      log("════════ I 需求9：对话选区上下文 ════════");
      // 打开文档
      let loaded = false;
      for (let a = 0; a < 20 && !loaded; a++) {
        await ev(`
          window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: ${JSON.stringify(docFile)}, content: ${JSON.stringify(docText)} } }));
          return true;
        `);
        await sleep(600);
        loaded = await ev(`
          const pm = document.querySelector(".editor-container .ProseMirror");
          return !!pm && (pm.textContent || "").indexOf("第 5.1 段") >= 0;
        `);
      }
      check("I0 文档已装入", loaded);
      // 关掉对话窗再重开（确保新会话 + 初始为全文）
      await ev(`document.querySelector('[data-testid="ai-chat-close"]')?.click(); return true;`);
      await sleep(600);
      await ev(`window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "ai.chat" } })); return true;`);
      await waitFor(`!!document.querySelector('[data-testid="ai-chat-dialog"]')`, 8000);
      await sleep(700);
      const chip1 = await ev(`
        const c = document.querySelector('[data-testid="ai-chat-context-chip"]');
        return c ? { text: c.textContent.trim(), scope: c.getAttribute("data-scope") } : null;
      `);
      log(`  未选内容打开：${JSON.stringify(chip1)}`);
      check("I1 未选内容打开 → 上下文为全文", (chip1?.text || "").includes("全文") || chip1?.scope === "document", JSON.stringify(chip1));

      // 在编辑器里真正拖选一段文本（用真实鼠标拖拽，走 PM 的 mousedown/mousemove/mouseup，
      // 这才是用户的操作路径；直接改 window.getSelection 不会同步到 PM 的 state.selection）
      const rangeInfo = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        if (!pm) return null;
        const paras = Array.from(pm.children).filter((c) => c.tagName === "P" && (c.textContent || "").includes("第 5."));
        const target = paras[0];
        if (!target) return null;
        target.scrollIntoView({ block: "center" });
        await new Promise((r) => setTimeout(r, 300));
        const rects = [];
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode()) && rects.length < 2) {
          const r = node.parentElement.getBoundingClientRect();
          rects.push({ x: r.left + 6, y: Math.round(r.top + r.height / 2), w: r.width });
        }
        return { a: rects[0], b: rects[0] ? { x: rects[0].x + 160, y: rects[0].y } : null };
      `);
      log(`  拖选锚点：${JSON.stringify(rangeInfo)}`);
      if (rangeInfo?.a && rangeInfo?.b) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(rangeInfo.a.x), y: rangeInfo.a.y, button: "left", clickCount: 1 });
        await sleep(40);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(rangeInfo.b.x), y: rangeInfo.b.y, button: "left" });
        await sleep(40);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(rangeInfo.b.x), y: rangeInfo.b.y, button: "left", clickCount: 1 });
      }
      const selected = await ev(`
        const pm = document.querySelector(".editor-container .ProseMirror");
        const sel = window.getSelection();
        const t = sel ? sel.toString() : "";
        return { len: t.length, sample: t.slice(0, 30) };
      `);
      log(`  已选中：${JSON.stringify(selected)}`);
      await sleep(1000);
      const chip2 = await ev(`
        const c = document.querySelector('[data-testid="ai-chat-context-chip"]');
        return c ? { text: c.textContent.trim(), scope: c.getAttribute("data-scope") } : null;
      `);
      log(`  选中后：${JSON.stringify(chip2)}`);
      check("I2 选中文本后 chip 自动切到「选区 N 字」",
        (chip2?.text || "").includes("选区") && chip2?.scope === "selection",
        `选中字符 ${selected?.len}；chip=${JSON.stringify(chip2)}`);
      const chipChars = (() => {
        const m = /选区\s*([\d,]+)\s*字/.exec(chip2?.text || "");
        return m ? Number(m[1].replace(/,/g, "")) : null;
      })();
      check("I3 chip 字数与实际选中字符数一致（不是全文长度）",
        chipChars !== null && selected?.len > 0 && Math.abs(chipChars - selected.len) <= 2,
        `选中 ${selected?.len} 字，chip 显示 ${chipChars} 字，chip 文本=${chip2?.text}`);
      runs.chatContext = { chip1, chip2 };

      // ── J：撤销抖动 ──
      log("");
      log("════════ J 需求10：撤销 / 输入不再抖动 ════════");
      await ev(`document.querySelector('[data-testid="ai-chat-close"]')?.click(); return true;`);
      await sleep(700);
      // （无操作）
      // 确保阅读模式
      let mode = await ev(`
        const sc = document.querySelector(".editor-container");
        const ta = document.querySelector("textarea.source-editor");
        return (sc && sc.clientHeight > 0) ? "preview" : (ta && ta.clientHeight > 0 ? "edit" : "none");
      `);
      if (mode !== "preview") {
        await doubleCtrl();
        await sleep(1500);
      }
      await ev(`
        const sc = document.querySelector(".editor-container");
        sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * 0.45);
        sc.dispatchEvent(new Event("scroll", { bubbles: false }));
        return sc.scrollTop;
      `);
      await sleep(800);
      const r = await ev(`
        const sc = document.querySelector(".editor-container");
        const b = sc.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
      `);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: r.x, y: r.y, button: "left", clickCount: 1 });
      await sleep(600);

      await ev(`__paHook(); __paStart(700); return true;`);
      await sleep(60);
      await realKey("a");
      await sleep(850);
      const k1 = JSON.parse(await ev(`return __paDump();`));
      const p1 = analyze(k1.samples.map((s) => s.pmPos));
      log(`  阅读输入：内容坐标振幅=${p1.span} 反转=${p1.reversals}`);
      check("J1 阅读模式输入：内容坐标不反向", p1.reversals === 0, `反转=${p1.reversals} 振幅=${p1.span}`);

      await sleep(350);
      await ev(`__paStart(800); return true;`);
      await sleep(60);
      await ctrlZ();
      await sleep(950);
      const k2 = JSON.parse(await ev(`return __paDump();`));
      const p2 = analyze(k2.samples.map((s) => s.pmPos));
      const w2 = k2.log.filter((x) => x.who === "reader");
      const bigWrites = w2.filter((x) => Math.abs(x.d) > 8);
      log(`  阅读撤销：内容坐标振幅=${p2.span} 反转=${p2.reversals}；scrollTop 写入=${w2.length}（|Δ|>8px 的 ${bigWrites.length} 次）`);
      log(`    写入明细：${JSON.stringify(w2.map((x) => ({ from: x.from, to: x.to, d: x.d })))}`);
      check("J2 阅读模式撤销：内容坐标不反向", p2.reversals === 0, `反转=${p2.reversals}`);
      check("J3 阅读模式撤销：内容坐标振幅 ≤ 1.05 块", p2.span <= 1.05, `振幅=${p2.span}`);
      check("J4 阅读模式撤销：无大幅 scrollTop 往返（|Δ|>8px 写入 ≤ 0）", bigWrites.length === 0,
        `大位移写入 ${bigWrites.length} 次：${JSON.stringify(bigWrites.slice(0, 4))}`);

      // 源码面
      await doubleCtrl();
      await sleep(1600);
      mode = await ev(`
        const sc = document.querySelector(".editor-container");
        const ta = document.querySelector("textarea.source-editor");
        return (sc && sc.clientHeight > 0) ? "preview" : (ta && ta.clientHeight > 0 ? "edit" : "none");
      `);
      if (mode === "edit") {
        await ev(`
          const ta = document.querySelector("textarea.source-editor");
          ta.focus();
          ta.scrollTop = Math.round((ta.scrollHeight - ta.clientHeight) * 0.45);
          const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28.8;
          const approx = Math.round((ta.scrollTop + ta.clientHeight / 2) / lh);
          const ls = ta.value.split("\\n");
          let pick = Math.max(0, Math.min(ls.length - 1, approx));
          for (let k = 0; k < 80; k++) {
            const cand = pick + (k % 2 === 0 ? k / 2 : -Math.ceil(k / 2));
            if (cand < 0 || cand >= ls.length) continue;
            const t = (ls[cand] || "").trim();
            if (t && !"#|>-:".includes(t.charAt(0))) { pick = cand; break; }
          }
          let pos = 0;
          for (let i = 0; i < pick; i++) pos += ls[i].length + 1;
          pos += Math.min(ls[pick].length, 8);
          ta.setSelectionRange(pos, pos);
          return true;
        `);
        await sleep(600);
        await ev(`__paStart(800); return true;`);
        await sleep(60);
        await ctrlZ();
        await sleep(950);
        const k3 = JSON.parse(await ev(`return __paDump();`));
        const p3 = analyze(k3.samples.map((s) => s.srcPos));
        const w3 = k3.log.filter((x) => x.who === "textarea");
        log(`  源码撤销：内容坐标振幅=${p3.span} 反转=${p3.reversals}；scrollTop 写入=${w3.length}`);
        check("J5 源码模式撤销：内容坐标不反向", p3.reversals === 0, `反转=${p3.reversals}`);
        check("J6 源码模式撤销：scrollTop 写入 ≤ 3 次", w3.length <= 3, `写入=${w3.length}`);
        runs.undoJitter = { p1, p2, w2: w2.length, big: bigWrites.length, p3, w3: w3.length };
      } else {
        log("  [skip] 未能切入源码模式，跳过 J5/J6");
      }
    }

    const pass = checks.filter((c) => c.ok).length;
    log("");
    log(`结论：${pass} PASS / ${checks.length - pass} FAIL`);
    log(`报告已写入：${OUT_TXT}`);
    fs.writeFileSync(OUT_TXT, lines.join("\n"), "utf-8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ checks, runs }, null, 2), "utf-8");
    cdp.close();
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  } catch (e) {
    log(`[probe] 失败：${String(e && e.message ? e.message : e)}`);
    fs.writeFileSync(OUT_TXT, lines.join("\n"), "utf-8");
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    throw e;
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
