/**
 * LightMD v0.15.3 —— 实机探针：左侧栏文件树右键「打开文件所在目录」失效
 *
 * ## 报的 bug
 * 在左侧栏（文件树）里对**已打开文件夹内的文件**右键 → 「打开文件所在目录」→
 * 什么都没有发生（期望：资源管理器打开父目录并选中该文件）。
 *
 * ## 本探针要证明什么（证据链，不靠猜）
 * E1 文件树确实渲染出来了，且节点 `node.path` 是**绝对路径**（排除前端路径形态问题）
 * E2 右键该节点 → 菜单项「打开文件所在目录」存在且可点（排除前端入口缺失）
 * E3 点击后：DOM 里**没有**错误 toast ⇒ Rust 命令返回 Ok（排除 "前端没调到 / 命令报错"）
 * E4 但资源管理器**没有**打开目标父目录窗口、也没选中目标文件 ⇒ 问题在 explorer 调用本身
 * E5 修复后用同一个探针复跑：资源管理器确实打开了目标父目录窗口，且选中项 == 目标文件名
 *
 * 判据（资源管理器侧）用 Shell.Application 枚举窗口 + Document.SelectedItems，
 * 而不是看进程名——explorer.exe 常驻，进程存在与否证明不了任何事。
 *
 * 用法：node scripts/v0153-probe-reveal-in-folder.mjs
 * 环境变量：V0153R_PORT（默认 9303）、V0153R_EXE、V0153R_TAG（报告名后缀）
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EXE =
  process.env.V0153R_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0153R_PORT || 9303);
const TAG = process.env.V0153R_TAG || "";
const OUT_DIR = "D:\\AI\\markdown view\\lightmd\\_verify-out";
const OUT_TXT = path.join(OUT_DIR, `v0153-reveal-in-folder${TAG}.txt`);
const OUT_JSON = path.join(OUT_DIR, `v0153-reveal-in-folder${TAG}.json`);
const DIST_INDEX = "D:\\AI\\markdown view\\lightmd\\dist\\index.html";
/** 探针专用 powershell：枚举资源管理器窗口与选中项 */
const SHELL_STATE_PS = path.join(OUT_DIR, "reveal-probe", "win-shell-state.ps1");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};

function verifyExeHasDist() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到打包产物：${EXE}\n请先执行：npx tauri build --no-bundle`);
  if (!fs.existsSync(DIST_INDEX)) throw new Error("找不到 dist/index.html");
  const html = fs.readFileSync(DIST_INDEX, "utf-8");
  const m = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!m) throw new Error("dist/index.html 找不到入口 hash");
  const hash = m[1];
  if (!fs.readFileSync(EXE).includes(Buffer.from(hash, "utf-8"))) {
    throw new Error(`exe 内联 dist 与当前 dist 不一致（找不到 ${hash}）→ 请 npx tauri build --no-bundle`);
  }
  log(`[probe] exe 内联 dist 校验通过：${hash}`);
  return hash;
}

/** 枚举资源管理器窗口状态（返回数组） */
function shellState() {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SHELL_STATE_PS],
      { encoding: "utf-8", timeout: 30000 },
    );
    const trimmed = (out || "").trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    log(`  [shellState] 枚举失败: ${String(e).slice(0, 200)}`);
    return [];
  }
}

const PROBE_DIR_MATCH = "LightMD 测试 目录";

/** 关闭本探针历史运行遗留的临时目录窗口（否则上一轮的「已选中」会污染本轮基线） */
function closeStaleProbeWindows() {
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
$n = 0
try {
  $sh = New-Object -ComObject Shell.Application
  foreach ($w in @($sh.Windows())) {
    if ($w.LocationURL -and $w.LocationURL -match 'lightmd-reveal-') { try { $w.Quit(); $n++ } catch {} }
  }
} catch {}
Write-Output $n
`;
  const tmpPs = path.join(os.tmpdir(), `lightmd-close-stale-${process.pid}.ps1`);
  // 写 BOM，避免 PowerShell 5.1 按 GBK 解析脚本里的中文/正则
  fs.writeFileSync(tmpPs, "\uFEFF" + ps, "utf-8");
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tmpPs], {
      encoding: "utf-8",
      timeout: 30000,
    });
    log(`[probe] 关闭历史探针窗口：${(out || "").trim()} 个`);
  } catch (e) {
    log(`  [closeStale] 失败: ${String(e).slice(0, 120)}`);
  } finally {
    try {
      fs.unlinkSync(tmpPs);
    } catch {
      /* ignore */
    }
  }
}

