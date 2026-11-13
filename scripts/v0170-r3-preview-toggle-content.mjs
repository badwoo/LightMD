/**
 * #12 终极判据：开合期间**视口中心的内容（PI 段号）**是否稳定？
 *
 * 为什么这才是"抖不抖"的正确主判据：
 * 宽度 517→1022 时正文列从 397 变 822，每段软换行数从 3 变 1~2 →
 * `scrollHeight` **必然**减少上千 px（实测 3 次跃变共 -1037px）。
 * 这是内容真实重排，**任何实现都必须消化它** —— 纠结"scrollTop 跳了几 px"会
 * 把正常重排误判成缺陷（R2 的"像素 Δ 不是判据"教训 #6 在 #12 上同样适用）。
 *
 * 用户真正看到的是：**屏幕正中那段文字有没有被换成别的段落**。
 * 所以主判据 = 开合全程 `PI` 段号的极差（应 ≤1~2 段）。
 * 次判据 = 该段的屏幕 Y 是否有大的来回摆（方向反转）。
 */
import { runBrowserProbe } from "./_lib/browser-probe.mjs";
import { makeDoc } from "./v0170-r3-jitter-lib.mjs";

const DOC = makeDoc(60);
const CM = ".cm-scroller";

const TRACE = (ms) => `
  window.__X = [];
  (function () {
    const t0 = performance.now();
    const tick = () => {
      const sc = document.querySelector(${JSON.stringify(CM)});
      const rec = { t: Math.round(performance.now()-t0) };
      if (sc) {
        const scR = sc.getBoundingClientRect();
        rec.st = Math.round(sc.scrollTop*100)/100;
        rec.sh = Math.round(sc.scrollHeight);
        const midY = scR.top + sc.clientHeight/2;
        let best = null, bestD = Infinity;
        for (const l of sc.querySelectorAll(".cm-line")) {
          const txt = l.textContent || "";
          if (!/PI\\d{2}/.test(txt)) continue;
          const r = l.getBoundingClientRect();
          const d = Math.abs((r.top+r.bottom)/2 - midY);
          if (d < bestD) { bestD = d; best = l; }
        }
        if (best) {
          const m = /PI(\\d{2})/.exec(best.textContent || "");
          rec.pi = m ? Number(m[1]) : null;
          rec.piTop = Math.round((best.getBoundingClientRect().top - scR.top)*100)/100;
        }
      }
      window.__X.push(rec);
      if (performance.now()-t0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
  return true;
`;

function stat(tr, field) {
  const s = tr.map(x=>x[field]).filter(v=>typeof v==="number");
  if (s.length<2) return {n:s.length};
  let maxJ=0, rev=0, prev=0;
  for (let i=1;i<s.length;i++){
    const d=s[i]-s[i-1];
    if (Math.abs(d)>maxJ) maxJ=Math.abs(d);
    if (Math.abs(d)>=0.05){ const sg=d>0?1:-1; if(prev!==0&&sg!==prev) rev++; prev=sg; }
  }
  return { n:s.length, first:s[0], last:s[s.length-1], min:Math.min(...s), max:Math.max(...s),
           net:Math.round((s[s.length-1]-s[0])*100)/100, maxJump:Math.round(maxJ*100)/100, reversals:rev };
}

await runBrowserProbe({ name: "v0170-r3-toggle-content", doc: DOC }, async (ui) => {
  await ui.command("view.edit");
  await ui.sleep(2200);
  await ui.focusSource();
  for (let i=0;i<40;i++){ await ui.wheel(300,500,120); await ui.sleep(12); }
  await ui.sleep(700);

  async function phase(dir) {
    const isOpen = await ui.ev(`const s=document.querySelector(".split-preview-shell"); return s?s.classList.contains("split-preview-open"):null;`);
    const want = dir === "open";
    if (isOpen !== want) { await ui.command("view.togglePreview"); await ui.sleep(1500); }
    const before = await ui.ev(`
      const sc=document.querySelector(${JSON.stringify(CM)});
      return { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight) };
    `);
    await ui.ev(TRACE(1600));
    await ui.sleep(70);
    await ui.command("view.togglePreview");
    await ui.sleep(1900);
    const tr = await ui.ev(`return window.__X||[]`);
    const after = await ui.ev(`
      const sc=document.querySelector(${JSON.stringify(CM)});
      return { st: Math.round(sc.scrollTop), sh: Math.round(sc.scrollHeight) };
    `);
    const pis = tr.map(x=>x.pi).filter(v=>v!=null);
    const piRange = pis.length ? Math.max(...pis)-Math.min(...pis) : null;
    const uniq = [...new Set(pis)];
    const r = {
      dir, before, after,
      st: stat(tr,"st"), piTop: stat(tr,"piTop"),
      piRange, piUniq: uniq, piN: pis.length,
      shChanges: (() => { const c=[]; for(let i=1;i<tr.length;i++) if(tr[i].sh!==tr[i-1].sh) c.push({t:tr[i].t,d:tr[i].sh-tr[i-1].sh}); return c; })(),
    };
    ui.log(`[${dir}] st ${before.st}→${after.st}（净${r.st.net}px，单帧max ${r.st.maxJump}px，反转${r.st.reversals}）`);
    ui.log(`[${dir}] sh ${before.sh}→${after.sh}；跃变 ${r.shChanges.length} 次: ${JSON.stringify(r.shChanges.slice(0,6))}`);
    ui.log(`[${dir}] ★ 视口中心 PI: 极差=${piRange} 取值=${JSON.stringify(uniq)}（${pis.length}帧）`);
    ui.log(`[${dir}] piTop: 净${r.piTop.net}px 单帧max ${r.piTop.maxJump}px 反转 ${r.piTop.reversals}`);
    return r;
  }

  const O = await phase("open");
  const C = await phase("close");

  const ok = (r) => r.piRange != null && r.piRange <= 2;
  ui.add("A1", "★ 打开预览：视口中心内容不跑到别的段落（PI 极差 ≤2）",
    ok(O) ? "PASS" : "FAIL",
    `PI 极差=${O.piRange}（取值 ${JSON.stringify(O.piUniq)}）；` +
    `scrollHeight 跃变 ${O.shChanges.length} 次；scrollTop 单帧 max=${O.st.maxJump}px 反转=${O.st.reversals}`);
  ui.add("A2", "★ 关闭预览：视口中心内容不跑到别的段落（PI 极差 ≤2）",
    ok(C) ? "PASS" : "FAIL",
    `PI 极差=${C.piRange}（取值 ${JSON.stringify(C.piUniq)}）；` +
    `scrollHeight 跃变 ${C.shChanges.length} 次；scrollTop 单帧 max=${C.st.maxJump}px 反转=${C.st.reversals}`);
  ui.add("A3", "两个方向 PI 都稳定（内容锚判据的总判定）",
    ok(O) && ok(C) ? "PASS" : "FAIL",
    `打开极差=${O.piRange} 关闭极差=${C.piRange}`);

  ui.add("B1", "开合确实重排了（scrollHeight 有变化，否则判据恒真）",
    Math.abs(O.after.sh - O.before.sh) > 200 || Math.abs(C.after.sh - C.before.sh) > 200 ? "PASS" : "FAIL",
    `打开 ${O.before.sh}→${O.after.sh}；关闭 ${C.before.sh}→${C.after.sh}`);

  ui.log("[SUMMARY] " + JSON.stringify({ O, C }, null, 1));
  await ui.shot("toggle-content");
});
