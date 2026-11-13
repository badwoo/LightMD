/**
 * v0170-r5-exe-identity.mjs —— **探针 exe 身份权威校验**（Lead 专用，一次性）
 *
 * ## 为什么需要它
 *
 * R5 V3（`fix-formatbar`）报告「探针 exe 内联的是旧 dist」，依据是在 exe 二进制里
 * `grep normalizeOrderedLists` = 0、`formatPainterContinuous` = 0。
 *
 * 该判据**从根上可能无效**：Tauri 2 把前端资源压缩后 embed 进 exe
 * （`tauri-utils` 的 `EmbeddedAssets` 走 zstd），因此任何"在 exe 里搜明文 JS 字符串"
 * 的检查都会**假阴性** —— 包括 `_lib/probe-harness.mjs` 现有的
 * `exe.includes(hashName)` 弱校验（它只命中资源清单里的文件名，不命中内容）。
 *
 * ## 本探针的判据（权威）
 *
 * 不看 exe 二进制，改看**运行中的页面实际加载了什么代码**：
 * 1. `document.querySelectorAll("script[src]")` 拿真实 script URL
 * 2. `fetch(url)` 读**解压后的明文**（WebView2 拿到的必然是解压后的资源）
 * 3. 在明文里查 R3/R4 的版本特征串
 *
 * 这一步必要且充分：exe 若内联旧 dist，页面里加载的明文就不含新特征。
 */
import { runProbe } from "./_lib/probe-harness.mjs";

const DOC = ["# EXE 身份校验", "", "第 1 段。IDENT01 标记。", ""].join("\n");

await runProbe(
  { name: "v0170-r5-exe-identity", doc: DOC, docTitle: "IDENT01", viewMode: "edit" },
  async (ui) => {
    /**
     * ⚠️ `ui.ev()` 底层是 `Runtime.evaluate` 且**不带 awaitPromise** ——
     * 第一版把整个采集写成 `(async () => {...})()` 直接返回，结果 `info === undefined`
     * （报错 `Cannot read properties of undefined (reading 'srcs')`）。
     *
     * 修法：异步结果先落到 `window.__ID_RESULT`，再把同步值返回给 ev，
     * 之后轮询读取。这样 ev 每次只返回同步可序列化值。
     */
    await ui.ev(`
      window.__ID_RESULT = null;
      (async () => {
        const srcs = Array.from(document.querySelectorAll("script[src]"))
          .map((s) => s.src)
          .filter(Boolean);
        const out = { srcs: srcs.map((u) => u.split("/").pop()), bundles: [] };
        for (const u of srcs) {
          try {
            const r = await fetch(u);
            const t = await r.text();
            out.bundles.push({
              name: u.split("/").pop(),
              len: t.length,
              norm: t.indexOf("normalizeOrderedLists") >= 0,
              cont: t.indexOf("formatPainterContinuous") >= 0,
              b64: t.indexOf("lmd-b64") >= 0,
              docc: t.indexOf("docChanged") >= 0,
              head: t.slice(0, 60),
            });
          } catch (e) {
            out.bundles.push({ name: u, error: String(e) });
          }
        }
        window.__ID_RESULT = out;
      })();
      true
    `);

    // 轮询等待异步采集完成（最多 5s）
    let info = null;
    for (let i = 0; i < 25; i++) {
      await ui.sleep(200);
      info = await ui.ev(`window.__ID_RESULT`);
      if (info && Array.isArray(info.bundles) && info.bundles.length) break;
    }

    if (!info || !Array.isArray(info.bundles)) {
      ui.add("ID-0", "前置断言：页面侧采集到 script 列表", "FAIL", `info=${JSON.stringify(info)}`);
      return;
    }

    console.log("[identity] scripts =", JSON.stringify(info.srcs));
    for (const b of info.bundles) {
      if (b.error) {
        console.log(`[bundle] ${b.name} ERROR ${b.error}`);
      } else {
        console.log(
          `[bundle] ${b.name} len=${b.len} norm=${b.norm} cont=${b.cont} b64=${b.b64} docChanged=${b.docc}`
        );
      }
    }

    // ── 前置断言：必须真的读到一份主 bundle 明文，否则结论无效 ──
    const mains = info.bundles.filter((b) => typeof b.len === "number" && b.len > 100000);
    ui.add(
      "ID-0",
      "前置断言：读到主 bundle 明文（非占位/非空）",
      mains.length ? "PASS" : "FAIL",
      mains.length ? `最大 ${mains[0].len} 字符，head="${String(mains[0].head).replace(/\n/g, "")}"` : "无 >100KB 的可读 script → 探针无效"
    );

    if (!mains.length) return;
    const main = mains[0];

    ui.add(
      "ID-1",
      "exe 内联当前 dist —— R4#6 归一化在",
      main.norm ? "PASS" : "FAIL",
      `normalizeOrderedLists 出现=${main.norm}`
    );
    ui.add(
      "ID-2",
      "exe 含本轮新功能 —— 连续刷菜单",
      main.cont ? "PASS" : "FAIL",
      `formatPainterContinuous 出现=${main.cont}`
    );
    ui.add(
      "ID-3",
      "exe 含 R4 T6 base64 新前缀",
      main.b64 ? "PASS" : "FAIL",
      `lmd-b64 出现=${main.b64}`
    );
    ui.add(
      "ID-4",
      "exe 含 R4#5 docChanged 判据",
      main.docc ? "PASS" : "FAIL",
      `docChanged 出现=${main.docc}`
    );

    console.log(
      `[identity] 结论：norm=${main.norm} cont=${main.cont} b64=${main.b64} docChanged=${main.docc}`
    );
  }
);
