/**
 * Lead · **干净基线探针**：双击 Shift 开/关预览，两屏到底对齐吗？
 *
 * ## 为什么重写（前几版的教训，全部记下来避免重犯）
 * 1. **探针自己会污染测量**：`_lead-p4n-route.mjs` 里我先滚左屏再测右屏，
 *    但滚轮事件落在了错误的元素上/flush 时序不对，实测右屏 `scrollHeight=109386`
 *    （正常 26554）—— 那是探针把布局搞坏了，不是产品缺陷。
 * 2. **不能直接用 `scrollTop` 百分比比较**：左右 max 差近 2 倍（左 16453 / 右 25795），
 *    同一内容在两屏的百分比**本来就不相等**。
 * 3. **必须用"同一内容在两屏的相对位置"**：找一段**唯一文本**（如表格某行），
 *    在左屏算它相对视口顶的 Y，在右屏算同一文本相对视口顶的 Y。两者都≈某值 ⇒ 对齐。
 *
 * ## 本探针的口径（最严格）
 * 取**左屏视口中央**那一行的文本 → 在右屏找同一文本 → 比较它离右屏**中央**多远。
 * 理想 = 0（两屏中央是同一内容）。这是用户真正看到的东西。
 *
 * ## 关键防污染措施
 * - 滚左屏只用 `ui.wheel` 落在**左屏中心**（x=250，不是 1000）
 * - 每次测量前 `await sleep()` 足量，并等 scrollTop 稳定
 * - 每次切换预览后**重新等 3s** 让 realign 链跑完
 * - 不读取/不写入 iframe 内部任何状态（只读 `getBoundingClientRect`）
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const LABEL = process.env.P4_LABEL || "base";
const USER_DOC = process.env.P4_DOC || "D:\\10254\\桌面\\job plan\\明途知识产权-高级数据工程师-沟通场景表.md";

function fixture(n) {
  const out = ["# 干净基线", ""];
  for (let i = 1; i <= n; i++) {
    out.push(`第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`, "");
  }
  return out.join("\n");
}
const USING = fs.existsSync(USER_DOC);
const DOC = USING ? fs.readFileSync(USER_DOC, "utf8") : fixture(60);

/** 左屏：视口中央那一行的文本 + 它相对视口中央的偏移 */
const LEFT_CENTER = `
  const sc=document.querySelector(".cm-scroller"); if(!sc)return null;
  const R=sc.getBoundingClientRect(), h=sc.clientHeight;
  const midViewport = R.top + h/2;
  let best=null, bestD=1e9;
  for(const l of sc.querySelectorAll(".cm-line")){
    const t=(l.textContent||"").trim();
    if(!t || t.length<4) continue;
    const r=l.getBoundingClientRect();
    const c=(r.top+r.bottom)/2;
    const d=Math.abs(c-midViewport);
    if(d<bestD){bestD=d;best={text:t,deltaFromCenter:Math.round((c-midViewport)*10)/10,top:Math.round(r.top)};}
  }
  return {st:Math.round(sc.scrollTop),sh:sc.scrollHeight,ch:h,
    max:Math.round(sc.scrollHeight-h),w:sc.clientWidth,
    text: best?best.text:null, deltaFromCenter: best?best.deltaFromCenter:null};
`;

/**
 * 右屏：给定文本，找它在 iframe 内相对**视口中央**的偏移。
 *
 * ## 坐标口径（本轮踩过三次，最终校准）
 * iframe 内元素 `rect.top` = 内容坐标 − scrollTop = **相对 iframe 视口顶**。
 * 因此"相对视口中央"= `rect.top + rect.height/2 - clientHeight/2`。
 * 不要再用 scRect.top 参与运算（那会双重计入滚动偏移）。
 */
const RIGHT_CENTER = (text) => `
  const f=document.querySelector(".split-preview-shell iframe");
  const d=f&&f.contentDocument; if(!d)return null;
  const sc=d.scrollingElement||d.documentElement||d.body;
  const h=sc.clientHeight; if(!(h>0))return null;

  const BT=String.fromCharCode(96), STAR=String.fromCharCode(42);
  const norm=(s)=>{
    let t=(s||"");
    t=t.replace(new RegExp(BT+"[^"+BT+"]*"+BT,"g")," ");
    t=t.replace(new RegExp("["+STAR+"_~]{1,3}","g"),"");
    t=t.replace(new RegExp("\\\\|","g")," ");
    t=t.replace(new RegExp("^[ \\\\t]*(#{1,6}|>|[-+"+STAR+"])[ \\\\t]*","g"),"");
    t=t.replace(new RegExp("\\\\s+","g")," ");
    return t.trim();
  };
  // 取一个足够独特的中段片段（避开开头可能是列表符号/表格竖线）
  const full = norm(${JSON.stringify(text)});
  let needle = full.length >= 12 ? full.slice(0, 12) : full;
  needle = needle.split(" ").join("");
  if (!needle) needle = full;

  const LEAF=new Set(["P","H1","H2","H3","H4","H5","H6","LI","TD","TH","PRE","BLOCKQUOTE"]);
  let hit=null, hitText=null;
  for(const el of d.querySelectorAll("body *")){
    if(!LEAF.has(el.tagName)) continue;
    const ts=norm(el.textContent||"").split(" ").join("");
    if(ts && ts.indexOf(needle)>=0){hit=el;hitText=norm(el.textContent||"").slice(0,30);break;}
  }
  const max=Math.max(0,sc.scrollHeight-h);
  if(!hit) return {st:Math.round(sc.scrollTop),sh:sc.scrollHeight,ch:h,max:Math.round(max),
    w:sc.clientWidth,found:false,needle,deltaFromCenter:null,text:null,
    pct:max>0?Math.round(sc.scrollTop/max*1000)/1000:null};
  const r=hit.getBoundingClientRect();
  return {st:Math.round(sc.scrollTop),sh:sc.scrollHeight,ch:h,max:Math.round(max),
    w:sc.clientWidth,found:true,needle,hitText,
    // rect.top 已相对 iframe 视口；减掉半个视口 = 相对视口中央
    deltaFromCenter: Math.round((r.top + r.height/2 - h/2)*10)/10,
    pct:max>0?Math.round(sc.scrollTop/max*1000)/1000:null};
`;

