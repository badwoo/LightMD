/**
 * Lead · 决定性实验：**开合预览后 vs 鼠标滚动后**，两屏对齐状态是否不同？
 *
 * 用户原话（本轮最关键的一句）：
 * > 「双击shift开关，右屏会比左屏超前好几段内容，**但通过鼠标滚动文档，
 * >  左右屏文档又慢慢对齐了**」
 *
 * 这句话包含一个强约束：**同一份文档、同一套映射，滚动就能对齐，开合就不行**。
 * 于是问题不在"映射算法错了"（否则滚动也对不齐），而在
 * **"开合这条路径用的输入是错的 / 用的时点是错的"**。
 *
 * ## 本探针的设计（单变量：只改"是否滚动过"）
 * ```
 * ① 关预览 → 左屏滚到某段 → 双击 Shift 打开预览
 * ② 立刻测：Δ顶(视口顶段号差) / Δ中(视口中央段号差)
 * ③ 极小幅度滚动左屏（一档滚轮，只改变少量内容，不改变"大概位置"）
 * ④ 再测：Δ顶 / Δ中
 * ```
 * 若 ③ 之后 Δ 明显变小 ⇒ 证实"滚动路径能自愈、开合路径不能"，
 * 修复目标就变成：**开合后要像滚动那样再驱动一次正确的同步**。
 *
 * ## 判据口径（关键：本项目设计口径是"视口顶对齐"）
 * `blockScrollAlign.ts` 文件头明确写：
 * > 「找到左屏视口顶部对应的源码行 → 找到该行所属的顶层块在右侧的元素
 * >  → 把该元素对齐到右侧视口顶部」
 * 所以 **Δ顶 是设计口径内的判据**；Δ中 只作旁证
 * （源码段高 ≈122px、渲染段高 ≈86px，"顶对齐"时中部必然不同步，这是物理事实）。
 *
 * 用法：
 *   $env:BROWSER_PROBE_DIST="<dist>"
 *   $env:P4_DOC="D:/10254/桌面/job plan/明途知识产权-高级数据工程师-沟通场景表.md"
 *   node scripts/_lead-p4j-rollvs-toggle.mjs
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { runBrowserProbe, sleep } from "./_lib/browser-probe.mjs";

const LABEL = process.env.P4_LABEL || "unlabeled";
const USER_DOC = process.env.P4_DOC || "D:\\10254\\桌面\\job plan\\明途知识产权-高级数据工程师-沟通场景表.md";

function fixture(n) {
  const out = ["# 滚动vs开合 夹具", ""];
  for (let i = 1; i <= n; i++) {
    out.push(
      `第 ${i} 段。段落编号 PI${String(i).padStart(2, "0")} 供定位。Lorem ipsum dolor sit amet ` +
        `consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
      "",
    );
  }
  return out.join("\n");
}
const USING_USER = fs.existsSync(USER_DOC);
const DOC = USING_USER ? fs.readFileSync(USER_DOC, "utf8") : fixture(60);

/**
 * 通用采样：视口顶段 / 视口中央段。
 *
 * ⚠️ 两边的"段标识"必须用**同一套可比较的锚**。用户文档没有 PIxx 标记，
 * 所以用**元素文本前 12 字**做指纹（左屏用 CM6 行文本，右屏用块文本）。
 * 为保证可比：先取左屏视口顶行文本 → 在右屏按该文本前缀查找对应块 → 得到右屏
 * 「同一内容」在视口里的相对位置。这样即使没有标记也能算"是否对齐"。
 */
