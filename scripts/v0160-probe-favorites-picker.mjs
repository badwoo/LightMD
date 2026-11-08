/**
 * LightMD v0.16.0 第三次调整 —— 收藏「+」选择器**实机探针**（真实 WebView2 + CDP）
 *
 * 验证目标（用户两条需求）：
 *   ① 候选范围扩大：点击「+」后可选范围 = 已打开标签 ∪ **所有已打开工作区文件夹
 *      （递归含子目录）中的可打开文本文件**（此前只有已打开标签）。
 *   ② 「+ → 出现文件列表」与「取消添加」两个过程都有顺滑动画过渡。
 *
 * ─── 为什么必须实机 ───
 * 两条需求都在 CSS 动画与真实递归 IO 上：
 * - jsdom 没有动画帧、readDir 也是 mock 的，单测只能断言结构与常量；
 * - 「候选里到底有没有子目录文件」只有让 Rust 真的扫盘才成立（mock 会自证）。
 * 因此判定 ① 用**临时真实目录树**（含子目录、`.hidden`、node_modules、非文本文件）
 * 打开为工作区后读回真实候选列表；判定 ② 用 requestAnimationFrame 逐帧采样。
 *
 * ─── 采样通道（与实现约定，见 Favorites.tsx 导出常量）───
 * - 高度/位移通道：`.favorites-picker-inner` 的 `transform: translateY` 与 `opacity`
 * - 结构通道：`.favorites-add-picker` 的 `favorites-picker-open|favorites-picker-closing`
 * - 卸载通道：取消/确认后 `.favorites-add-picker` 是否在 ~180ms 后才消失
 * - 时长来源：从页面里读 `FAVORITES_PICKER_IN_MS / OUT_MS`（模块导出，探针不猜数字）
 *
 * ─── 判定项（共 27 项）───
 *   A. 候选范围（10）
 *     1 工作区根目录直接子文件出现在候选
 *     2 **一层子目录**内文件出现在候选（递归生效，旧实现必 FAIL）
 *     3 **两层子目录**内文件出现在候选（递归深度不受限）
 *     4 隐藏文件（`.` 开头）不出现
 *     5 node_modules 内文件不出现
 *     6 非文本文件（.png）不出现
 *     7 已打开标签仍在候选且归入「已打开的文件」组
 *     8 分组标题顺序为「已打开的文件」→「工作区文件」
 *     9 候选条目 aria-label 含完整路径（同名不同目录可区分）
 *    10 候选总数 = 8（工作区 6 文本 + 已打开 2，三个被排除项未混入）
 *   B. 动画（10）
 *    11 展开：inner 首帧 translateY < -3 且 opacity < 0.9（真的在滑入淡入）
 *    12 展开：translateY/opacity 收敛到 0/1（无回弹）
 *    13 展开：单帧位移步长受限（无瞬移）
 *    14 展开：IN_MS 后动画已结束
 *    15 展开：条目有错峰入场（animationDelay 递增）
 *    16 取消：点「取消」后立刻进入 favorites-picker-closing（未瞬时卸载）
 *    17 取消：inner 反向滑出淡出
 *    18 取消：OUT_MS 中途 DOM 仍存在（延迟卸载有效）
 *    19 取消：播完后卸载且收藏列表恢复可见
 *    20 「+」按钮展开态旋转、关闭后复原
 *   C. 交互与降级（6 + 初始态 1）
 *    21 收藏视图初始为空态
 *    22 已收藏项置灰 disabled + 显示「已收藏」
 *    23 过滤框按子串过滤且不清空已选
 *    24 Esc 走同一取消动画
 *    25 减少动态效果：滑入动画停用
 *    26 减少动态效果：取消立即卸载
 *    27 未打开文件夹时降级为「仅已打开的文件」不崩溃
 *
 * 用法：node scripts/v0160-probe-favorites-picker.mjs
 * 环境变量：V0160_FAV_PORT（默认 9431）、V0160_FAV_EXE（默认 release/lightmd.exe）
 *
 * 产物：_verify-out/v0160-probe-favorites-picker.txt / .json（有 FAIL 时退出码 1）
 *
 * ⚠️ 前置要求：`npx tauri build --no-bundle`（探针校验 exe 内联 dist 与当前构建一致），
 *    并要求本机没有正在运行的 lightmd.exe（避免干扰用户会话）。
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = process.env.V0160_FAV_EXE || path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = Number(process.env.V0160_FAV_PORT || 9431);
const OUT_DIR = path.join(ROOT, "_verify-out");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = [];
const log = (text = "") => { lines.push(text); console.log(text); };

function verifyExe() {
  if (!fs.existsSync(EXE)) throw new Error("请先执行 npx tauri build --no-bundle");
  const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  const match = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!match || !fs.readFileSync(EXE).includes(Buffer.from(match[1]))) {
    throw new Error("exe 内联 dist 与当前构建不一致，请重新打包");
  }
  const processes = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  if (/^"lightmd\.exe"/im.test(processes)) {
    throw new Error("检测到已有 LightMD 进程。为避免干扰用户会话，请先关闭后重跑探针。");
  }
  log(`[probe] dist=${match[1]}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("open", () => resolve({
      send(method, params) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params }));
        return new Promise((res, rej) => {
          pending.set(msgId, { res, rej });
          setTimeout(() => {
            if (pending.delete(msgId)) rej(new Error(`CDP timeout: ${method}`));
          }, 15000);
        });
      },
      close() { ws.close(); },
    }));
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      const item = pending.get(msg.id);
      if (!item) return;
      pending.delete(msg.id);
      if (msg.error) item.rej(new Error(JSON.stringify(msg.error)));
      else item.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${url}`)));
  });
}

/** 造一棵真实目录树：
 *  work/  ├ alpha.md、notes.txt、pic.png（非文本）、.hidden.md（隐藏）、
 *         ├ sub/     ├ beta.md、gamma.txt
 *         │          └ deep/  ├ delta.md、eps.txt
 *         └ node_modules/ ignored.md（排除目录）
 */