/**
 * ★ 核心判据：目标父目录窗口是否「新开/新激活」且选中了目标文件。
 *
 * 不能用「进程里有没有 explorer.exe」——explorer.exe 常驻，恒为真。
 * 也不能简单看「窗口数变多」——用户桌面本来就有很多资源管理器窗口，
 * 且打开同一目录可能激活既有窗口而非新建。
 * 正确口径：**选中项里有目标文件名** 且 该窗口 URL 指向**本轮**的临时目录。
 */
function assessReveal(before, after, targetName, runDir) {
  const norm = (u) => {
    try {
      return decodeURIComponent(u || "").replace(/\\/g, "/");
    } catch {
      return u || "";
    }
  };
  // 注意：只认本轮目录（历史运行目录不同、且已在开跑前关掉）
  const runDirNorm = norm("file:///" + runDir.replace(/\\/g, "/"));
  const dirWindows = after.filter((w) => norm(w.url).startsWith(runDirNorm));
  const selWindows = after.filter((w) => Array.isArray(w.sel) && w.sel.includes(targetName));
  const correctDir = selWindows.filter((w) => norm(w.url).startsWith(runDirNorm));
  const beforeSel = before.filter(
    (w) => Array.isArray(w.sel) && w.sel.includes(targetName) && norm(w.url).startsWith(runDirNorm),
  ).length;
  return {
    dirWindows: dirWindows.length,
    selectedWindows: selWindows.length,
    correctDirWindows: correctDir.length,
    beforeSelectedWindows: beforeSel,
    matched: correctDir.map((w) => ({ url: w.url, sel: w.sel })),
  };
}