const LEFT_SAMPLE = `
  const sc=document.querySelector(".cm-scroller"); if(!sc)return null;
  const scR=sc.getBoundingClientRect(), h=sc.clientHeight, st=sc.scrollTop;
  const midC = st + h/2;
  const rows=[];
  for(const l of sc.querySelectorAll(".cm-line")){
    const t=(l.textContent||"").trim();
    if(!t) continue;
    const r=l.getBoundingClientRect();
    rows.push({ text:t.slice(0,24), viewportTop: Math.round((r.top-scR.top)*10)/10,
      h: Math.round(r.height*10)/10, center: Math.round(((r.top-scR.top)+r.height/2)*10)/10 });
  }
  // 视口顶：第一个 viewportTop >= 0 的行
  const topRow = rows.filter(r=>r.viewportTop>=0).sort((a,b)=>a.viewportTop-b.viewportTop)[0] || null;
  // 中央：center 最接近 h/2 的行
  let midRow=null,md=1e9;
  for(const r of rows){const d=Math.abs(r.center-h/2); if(d<md){md=d;midRow=r;}}
  return {st:Math.round(st),sh:sc.scrollHeight,ch:h,max:Math.round(sc.scrollHeight-h),
    w:sc.clientWidth, topText: topRow?topRow.text:null, midText: midRow?midRow.text:null,
    topViewportY: topRow?topRow.viewportTop:null, midViewportY: midRow?midRow.center:null,
    lineCount: rows.length};
`;

/**
 * 右屏：给定"要找的文本"，回报它在右屏视口里的**相对 Y**。
 *
 * ## ⚠️ 三个必须记住的坑（本探针前两版全踩了，逐条记下来）
 *
 * **坑1：iframe 内元素的 `rect.top` 是「内容坐标 − scrollTop」**
 * 实测（`scripts/_tmp-geom.mjs`，用户文档滚到 st=9078）：
 * ```
 * scRect.top  = -9078          ← 根元素随滚动整体上移
 * body.rect.top = -9078
 * H1.rect.top = -9000          ← 已含 -scrollTop
 * ```
 * 所以 `relY = r.top - scRect.top` 才是"相对视口顶"（H1 → -9000-(-9078) = 78 ✓）。
 * 我上一版写成 `r.top - scRect.top` 时结果 8197，是因为 **relY 用的 found 元素不对**
 * （见坑3），而不是公式错。
 *
 * **坑2：前缀匹配必须剥 markdown 标记**
 * 左屏是源码（`**约面话术**：`、`| 9 | ...`），右屏是渲染文本（`约面话术：`）。
 * 不剥标记 → 第一个字符就不同 → score=0，挑到的元素完全无关。
 *
 * **坑3：不能按"最长前缀"挑元素，要按"内容命中"**
 * 多个块共享相同开头（如 `生成时间：` 在 BLOCKQUOTE 与 P 里都出现），
 * 取最高分可能选中嵌套容器。改为：**先算 needle 的稳定前缀（≥8 字），
 * 在"叶子级块元素"（P/H1-6/LI/TD/PRE）里找包含它的第一个**，并用
 * 「内容坐标」验证它落在合理范围内。
 */
