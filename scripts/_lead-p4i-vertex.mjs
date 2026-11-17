/**
 * Lead · 定位（第四层）：右屏落后 8~11 段，是**"视口顶对齐 vs 视口中央对齐"的错配**吗？
 *
 * ## 假设
 * 左→右同步的口径是：
 * ```
 * topLine = currentTopSourceLine()            // 左屏**视口顶**对应的源码行
 * next    = mapSourceLineToPreviewScroll(set, topLine, preview.clientHeight)
 * preview.scrollTop = next                    // 让右屏**视口顶**也落在该源码行
 * ```
 * 如果这个链路完全正确，那么"左屏视口顶那一行"与"右屏视口顶那一行"应该一致，
 * 于是**两屏中央也应该一致**（同一视口高 759）。
 *
 * 但如果映射表把 `top` 理解成"该块顶在内容中的位置"而不是"让块顶贴到视口顶所需的
 * scrollTop"，就会产生**恒定偏移** —— 而实测 Δ 全是正、且随深度增大（8→8→11），
 * 正符合"每段像素差 × 累积"的形态。
 *
 * ## 本探针直接对账三个量
 *   ① 左屏**视口顶**对应的源码行（用 PI 段近似：视口顶附近最近的 PI）
 *   ② 右屏**视口顶**对应的源码行
 *   ③ 两者的差 → 这才是映射的**系统误差**
 *
 * 与上一轮的"中央对中央"分开看：若"顶对顶差"≈"中央对中央差"，说明是整体平移；
 * 若"顶对顶"很小而"中央对中央"很大，说明是**视口高/块高尺度**问题。
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

function makeDoc(n) {
  const out = ["# 顶点对账", ""];
  for (let i = 1; i <= n; i++) {
    out.push(
      `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet ` +
        `consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
      "",
    );
  }
  return out.join("\n");
}
const DOC = makeDoc(60);

/** 一次采样：同时给出"视口顶的段"和"视口中央的段" */
const SAMPLE = (side) => side === "left" ? `
  const sc=document.querySelector(".cm-scroller"); if(!sc)return null;
  const scR=sc.getBoundingClientRect(), h=sc.clientHeight, st=sc.scrollTop;
  const midC=st+h/2;
  let piCenter=null,dc=1e9, piTopV=null,dt=1e9, piTopContent=null,dtt=1e9, firstPiTop=null;
  for(const l of sc.querySelectorAll(".cm-line")){const t=l.textContent||"";
    if(!/PI\\d{2}/.test(t))continue;
    const m=/PI(\\d{2})/.exec(t); const v=+m[1];
    const r=l.getBoundingClientRect();
    const viewportTop = r.top - scR.top;                 // 相对视口顶
    const c = viewportTop + r.height/2;
    const d1=Math.abs(c-midC); if(d1<dc){dc=d1;piCenter=v;}
    const d2=Math.abs(viewportTop);  if(d2<dt){dt=d2;piTopV=v;}            // 最靠近视口顶的行
    const d3=Math.abs(viewportTop-0); if(viewportTop>=0 && d3<dtt){dtt=d3;piTopContent=v;} // 视口内第一行
  }
  return {st:Math.round(st),sh:sc.scrollHeight,ch:h,max:Math.round(sc.scrollHeight-h),w:sc.clientWidth,
    piCenter, piTopV, piTopContent};
` : `
  const f=document.querySelector(".split-preview-shell iframe")||document.querySelector("iframe");
  const d=f&&f.contentDocument; if(!d)return null;
  const sc=d.scrollingElement||d.documentElement||d.body;
  const h=sc.clientHeight; if(!(h>0))return null;
  const st=sc.scrollTop, sh=sc.scrollHeight, max=Math.max(0,sh-h);
  const scTop=sc.getBoundingClientRect().top, midC=st+h/2;
  let piCenter=null,dc=1e9, piTopV=null,dt=1e9, piTopContent=null,dtt=1e9;
  for(const el of d.querySelectorAll("body *")){const t=el.textContent||"";
    if(!/PI\\d{2}/.test(t))continue; if(el.children.length>3)continue;
    const m=/PI(\\d{2})/.exec(t); const v=+m[1];
    const r=el.getBoundingClientRect();
    const ct = r.top - scTop;                            // 内容坐标
    const viewportTop = st>0 ? (ct - st) : ct;           // 转为相对视口顶
    const c = ct + r.height/2;
    const d1=Math.abs(c-midC); if(d1<dc){dc=d1;piCenter=v;}
    const d2=Math.abs(viewportTop); if(d2<dt){dt=d2;piTopV=v;}
    if(viewportTop>=0){const d3=viewportTop; if(d3<dtt){dtt=d3;piTopContent=v;}}
  }
  return {st:Math.round(st),sh,ch:h,max:Math.round(max),w:sc.clientWidth,
    piCenter, piTopV, piTopContent,
    pct:max>0?Math.round(st/max*1000)/1000:null, atBottom:max>0&&st>=max-2};
`;