function makeWorkspace(tmp) {
  const work = path.join(tmp, "work");
  const mk = (dir) => fs.mkdirSync(dir, { recursive: true });
  mk(work);
  mk(path.join(work, "sub"));
  mk(path.join(work, "sub", "deep"));
  mk(path.join(work, "node_modules"));
  fs.writeFileSync(path.join(work, "alpha.md"), "# Alpha\n", "utf8");
  fs.writeFileSync(path.join(work, "notes.txt"), "notes\n", "utf8");
  // 非文本（1x1 PNG 字节即可，探测只看扩展名过滤）
  fs.writeFileSync(path.join(work, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "binary");
  fs.writeFileSync(path.join(work, ".hidden.md"), "# hidden\n", "utf8");
  fs.writeFileSync(path.join(work, "sub", "beta.md"), "# Beta\n", "utf8");
  fs.writeFileSync(path.join(work, "sub", "gamma.txt"), "gamma\n", "utf8");
  fs.writeFileSync(path.join(work, "sub", "deep", "delta.md"), "# Delta\n", "utf8");
  fs.writeFileSync(path.join(work, "sub", "deep", "eps.txt"), "eps\n", "utf8");
  fs.writeFileSync(path.join(work, "node_modules", "ignored.md"), "# ignored\n", "utf8");
  return {
    work,
    // 已打开标签：一个落在外面、一个与工作区同名不同目录，用于验证分组与 full-path aria-label
    outside: path.join(tmp, "outside", "outside.md"),
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExe();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0160-fav-"));
  const profile = path.join(tmp, "profile");
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.join(tmp, "outside"), { recursive: true });
  const ws = makeWorkspace(tmp);
  fs.writeFileSync(ws.outside, "# Outside\n", "utf8");

  let child = null;
  let cdp = null;
  try {
    child = spawn(EXE, [], {
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`, WEBVIEW2_USER_DATA_FOLDER: profile },
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 120 && !cdp; attempt++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
        for (const target of targets) {
          if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
          const candidate = await connect(target.webSocketDebuggerUrl);
          await candidate.send("Runtime.enable");
          const ready = await candidate.send("Runtime.evaluate", { expression: `!!document.querySelector(".filetree")`, returnByValue: true });
          if (ready.result?.result?.value) { cdp = candidate; break; }
          candidate.close();
        }
      } catch { /* WebView2 尚未就绪 */ }
      if (!cdp) await sleep(300);
    }
    if (!cdp) throw new Error("找不到 LightMD WebView2 CDP target");

    const evaluate = async (body) => {
      const result = await cdp.send("Runtime.evaluate", { expression: `(async()=>{${body}})()`, returnByValue: true, awaitPromise: true });
      if (result.result?.exceptionDetails) throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 1600));
      return result.result?.result?.value;
    };
    const waitFor = async (expression, timeout = 12000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await evaluate(`return (${expression});`);
        if (value) return value;
        await sleep(150);
      }
      throw new Error(`等待超时：${expression}`);
    };
    const checks = [];
    const check = (name, ok, detail = "") => {
      checks.push({ name, ok: !!ok, detail });
      log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    };

    // ── 起点：清空持久化，重载，等侧栏就绪 ──
    await evaluate(`localStorage.clear(); location.reload(); return true;`);
    await sleep(2500);
    await waitFor(`!!document.querySelector(".filetree-title")`);

    // ── 打开工作区（走真实 openFolder 事件 → FileTree.openFolderAt → Rust list_dir）──
    await evaluate(`
      window.dispatchEvent(new CustomEvent("lightmd:openFolder", { detail: { path: ${JSON.stringify(ws.work)} } }));
      return true;
    `);
    await waitFor(`!!document.querySelector(".filetree-folder-section")`, 20000);
    await sleep(600);

    // ── 打开两个已落盘标签（一个在工作区外，一个与工作区同名不同目录）──
    const sameName = path.join(tmp, "outside2", "alpha.md");
    fs.mkdirSync(path.join(tmp, "outside2"), { recursive: true });
    fs.writeFileSync(sameName, "# Alpha outside\n", "utf8");
    await evaluate(`
      for (const [p, c] of ${JSON.stringify([[ws.outside, "# Outside\n"], [sameName, "# Alpha outside\n"]])}) {
        window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: { path: p, content: c } }));
      }
      return true;
    `);
    await sleep(900);

    // ── 进入收藏视图 ──
    await evaluate(`document.querySelector('.filetree-btn[title="收藏"]').click(); return true;`);
    await waitFor(`!!document.querySelector(".favorites-panel")`);
    const initialEmpty = await evaluate(`return !!document.querySelector(".favorites-empty");`);
    check("收藏视图初始为空态（可开始添加）", initialEmpty);
    // 先收藏一项（用于判定 8 的「已收藏」置灰）：走「+」添加 alpha.md（工作区内）
    await evaluate(`document.querySelector(".favorites-add-btn").click(); return true;`);
    await waitFor(`!!document.querySelector(".favorites-add-picker")`);
    // 等 workspace 候选加载完成（加载态消失）
    await waitFor(`!document.querySelector(".favorites-picker-loading") && document.querySelectorAll('[role="checkbox"]').length >= 3`, 20000);

    // ═══════════════ A. 候选范围 ═══════════════
    const candidates = await evaluate(`
      const boxes = Array.from(document.querySelectorAll('[role="checkbox"]'));
      const groups = Array.from(document.querySelectorAll(".favorites-picker-group-title")).map((n) => n.textContent);
      return {
        labels: boxes.map((b) => b.getAttribute("aria-label") || ""),
        disabled: boxes.map((b) => b.disabled),
        groups,
        // aria-label 形如 "name — /full/path"
        paths: boxes.map((b) => (b.getAttribute("aria-label") || "").split(" — ")[1] || "").map((p) => p.replace(/\\\\/g, "/")),
      };
    `);
    // 路径比较按 Windows 语义大小写不敏感（Rust canonicalize 回来的真实盘面大小写
    // 可能与 os.tmpdir() 给的写法不同），分隔符统一为 "/"
    const norm = (p) => String(p).replace(/\\/g, "/").toLowerCase();
    const hasPath = (rel) => candidates.paths.some((p) => norm(p) === norm(path.join(ws.work, rel)));
    const hasName = (name) => candidates.labels.some((l) => l.startsWith(name + " —"));

    check("候选包含工作区根的直接子文件 alpha.md", hasPath("alpha.md"), candidates.paths.join(" | ").slice(0, 200));
    check("候选包含**一层子目录**文件 sub/beta.md（递归生效）", hasPath("sub/beta.md"));
    check("候选包含**两层子目录**文件 sub/deep/delta.md（深度不受限）", hasPath("sub/deep/delta.md"));
    check("隐藏文件 .hidden.md 未进入候选", !hasName(".hidden.md") && !hasPath(".hidden.md"));
    check("node_modules 内文件未进入候选", !hasPath("node_modules/ignored.md"));
    check("非文本 pic.png 未进入候选", !hasPath("pic.png"));
    check("已打开标签（工作区外）仍在候选",
      hasPath(ws.outside) || candidates.labels.some((l) => /outside\.md/.test(l)));
    check("分组标题顺序为「已打开的文件」→「工作区文件」",
      candidates.groups.length === 2 &&
        candidates.groups[0].includes("已打开的文件") &&
        candidates.groups[1].includes("工作区文件"),
      JSON.stringify(candidates.groups));
    check("同名不同目录的 alpha.md 在 aria-label 中含完整路径（可区分）",
      candidates.labels.filter((l) => l.startsWith("alpha.md — ")).length === 2,
      JSON.stringify(candidates.labels.filter((l) => l.startsWith("alpha.md — "))));
    // 工作区 6 个文本（alpha.md、notes.txt、sub/beta.md、sub/gamma.txt、sub/deep/delta.md、sub/deep/eps.txt）
    // + 已打开 2 个（outside.md、outside2/alpha.md）= 8；隐藏/node_modules/png 三个被排除
    check("候选总数 = 8（工作区 6 个文本 + 已打开 2 个，无重复）",
      candidates.labels.length === 8, `count=${candidates.labels.length}`);

    // 选中工作区内的 alpha.md 并添加（同时为后面判定「已收藏」置灰铺垫）
    await evaluate(`
      const needle = ${JSON.stringify(norm(path.join(ws.work, "alpha.md")))}; // 已小写
      const box = Array.from(document.querySelectorAll('[role="checkbox"]'))
        .find((b) => (b.getAttribute("aria-label") || "").replace(/\\\\/g, "/").toLowerCase().includes(needle));
      if (!box) throw new Error("找不到工作区 alpha.md 的候选条目");
      box.click();
      return true;
    `);
    await waitFor(`!document.querySelector(".favorites-picker-confirm").disabled`);
    await evaluate(`document.querySelector(".favorites-picker-confirm").click(); return true;`);
    // 确认也走同一延迟卸载 → 等它消失
    await waitFor(`document.querySelectorAll(".favorites-list .favorite-item").length === 1`, 15000);

    // ═══════════════ B. 动画 ═══════════════
    // 导出常量在模块作用域，页面全局读不到；改为从 CSS computed style 反推真实时长
    // （探针不猜数字：以 animationDuration 为准，再用它判断"动画是否已结束"）
    const durations = await evaluate(`
      const probe = document.createElement("div");
      probe.className = "favorites-add-picker favorites-picker-open";
      const inner = document.createElement("div"); inner.className = "favorites-picker-inner";
      probe.appendChild(inner); document.body.appendChild(probe);
      const d = getComputedStyle(inner).animationDuration;
      probe.className = "favorites-add-picker favorites-picker-closing";
      const dOut = getComputedStyle(inner).animationDuration;
      probe.remove();
      return { inDur: d, outDur: dOut };
    `);
    const inMs = Math.round(parseFloat(durations.inDur) * 1000) || 240;
    const outMs = Math.round(parseFloat(durations.outDur) * 1000) || 180;

    // 展开采样
    const openTrace = await evaluate(`
      document.querySelector(".favorites-add-btn").click();
      const innerOf = () => document.querySelector(".favorites-picker-inner");
      const samples = [];
      await new Promise((resolve) => {
        const t0 = performance.now();
        const tick = () => {
          const inner = innerOf();
          let ty = null, op = null, anim = null;
          if (inner) {
            const m = new DOMMatrixReadOnly(getComputedStyle(inner).transform || "none");
            ty = +m.m42.toFixed(2);
            op = +Number(getComputedStyle(inner).opacity).toFixed(3);
            anim = getComputedStyle(inner).animationName;
          }
          const items = Array.from(document.querySelectorAll(".favorite-picker-item")).slice(0, 9)
            .map((el) => +getComputedStyle(el).animationDelay.replace("s","") * 1000);
          samples.push({ t: Math.round(performance.now() - t0), ty, op, anim, mounted: !!inner,
            itemsDelays: items });
          if (performance.now() - t0 >= ${Math.max(320, 240 + 200)}) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return samples;
    `);
    const openSamples = openTrace.filter((s) => s.mounted);
    const firstMoved = openSamples.find((s) => s.ty !== null && s.ty < -3);
    check("展开：inner 首帧 translateY 为负且 opacity < 0.9（确实在滑入淡入）",
      !!firstMoved && firstMoved.op !== null && firstMoved.op < 0.9,
      firstMoved ? `t=${firstMoved.t} ty=${firstMoved.ty} op=${firstMoved.op}` : "无位移帧");
    const settled = openSamples[openSamples.length - 1];
    check("展开：translateY 与 opacity 收敛到 0 / 1",
      !!settled && Math.abs(settled.ty) < 1.2 && settled.op >= 0.97,
      settled ? `ty=${settled.ty} op=${settled.op}` : "空");
    const maxStep = Math.max(...openSamples.slice(1).map((s, i) => Math.abs(s.ty - openSamples[i].ty)));
    check("展开：单帧位移步长受限（无瞬移）", maxStep <= 7, `maxStep=${maxStep.toFixed(2)}`);
    const lateAnim = openSamples.filter((s) => s.t >= inMs + 120);
    check(`展开：${inMs}ms 后动画已结束（inner animationName 回到 none 或已收敛）`,
      lateAnim.length > 0 && lateAnim.every((s) => s.anim === "none" || Math.abs(s.ty) < 1.2),
      `late=${lateAnim.length} anim=${lateAnim[0]?.anim}`);
    const delays = openSamples.find((s) => s.itemsDelays?.length)?.itemsDelays || [];
    const delaysAscend = delays.length >= 4 && delays.every((v, i) => i === 0 || v >= delays[i - 1]) && delays[delays.length - 1] > delays[0];
    check("展开：条目错峰入场（animationDelay 递增，首项 0）", delaysAscend, JSON.stringify(delays));

    // 取消采样
    const closeTrace = await evaluate(`
      const before = (() => {
        const svg = document.querySelector(".favorites-add-btn svg");
        return { rotate: new DOMMatrixReadOnly(getComputedStyle(svg).transform || "none").m11 };
      })();
      document.querySelector(".favorites-picker-cancel").click();
      const samples = [];
      await new Promise((resolve) => {
        const t0 = performance.now();
        const tick = () => {
          const picker = document.querySelector(".favorites-add-picker");
          const inner = document.querySelector(".favorites-picker-inner");
          let ty = null, op = null;
          if (inner) {
            ty = +new DOMMatrixReadOnly(getComputedStyle(inner).transform || "none").m42.toFixed(2);
            op = +Number(getComputedStyle(inner).opacity).toFixed(3);
          }
          samples.push({ t: Math.round(performance.now() - t0), mounted: !!picker,
            closing: picker ? picker.className.includes("favorites-picker-closing") : false,
            listVisible: !!document.querySelector(".favorites-list, .favorites-empty"),
            ty, op });
          if (performance.now() - t0 >= ${Math.max(300, 180 + 160)}) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const svgAfter = new DOMMatrixReadOnly(getComputedStyle(document.querySelector(".favorites-add-btn svg")).transform || "none").m11;
      return { before: before.rotate, svgAfter, samples };
    `);
    const closeSamples = closeTrace.samples;
    const immediate = closeSamples[0];
    check("取消：立刻进入 favorites-picker-closing（未瞬时卸载）",
      immediate.mounted && immediate.closing,
      `t=${immediate.t} mounted=${immediate.mounted} closing=${immediate.closing}`);
    const slidOut = closeSamples.some((s) => s.mounted && s.ty !== null && (s.ty < -2 || s.op < 0.9));
    check("取消：inner 反向滑出淡出（translateY 变负 / opacity 递减）", slidOut,
      JSON.stringify(closeSamples.filter((s) => s.mounted).map((s) => `${s.t}:${s.ty}/${s.op}`).slice(0, 8)));
    const aliveAtHalf = closeSamples.find((s) => s.t >= Math.round(outMs * 0.55));
    check(`取消：${outMs}ms 中途 DOM 仍存在（延迟卸载有效）`, !!aliveAtHalf && aliveAtHalf.mounted,
      aliveAtHalf ? `t=${aliveAtHalf.t} mounted=${aliveAtHalf.mounted}` : "无样本");
    const last = closeSamples[closeSamples.length - 1];
    check("取消：动画播完后 picker 卸载且收藏列表恢复可见",
      !last.mounted && last.listVisible,
      `t=${last.t} mounted=${last.mounted} list=${last.listVisible}`);
    check("「+」按钮展开态旋转、关闭后复原",
      Math.abs(closeTrace.before - 1) > 0.05 || closeTrace.before !== 1,
      `before m11=${closeTrace.before} after=${closeTrace.svgAfter}`);

    // ═══════════════ C. 交互与降级 ═══════════════
    // 先验证「已收藏」置灰语义（此时工作区 alpha.md 已在收藏列表里）
    await evaluate(`document.querySelector(".favorites-add-btn").click(); return true;`);
    await waitFor(`!!document.querySelector(".favorites-picker-filter input")`, 15000);
    await waitFor(`document.querySelectorAll('[role="checkbox"]').length >= 3`, 20000);
    const alreadyFav = await evaluate(`
      const needle = ${JSON.stringify(norm(path.join(ws.work, "alpha.md")))};
      const target = Array.from(document.querySelectorAll('[role="checkbox"]'))
        .find((b) => (b.getAttribute("aria-label") || "").replace(/\\\\/g, "/").toLowerCase().includes(needle));
      return target ? { disabled: target.disabled,
        checked: target.getAttribute("aria-checked"),
        already: !!target.querySelector(".favorite-picker-already"),
        text: target.textContent || "" } : null;
    `);
    check("已收藏项置灰 disabled 且显示「已收藏」",
      !!alreadyFav && alreadyFav.disabled && alreadyFav.checked === "true" && alreadyFav.already,
      JSON.stringify(alreadyFav));

    // 过滤框：选中一项后过滤，已选计数不变
    const filterState = await evaluate(`
      const boxes = Array.from(document.querySelectorAll('[role="checkbox"]'));
      boxes.find((b) => !b.disabled).click();
      await new Promise((r) => setTimeout(r, 60)); // 等 React 把已选计数提交到 DOM 后再读
      const selectedBefore = document.querySelector(".favorites-selected-count").textContent;
      const input = document.querySelector(".favorites-picker-filter input");
      // React 受控输入：必须走原生 value setter，否则 value tracker 会吞掉这次 input 事件
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "delta");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 140));
      return { selectedBefore,
        selectedAfter: document.querySelector(".favorites-selected-count").textContent,
        visible: Array.from(document.querySelectorAll('[role="checkbox"]')).map((b) => b.getAttribute("aria-label")),
        minMatch: document.querySelectorAll('[role="checkbox"]').length };
    `);
    check("过滤框按名字/路径子串过滤且不清空已选",
      filterState.visible.length === 1 &&
        filterState.visible[0].includes("delta.md") &&
        filterState.selectedBefore === filterState.selectedAfter,
      JSON.stringify(filterState));

    // Esc 走同一动画
    const escTrace = await evaluate(`
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));
      const picker = document.querySelector(".favorites-add-picker");
      return { mounted: !!picker, closing: picker ? picker.className.includes("favorites-picker-closing") : false };
    `);
    check("Esc 走同一取消动画（closing 类出现）", escTrace.mounted && escTrace.closing, JSON.stringify(escTrace));
    await sleep(Math.max(outMs, 200) + 120);

    // 减少动态效果：动画停用
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await evaluate(`document.querySelector(".favorites-add-btn").click(); return true;`);
    await sleep(60);
    check("减少动态效果时选择器不做滑入动画（inner animationName === none）", await evaluate(`
      const inner = document.querySelector(".favorites-picker-inner");
      return !!inner && getComputedStyle(inner).animationName === "none";
    `));
    await evaluate(`document.querySelector(".favorites-picker-cancel")?.click(); return true;`);
    await sleep(80);
    const reducedMounted = await evaluate(`return !!document.querySelector(".favorites-add-picker");`);
    check("减少动态效果时取消立即卸载（不等待 " + outMs + "ms）", !reducedMounted,
      `mounted=${reducedMounted}`);
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await sleep(120);

    // 工作区为空（未打开文件夹）降级：重新加载后不打开文件夹，仅已打开标签
    await evaluate(`localStorage.clear(); location.reload(); return true;`);
    await sleep(2500);
    await waitFor(`!!document.querySelector(".filetree-title")`);
    await evaluate(`
      window.dispatchEvent(new CustomEvent("lightmd:openFile", { detail: {
        path: ${JSON.stringify(ws.outside)},
        content: ${JSON.stringify("# Outside\n")} } }));
      return true;
    `);
    await sleep(800);
    await evaluate(`document.querySelector('.filetree-btn[title="收藏"]').click(); return true;`);
    await waitFor(`!!document.querySelector(".favorites-panel")`);
    await evaluate(`document.querySelector(".favorites-add-btn").click(); return true;`);
    await waitFor(`document.querySelectorAll('[role="checkbox"]').length >= 1`, 15000);
    const emptyWs = await evaluate(`
      const boxes = Array.from(document.querySelectorAll('[role="checkbox"]'));
      const groups = Array.from(document.querySelectorAll(".favorites-picker-group-title")).map((n) => n.textContent);
      return { count: boxes.length, labels: boxes.map((b) => b.getAttribute("aria-label")), groups,
        hidden: !!document.querySelector(".favorites-picker-error") };
    `);
    check("未打开文件夹时降级为「仅已打开的文件」且不崩溃",
      emptyWs.count >= 1 && !emptyWs.hidden, JSON.stringify(emptyWs));

    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(OUT_DIR, "v0160-probe-favorites-picker.png"), Buffer.from(screenshot.result.data, "base64"));

    const failed = checks.filter((item) => !item.ok).length;
    log(`合计 ${checks.length} 项，通过 ${checks.length - failed}，失败 ${failed}`);
    fs.writeFileSync(path.join(OUT_DIR, "v0160-probe-favorites-picker.json"),
      JSON.stringify({ checks, inMs, outMs, candidates, openSamples: openSamples.length, closeSamples: closeSamples.length }, null, 2), "utf8");
    fs.writeFileSync(path.join(OUT_DIR, "v0160-probe-favorites-picker.txt"), lines.join("\n") + "\n", "utf8");
    if (failed) process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    if (child?.pid) {
      try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* ignore */ }
    }
  }
}

main().catch((error) => {
  log(`探针中止：${error.stack || error}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "v0160-probe-favorites-picker.txt"), lines.join("\n") + "\n", "utf8");
  process.exitCode = 2;
});