const PAGE_TOOLS = String.raw`
window.__revealProbe = {
  /** 找到文件树里名为 name 的文件节点 */
  findNode(name) {
    const nodes = Array.from(document.querySelectorAll(".filetree-node"));
    return nodes.find((n) => {
      const t = n.querySelector(".filetree-name");
      return t && t.textContent.trim() === name;
    }) || null;
  },
  nodePath(node) {
    return node ? node.getAttribute("title") : null;
  },
  /** 收集当前 DOM 里的 toast 文本（用于判断有没有错误提示） */
  toasts() {
    return Array.from(document.querySelectorAll(".notification-toast")).map((t) => ({
      type: (t.className.match(/notification-(error|warning|success|info)/) || [])[1] || "?",
      message: (t.querySelector(".notification-message") || {}).textContent || "",
    }));
  },
};
`;

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
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${wsUrl}`)));
  });
}

const main = async () => {
  fs.mkdirSync(path.join(OUT_DIR, "reveal-probe"), { recursive: true });
  verifyExeHasDist();

  // ── 造临时文件夹：路径含空格 + 中文（最容易触发 explorer /select 引号问题） ──
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-reveal-"));
  const folderName = PROBE_DIR_MATCH;
  const probeDir = path.join(tmpRoot, folderName);
  fs.mkdirSync(probeDir, { recursive: true });
  const targetName = "中文 文件.md";
  const targetFile = path.join(probeDir, targetName);
  fs.writeFileSync(targetFile, "# reveal probe\n", "utf-8");
  const decoyName = "普通 文件2.md";
  fs.writeFileSync(path.join(probeDir, decoyName), "# decoy\n", "utf-8");
  log(`[probe] 临时目录：${probeDir}`);
  log(`[probe] 目标文件：${targetFile}（存在=${fs.existsSync(targetFile)}）`);

  const profile = path.join(tmpRoot, "profile");
  fs.mkdirSync(profile, { recursive: true });

  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await sleep(1200);

  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
  });

  log("[probe] 等待 CDP 端点就绪…");
  for (let i = 0; i < 140; i++) {
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
    if (!cdp) await sleep(400);
  }
  if (!cdp) throw new Error("找不到 WebView2 CDP target");

  const ev = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${PAGE_TOOLS}\n${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 900));
    return r.result?.result?.value;
  };

  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    // ── E1：打开文件夹，等文件树渲染 ──
    let node = null;
    for (let a = 0; a < 30 && !node; a++) {
      await ev(`
        window.dispatchEvent(new CustomEvent("lightmd:openFolder", {
          detail: { path: ${JSON.stringify(probeDir)} },
        }));
        return true;
      `);
      await sleep(700);
      node = await ev(`
        const n = window.__revealProbe.findNode(${JSON.stringify(targetName)});
        return n ? { path: window.__revealProbe.nodePath(n) } : null;
      `);
      if (!node) {
        const diag = await ev(`
          return {
            nodes: Array.from(document.querySelectorAll(".filetree-node")).map(
              (n) => (n.querySelector(".filetree-name") || {}).textContent
            ).slice(0, 40),
            folderCount: document.querySelectorAll(".filetree-node").length,
          };
        `);
        log(`  [retry ${a + 1}] ${JSON.stringify(diag)}`);
      }
    }
    if (!node) throw new Error("文件树未渲染出目标文件（判定会失真，中止）");
    log(`[probe] 文件树节点已就绪：${targetName} → ${node.path}`);

    const abs = await ev(`
      const p = ${JSON.stringify(node.path)};
      // list_dir 把 '\\' 归一成 '/'，所以绝对路径判定必须同时接受两种分隔符
      return {
        isAbs: /^[A-Za-z]:[\\\\/]/.test(p) || /^\\\\\\\\/.test(p) || p.startsWith("/"),
        hasDotDot: p.split(/[\\\\/]/).includes(".."),
        p,
      };
    `);
    check(
      "E1 文件树 node.path 是绝对路径（无 .. 相对拼接）",
      abs.isAbs === true && abs.hasDotDot === false,
      JSON.stringify(abs),
    );

    // ── E2：右键节点 → 菜单项存在 ──
    const menuInfo = await ev(`
      const n = window.__revealProbe.findNode(${JSON.stringify(targetName)});
      if (!n) return { ok: false, why: "node gone" };
      const r = n.getBoundingClientRect();
      const opt = { bubbles: true, cancelable: true, button: 2, clientX: r.left + 40, clientY: r.top + r.height / 2 };
      n.dispatchEvent(new MouseEvent("mousedown", opt));
      n.dispatchEvent(new MouseEvent("mouseup", opt));
      n.dispatchEvent(new MouseEvent("contextmenu", opt));
      await new Promise((res) => setTimeout(res, 250));
      const items = Array.from(document.querySelectorAll(".filetree-context-menu .context-menu-item"));
      const texts = items.map((b) => b.textContent.trim());
      const revealIdx = texts.findIndex((t) => t.indexOf("打开文件所在目录") >= 0);
      // 菜单打开时读到的 node.path = 即将传给 revealInFolder 的值
      return { ok: revealIdx >= 0, texts, revealIdx, nodeTitle: window.__revealProbe.nodePath(n) };
    `);
    check(
      "E2 文件树右键菜单含「打开文件所在目录」入口",
      menuInfo?.ok === true,
      `菜单项=${JSON.stringify(menuInfo?.texts || [])} node.path=${menuInfo?.nodeTitle}`,
    );

    // 记录点击前的资源管理器状态（基线）：先关掉历史探针窗口，避免上一轮「已选中」污染
    closeStaleProbeWindows();
    await sleep(1200);
    const beforeState = shellState();
    log(
      `[probe] 点击前资源管理器窗口数=${beforeState.length}，` +
        `其中已选中目标的=${assessReveal(beforeState, beforeState, targetName, probeDir).selectedWindows}`,
    );

    // ── E3/E4：点「打开文件所在目录」，观察 toast + 资源管理器 ──
    const clicked = await ev(`
      const items = Array.from(document.querySelectorAll(".filetree-context-menu .context-menu-item"));
      const btn = items.find((b) => b.textContent.trim().indexOf("打开文件所在目录") >= 0);
      if (!btn) return { ok: false, why: "no button" };
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      btn.click();
      await new Promise((res) => setTimeout(res, 1200));
      const toasts = window.__revealProbe.toasts();
      return { ok: true, toasts };
    `);
    log(`[probe] 点击结果：${JSON.stringify(clicked)}`);

    // 给 explorer 充分时间开窗/选中
    await sleep(3500);
    const afterState = shellState();
    const assessment = assessReveal(beforeState, afterState, targetName, probeDir);
    log(`[probe] 点击后资源管理器窗口数=${afterState.length}`);
    for (const w of afterState.filter((w) =>
      decodeURIComponent(w.url || "").replace(/\\/g, "/").includes(probeDir.replace(/\\/g, "/")),
    )) {
      log(`  [explorer] ${decodeURIComponent(w.url)} sel=${JSON.stringify(w.sel)}`);
    }


    const errorToasts = (clicked?.toasts || []).filter((t) => t.type === "error");
    check(
      "E3 点击后无错误 toast（Rust 命令返回 Ok，排除前端/命令报错）",
      errorToasts.length === 0,
      `toasts=${JSON.stringify(clicked?.toasts || [])}`,
    );
    check(
      "E4 资源管理器打开了目标父目录并选中目标文件",
      assessment.correctDirWindows > 0,
      `选中窗口=${assessment.selectedWindows} 正确目录窗口=${assessment.correctDirWindows} ` +
        `before=${assessment.beforeSelectedWindows} matched=${JSON.stringify(assessment.matched)}`,
    );

    // ── E5：直接 invoke 该命令，看 Rust 返回什么（对照证据） ──
    const directInvoke = await ev(`
      const { invoke } = window.__TAURI_INTERNALS__;
      try {
        const r = await window.__TAURI_INTERNALS__.invoke("reveal_in_folder", { path: ${JSON.stringify(node.path)} });
        return { ok: true, result: r === undefined ? "<undefined>" : JSON.stringify(r) };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    `);
    log(`[probe] 直接 invoke("reveal_in_folder") ⇒ ${JSON.stringify(directInvoke)}`);
    check(
      "E5 直接 invoke reveal_in_folder 返回 Ok（命令本身不报错，问题就在 explorer 侧）",
      directInvoke?.ok === true,
      JSON.stringify(directInvoke),
    );

    const failed = checks.filter((c) => !c.ok).length;
    log("");
    log(`结论：${checks.length - failed} PASS / ${failed} FAIL`);
    log(`（E4/E5 同时为真 ⇒ 后端命令成功但资源管理器没选中 = explorer /select 参数形态问题）`);
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf-8");
    fs.writeFileSync(
      OUT_JSON,
      JSON.stringify(
        { hash: fs.readFileSync(EXE).length, probeDir, targetFile, node, menuInfo, clicked, beforeState, afterState, assessment, directInvoke, checks },
        null,
        2,
      ),
      "utf-8",
    );
    log(`报告已写入：${OUT_TXT}`);
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    try {
      cdp?.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
};

main().catch((e) => {
  console.error("探针失败：", e);
  process.exitCode = 2;
});