await runBrowserProbe({ name: "lead-p4i-vertex", doc: DOC, docTitle: "顶点对账" }, async (ui) => {
  const L = () => ui.ev(SAMPLE("left"));
  const R = () => ui.ev(SAMPLE("right"));
  const isOpen = () => ui.ev(`const s=document.querySelector(".split-preview-shell");return !!s&&s.getBoundingClientRect().width>40;`);
  const dblShift = async () => {
    for (let i = 0; i < 2; i++) {
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
      await sleep(70);
    }
  };

  await ui.command("view.edit");
  await sleep(2400);
  if (await isOpen()) { await dblShift(); await sleep(2200); }

  const scrollLeftToPi = async (targetPi) => {
    for (let r = 0; r < 45; r++) {
      const cur = await L();
      if (!cur || cur.piCenter === null || cur.max <= 0) return cur;
      if (cur.piCenter === targetPi) return cur;
      const perPi = cur.max / 60;
      const delta = Math.max(-900, Math.min(900, Math.round((targetPi - cur.piCenter) * perPi)));
      if (delta === 0) return cur;
      await ui.wheel(1000, 500, delta);
      await sleep(55);
    }
    return await L();
  };

  const rows = [];
  for (const targetPi of [20, 40]) {
    await scrollLeftToPi(targetPi);
    await sleep(350);
    await dblShift();
    await sleep(3000);
    const l = await L();
    const r = await R();
    const dCenter = (l && r && l.piCenter !== null && r.piCenter !== null) ? (r.piCenter - l.piCenter) : null;
    const dTopV = (l && r && l.piTopV !== null && r.piTopV !== null) ? (r.piTopV - l.piTopV) : null;
    const dTopContent = (l && r && l.piTopContent !== null && r.piTopContent !== null) ? (r.piTopContent - l.piTopContent) : null;
    rows.push({ targetPi, l, r, dCenter, dTopV, dTopContent });
    ui.log(`[p4i] 目标PI${targetPi}`);
    ui.log(`[p4i]   左: 中央PI${l && l.piCenter} 顶点PI${l && l.piTopV} 首行PI${l && l.piTopContent} st=${l && l.st}/${l && l.max} w=${l && l.w}`);
    ui.log(`[p4i]   右: 中央PI${r && r.piCenter} 顶点PI${r && r.piTopV} 首行PI${r && r.piTopContent} st=${r && r.st}/${r && r.max} w=${r && r.w} atBottom=${r && r.atBottom}`);
    ui.log(`[p4i]   Δ中央=${dCenter}  Δ顶点=${dTopV}  Δ首行=${dTopContent}`);

    await dblShift();
    await sleep(2200);
  }

  ui.log(`[p4i] ===== 汇总 =====`);
  ui.log(`[p4i] Δ中央 = ${JSON.stringify(rows.map((x) => x.dCenter))}`);
  ui.log(`[p4i] Δ顶点 = ${JSON.stringify(rows.map((x) => x.dTopV))}`);
  ui.log(`[p4i] Δ首行 = ${JSON.stringify(rows.map((x) => x.dTopContent))}`);
  const sameSign = rows.every((x) => x.dCenter !== null && x.dTopV !== null && Math.sign(x.dCenter) === Math.sign(x.dTopV));
  ui.log(`[p4i] Δ中央与Δ顶点同向=${sameSign}  （同向 → 整体平移；异向 → 尺度问题）`);

  fs.writeFileSync(path.join("D:/AI/markdown view/lightmd/_verify-out", "lead-p4i-vertex.json"),
    JSON.stringify({ rows }, null, 1), "utf8");
});
