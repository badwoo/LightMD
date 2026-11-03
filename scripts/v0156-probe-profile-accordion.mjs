/**
 * LightMD v0.15.6 实机探针：条目式配置交互（自定义 + 服务商两个页签）。
 *
 * 用户要求（本次）：
 * 1. 「自定义模型配置，每进行了一个配置就对应一个条目，每点击一个条目都要能展开或收起它
 *    对应的配置信息，条目右边绿色亮点左边再增加一个启用或关闭按钮，用来启用某个条目。」
 * 2. 「服务商配置也改为一样的配置条目交互。」
 *
 * 用户补充口径（本次对话）：
 * 「点一下当前已启用的那条应该展开该条的配置信息，点击其他已配置的条目同理，
 *   但如果点击配置条目上的启用/关闭就是开启或关闭该条目」
 * → 点主体 = 只展开/收起；点按钮 = 只切换启用状态。
 *
 * 判据（全部在真机 WebView2 + 真实 Tauri store 上验证）：
 *   C1 自定义页签：每条配置对应一个条目；列表容器存在
 *   C2 点条目主体 → 展开该条配置体；再点一次 → 收起
 *   C3 同时只展开一条（点 B 后 A 自动收起）
 *   C4 点条目上的启用/关闭按钮 → 切换启用状态，**不影响展开状态**
 *   C5 绿点仅在启用条目上出现，且 DOM 顺序位于启用按钮之后（用户：绿点在按钮右边）
 *   C6 允许全部关闭：关掉唯一启用条目后 activeProfileId 为空，顶部摘要显示 none
 *   P1 服务商页签：只列已配置的服务商条目（不是 54 个预设全列）
 *   P2 点条目主体 → 展开/收起，同时只展开一条
 *   P3 服务商条目上的启用/关闭按钮独立于展开
 *   P4 服务商页签「添加服务商」：下拉只含未配置预设，选中后新增条目并自动展开
 *   P5 服务商展开条目编辑的是**该条目**（不是当前启用条目）
 *
 * 用法：node scripts/v0156-probe-profile-accordion.mjs [--only=C|P]
 * 环境变量：V0156A_PORT（默认 9340）、V0156A_EXE
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = process.env.V0156A_EXE || path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = Number(process.env.V0156A_PORT || 9340);
const ONLY = (process.env.V0156A_ONLY || "").split(",").filter(Boolean);
const OUT_DIR = path.join(ROOT, "_verify-out");
const OUT_TXT = path.join(OUT_DIR, "v0156-probe-profile-accordion.txt");
const OUT_JSON = path.join(OUT_DIR, "v0156-probe-profile-accordion.json");
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
  if (!fs.readFileSync(EXE).includes(Buffer.from(m[1], "utf-8"))) {
    throw new Error(`exe 内联 dist 与当前 dist 不一致（找不到 ${m[1]}）→ 请 npx tauri build --no-bundle`);
  }
  log(`[probe] exe 内联 dist 校验通过：${m[1]}`);
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

/** 页面内通用工具 */
const PAGE_TOOLS = String.raw`
window.__ppQ = function (testid) {
  return document.querySelector('[data-testid="' + testid + '"]');
};
/** 收集某页签列表里的条目 id（从 li 的 data-testid 反解） */
window.__ppItemIds = function (prefix) {
  const list = __ppQ(prefix + "-list");
  if (!list) return [];
  return Array.from(list.querySelectorAll("li")).map((li) => {
    const t = li.getAttribute("data-testid") || "";
    return t.slice((prefix + "-item-").length);
  });
};
/** 某条目的状态快照 */
window.__ppState = function (prefix, id) {
  const item = __ppQ(prefix + "-item-" + id);
  const sel = __ppQ(prefix + "-item-select-" + id);
  const toggle = __ppQ(prefix + "-item-toggle-" + id);
  const dot = __ppQ(prefix + "-item-active-" + id);
  const body = __ppQ(prefix + "-body-" + id);
  const del = __ppQ(prefix + "-item-delete-" + id);
  let dotAfterToggle = null;
  if (dot && toggle) {
    // DOCUMENT_POSITION_FOLLOWING → dot 在 toggle 之后
    dotAfterToggle = !!(toggle.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING);
  }
  return {
    hasItem: !!item,
    expanded: sel ? sel.getAttribute("aria-expanded") === "true" : null,
    bodyVisible: body ? body.offsetHeight > 0 : false,
    toggled: toggle ? toggle.getAttribute("aria-pressed") === "true" : null,
    hasDot: !!dot,
    dotAfterToggle,
    hasDelete: !!del,
  };
};
/** store 里当前启用档案 */
window.__ppActive = function () {
  const raw = localStorage.getItem("lightmd-settings");
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && p.state && p.state.ai ? p.state.ai.activeProfileId : null;
  } catch (e) { return "parse-error"; }
};
window.__ppProfileIds = function () {
  const raw = localStorage.getItem("lightmd-settings");
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    const ai = p && p.state ? p.state.ai : null;
    return ai ? ai.profiles.map((x) => x.id) : [];
  } catch (e) { return []; }
};
`;

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0156-"));
  const profile = path.join(tmpRoot, "profile");
  fs.mkdirSync(profile, { recursive: true });

  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
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
          /* ignore */
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
  const ensureAiOn = () =>
    ev(`
      const en = __ppQ("ai-enabled");
      if (en && en.value !== "on") {
        en.value = "on";
        en.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 500));
      return true;
    `);
  const openCustomTab = () =>
    ev(`
      const tab = document.querySelector('[role="tab"][id$="custom-tab"]');
      if (tab) tab.click();
      await new Promise((r) => setTimeout(r, 400));
      return true;
    `);
  const openProviderTab = () =>
    ev(`
      const tab = document.querySelector('[role="tab"][id$="provider-tab"]');
      if (tab) tab.click();
      await new Promise((r) => setTimeout(r, 400));
      return true;
    `);
  /** 点某元素 */
  const click = (testid) =>
    ev(`
      const el = __ppQ(${JSON.stringify(testid)});
      if (!el) return false;
      el.click();
      await new Promise((r) => setTimeout(r, 450));
      return true;
    `);
  const state = (prefix, id) =>
    ev(`return JSON.stringify(__ppState(${JSON.stringify(prefix)}, ${JSON.stringify(id)}));`).then((s) =>
      s ? JSON.parse(s) : null
    );
  const itemIds = (prefix) =>
    ev(`return JSON.stringify(__ppItemIds(${JSON.stringify(prefix)}));`).then((s) => (s ? JSON.parse(s) : []));
  const activeId = () => ev(`return __ppActive();`);
  const profileIds = () => ev(`return JSON.stringify(__ppProfileIds());`).then((s) => (s ? JSON.parse(s) : []));

  /** 造一条自定义档案（走 UI：新建 + 填值 + 保存） */
  const createCustom = async (providerId, displayName, modelId = "m1") => {
    const ok = await ev(`
      const setVal = (el, v) => {
        if (!el) return;
        const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      __ppQ("ai-model-custom-new")?.click();
      await new Promise((r) => setTimeout(r, 500));
      setVal(__ppQ("ai-model-custom-provider-id"), ${JSON.stringify(providerId)});
      await new Promise((r) => setTimeout(r, 250));
      setVal(__ppQ("ai-model-custom-name"), ${JSON.stringify(displayName)});
      await new Promise((r) => setTimeout(r, 250));
      setVal(__ppQ("ai-model-custom-base-url"), "https://probe.test/v1");
      await new Promise((r) => setTimeout(r, 250));
      // 清掉可能遗留的目录行
      let guard = 0;
      while (document.querySelectorAll('[data-testid^="ai-model-custom-remove-"]').length > 0 && guard++ < 8) {
        document.querySelector('[data-testid^="ai-model-custom-remove-"]').click();
        await new Promise((r) => setTimeout(r, 200));
      }
      __ppQ("ai-model-custom-add-model")?.click();
      await new Promise((r) => setTimeout(r, 400));
      setVal(__ppQ("ai-model-custom-model-id-0"), ${JSON.stringify(modelId)});
      await new Promise((r) => setTimeout(r, 250));
      setVal(__ppQ("ai-model-custom-model-name-0"), ${JSON.stringify(modelId.toUpperCase())});
      await new Promise((r) => setTimeout(r, 250));
      setVal(__ppQ("ai-model-custom-model-context-0"), "32768");
      await new Promise((r) => setTimeout(r, 350));
      __ppQ("ai-model-custom-select-0")?.click();
      await new Promise((r) => setTimeout(r, 400));
      __ppQ("ai-model-custom-save")?.click();
      await new Promise((r) => setTimeout(r, 1200));
      return __ppProfileIds();
    `);
    return ok;
  };

  try {
    await ev(`localStorage.clear(); location.reload(); return true;`);
    await sleep(3500);
    await waitFor(`!!document.querySelector('#root > *')`);
    if (!(await openSettings())) throw new Error("设置弹窗未打开");
    await waitFor(`!!__ppQ("ai-model-provider-panel") || !!__ppQ("ai-model-custom-panel")`, 15000);
    await ensureAiOn();

    // ══════════ 自定义页签 ══════════
    if (want("C")) {
      log("");
      log("════════ 自定义页签：条目 + 展开/收起 + 启用开关 ════════");
      await openCustomTab();
      await sleep(400);

      // 造两条自定义档案
      await createCustom("probe-alpha", "探针 Alpha", "alpha-m");
      await createCustom("probe-beta", "探针 Beta", "beta-m");
      const ids = await itemIds("ai-model-custom");
      log(`  自定义条目：${JSON.stringify(ids)}`);
      check("C1 每条自定义配置对应一个条目", ids.length >= 2, `条目数=${ids.length} ids=${JSON.stringify(ids)}`);

      const a = ids.find((x) => x === "probe-alpha");
      const b = ids.find((x) => x === "probe-beta");
      if (!a || !b) {
        check("C1b 能定位到两条测试条目", false, `缺 ${!a ? "probe-alpha" : ""} ${!b ? "probe-beta" : ""}`);
      } else {
        // C2：点主体展开 → 再点收起
        const s0 = await state("ai-model-custom", a);
        log(`  初始 Alpha：${JSON.stringify(s0)}`);
        await click(`ai-model-custom-item-select-${a}`);
        const s1 = await state("ai-model-custom", a);
        log(`  点主体后 Alpha：${JSON.stringify(s1)}`);
        check("C2a 点条目主体能展开该条配置体", s1?.expanded === true && s1?.bodyVisible === true,
          JSON.stringify(s1));
        await click(`ai-model-custom-item-select-${a}`);
        const s2 = await state("ai-model-custom", a);
        log(`  再点一次 Alpha：${JSON.stringify(s2)}`);
        check("C2b 再点条目主体能收起", s2?.expanded === false, JSON.stringify(s2));

        // C3：手风琴
        await click(`ai-model-custom-item-select-${a}`);
        const sa1 = await state("ai-model-custom", a);
        await click(`ai-model-custom-item-select-${b}`);
        const sa2 = await state("ai-model-custom", a);
        const sb2 = await state("ai-model-custom", b);
        log(`  展开 A→B 后：A=${JSON.stringify(sa2)} B=${JSON.stringify(sb2)}`);
        check("C3 同时只展开一条（点 B 后 A 自动收起）",
          sb2?.expanded === true && sa2?.expanded === false, `A=${sa2?.expanded} B=${sb2?.expanded}`);

        /**
         * C4：启用/关闭按钮独立于展开 —— **两个方向都要测**。
         *
         * ⚠️ 探针必须自己把状态归零，不能假设"当前是启用还是关闭"：
         * `createCustom` 保存时会自动启用该档案，所以此刻 Beta 很可能**已经是启用态**，
         * 那样"点 toggle" 执行的是**关闭**而不是启用。先把它**关闭**到已知状态，
         * 再测「关闭 → 启用」的方向，这样两个方向的语义都被覆盖。
         */
        // 归零：若 Beta 当前启用，先点一次关闭它
        const pre = await state("ai-model-custom", b);
        if (pre?.toggled) {
          await click(`ai-model-custom-item-toggle-${b}`);
          await sleep(450);
        }
        const offNow = await state("ai-model-custom", b);
        const actOff = await activeId();
        log(`  Beta 归零后：state=${JSON.stringify(offNow)} active=${JSON.stringify(actOff)}`);
        check("C4a 点已启用条目的启用/关闭按钮 → 关闭它（activeProfileId 置空、绿点消失）",
          offNow?.toggled === false && offNow?.hasDot === false && actOff === "",
          `state=${JSON.stringify(offNow)} active=${JSON.stringify(actOff)}`);

        const expBefore = offNow?.expanded;
        // 正向：点未启用条目的 toggle → 启用
        await click(`ai-model-custom-item-toggle-${b}`);
        await sleep(450);
        const afterToggle = await state("ai-model-custom", b);
        const act1 = await activeId();
        log(`  点 Beta 的启用按钮后：state=${JSON.stringify(afterToggle)} active=${act1}`);
        check("C4b 点未启用条目的启用/关闭按钮 → 启用它（绿点出现、activeProfileId 指向它）",
          afterToggle?.toggled === true && afterToggle?.hasDot === true && act1 === b,
          `state=${JSON.stringify(afterToggle)} active=${act1} 期望=${b}`);
        check("C4c 启用/关闭按钮不影响展开状态", afterToggle?.expanded === expBefore,
          `展开态 before=${expBefore} after=${afterToggle?.expanded}`);

        // C5：绿点在启用按钮右侧（在**启用态**下检查，否则绿点本就不存在）
        check("C5 绿点位于启用按钮之后（用户要求绿点在按钮右边）",
          afterToggle?.dotAfterToggle === true, JSON.stringify(afterToggle));

        // 切到 A 启用，B 应变未启用（同时只有一条启用）
        await click(`ai-model-custom-item-toggle-${a}`);
        await sleep(400);
        const aOn = await state("ai-model-custom", a);
        const bOff = await state("ai-model-custom", b);
        log(`  改启用 A 后：A=${JSON.stringify(aOn)} B=${JSON.stringify(bOff)}`);
        check("C4d 同时只有一条启用（改启用 A 后 B 自动未启用）",
          aOn?.toggled === true && aOn?.hasDot === true && bOff?.toggled === false && bOff?.hasDot === false,
          `A.toggled=${aOn?.toggled} A.dot=${aOn?.hasDot} B.toggled=${bOff?.toggled} B.dot=${bOff?.hasDot}`);

        // C6：全部关闭 → activeProfileId 置空，摘要显示 none
        await click(`ai-model-custom-item-toggle-${a}`);
        await sleep(600);
        const actNone = await activeId();
        const summaryNone = await ev(`
          const s = document.querySelector('[data-testid="ai-active-model-summary"]');
          const e = document.querySelector('[data-testid="ai-active-model-empty"]');
          return JSON.stringify({ hasSummary: !!s, hasEmpty: !!e, text: s ? s.textContent.trim() : null });
        `);
        log(`  全部关闭后：active=${JSON.stringify(actNone)} summary=${summaryNone}`);
        const summaryObj = JSON.parse(summaryNone || "null");
        check("C6a 允许全部关闭：activeProfileId 置空", actNone === "" || actNone === null, `active=${JSON.stringify(actNone)}`);
        check("C6b 全部关闭后顶部摘要显示「未启用」占位", summaryObj?.hasEmpty === true, summaryNone);
        // 恢复：重新启用 Beta 供后续检查
        await click(`ai-model-custom-item-toggle-${b}`);
        await sleep(400);
      }
    }

    // ══════════ 服务商页签 ══════════
    if (want("P")) {
      log("");
      log("════════ 服务商页签：条目 + 展开/收起 + 启用开关 + 添加 ════════");
      await openProviderTab();
      await sleep(500);
      const pids = await itemIds("ai-model-provider");
      const allProfiles = await profileIds();
      log(`  服务商条目：${JSON.stringify(pids)}（store 全部档案 ${JSON.stringify(allProfiles)}）`);
      check("P1 服务商页签只列已配置的服务商（是档案子集，不是 54 个预设全列）",
        pids.length > 0 && pids.length <= allProfiles.length && pids.length < 54,
        `条目=${pids.length} 档案=${allProfiles.length}`);

      // P4：添加服务商
      const addState = await ev(`
        const btn = __ppQ("ai-model-provider-add");
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 500));
        const sel = __ppQ("ai-model-provider-add-select");
        if (!sel) return JSON.stringify({ hasAdd: !!btn, hasSelect: false });
        const opts = Array.from(sel.querySelectorAll("option")).map((o) => o.value).filter((v) => v);
        const existing = __ppProfileIds();
        return JSON.stringify({
          hasAdd: !!btn,
          hasSelect: true,
          optionCount: opts.length,
          allUnconfigured: opts.every((v) => !existing.includes(v)),
          firstFew: opts.slice(0, 5),
        });
      `);
      log(`  添加服务商：${addState}`);
      const addObj = JSON.parse(addState || "null");
      check("P4a 服务商页签有「添加服务商」按钮与下拉", addObj?.hasAdd === true && addObj?.hasSelect === true, addState);
      check("P4b 添加下拉只含未配置的预设", addObj?.allUnconfigured === true,
        `optionCount=${addObj?.optionCount} firstFew=${JSON.stringify(addObj?.firstFew)}`);

      // 选第一个未配置预设 → 新增条目并自动展开
      const added = await ev(`
        const sel = __ppQ("ai-model-provider-add-select");
        if (!sel) return JSON.stringify({ ok: false, why: "no-select" });
        const opts = Array.from(sel.querySelectorAll("option")).map((o) => o.value).filter((v) => v);
        if (!opts.length) return JSON.stringify({ ok: false, why: "no-options" });
        const target = opts[0];
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, target);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 900));
        const before = __ppProfileIds();
        const ids = __ppItemIds("ai-model-provider");
        const created = ids.find((x) => !before.includes(x)) || target;
        const st = __ppState("ai-model-provider", created);
        const raw = localStorage.getItem("lightmd-settings");
        const ai = raw ? (JSON.parse(raw).state || {}).ai : null;
        const prof = ai ? ai.profiles.find((p) => p.id === created) : null;
        return JSON.stringify({
          ok: true, target, created, state: st,
          source: prof ? prof.source : null,
          providerId: prof ? prof.providerId : null,
        });
      `);
      log(`  添加结果：${added}`);
      const addRes = JSON.parse(added || "null");
      check("P4c 选择未配置预设后新增条目", !!addRes?.created, added);
      check("P4d 新增条目自动展开", addRes?.state?.expanded === true, JSON.stringify(addRes?.state));
      check("P4e 新增的服务商档案带 source:preset 标记", addRes?.source === "preset", `source=${addRes?.source}`);

      // P2/P3：新条目上的展开/收起与启用开关
      const newId = addRes?.created;
      if (newId) {
        await click(`ai-model-provider-item-select-${newId}`);
        const colState = await state("ai-model-provider", newId);
        log(`  收起新条目：${JSON.stringify(colState)}`);
        check("P2a 服务商条目点主体能收起", colState?.expanded === false, JSON.stringify(colState));
        await click(`ai-model-provider-item-select-${newId}`);
        const expState = await state("ai-model-provider", newId);
        check("P2b 服务商条目点主体能展开", expState?.expanded === true, JSON.stringify(expState));

        const beforeToggle = expState?.expanded;
        await click(`ai-model-provider-item-toggle-${newId}`);
        await sleep(400);
        const togState = await state("ai-model-provider", newId);
        const actNow = await activeId();
        log(`  启用新条目后：${JSON.stringify(togState)} active=${actNow}`);
        check("P3a 服务商条目启用按钮切换启用状态", togState?.toggled === true && togState?.hasDot === true,
          JSON.stringify(togState));
        check("P3b 启用不影响展开", togState?.expanded === beforeToggle,
          `before=${beforeToggle} after=${togState?.expanded}`);
        check("P3c 绿点在按钮右侧", togState?.dotAfterToggle === true, JSON.stringify(togState));

        /**
         * P5：展开条目编辑的是**该条目**，而不是当前启用条目。
         *
         * 关键：必须让「展开的条目」≠「启用的条目」，否则两种实现都会通过、测不出问题。
         * 做法：先把启用切到**另一个**已有档案（ollama），再展开 newId 编辑，
         * 然后断言 newId 的 baseUrl 被改、ollama 的 baseUrl **没被改**。
         */
        const otherActive = await ev(`
          // 找一个不是 newId 的档案 id（优先 ollama）
          const ids = __ppProfileIds();
          const cand = ids.indexOf("ollama") >= 0 ? "ollama" : ids.find((x) => x !== "${newId}");
          const tog = cand ? __ppQ("ai-model-provider-item-toggle-" + cand) : null;
          if (tog) {
            // 只有未启用时才点，避免把唯一启用项关掉
            if (tog.getAttribute("aria-pressed") !== "true") tog.click();
            await new Promise((r) => setTimeout(r, 600));
          }
          return JSON.stringify({ otherId: cand || null, active: __ppActive() });
        `);
        const otherObj = JSON.parse(otherActive || "null");
        log(`  把启用切到别的条目：${otherActive}`);

        // 现在展开 newId（若已展开则先收起再展开，保证状态确定）
        const expNow = await state("ai-model-provider", newId);
        if (!expNow?.expanded) {
          await click(`ai-model-provider-item-select-${newId}`);
        }
        const editCheck = await ev(`
          const body = __ppQ("ai-model-provider-body-${newId}");
          if (!body) return JSON.stringify({ ok: false, why: "no-body" });
          const urlInput = body.querySelector('[data-testid^="ai-model-base-url"]');
          if (!urlInput) return JSON.stringify({ ok: false, why: "no-url-input" });
          const before = urlInput.value;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(urlInput, "https://probe-edited.test/v1");
          urlInput.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 700));
          const raw = localStorage.getItem("lightmd-settings");
          const ai = raw ? (JSON.parse(raw).state || {}).ai : null;
          const target = ai ? ai.profiles.find((p) => p.id === "${newId}") : null;
          const active = ai ? ai.profiles.find((p) => p.id === ai.activeProfileId) : null;
          return JSON.stringify({
            ok: true, before,
            savedBaseUrl: target ? target.baseUrl : null,
            activeId: ai ? ai.activeProfileId : null,
            activeBaseUrl: active ? active.baseUrl : null,
            expandedIsNotActive: ai ? ai.activeProfileId !== "${newId}" : null,
          });
        `);
        log(`  展开条目编辑归属：${editCheck}`);
        const editObj = JSON.parse(editCheck || "null");
        check("P5a 前置条件成立：展开的条目 != 当前启用条目",
          editObj?.expandedIsNotActive === true,
          `展开=${newId} 启用=${editObj?.activeId}`);
        check("P5b 展开的条目表单编辑的是该条目本身的档案字段",
          editObj?.savedBaseUrl === "https://probe-edited.test/v1", editCheck);
        check("P5c 当前启用条目的档案**没有**被误改",
          editObj?.activeBaseUrl !== "https://probe-edited.test/v1", editCheck);
      }
    }

    const pass = checks.filter((c) => c.ok).length;
    log("");
    log(`结论：${pass} PASS / ${checks.length - pass} FAIL`);
    log(`报告已写入：${OUT_TXT}`);
    fs.writeFileSync(OUT_TXT, lines.join("\n"), "utf-8");
    fs.writeFileSync(OUT_JSON, JSON.stringify({ checks }, null, 2), "utf-8");
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