const RIGHT_FIND = (text) => `
  const f=document.querySelector(".split-preview-shell iframe")||document.querySelector("iframe");
  const d=f&&f.contentDocument; if(!d)return null;
  const sc=d.scrollingElement||d.documentElement||d.body;
  const h=sc.clientHeight; if(!(h>0))return null;
  const st=sc.scrollTop, sh=sc.scrollHeight, max=Math.max(0,sh-h);
  const scTop=sc.getBoundingClientRect().top;

  /**
   * 剥掉常见 markdown 标记，得到可比对的可见文本。
   * 用字符码构造正则，避免模板字符串里反斜杠层层转义出错（本轮踩过两次）。
   */
  const BT = String.fromCharCode(96);
  const star = String.fromCharCode(42);
  const strip = (s) => {
    let t = s || "";
    t = t.replace(new RegExp("^" + BT + "{3}[^" + BT + "]*" + BT + "{3}", "g"), " ");
    t = t.replace(new RegExp(BT + "[^" + BT + "]*" + BT, "g"), " ");
    t = t.replace(new RegExp("^[ \\t]*#{1,6}[ \\t]+"), " ");
    t = t.replace(new RegExp("^[ \\t]*>" + "[ \\t]?"), " ");
    t = t.replace(new RegExp("^[ \\t]*[-+" + star + "][ \\t]+\\[[ xX]\\][ \\t]+"), " ");
    t = t.replace(new RegExp("^[ \\t]*[-+" + star + "][ \\t]+"), " ");
    t = t.replace(new RegExp("^[ \\t]*[0-9]+\\.[ \\t]+"), " ");
    t = t.replace(new RegExp("[" + star + "_~]{1,3}", "g"), " ");
    t = t.replace(new RegExp("\\|", "g"), " ");
    t = t.replace(new RegExp("\\s+", "g"), " ");
    return t.trim();
  };

  const rawNeedle = strip(${JSON.stringify(text)});
  // 稳定前缀：取前 10 个非空白字符（太短容易误命中，太长易受排版差异影响）
  let needle = rawNeedle.split(" ").join("").slice(0, 10);
  if (!needle) return { ok:false, why:"empty-needle", rawNeedle };

  // 只取叶子级块元素，避免选中嵌套容器
  const LEAF = new Set(["P","H1","H2","H3","H4","H5","H6","LI","TD","TH","PRE","BLOCKQUOTE","FIGCAPTION","DT","DD"]);
  let found=null, foundText=null;
  for (const el of d.querySelectorAll("body *")) {
    if (!LEAF.has(el.tagName)) continue;
    const ts = strip(el.textContent || "").split(" ").join("");
    if (!ts) continue;
    if (ts.indexOf(needle) >= 0) { found = el; foundText = ts.slice(0,28); break; }
  }
  if (!found) {
    // 退化：任意元素包含即可
    for (const el of d.querySelectorAll("body *")) {
      const ts = strip(el.textContent || "").split(" ").join("");
      if (ts && ts.indexOf(needle) >= 0) { found = el; foundText = ts.slice(0,28); break; }
    }
  }
  let relY=null, relCenter=null, height=null, contentTop=null;
  if(found){
    const r=found.getBoundingClientRect();
    /**
     * 坑1 的最终答案（实测校准）
     *
     * iframe 内元素 r.top 已经是相对视口顶，不要再减 scTop：
     *   st=9078  scRect.top=-9078  H1.rect.top=-9000
     *   H1 内容坐标 = -9000 + 9078 = 78      （第一个元素在内容顶附近，正确）
     *   H1 相对视口顶 = 78 - 9078 = -9000 = r.top
     * 即 r.top === contentTop - scrollTop。
     * 前几版分别写成 r.top - scTop（得 contentTop，错）和 r.top - scTop - st
     * （双重减，错），才读出 8197 / -8737 这类不可能的数值。
     * 正确写法就是 relY = r.top。
     */
    relY=Math.round(r.top*10)/10;
    height=Math.round(r.height*10)/10;
    // 相对视口**中央**的偏移（用于区分"顶对齐但中部不同步"这一物理事实）
    relCenter=Math.round((r.top + r.height/2 - h/2)*10)/10;
    contentTop=Math.round((r.top + st)*10)/10;
  }
  return {ok:true, st:Math.round(st),sh,ch:h,max:Math.round(max),w:sc.clientWidth,
    pct:max>0?Math.round(st/max*1000)/1000:null, atBottom:max>0&&st>=max-2,
    needle, foundTag: found?found.tagName:null, foundText, relY, relCenter, height, contentTop};
`;

