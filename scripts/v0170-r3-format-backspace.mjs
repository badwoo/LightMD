/**
 * v0.17.0 第三轮 · T2 · 第 4 项：**格式栏/语法栏插入格式后按退格 → 抖动或重置**
 *
 * 用户原话：「格式栏或语法栏插入某格式后按退格键删除实现了，但删除动作会导致页面抖动或重置。」
 *
 * 上一轮（R2 #7）修好了**功能**（ghost 活跃时退格整段删格式符，`SourcePane.tsx:1928-1958`
 * 的捕获阶段监听），但**没管滚动**。用户现在说的是：功能对了，按下去页面抖/重置。
 *
 * ## 量化口径（口径同 #1，但**主判据换成内容**——R2 教训 #6）
 * ⚠️ R2 的教训是："整篇替换后 scrollTop 本来就该变，判据必须是**内容**不变"。
 * 本项的删除确实会改变内容长度（`****` → 空），所以：
 *
 * | 量 | 定义 | 为什么代表用户感受 |
 * |---|---|---|
 * | `piStable` | 视口中心 PI 段号在整段操作前后是否**不变** | 用户说"重置"= 视野跑到别处；段号不变 = 没跑 |
 * | `piTopJump` | 视口中心锚块**屏幕 Y** 的单帧最大跳变 | 用户看到的"页面跳一下" |
 * | `stReversals` | scrollTop 位移方向反转次数 | 来回摆 = 抖 |
 * | `scrollWriters` | 期间 scrollTop 被写入的次数与调用栈 | 找"谁在写"（R2 的利器） |
 *
 * ## 场景
 * S1 滚到文档中部 → 点格式栏「粗体」（B）→ 不输入，直接 Backspace
 * S2 同上但用语法栏（若存在）
 * S3 破坏性对照：点按钮后**先输入几个字**再退格（此时 ghost 已失效，
 *    走 CM6 默认逐字符删除）—— 用于证明"抖动只在 ghost 路径上"
 *
 * 用法：
 *   BROWSER_PROBE_DIST=".../_verify-out/dist-t2" node scripts/v0170-r3-format-backspace.mjs
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc, INSTALL_SCROLL_SPY, wheelScrollToPercent } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);
const CM = ".cm-scroller";

const START_TRACE = (ms, anchorPi) => `
  window.__TR = [];
  (function () {
    const ANCHOR_PI = ${JSON.stringify(String(anchorPi))};
    const t0 = performance.now();
    const tick = () => {
      const sc = document.querySelector(${JSON.stringify(CM)});
      const rec = { t: Math.round(performance.now() - t0) };
      if (sc) {
        const scR = sc.getBoundingClientRect();
        rec.st = Math.round(sc.scrollTop * 100) / 100;
        rec.sh = Math.round(sc.scrollHeight);
        rec.max = Math.round(sc.scrollHeight - sc.clientHeight);
        const midY = scR.top + sc.clientHeight / 2;
        let best = null, bestD = Infinity;
        for (const l of sc.querySelectorAll(".cm-line")) {
          const txt = l.textContent || "";
          if (!/PI\\d{2}/.test(txt)) continue;
          if (ANCHOR_PI && txt.indexOf(ANCHOR_PI) < 0) continue;
          const r = l.getBoundingClientRect();
          const d = Math.abs((r.top + r.bottom) / 2 - midY);
          if (d < bestD) { bestD = d; best = l; }
        }
        if (best) {
          const m = /PI(\\d{2})/.exec(best.textContent || "");
          rec.pi = m ? Number(m[1]) : null;
          rec.piTop = Math.round((best.getBoundingClientRect().top - scR.top) * 100) / 100;
        }
        const cur = sc.querySelector(".cm-cursor");
        if (cur) rec.caretY = Math.round((cur.getBoundingClientRect().top - scR.top) * 100) / 100;
      }
      window.__TR.push(rec);
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

const READ = `
  const sc = document.querySelector(${JSON.stringify(CM)});
  if (!sc) return { ok: false };
  const scR = sc.getBoundingClientRect();
  const midY = scR.top + sc.clientHeight / 2;
  let best = null, bestD = Infinity;
  for (const l of sc.querySelectorAll(".cm-line")) {
    if (!/PI\\d{2}/.test(l.textContent || "")) continue;
    const r = l.getBoundingClientRect();
    const d = Math.abs((r.top + r.bottom) / 2 - midY);
    if (d < bestD) { bestD = d; best = l; }
  }
  const cur = sc.querySelector(".cm-cursor");
  const c = document.querySelector(".cm-content");
  let text = null;
  try { const v = c && c.cmTile && c.cmTile.view; if (v && v.state && v.state.doc) text = v.state.doc.toString(); } catch (e) {}
  return {
    ok: true,
    st: Math.round(sc.scrollTop * 100) / 100,
    sh: Math.round(sc.scrollHeight),
    max: Math.round(sc.scrollHeight - sc.clientHeight),
    pi: best ? Number((/PI\\d{2}/.exec(best.textContent || "") || [])[0].slice(2)) : null,
    piTop: best ? Math.round(best.getBoundingClientRect().top - scR.top) : null,
    caretY: cur ? Math.round(cur.getBoundingClientRect().top - scR.top) : null,
    textLen: text ? text.length : null,
    text,
  };
`;

function analyze(trace, field) {
  const seq = trace.map((s) => s[field]).filter((v) => typeof v === "number");
  if (seq.length < 2) return { n: seq.length, maxJump: 0, reversals: 0, net: 0 };
  const v = [];
  for (let i = 1; i < seq.length; i++) v.push(Math.round((seq[i] - seq[i - 1]) * 100) / 100);
  let maxJump = 0;
  const jumps = [];
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i]);
    if (a > maxJump) maxJump = a;
    if (a > 3) jumps.push({ frame: i + 1, t: trace[i + 1].t, from: seq[i], to: seq[i + 1], d: v[i] });
  }
  const runs = [];
  for (const x of v) { if (Math.abs(x) < 0.05) continue; const s = x > 0 ? 1 : -1; if (!runs.length || runs[runs.length - 1] !== s) runs.push(s); }
  return {
    n: seq.length, first: seq[0], last: seq[seq.length - 1],
    maxJump: Math.round(maxJump * 100) / 100,
    reversals: Math.max(0, runs.length - 1),
    net: Math.round((seq[seq.length - 1] - seq[0]) * 100) / 100,
    jumps: jumps.slice(0, 10), jumpsCount: jumps.length,
  };
}

await runBrowserProbe({ name: "v0170-r3-format-backspace", doc: DOC }, async (ui) => {
  ui.log("[setup] impl = " + ui.impl);
  if (ui.impl !== "cm6") {
    ui.add("A0", "源码面是 CM6", "FAIL", `impl=${ui.impl}`);
    return;
  }
  await ui.command("view.edit");
  await ui.sleep(2000);
  await ui.focusSource();
  await ui.sleep(300);

  const hasToolbar = await ui.ev(`
    const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
    return { n: btns.length, labels: btns.map(b => b.getAttribute("title") || b.textContent).slice(0, 30) };
  `);
  ui.add("A0", "格式工具栏存在", hasToolbar.n > 0 ? "PASS" : "FAIL", `按钮数=${hasToolbar.n} ${JSON.stringify(hasToolbar.labels.slice(0, 12))}`);

  /** 定位格式栏按钮（按 title 精确/包含匹配） */
  async function findBtn(title) {
    return await ui.ev(`
      const btns = Array.from(document.querySelectorAll(".source-format-toolbar .format-btn"));
      const b = btns.find(x => (x.getAttribute("title") || "").indexOf(${JSON.stringify(title)}) >= 0);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), title: b.getAttribute("title") };
    `);
  }

  /** 把光标放到视口中部某段（CM6：点该行的文字） */
  async function placeCaretAt(frac = 0.5) {
    const pt = await ui.ev(`
      const sc = document.querySelector(${JSON.stringify(CM)});
      const scR = sc.getBoundingClientRect();
      const y = scR.top + sc.clientHeight * ${frac};
      for (const l of sc.querySelectorAll(".cm-line")) {
        const r = l.getBoundingClientRect();
        if (r.top <= y && r.bottom >= y && (l.textContent || "").trim()) {
          return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    `);
    if (!pt) return null;
    await ui.click(pt.x, pt.y);
    await ui.sleep(450);
    return pt;
  }

  /**
   * 跑一个场景：滚到中部 → 放光标 → 点格式按钮 → (可选输入) → Backspace → 采样
   */
  async function scenario(name, { title, typeBeforeBackspace }) {
    await wheelScrollToPercent(ui, 0.45, CM, { step: 150, settle: 700 });
    await placeCaretAt(0.5);
    const before = await ui.ev(READ);
    if (!before.ok || before.st < 200) {
      ui.log(`[${name}] 基线无效 st=${before.st}，重滚`);
      await wheelScrollToPercent(ui, 0.45, CM, { step: 150, settle: 700 });
      await placeCaretAt(0.5);
    }
    const b2 = await ui.ev(READ);
    const btn = await findBtn(title);
    if (!btn) {
      ui.add(name, `${name}：找到按钮「${title}」`, "FAIL", "未找到");
      return null;
    }
    ui.log(`[${name}] 基线 = ${JSON.stringify({ st: b2.st, sh: b2.sh, pi: b2.pi, piTop: b2.piTop, textLen: b2.textLen })}`);
    ui.log(`[${name}] 按钮 = ${JSON.stringify(btn)}`);

    // 点按钮（这会插入格式符 + 显示 ghost）
    // ⚠️ hook 必须在**点按钮之前**装好：格式插入本身就是一次整篇替换事务，
    //    它会触发 CM6 heightMap 重估并改写 scrollTop —— 那正是用户"点完就抖"的一半。
    //    第一版把 clear 放在点击之后，导致点击阶段的写入全被漏掉（只有退格阶段可见）。
    await ui.ev(`window.__ST_WRITES = []; return true;`);
    await ui.click(btn.x, btn.y);
    await ui.sleep(700);
    const afterClick = await ui.ev(READ);
    ui.log(`[${name}] 点后 = ${JSON.stringify({ st: afterClick.st, sh: afterClick.sh, pi: afterClick.pi, piTop: afterClick.piTop, textLen: afterClick.textLen })}`);

    const clickWrites = await ui.ev(`
      return (window.__ST_WRITES || []).map(w => ({ v: w.v, from: w.from, how: w.how, s: (w.stack[1]||"") + " >> " + (w.stack[2]||"") }));
    `);
    ui.log(`[${name}] ★点击阶段 scrollTop 写入 ${clickWrites.length} 次：`);
    for (const w of clickWrites) ui.log(`   ${w.from}->${w.v} [${w.how}] ${w.s}`);

    if (typeBeforeBackspace) {
      await ui.key("x", "KeyX", 88);
      await ui.sleep(300);
    }

    // 开始逐帧采样，然后按 Backspace
    const anchorPi = "PI" + String(b2.pi ?? 1).padStart(2, "0");
    await ui.ev(`window.__ST_WRITES = []; return true;`);
    await ui.ev(START_TRACE(2200, anchorPi));
    await ui.sleep(80);
    const justBeforeBs = await ui.ev(READ);
    const clicksBeforeBs = await ui.ev(`
      return (window.__ST_WRITES || []).map(w => ({ v: w.v, from: w.from, how: w.how, s: (w.stack[1]||"") + " >> " + (w.stack[2]||"") }));
    `);
    await ui.key("Backspace", "Backspace", 8);
    await ui.sleep(2400);
    const trace = await ui.ev(`return window.__TR || []`);
    const after = await ui.ev(READ);
    const writes = await ui.ev(`
      return (window.__ST_WRITES || []).map(w => ({ v: w.v, from: w.from, how: w.how, s: (w.stack[1]||"") + " >> " + (w.stack[2]||"") }));
    `);

    const stA = analyze(trace, "st");
    const shA = analyze(trace, "sh");
    const piA = analyze(trace, "piTop");
    const caretA = analyze(trace, "caretY");
    const pis = trace.map((s) => s.pi).filter((v) => v != null);

    ui.log(`[${name}] st=${JSON.stringify(stA)}`);
    ui.log(`[${name}] piTop=${JSON.stringify(piA)}`);
    ui.log(`[${name}] caretY=${JSON.stringify(caretA)}`);
    ui.log(`[${name}] PI 轨迹=${JSON.stringify([...new Set(pis)])} 共${pis.length}帧`);
    ui.log(`[${name}] 退格前写入(${clicksBeforeBs.length})=${JSON.stringify(clicksBeforeBs.slice(0, 6))}`);
    ui.log(`[${name}] 全程写入(${writes.length})=${JSON.stringify(writes.slice(0, 8))}`);

    return {
      name, before: b2, afterClick, justBeforeBs, after, trace, writes,
      st: stA, pi: piA, caret: caretA, sh: shA, clickWrites,
      piSet: [...new Set(pis)],
      deleted: (justBeforeBs.textLen ?? 0) - (after.textLen ?? 0),
      clickDelta: { st: afterClick.st - b2.st, pi: afterClick.pi, piTop: afterClick.piTop },
    };
  }

  /* S1：格式栏「粗体」→ 不输入 → Backspace（用户描述的原始场景） */
  const s1 = await scenario("S1", { title: "粗体", typeBeforeBackspace: false });
  /* S2：语法栏（若与格式栏不同容器）—— 先用标题一，它走 heading 前缀路径 */
  const s2 = await scenario("S2", { title: "标题一", typeBeforeBackspace: false });
  /* S3：负对照——点按钮后先输入再退格（ghost 失效，走 CM6 默认逐字符删除） */
  const s3 = await scenario("S3", { title: "粗体", typeBeforeBackspace: true });

  /* ── 判据 ── */
  function judge(id, rec, opts) {
    if (!rec) { ui.add(id, "场景未跑到", "FAIL", "前置失败"); return; }
    const piStable = rec.piSet.length <= 1 || (rec.pi.first == null);
    const piJumpOk = rec.pi.maxJump <= 3;
    const stRevOk = rec.st.reversals === 0;
    const stJumpOk = rec.st.maxJump <= 3;
    const pass = opts.strict ? piStable && piJumpOk && stRevOk && stJumpOk : true;
    ui.add(id,
      opts.strict
        ? `${rec.name}：退格后视口中心**内容**不变（PI 不变、piTop 跳变≤3px、scrollTop 反转 0、单帧≤3px）`
        : `${rec.name}（负对照，记录用）`,
      opts.strict ? (pass ? "PASS" : "FAIL") : "KNOWN",
      `PI 轨迹=${JSON.stringify(rec.piSet)}（未变=${piStable}）；` +
      `piTop 单帧maxJump=${rec.pi.maxJump}px 反转=${rec.pi.reversals}；` +
      `scrollTop 单帧maxJump=${rec.st.maxJump}px 反转=${rec.st.reversals} 净=${rec.st.net}；` +
      `caretY maxJump=${rec.caret.maxJump}px；写入 ${rec.writes.length} 次；` +
      `scrollHeight ${rec.justBeforeBs.sh}→${rec.after.sh}；删除 ${rec.deleted} 字符`);
  }

  judge("B1", s1, { strict: true });
  judge("B2", s2, { strict: true });
  judge("B3", s3, { strict: false });

  ui.log("[SUMMARY] " + JSON.stringify({
    s1: s1 && { before: { st: s1.before.st, sh: s1.before.sh, pi: s1.before.pi }, afterClick: { st: s1.afterClick.st, pi: s1.afterClick.pi, piTop: s1.afterClick.piTop }, after: { st: s1.after.st, pi: s1.after.pi }, st: s1.st, pi: s1.pi, piSet: s1.piSet, deleted: s1.deleted, writes: s1.writes.slice(0, 8) },
    s2: s2 && { before: { st: s2.before.st, pi: s2.before.pi }, afterClick: { st: s2.afterClick.st, pi: s2.afterClick.pi }, st: s2.st, pi: s2.pi, piSet: s2.piSet, deleted: s2.deleted, writes: s2.writes.slice(0, 8) },
    s3: s3 && { st: s3.st, pi: s3.pi, piSet: s3.piSet, deleted: s3.deleted },
  }, null, 1));

  await ui.shot("format-backspace");
});