await runBrowserProbe(
  { name: `lead-p4o-clean-${LABEL}`, doc: DOC, docTitle: USING ? "明途知识产权" : "干净基线" },
  async (ui) => {
    const LC = () => ui.ev(LEFT_CENTER);
    const RC = (t) => ui.ev(RIGHT_CENTER(t));
    const isOpen = () => ui.ev(`const s=document.querySelector(".split-preview-shell");return !!s&&s.getBoundingClientRect().width>40;`);
    const dblShift = async () => {
      for (let i = 0; i < 2; i++) {
        await ui.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
        await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
        await sleep(70);
      }
    };

    ui.log(`[p4o:${LABEL}] 文档=${USING ? "用户真实文档" : "夹具"} ${DOC.length}字符`);
    await ui.command("view.edit");
    await sleep(2600);

    // 规范化为"预览关闭"状态起测
    if (await isOpen()) { await dblShift(); await sleep(2400); }
    ui.log(`[p4o:${LABEL}] 规范化 open=${await isOpen()}`);

    /** 滚左屏到 frac —— 滚轮**落在左屏中心**，避免误触右屏/侧栏 */
    const scrollLeftTo = async (frac) => {
      for (let i = 0; i < 70; i++) {
        const c = await LC();
        if (!c || c.max <= 0) return c;
        const d = Math.round(c.max * frac) - c.st;
        if (Math.abs(d) < 35) break;
        // 预览关闭时左屏是全宽（517→1022），中心 x 用 500；稳妥取 400
        await ui.wheel(400, 500, Math.max(-800, Math.min(800, d)));
        await sleep(42);
      }
      await sleep(520);
      return await LC();
    };

    const rows = [];
    for (const frac of [0.3, 0.5, 0.7]) {
      const closed = await scrollLeftTo(frac);
      ui.log(`[p4o:${LABEL}] ── frac=${frac} 关闭态 左 st=${closed.st}/${closed.max} w=${closed.w} 中央="${(closed.text||"").slice(0,26)}"`);

      await dblShift();                 // 打开
      await sleep(3400);
      const open = await isOpen();
      const L = await LC();
      const R = await RC(L && L.text);

      const gapFromCenter = R && R.found ? R.deltaFromCenter : null;
      rows.push({ frac, closed, open, L, R, gapFromCenter });

      ui.log(`[p4o:${LABEL}]    打开=${open} 左 w=${L.w} 中央="${(L.text||"").slice(0,26)}"(偏移${L.deltaFromCenter})`);
      ui.log(`[p4o:${LABEL}]    右 w=${R && R.w} 命中=${R && R.found} 同一内容离右屏中央=${gapFromCenter}px  (右sh=${R && R.sh} max=${R && R.max})`);

      await dblShift();                 // 关回去
      await sleep(2400);
    }

    const gaps = rows.map((r) => r.gapFromCenter).filter((v) => typeof v === "number");
    const absGaps = gaps.map((v) => Math.abs(v));
    const worst = absGaps.length ? Math.max(...absGaps) : null;
    const avg = absGaps.length ? Math.round((absGaps.reduce((a, b) => a + b, 0) / absGaps.length) * 10) / 10 : null;
    const foundRate = rows.filter((r) => r.R && r.R.found).length;

    ui.log(`[p4o:${LABEL}] ===== 汇总 =====`);
    ui.log(`[p4o:${LABEL}] 命中率=${foundRate}/${rows.length}  |Δ中央| = ${JSON.stringify(absGaps)} 平均=${avg} 最差=${worst}`);
    ui.add("P4O-1", "★ 打开预览后，左屏中央那段内容也在右屏中央（|Δ| ≤ 120px）",
      worst !== null && worst <= 120 ? "PASS" : "FAIL",
      `各轮 |Δ|=${JSON.stringify(absGaps)}px 平均=${avg} 最差=${worst}；命中=${foundRate}/${rows.length}`);

    fs.writeFileSync(path.join("D:/AI/markdown view/lightmd/_verify-out", `lead-p4o-clean-${LABEL}.json`),
      JSON.stringify({ label: LABEL, using: USING, rows, absGaps, worst, avg }, null, 1), "utf8");
  },
);