await runBrowserProbe(
  { name: `lead-p4j-roll-${LABEL}`, doc: DOC, docTitle: USING_USER ? "明途知识产权" : "滚动vs开合" },
  async (ui) => {
    const L = () => ui.ev(LEFT_SAMPLE);
    const rf = (t) => ui.ev(RIGHT_FIND(t));
    const isOpen = () => ui.ev(`const s=document.querySelector(".split-preview-shell");return !!s&&s.getBoundingClientRect().width>40;`);
    const dblShift = async () => {
      for (let i = 0; i < 2; i++) {
        await ui.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
        await ui.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 });
        await sleep(70);
      }
    };

    ui.log(`[p4j:${LABEL}] 文档=${USING_USER ? "用户真实文档" : "夹具"}（${DOC.length} 字符）`);

    await ui.command("view.edit");
    await sleep(2400);
    if (await isOpen()) { await dblShift(); await sleep(2200); }

    /** 滚左屏到大约 frac 位置 */
    const scrollToFrac = async (frac) => {
      for (let r = 0; r < 50; r++) {
        const c = await L();
        if (!c || c.max <= 0) return c;
        const target = Math.round(c.max * frac);
        const d = target - c.st;
        if (Math.abs(d) < 40) break;
        await ui.wheel(1000, 500, Math.max(-900, Math.min(900, d)));
        await sleep(45);
      }
      await sleep(420);
      return await L();
    };

    const rows = [];
    for (const frac of [0.3, 0.5, 0.7]) {
      const closed = await scrollToFrac(frac);
      ui.log(`[p4j:${LABEL}] ── frac=${frac} 关闭态 左 st=${closed && closed.st}/${closed && closed.max} w=${closed && closed.w}`);

      await dblShift();                 // 打开
      await sleep(3200);
      const openL = await L();
      const rAfterToggle = await rf(openL && openL.topText);

      // 极小幅度滚动（一档滚轮），模拟用户"滚一下"
      await ui.wheel(1000, 500, 120);
      await sleep(900);
      const rollL = await L();
      const rAfterRoll = await rf(rollL && rollL.topText);

      const row = {
        frac,
        afterToggle: { left: openL, right: rAfterToggle },
        afterRoll: { left: rollL, right: rAfterRoll },
      };
      rows.push(row);

      ui.log(`[p4j:${LABEL}]    开合后 左顶="${openL && openL.topText}" (y=${openL && openL.topViewportY}) → 右屏同内容 relY=${rAfterToggle && rAfterToggle.relY} tag=${rAfterToggle && rAfterToggle.foundTag} hit="${rAfterToggle && rAfterToggle.foundText}"`);
      ui.log(`[p4j:${LABEL}]    滚一下 左顶="${rollL && rollL.topText}" (y=${rollL && rollL.topViewportY}) → 右屏同内容 relY=${rAfterRoll && rAfterRoll.relY} tag=${rAfterRoll && rAfterRoll.foundTag} hit="${rAfterRoll && rAfterRoll.foundText}"`);
      ui.log(`[p4j:${LABEL}]    右屏 st: 开合后=${rAfterToggle && rAfterToggle.st}/${rAfterToggle && rAfterToggle.max} → 滚动后=${rAfterRoll && rAfterRoll.st}/${rAfterRoll && rAfterRoll.max}`);

      await dblShift();                 // 关回去
      await sleep(2200);
    }

    // ── 判据：同一内容在右屏视口里的相对 Y（越接近 0 = 越贴右屏顶 = 与左屏顶对齐）──
    const dT = rows.map((r) => r.afterToggle.right && r.afterToggle.right.relY).filter((v) => typeof v === "number");
    const dR = rows.map((r) => r.afterRoll.right && r.afterRoll.right.relY).filter((v) => typeof v === "number");
    const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
    const mad = (a) => (a.length ? Math.round((a.reduce((x, y) => x + Math.abs(y), 0) / a.length) * 10) / 10 : null);

    ui.log(`[p4j:${LABEL}] ===== 汇总 =====`);
    ui.log(`[p4j:${LABEL}] 开合后 右屏同内容相对Y = ${JSON.stringify(dT)}  均值=${avg(dT)} 绝对均值=${mad(dT)}`);
    ui.log(`[p4j:${LABEL}] 滚动后 右屏同内容相对Y = ${JSON.stringify(dR)}  均值=${avg(dR)} 绝对均值=${mad(dR)}`);

    // 若"滚动后"的偏差显著小于"开合后"，即证实用户的观察
    const better = mad(dT) !== null && mad(dR) !== null && mad(dR) < mad(dT) - 20;
    ui.add("P4J-1", "★ 用户观察复现：滚动后比开合后更对齐",
      better ? "PASS" : "KNOWN",
      `开合后绝对偏差=${mad(dT)}px vs 滚动后=${mad(dR)}px（${better ? "复现：滚动能自愈" : "未复现差值"}）`);

    fs.writeFileSync(path.join("D:/AI/markdown view/lightmd/_verify-out", `lead-p4j-roll-${LABEL}.json`),
      JSON.stringify({ label: LABEL, usingUserDoc: USING_USER, rows, toggleRelY: dT, rollRelY: dR, avgT: avg(dT), avgR: avg(dR) }, null, 1), "utf8");
  },
);
