/**
 * LightMD v0.11.0 导出三项修复 —— 实机验证（打包产物 + WebView2 CDP 驱动）
 *
 * 覆盖范围（PLAN-0.11.0.md 的 B2 批次）：
 *   E1 = B2-1 导出的 HTML 必须自包含 / 离线可用
 *        · 不得再依赖 jsdelivr 等 CDN（katex / mermaid）
 *        · KaTeX 的 CSS + JS 内联，字体以 base64 data URL 写进 @font-face
 *        · mermaid 体积 3.2MB 不内联，改为导出文件旁 `_assets/mermaid.min.js` + 相对路径引用
 *        · mermaid securityLevel 必须是 "strict"（旧实现是 "loose"）
 *   E2 = B2-2 导出的多页 PDF 必须在**每一页**都有页眉/页脚文本
 *        · 旧实现 `@page { @top-center { content: ... } }` 被 Chromium --print-to-pdf 静默忽略
 *        · 修复改用 `position:fixed` 常规元素（Chromium 打印逐页重复）
 *        · 页码按用户拍板**降级停用**：UI 不得再有页码格式控件，也不得再宣传 {page} 变量
 *   E3 = B2-3 含块级公式的文档导出 PNG 时，公式必须带正确的 KaTeX 字形
 *        · 旧实现 skipFonts:true 丢失 web 字体 → 修复应显式提供 fontEmbedCSS
 *
 * 用法（脚本自行启动打包产物，一条命令）：
 *   node "D:\AI\markdown view\lightmd\scripts\real-machine-v0110-export.mjs"
 *
 * ★ 关于「原生保存对话框」——本脚本与最初设想的关键差异（已实机验证，务必先读）：
 *   三种导出都调用 @tauri-apps/plugin-dialog 的 save() → Rust 弹出**真实**的「另存为」
 *   原生对话框。计划中的拦截手法（改写 window.__TAURI_INTERNALS__.invoke）在本产物上
 *   **不可能生效**：实机属性描述符为
 *       window.__TAURI_INTERNALS__            {writable:false, configurable:false}
 *       window.__TAURI_INTERNALS__.invoke     {writable:false, configurable:false}
 *   赋值在非严格模式下静默失败（__invokeLog 始终为空，脚本首版已实测）。
 *   因此本脚本改用三层策略：
 *     ① Win32 自动化（best-effort）：找到属于 lightmd 的「另存为」对话框（class #32770），
 *        把文件名框（Edit, ctrl id=1001）设为脚本指定路径，再真实点击「保存」(Button id=1)；
 *     ② 人工兜底：若超时仍未落盘，控制台打印醒目提示，等待人手在对话框里填路径并保存
 *        （时长可用 V0110_DIALOG_WAIT_MS 调整，默认 90000ms）；
 *     ③ 仍失败 → 该项记 FAIL(产物未生成) 并把内容断言记 SKIP（绝不挂死、绝不伪造结论）。
 *
 * ⚠ 需要人工目视判定的部分（脚本内标记 SKIP，不伪造结论）：
 *   E3 的「字形是否正确」是视觉问题。脚本给出全部可客观断言的部分（PNG 合法/非空白/有
 *   绘制内容、字体嵌入前提是否成立、应用是否自曝字体告警），并把导出 PNG 复制到
 *   `_verify-out/v0110-png-formula.png`，把页面内 KaTeX 正确渲染的对照图存到
 *   `_verify-out/v0110-preview-formula.png`，供人或多模态 agent 目视比对。
 *
 * 前置条件：
 *   1) 已构建打包产物 lightmd\src-tauri\target\release\lightmd.exe
 *   2) 没有其它 LightMD 实例（tauri-plugin-single-instance：第二个进程会退出、
 *      CDP 端口不打开）→ 遇此情况脚本打印处理办法并以退出码 4 结束
 *   3) Windows 已安装 Edge（PDF 导出走 msedge --headless --print-to-pdf）
 *
 * 退出码：0=全部通过 / 1=有 FAIL / 2=脚本异常 / 3=未找到打包产物 / 4=应用未起来
 * 环境变量：V0110_EXE、V0110_EXPORT_PORT(默认 9227)、V0110_DIALOG_WAIT_MS(默认 90000)、
 *           V0110_NO_DIALOG_AUTOMATION=1（关闭 Win32 自动化，纯人工应答）、
 *           V0110_EXPORT_WATCHDOG_MS(默认 12 分钟)
 *
 * 只使用 Node 内置模块（child_process/fs/os/path/zlib/url）+ 全局 WebSocket；
 * 不新增任何 npm 依赖；所有等待均有超时；结束时必定结束应用进程（含 WebView2 子进程）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const EXE =
  process.env.V0110_EXE ||
  "D:\\AI\\markdown view\\lightmd\\src-tauri\\target\\release\\lightmd.exe";
const PORT = Number(process.env.V0110_EXPORT_PORT || 9227);
const CDP_BASE = `http://127.0.0.1:${PORT}`;
const REPO = "D:\\AI\\markdown view\\lightmd";
const VERIFY_OUT = path.join(REPO, "_verify-out");
const DIALOG_WAIT_MS = Number(process.env.V0110_DIALOG_WAIT_MS || 90_000);
const DIALOG_AUTOMATION = process.env.V0110_NO_DIALOG_AUTOMATION !== "1";
/** export_html_to_pdf 的临时 HTML（Rust 写完即删，需抢在删除前快照） */
const TEMP_EXPORT_HTML = path.join(os.tmpdir(), "lightmd-export", "export_temp.html");

/** 页眉/页脚用的唯一 ASCII 令牌（便于 PDF 文本解码后精确检索） */
const HEADER_TOKEN = "LMHEADERV0110";
const FOOTER_TOKEN = "LMFOOTERV0110";

const results = [];
let failed = 0;
let skipped = 0;
let humanPrompted = false;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
  return !!ok;
}
function skip(name, reason) {
  results.push(`SKIP  ${name} — ${reason}`);
  skipped++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`超时 ${ms}ms: ${label}`)), ms)),
  ]);
}

// ────────────────────────── CDP ──────────────────────────

async function findPageTarget({ attempts = 60, intervalMs = 500, aborted } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (aborted && aborted()) return { target: null, aborted: true };
    try {
      const res = await withTimeout(fetch(`${CDP_BASE}/json/list`), 4000, "GET /json/list");
      const targets = await res.json();
      const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      // 优先选应用页面（tauri.localhost / localhost）；避免连到 about:blank 之类的空目标
      const page = pages.find((t) => /tauri\.localhost|localhost/.test(t.url || "")) || pages[0];
      if (page) return { target: page, aborted: false };
    } catch {
      /* 端口未就绪 */
    }
    await sleep(intervalMs);
  }
  return { target: null, aborted: false };
}

function connect(wsUrl, onConsole) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        entry.resolve(msg);
      } else if (msg.method === "Runtime.consoleAPICalled" && onConsole) {
        try {
          const text = (msg.params.args || [])
            .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type || ""))
            .join(" ");
          onConsole(msg.params.type, text);
        } catch {
          /* ignore */
        }
      }
    };
    ws.onerror = (e) => reject(e instanceof Error ? e : new Error("WebSocket 连接错误"));
    ws.onopen = () =>
      resolve({
        ws,
        send(method, params, timeoutMs = 30000) {
          const i = ++id;
          ws.send(JSON.stringify({ id: i, method, params }));
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(i);
              rej(new Error(`CDP ${method} 超时(${timeoutMs}ms)`));
            }, timeoutMs);
            pending.set(i, { resolve: res, timer });
          });
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      });
  });
}

// ────────────────── 原生「另存为」对话框应答 ──────────────────
// Win32：找 lightmd 进程的 #32770 对话框 → 文件名框(Edit,id=1001) 设为指定绝对路径
// → 真实鼠标点击「保存」(Button,id=1)（辅以 BM_CLICK / WM_COMMAND IDOK 兜底）。
// 路径经环境变量传入，避免任何命令行转义问题。整个过程静默、有界（默认最多等 25s）。

const DIALOG_HELPER_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class LMDlg {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr wp, string lp);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public static IntPtr dlg = IntPtr.Zero;
  public static int want = 0;
  public static bool OnTop(IntPtr h, IntPtr l) {
    int pid; GetWindowThreadProcessId(h, out pid);
    if (pid == want && IsWindowVisible(h)) {
      StringBuilder sb = new StringBuilder(64); GetClassName(h, sb, 64);
      if (sb.ToString() == "#32770") { dlg = h; return false; }
    }
    return true;
  }
  public static IntPtr Find(int pid) { want = pid; dlg = IntPtr.Zero; EnumWindows(new EnumProc(OnTop), IntPtr.Zero); return dlg; }
  public static IntPtr editH = IntPtr.Zero;
  public static bool OnEdit(IntPtr h, IntPtr l) {
    StringBuilder c = new StringBuilder(64); GetClassName(h, c, 64);
    if (c.ToString() == "Edit" && GetDlgCtrlID(h) == 1001) { editH = h; return false; }
    return true;
  }
  public static IntPtr FindEdit(IntPtr h) { editH = IntPtr.Zero; EnumChildWindows(h, new EnumProc(OnEdit), IntPtr.Zero); return editH; }
  public static IntPtr btnH = IntPtr.Zero;
  public static bool OnButton(IntPtr h, IntPtr l) {
    StringBuilder c = new StringBuilder(64); GetClassName(h, c, 64);
    if (c.ToString() == "Button" && GetDlgCtrlID(h) == 1) { btnH = h; return false; }
    return true;
  }
  public static IntPtr FindButton(IntPtr h) { btnH = IntPtr.Zero; EnumChildWindows(h, new EnumProc(OnButton), IntPtr.Zero); return btnH; }
  public static void ClickCenter(IntPtr h) {
    RECT r; if (!GetWindowRect(h, out r)) return;
    int x = (r.L + r.R) / 2, y = (r.T + r.B) / 2;
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }
}
"@
$want = $env:V0110_DLG_PATH
$deadline = (Get-Date).AddSeconds(25)
$done = 0
while ((Get-Date) -lt $deadline -and $done -lt 3) {
  $p = Get-Process lightmd -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { break }
  $h = [LMDlg]::Find($p.Id)
  if ($h -ne [IntPtr]::Zero) {
    [void][LMDlg]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 200
    $e = [LMDlg]::FindEdit($h)
    $b = [LMDlg]::FindButton($h)
    if ($e -ne [IntPtr]::Zero -and $want) { [void][LMDlg]::SendMessage($e, 0x000C, [IntPtr]::Zero, $want) }
    Start-Sleep -Milliseconds 250
    if ($b -ne [IntPtr]::Zero) {
      [LMDlg]::ClickCenter($b)
      Start-Sleep -Milliseconds 250
      [void][LMDlg]::PostMessage($b, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
    } else {
      [void][LMDlg]::PostMessage($h, 0x0111, [IntPtr]1, [IntPtr]::Zero)
    }
    $done = $done + 1
    Start-Sleep -Milliseconds 900
  } else {
    Start-Sleep -Milliseconds 400
  }
}
Write-Output ("dialog-attempts=" + $done)
`;

/**
 * 后台启动「另存为」应答器（不 await：它要在对话框出现前就开始等）。
 * 路径通过环境变量传递，规避命令行转义。
 */
function spawnDialogAnswerer(targetPath) {
  if (!DIALOG_AUTOMATION) return null;
  try {
    const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", DIALOG_HELPER_PS], {
      stdio: "ignore",
      env: { ...process.env, V0110_DLG_PATH: targetPath },
    });
    p.on("error", () => {
      /* 静默：自动化失败不影响主流程，会走人工兜底 */
    });
    return p;
  } catch {
    return null;
  }
}

// ────────────────────── PDF 解析（E2） ──────────────────────
// Chromium/Skia PDF：内容流 Flate 压缩，文本多为 Identity-H 双字节 hex 串，
// 字形→Unicode 依赖各字体自己的 ToUnicode CMap。故：
//   1) 按 N 0 obj 切对象并解压 /FlateDecode 流；
//   2) 逐页取 /Resources /Font 里每个字体的 ToUnicode 表；
//   3) 单遍扫描内容流（跟踪 /Fx Tf），保证书写顺序不乱；
//   4) 逐页统计页数、含页眉/页脚 token 的页数。
// 若某页文本解不出字符，脚本如实报告，不伪造"每页都有"的结论。

function parsePdfObjects(buf) {
  const s = buf.toString("latin1");
  const objs = new Map();
  const re = /(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const num = Number(m[1]);
    const body = m[2];
    let dict = body;
    let text = null;
    const sm = /stream\r?\n/.exec(body);
    if (sm) {
      dict = body.slice(0, sm.index);
      const sIdx = sm.index + sm[0].length;
      const eIdx = body.indexOf("endstream", sIdx);
      const raw = body.slice(sIdx, eIdx >= 0 ? eIdx : body.length);
      if (/\/FlateDecode/.test(dict)) {
        try {
          text = zlib.inflateSync(Buffer.from(raw, "latin1")).toString("latin1");
        } catch {
          text = null;
        }
      } else {
        text = raw;
      }
    }
    objs.set(num, { dict, text });
  }
  return objs;
}

function hexToUnicodeString(hex) {
  const h = hex.replace(/[^0-9A-Fa-f]/g, "");
  let out = "";
  if (h.length % 4 === 0) {
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.substr(i, 4), 16));
  } else if (h.length % 2 === 0) {
    for (let i = 0; i + 2 <= h.length; i += 2) out += String.fromCharCode(parseInt(h.substr(i, 2), 16));
  }
  return out;
}

function buildCmapFromText(text) {
  const cmap = new Map();
  if (!text) return cmap;
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      cmap.set(parseInt(pair[1], 16), hexToUnicodeString(pair[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(r[1], 16);
      const hi = parseInt(r[2], 16);
      const dst = parseInt(r[3], 16);
      for (let c = lo; c <= hi && c - lo < 65536; c++) cmap.set(c, String.fromCharCode(dst + (c - lo)));
    }
    for (const r of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(r[1], 16);
      const items = [...r[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToUnicodeString(x[1]));
      items.forEach((v, i) => cmap.set(lo + i, v));
    }
  }
  return cmap;
}

/**
 * 全文档合并的 ToUnicode 表（仅兜底）。不同子集字体会给同一 code 分配不同字形，
 * 合并必然互相覆盖，所以优先用按页按字体的精确表；此处第一项优先，降低碰撞伤害。
 */
function buildToUnicodeMap(objs) {
  const merged = new Map();
  for (const o of objs.values()) {
    if (!o.text || !/beginbfchar|beginbfrange/.test(o.text)) continue;
    for (const [k, v] of buildCmapFromText(o.text)) if (!merged.has(k)) merged.set(k, v);
  }
  return merged;
}

/** 某页 /Resources /Font 中每个字体的 ToUnicode 表：字体名 → Map(code→字符) */
function parsePageFontMaps(objs, pageDict) {
  const maps = new Map();
  let fontDict = null;
  const inline = /\/Font\s*<<([\s\S]*?)>>/.exec(pageDict);
  if (inline) {
    fontDict = inline[1];
  } else {
    const ref = /\/Font\s+(\d+)\s+\d+\s+R/.exec(pageDict);
    if (ref) {
      const fo = objs.get(Number(ref[1]));
      const inner = fo ? /<<([\s\S]*)>>/.exec(fo.dict) : null;
      if (inner) fontDict = inner[1];
    }
  }
  if (!fontDict) return maps;
  for (const m of fontDict.matchAll(/\/([A-Za-z0-9+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const fobj = objs.get(Number(m[2]));
    if (!fobj) continue;
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fobj.dict);
    if (!tu) continue;
    const cm = objs.get(Number(tu[1]));
    if (!cm || !cm.text) continue;
    maps.set(m[1], buildCmapFromText(cm.text));
  }
  return maps;
}

function decodePdfLiteral(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const nx = str[i + 1];
    if (nx === undefined) break;
    if (nx === "n") out += "\n";
    else if (nx === "r") out += "\r";
    else if (nx === "t") out += "\t";
    else if (nx === "b") out += "\b";
    else if (nx === "f") out += "\f";
    else if (nx >= "0" && nx <= "7") {
      let oct = "";
      let j = i + 1;
      while (j < str.length && oct.length < 3 && str[j] >= "0" && str[j] <= "7") oct += str[j++];
      out += String.fromCharCode(parseInt(oct, 8));
      i = j - 1;
      continue;
    } else out += nx;
    i++;
  }
  return out;
}

function decodePdfHexString(hex, cmap) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  if (cmap && cmap.size > 0) {
    let out = "";
    for (let i = 0; i + 4 <= clean.length; i += 4) {
      const ch = cmap.get(parseInt(clean.substr(i, 4), 16));
      if (ch !== undefined) out += ch;
    }
    if (out) return out;
  }
  let ascii = "";
  for (let i = 0; i + 2 <= clean.length; i += 2) {
    const b = parseInt(clean.substr(i, 2), 16);
    if (b >= 32 && b < 127) ascii += String.fromCharCode(b);
  }
  return ascii;
}

/**
 * 按内容流的**书写顺序**解码文本（单遍扫描，跟踪当前字体）。
 * 单遍很关键：分遍（先所有 Tj 再所有 TJ）会打乱顺序，使被拆成多个
 * 操作符的同一段文本无法拼回。
 */
function extractPdfStreamText(content, fontMaps, fallbackCmap) {
  if (!content) return "";
  const re =
    /\/([A-Za-z0-9+._-]+)\s+[-\d.]+\s+Tf|\(((?:[^()\\]|\\.)*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj|\[((?:[^\[\]])*)\]\s*TJ/g;
  let cur = fallbackCmap || new Map();
  const chunks = [];
  for (const m of content.matchAll(re)) {
    if (m[1] !== undefined) {
      cur = (fontMaps && fontMaps.get(m[1])) || fallbackCmap || new Map();
      continue;
    }
    if (m[2] !== undefined) {
      chunks.push(decodePdfLiteral(m[2]));
      continue;
    }
    if (m[3] !== undefined) {
      chunks.push(decodePdfHexString(m[3], cur));
      continue;
    }
    if (m[4] !== undefined) {
      let acc = "";
      for (const part of m[4].matchAll(/\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>/g)) {
        const tok = part[0];
        if (tok.startsWith("(")) acc += decodePdfLiteral(tok.slice(1, -1));
        else acc += decodePdfHexString(tok.slice(1, -1), cur);
      }
      chunks.push(acc);
    }
  }
  return chunks.join("\n");
}

function analyzePdf(buf) {
  const objs = parsePdfObjects(buf);
  const fallbackCmap = buildToUnicodeMap(objs);
  const pageNums = [];
  for (const [num, o] of objs) {
    if (/\/Type\s*\/Page(?![sA-Za-z])/.test(o.dict) && !/\/Type\s*\/Pages/.test(o.dict)) pageNums.push(num);
  }
  const pageTexts = [];
  let fontCount = 0;
  for (const num of pageNums) {
    const o = objs.get(num);
    const fontMaps = parsePageFontMaps(objs, o.dict);
    fontCount += fontMaps.size;
    const refs = [];
    const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(o.dict);
    if (single) refs.push(Number(single[1]));
    else {
      const arr = /\/Contents\s*\[([^\]]*)\]/.exec(o.dict);
      if (arr) for (const r of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(r[1]));
    }
    const content = refs.map((r) => (objs.get(r) || {}).text || "").join("\n");
    pageTexts.push(extractPdfStreamText(content, fontMaps, fallbackCmap));
  }
  const globalText = [...objs.values()].map((o) => o.text || "").join("\n");
  return {
    pageCount: pageNums.length,
    pageTexts,
    cmapSize: fallbackCmap.size,
    fontsPerPage: pageNums.length ? Math.round(fontCount / pageNums.length) : 0,
    globalText: extractPdfStreamText(globalText, null, fallbackCmap),
  };
}

// ────────────────────── PNG 解码（E3） ──────────────────────

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    return { reason: "bad-signature" };
  }
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (!ihdr) return { reason: "no-ihdr" };
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels || ihdr.bitDepth !== 8 || ihdr.interlace !== 0) {
    return { ihdr, pixels: null, reason: `unsupported(color=${ihdr.colorType},bit=${ihdr.bitDepth},interlace=${ihdr.interlace})` };
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = ihdr.width * bpp;
  const out = Buffer.alloc(stride * ihdr.height);
  let pos = 0;
  for (let y = 0; y < ihdr.height; y++) {
    const ft = raw[pos++];
    const lineStart = pos;
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = raw[lineStart + x];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
  }
  return { ihdr, pixels: out, channels, stride, reason: null };
}

function pngStats(img) {
  const { ihdr, pixels, channels, stride } = img;
  const colors = new Set();
  let ink = 0;
  const rowInk = new Uint32Array(ihdr.height);
  for (let y = 0; y < ihdr.height; y++) {
    for (let x = 0; x < ihdr.width; x++) {
      const i = y * stride + x * channels;
      const r = pixels[i];
      const g = channels >= 3 ? pixels[i + 1] : r;
      const b = channels >= 3 ? pixels[i + 2] : r;
      if (0.299 * r + 0.587 * g + 0.114 * b < 245) {
        ink++;
        rowInk[y]++;
      }
      if (x % 7 === 0 && y % 7 === 0) colors.add((r << 16) | (g << 8) | b);
    }
  }
  let bands = 0;
  let inBand = false;
  for (let y = 0; y < ihdr.height; y++) {
    const has = rowInk[y] > 0;
    if (has && !inBand) {
      bands++;
      inBand = true;
    } else if (!has) inBand = false;
  }
  return {
    width: ihdr.width,
    height: ihdr.height,
    inkPixels: ink,
    inkRatio: ink / (ihdr.width * ihdr.height),
    colors: colors.size,
    bands,
  };
}

function isPng(p) {
  try {
    const fd = fs.openSync(p, "r");
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    return head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a;
  } catch {
    return false;
  }
}

// ────────────────────── 主流程 ──────────────────────

let child = null;
let cdp = null;

async function main() {
  console.log("=== LightMD v0.11.0 导出修复 实机验证（B2-1 / B2-2 / B2-3）===");
  console.log(`打包产物: ${EXE}`);
  console.log(`CDP 端口: ${PORT}  原生对话框等待: ${DIALOG_WAIT_MS}ms  Win32 自动化: ${DIALOG_AUTOMATION ? "开" : "关"}`);

  if (!fs.existsSync(EXE)) {
    console.error("");
    console.error("[退出码 3] 未找到打包产物，无法实机验证。");
    console.error('  请先构建：cd "D:\\AI\\markdown view\\lightmd"; pnpm tauri build');
    process.exit(3);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-v0110-exp-"));
  console.log(`临时目录: ${tmpDir}`);

  // ── 三份验证文档 ──
  const mdE1 = [
    "# v0.11.0 B2-1 导出自包含验证",
    "",
    "行内公式 $E=mc^2$ 与块级公式：",
    "",
    "$$",
    "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
    "$$",
    "",
    "下面是 mermaid 图表：",
    "",
    "```mermaid",
    "graph TD; A[开始]-->B[结束];",
    "```",
    "",
    "正文段落：这段文字用于确认导出的 HTML 不只是空壳。",
    "",
  ].join("\n");
  const mdE3 = [
    "# v0.11.0 B2-3 PNG 公式保真验证",
    "",
    "本段位于公式之前，用于在截图中形成与公式分离的墨迹行带。",
    "",
    "$$",
    "\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}",
    "$$",
    "",
    "公式之后的收尾段落。",
    "",
  ].join("\n");
  const pdfPara =
    "本段用于制造多页 PDF：LightMD 导出验证需要足够长的正文，以证明页眉与页脚在每一页都重复出现，而不是只出现在第一页或最后一页。";
  const mdE2Lines = ["# v0.11.0 B2-2 PDF 多页页眉页脚验证", ""];
  for (let i = 1; i <= 80; i++) {
    mdE2Lines.push(`## 第 ${i} 节`, "", pdfPara.repeat(3), "", `小节 ${i} 补充：${pdfPara}`, "");
  }
  const mdE2 = mdE2Lines.join("\n");

  const docE1 = path.join(tmpDir, "v0110-e1-公式图表.md");
  const docE2 = path.join(tmpDir, "v0110-e2-多页.md");
  const docE3 = path.join(tmpDir, "v0110-e3-公式.md");
  fs.writeFileSync(docE1, mdE1, "utf-8");
  fs.writeFileSync(docE2, mdE2, "utf-8");
  fs.writeFileSync(docE3, mdE3, "utf-8");

  const htmlPath = path.join(tmpDir, "v0110-e1-export.html");
  const pdfPath = path.join(tmpDir, "v0110-e2-export.pdf");
  const pngPath = path.join(tmpDir, "v0110-e3-export.png");

  // ── 启动打包产物 ──
  console.log(`启动应用（WebView2 远程调试 ${PORT}）…`);
  let childExited = false;
  let childExitCode = null;
  child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
    detached: false,
  });
  child.on("exit", (code) => {
    childExited = true;
    childExitCode = code;
  });
  child.on("error", (err) => {
    childExited = true;
    console.error(`启动失败: ${err.message}`);
  });

  const found = await findPageTarget({ aborted: () => childExited });
  if (!found.target) {
    if (childExited) {
      console.error("");
      console.error(`[退出码 4] 应用进程立即退出（code=${childExitCode}）。`);
      console.error("  最可能原因：**已有另一个 LightMD 实例在运行**（tauri-plugin-single-instance：");
      console.error("  第二个进程会把参数转交已有实例后退出，CDP 端口不会打开）。请先关闭后重跑：");
      console.error("    Get-Process lightmd -ErrorAction SilentlyContinue | Stop-Process -Force");
      cleanup();
      process.exit(4);
    }
    console.error("");
    console.error(`[退出码 4] 30s 内未在 ${CDP_BASE} 找到页面调试目标。`);
    console.error("  请确认远程调试端口未被拦截，或用 V0110_EXPORT_PORT 指定其它端口。");
    cleanup();
    process.exit(4);
  }

  const consoleLog = [];
  cdp = await connect(found.target.webSocketDebuggerUrl, (type, text) => {
    if (consoleLog.length < 400) consoleLog.push(`[${type}] ${text}`);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const evalJs = async (expression, timeoutMs = 30000) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error(`eval 失败: ${d.exception?.description || JSON.stringify(d).slice(0, 300)}`);
    }
    return r.result?.result?.value;
  };

  const openFile = async (p, content) => {
    await evalJs(
      `window.dispatchEvent(new CustomEvent("lightmd:openFile",{detail:{path:${JSON.stringify(p)},content:${JSON.stringify(content)}}})); true`,
    );
    await sleep(700);
  };
  /**
   * 等应用主界面挂载 —— 实测教训：应用刚起时 `lightmd:openFile` 监听尚未挂上，
   * 首个事件会丢失，于是「导出」导出的是**会话恢复出来的上一份文档**（曾导致
   * E1 检查跑在 E3 的文档上，得出 mermaid 未触发的假结论）。故必须显式等待。
   */
  const waitAppReady = async () => {
    const ok = await waitForExpr(
      `document.querySelector(".ProseMirror, .tab-bar, .app-sidebar, [data-genie-anchor]")`,
      25000,
    );
    await sleep(800);
    return ok;
  };
  /** 打开文档并校验当前文档确实是它（用源码模式读回比对标记串） */
  const openFileVerified = async (p, content, marker) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await openFile(p, content);
      await runCommand("view.edit");
      await sleep(450);
      const v = await evalJs(
        `(() => { const ta = document.querySelector("textarea.source-editor") || document.querySelector("textarea"); return ta ? ta.value : ""; })()`,
      );
      await runCommand("view.preview");
      await sleep(350);
      if (typeof v === "string" && v.includes(marker)) return true;
      console.log(`  [警告] 第 ${attempt} 次打开文档未生效（当前内容不含标记「${marker}」），重试…`);
      await sleep(900);
    }
    return false;
  };
  const runCommand = async (id) => {
    await evalJs(`window.dispatchEvent(new CustomEvent("lightmd:command",{detail:{id:${JSON.stringify(id)}}})); true`);
    await sleep(350);
  };
  const waitForExpr = async (expr, timeoutMs, intervalMs = 250) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (await evalJs(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`)) return true;
      } catch {
        /* ignore */
      }
      await sleep(intervalMs);
    }
    return false;
  };
  const waitForFile = async (p, timeoutMs, intervalMs = 400) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const st = fs.statSync(p);
        if (st.size > 0) return st.size;
      } catch {
        /* 尚未生成 */
      }
      await sleep(intervalMs);
    }
    return 0;
  };
  /** 目录里最新出现的指定扩展名文件（人工可能把文件存到预填路径之外） */
  const newestFileWithExt = (dir, ext) => {
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(ext))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      return files.length ? path.join(dir, files[0].f) : null;
    } catch {
      return null;
    }
  };

  // ── 应用就绪 + 目标校验（实测：启动瞬间 __TAURI_INTERNALS__ 可能尚未注入，
  //    必须等到 IPC 就绪再做根因探针，否则会得到一堆 undefined 的假 FAIL）──
  const appReady = await waitAppReady();
  const tauriReady = await waitForExpr(`window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke`, 20000);
  // 注意：href 必须在**等待之后**取。启动瞬间页面可能仍是 about:blank，
  // 等 IPC 就绪后才导航到 http://tauri.localhost/；在等待前取值会得到假 FAIL。
  const appTargetInfo = await evalJs(
    `JSON.stringify({ href: location.href, tauri: !!window.__TAURI_INTERNALS__ })`,
  );
  let appHref = "";
  try {
    appHref = String(JSON.parse(appTargetInfo).href || "");
  } catch {
    /* ignore */
  }
  check(
    "环境自检：已连到应用页面且 Tauri IPC 注入完成",
    appReady && tauriReady && /tauri\.localhost|localhost/.test(appHref),
    `${appTargetInfo} 界面就绪=${appReady} IPC就绪=${tauriReady}`,
  );

  // ── 环境自检：为什么不能靠改 invoke 拦截（并如实记录）──
  const patchProbeRaw = await evalJs(`JSON.stringify({
  hasInternals: !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke),
  rootWritable: (Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__") || {}).writable,
  rootConfigurable: (Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__") || {}).configurable,
  invokeWritable: (Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__ || {}, "invoke") || {}).writable,
  invokeConfigurable: (Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__ || {}, "invoke") || {}).configurable,
  pattern: (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.__TAURI_PATTERN__ && window.__TAURI_INTERNALS__.__TAURI_PATTERN__.pattern) || null,
})`);
  let pp = {};
  try {
    pp = JSON.parse(patchProbeRaw);
  } catch {
    /* ignore */
  }
  check(
    "环境自检：__TAURI_INTERNALS__.invoke 不可改写（说明保存对话框无法用 JS 拦截，须走真实对话框）",
    pp.hasInternals === true && pp.invokeWritable === false && pp.invokeConfigurable === false,
    `invoke.writable=${pp.invokeWritable} invoke.configurable=${pp.invokeConfigurable} root.writable=${pp.rootWritable} ipc模式=${pp.pattern}`,
  );

  // ── DOM toast 观察（不依赖任何 invoke 改写；每次导出前重置）──
  const toastLog = async () =>
    JSON.parse((await evalJs(`JSON.stringify(window.__toastLog||[])`)) || "[]");
  /** 重新安装 toast 观察器并清空（万一页面发生过重载，window 上的观察器会丢） */
  const resetToastLog = async () => {
    await evalJs(String.raw`(() => {
  window.__toastLog = [];
  if (!window.__toastObserver && window.MutationObserver) {
    window.__toastObserver = new MutationObserver(function () {
      var nodes = document.querySelectorAll(".notification-toast");
      for (var i = 0; i < nodes.length; i++) {
        var t = (nodes[i].textContent || "").trim();
        if (t && window.__toastLog.indexOf(t) === -1) window.__toastLog.push(t);
      }
    });
    window.__toastObserver.observe(document.body, { childList: true, subtree: true });
  }
  return "ok";
})()`);
  };

  // ── 资源可读性根因探针（B2-1 / B2-3 的共同前提）──
  // 复刻 vendorAssets.resolveAssetPath：resourceDir() + "vendor/katex/katex.min.css"
  const resProbe = await evalJs(`(async () => {
  const out = { ok: false };
  try {
    const dir = await window.__TAURI_INTERNALS__.invoke("plugin:path|resolve_directory", { directory: 11 });
    out.resourceDir = dir;
    out.katexCssExists = await window.__TAURI_INTERNALS__.invoke("plugin:fs|exists", { path: dir + "/vendor/katex/katex.min.css", options: undefined });
    out.katexJsExists = await window.__TAURI_INTERNALS__.invoke("plugin:fs|exists", { path: dir + "/vendor/katex/katex.min.js", options: undefined });
    out.mermaidExists = await window.__TAURI_INTERNALS__.invoke("plugin:fs|exists", { path: dir + "/vendor/mermaid/mermaid.min.js", options: undefined });
    out.ok = true;
  } catch (e) { out.error = String(e && e.message ? e.message : e); }
  try {
    const r = await fetch("/vendor/katex/katex.min.css");
    const t = await r.text();
    out.frontendCss = { status: r.status, bytes: t.length };
  } catch (e) { out.frontendCss = { error: String(e && e.message ? e.message : e) }; }
  return JSON.stringify(out);
})()`);
  let rp = {};
  try {
    rp = JSON.parse(resProbe);
  } catch {
    /* ignore */
  }
  check(
    "E1/E3 前置：能从 webview 源取到 vendor/katex（返修后的真实内联路径）",
    rp.frontendCss?.status === 200 && rp.frontendCss?.bytes > 1000,
    `前端 fetch 状态=${JSON.stringify(rp.frontendCss)}；resourceDir=${rp.resourceDir ?? rp.error}（fs 路径仅作兜底：katexCss=${rp.katexCssExists} katexJs=${rp.katexJsExists} mermaid=${rp.mermaidExists}，为 false 属预期——public/vendor 经 Vite 进 dist 由 webview 提供，未配置 bundle.resources）`,
  );

  // ── 导出对话框操作原语 ──
  const closeDialogs = String.raw`(() => {
  const p = document.querySelector(".pdf-export-close"); if (p) p.click();
  const e = document.querySelector(".export-close"); if (e) e.click();
  return document.querySelectorAll(".export-dialog, .pdf-export-dialog").length;
})()`;
  const ensureNoDialog = async () => {
    for (let i = 0; i < 6; i++) {
      if (!(await evalJs(closeDialogs))) return true;
      await sleep(250);
    }
    return false;
  };
  const openExportDialog = async (formatText) => {
    await ensureNoDialog();
    await runCommand("export.html");
    if (!(await waitForExpr(`document.querySelector(".export-dialog")`, 8000))) {
      return { ok: false, reason: "导出对话框未出现（export.html 命令未生效？）" };
    }
    if (formatText) {
      const r = await evalJs(`(() => {
        const btns = [...document.querySelectorAll(".export-format-group .export-format-btn")];
        const b = btns.find(x => (x.textContent || "").toUpperCase().includes(${JSON.stringify(formatText.toUpperCase())}));
        if (!b) return "no-btn:" + btns.map(x => (x.textContent || "").trim()).join("/");
        b.click();
        return "ok";
      })()`);
      if (r !== "ok") return { ok: false, reason: String(r) };
      await sleep(350);
    }
    return { ok: true };
  };
  const clickExportPrimary = async () =>
    evalJs(`(() => {
      const b = document.querySelector(".export-dialog .export-btn.primary");
      if (!b) return "no-primary";
      if (b.disabled) return "disabled";
      b.click();
      return "ok";
    })()`);

  /**
   * 点击导出后：启动 Win32 应答器 → 轮询产物落盘 → 未落盘则打印人工提示并继续等待。
   * 返回 {size, path}（path 为实际落盘路径）。
   */
  const runExportAndCollect = async (intendedPath, ext, waitMs) => {
    const answerer = spawnDialogAnswerer(intendedPath);
    const t0 = Date.now();
    let size = 0;
    let actual = null;
    let prompted = false;
    while (Date.now() - t0 < waitMs) {
      try {
        const st = fs.statSync(intendedPath);
        if (st.size > 0) {
          size = st.size;
          actual = intendedPath;
          break;
        }
      } catch {
        /* 尚未生成 */
      }
      const newest = newestFileWithExt(path.dirname(intendedPath), ext);
      if (newest && fs.statSync(newest).mtimeMs > t0 - 1000) {
        size = fs.statSync(newest).size;
        actual = newest;
        break;
      }
      if (!prompted && Date.now() - t0 > 6000) {
        prompted = true;
        humanPrompted = true;
        console.log("");
        console.log("  ⚠ 原生「另存为」对话框已弹出。脚本的 Win32 自动化未能落盘时，请手工操作：");
        console.log(`     文件名填入：${intendedPath}`);
        console.log(`     然后点击「保存」（脚本最多再等 ${Math.round((waitMs - 6000) / 1000)} 秒）`);
        console.log("");
      }
      await sleep(400);
    }
    try {
      answerer?.kill();
    } catch {
      /* ignore */
    }
    return { size, path: actual };
  };

  // ═══════════════════════ E1（B2-1）：HTML 自包含/离线 ═══════════════════════
  const openedE1 = await openFileVerified(docE1, mdE1, "B2-1 导出自包含验证");
  check(
    "E1 环境：待导出文档已就位（避免导出会话恢复的旧文档）",
    openedE1,
    `文档校验=${openedE1}`,
  );
  const odE1 = await openExportDialog("HTML");
  let e1Done = false;
  if (!odE1.ok) {
    check("E1 打开导出对话框并选中 HTML 格式", false, odE1.reason);
  } else {
    await resetToastLog();
    const clicked = await clickExportPrimary();
    const got = clicked === "ok" ? await runExportAndCollect(htmlPath, ".html", DIALOG_WAIT_MS) : { size: 0, path: null };
    e1Done = got.size > 0 && !!got.path;
    check(
      "E1-0 导出 HTML 真实落盘（原生「另存为」对话框已应答）",
      clicked === "ok" && e1Done,
      `click=${clicked} 文件=${got.size ? `${kb(got.size)} @ ${got.path}` : "未生成"}（若一直未生成：请按上方提示手工应答对话框后重跑）`,
    );

    if (e1Done) {
      const html = fs.readFileSync(got.path, "utf-8");
      const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
      const external = refs.filter((u) => /^https?:|^\/\//i.test(u));
      const cssUrlExternal = html.match(/url\(\s*["']?(https?:|\/\/)/gi) || [];
      const cdnKatex = /cdn\.jsdelivr\.net[^"']*katex/i.test(html) || /unpkg\.com[^"']*katex/i.test(html);
      const cdnMermaid = /cdn\.jsdelivr\.net[^"']*mermaid/i.test(html) || /unpkg\.com[^"']*mermaid/i.test(html);
      const fontDataCount = (html.match(/data:font\/[a-z0-9]+;base64,/gi) || []).length;
      const katexCssInlined = /\.katex\s*\{/.test(html);
      // 内联的 KaTeX 库 = 无 src 的 <script> 且体量巨大（katex.min.js ≈ 271KB）；
      // 仅凭 "katex.render" 判断会被 buildKatexRenderScript 的渲染脚本骗过（首版踩过）
      const maxInlineScript = Math.max(
        0,
        ...[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].length),
      );
      const katexJsInlined = maxInlineScript > 100_000;
      const sidecar = path.join(path.dirname(got.path), "_assets", "mermaid.min.js");
      let sidecarSize = 0;
      try {
        sidecarSize = fs.statSync(sidecar).size;
      } catch {
        sidecarSize = 0;
      }
      const localMermaidRef = /_assets\/mermaid\.min\.js/.test(html) && !/https?:\/\/[^"']*mermaid/i.test(html);
      const strict = /securityLevel\s*:\s*["']strict["']/.test(html);
      const loose = /securityLevel\s*:\s*["']loose["']/.test(html);
      const hasMermaidMarker = html.includes('class="mermaid"');
      const hasMathMarker = /data-math="block"|data-math="inline"/.test(html);

      check(
        "E1-a 导出 HTML 体量符合自包含预期（内联 KaTeX 后应 >100KB）",
        got.size > 100_000,
        `${kb(got.size)}；字体 data URL ${fontDataCount} 处；文档触发 mermaid=${hasMermaidMarker} math=${hasMathMarker}`,
      );
      check(
        "E1-b 无任何绝对 http(s)/CDN 外部引用（离线保证）",
        external.length === 0 && cssUrlExternal.length === 0 && !cdnKatex && !cdnMermaid,
        `外部引用=${external.length}${external.length ? ` [${external.slice(0, 3).join(" , ")}]` : ""} css(url)=${
          cssUrlExternal.length
        } katexCDN=${cdnKatex} mermaidCDN=${cdnMermaid}`,
      );
      check(
        "E1-c KaTeX CSS/JS 内联 + 字体 base64 data URL（@font-face）",
        katexCssInlined && katexJsInlined && fontDataCount >= 20,
        `katexCss=${katexCssInlined} katexJs内联(最大内联script ${kb(maxInlineScript)})=${katexJsInlined} 字体 data URL=${fontDataCount}`,
      );
      check(
        "E1-d mermaid 旁置 _assets/mermaid.min.js 且被相对路径引用",
        hasMermaidMarker ? localMermaidRef && sidecarSize > 1_000_000 : false,
        `HTML 相对引用=${localMermaidRef} 旁置文件=${sidecarSize ? kb(sidecarSize) : "不存在"} mermaid标记=${hasMermaidMarker}`,
      );
      check("E1-e mermaid securityLevel 为 strict（无 loose）", strict && !loose, `strict=${strict} loose=${loose}`);
      console.log(
        `[E1] ${got.path}  ${kb(got.size)}  外部引用=${external.length}  字体dataURL=${fontDataCount}  旁置mermaid=${
          sidecarSize ? kb(sidecarSize) : "无"
        }`,
      );
      console.log(
        "[E1] 离线说明：脚本未断开本机网络（不修改系统网络配置）。离线保证由三项静态断言证明：无任何 http(s) 绝对引用 + KaTeX CSS/JS/字体全部内联 + mermaid 为同目录旁置文件。",
      );
    } else {
      skip("E1-a/b/c/d/e", "导出 HTML 未生成（原生「另存为」对话框未被应答）→ 无法验证产物内容");
    }
  }

  // ═══════════════════════ E2（B2-2）：PDF 每页页眉页脚 ═══════════════════════
  await openFileVerified(docE2, mdE2, "B2-2 PDF 多页页眉页脚验证");
  const odE2 = await openExportDialog("PDF");
  if (!odE2.ok) {
    check("E2 打开导出对话框并选中 PDF 格式", false, odE2.reason);
    skip("E2-a/b/c/d/e/f/g/h", "导出对话框不可用");
  } else {
    const clickedPdf = await clickExportPrimary();
    const pdfDialogUp = await waitForExpr(`document.querySelector(".pdf-export-dialog")`, 8000);
    check(
      "E2-0 进入 PDF 选项对话框（PdfExportDialog）",
      clickedPdf === "ok" && pdfDialogUp,
      `click=${clickedPdf} 选项对话框=${pdfDialogUp}`,
    );

    if (pdfDialogUp) {
      const uiRaw = await evalJs(String.raw`(() => {
  const dlg = document.querySelector(".pdf-export-dialog");
  if (!dlg) return JSON.stringify({ present: false });
  const labels = [...dlg.querySelectorAll("label")].map(l => (l.textContent || "").trim());
  const selects = [...dlg.querySelectorAll("select")].map(s => ({
    cls: s.className,
    options: [...s.options].map(o => o.value),
  }));
  const inputs = [...dlg.querySelectorAll("input")].map(i => ({
    cls: i.className,
    placeholder: i.placeholder || "",
    readOnly: !!i.readOnly,
  }));
  const hints = [...dlg.querySelectorAll(".pdf-export-hint")].map(h => (h.textContent || "").trim());
  return JSON.stringify({ present: true, labels, selects, inputs, hints });
})()`);
      let ui = {};
      try {
        ui = JSON.parse(uiRaw);
      } catch {
        /* ignore */
      }
      const hasPageNumberControl =
        (ui.labels || []).some((l) => l.includes("页码")) ||
        (ui.selects || []).some((s) => (s.options || []).some((v) => /bottom|page-number/i.test(v)));
      const stalePageTexts = [...(ui.hints || []), ...(ui.inputs || []).map((i) => i.placeholder || "")].filter((t) =>
        t.includes("{page}"),
      );
      check(
        "E2-d PDF 选项 UI 已无「页码格式」控件（降级为仅页脚）",
        hasPageNumberControl === false,
        `labels=[${(ui.labels || []).join("|")}] selects=${JSON.stringify((ui.selects || []).map((s) => s.options))}`,
      );
      check(
        "E2-e UI 文案不再宣传 {page} 变量（诚实降级，无残留误导）",
        stalePageTexts.length === 0,
        stalePageTexts.length ? `仍出现 {page} 的文案：${JSON.stringify(stalePageTexts)}` : "无 {page} 残留",
      );

      const setReactInput = (selector, index, value) => `(() => {
  const els = document.querySelectorAll(${JSON.stringify(selector)});
  const el = els[${index}];
  if (!el) return "no-el";
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return "ok";
})()`;
      const setHeader = await evalJs(setReactInput(".pdf-export-input", 1, HEADER_TOKEN));
      const setFooter = await evalJs(setReactInput(".pdf-export-input", 2, FOOTER_TOKEN));
      await sleep(300);
      const readBack = await evalJs(`JSON.stringify([...document.querySelectorAll(".pdf-export-input")].map(i => i.value))`);
      check(
        "E2-1 页眉/页脚输入框已写入唯一令牌",
        String(readBack).includes(HEADER_TOKEN) && String(readBack).includes(FOOTER_TOKEN),
        `setHeader=${setHeader} setFooter=${setFooter} 值=${readBack}`,
      );

      // 抢在 Rust 删除前快照真正送交 Edge 的临时 HTML（export_html_to_pdf 的入参）
      const tempWatch = (async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < DIALOG_WAIT_MS + 120_000) {
          try {
            const s = fs.readFileSync(TEMP_EXPORT_HTML, "utf-8");
            if (s.length > 200) return s;
          } catch {
            /* 尚未写出 */
          }
          await sleep(80);
        }
        return null;
      })();

      const pdfClicked = await evalJs(`(() => {
  const b = document.querySelector(".pdf-export-btn.primary");
  if (!b) return "no-btn";
  b.click();
  return "ok";
})()`);
      const gotPdf =
        pdfClicked === "ok"
          ? await runExportAndCollect(pdfPath, ".pdf", DIALOG_WAIT_MS + 60_000)
          : { size: 0, path: null };
      check(
        "E2-a PDF 落盘且体量非平凡",
        gotPdf.size > 10_000,
        `click=${pdfClicked} 文件=${gotPdf.size ? `${kb(gotPdf.size)} @ ${gotPdf.path}` : "未生成"}`,
      );

      // ── 实现层：真正送交 Edge 的临时 HTML ──
      const pdfHtml = await tempWatch;
      if (pdfHtml) {
        const probe = {
          hasHeaderDiv: pdfHtml.includes('class="pdf-header"'),
          hasFooterDiv: pdfHtml.includes('class="pdf-footer"'),
          fixedHeader: /\.pdf-header\s*\{[^}]*position:\s*fixed/.test(pdfHtml),
          fixedFooter: /\.pdf-footer\s*\{[^}]*position:\s*fixed/.test(pdfHtml),
          marginBox: /@top-center|@bottom-center|@top-left|@bottom-left|@bottom-right|counter\(\s*page\s*\)/.test(pdfHtml),
          pageRule: (pdfHtml.match(/@page\s*\{[\s\S]*?\}/) || [""])[0].replace(/\s+/g, " ").slice(0, 140),
          headerOffset: (pdfHtml.match(/\.pdf-header\s*\{[^}]*?(?:top|bottom):\s*(-?[\d.]+mm)/) || [])[1] || null,
          footerOffset: (pdfHtml.match(/\.pdf-footer\s*\{[^}]*?(?:top|bottom):\s*(-?[\d.]+mm)/) || [])[1] || null,
          headerText: pdfHtml.includes(HEADER_TOKEN),
          footerText: pdfHtml.includes(FOOTER_TOKEN),
        };
        check(
          "E2-f 送交 Edge 的 HTML 用 position:fixed 真实元素承载页眉页脚",
          probe.hasHeaderDiv && probe.hasFooterDiv && probe.fixedHeader && probe.fixedFooter,
          `headerDiv=${probe.hasHeaderDiv} footerDiv=${probe.hasFooterDiv} fixed=${probe.fixedHeader}/${probe.fixedFooter} 令牌=${probe.headerText}/${probe.footerText} 偏移(header=${probe.headerOffset} footer=${probe.footerOffset}) @page=${probe.pageRule}`,
        );
        check(
          "E2-g @page 内不再有 margin box / counter(page)（旧实现已清除）",
          probe.marginBox === false,
          `marginBox/counter(page) 命中=${probe.marginBox} @page=${probe.pageRule}`,
        );
      } else {
        skip("E2-f/E2-g", `未能抢到临时 HTML 快照（${TEMP_EXPORT_HTML} 未出现或被提前删除）`);
      }

      // ── 产物层：解析 PDF，验证逐页重复 ──
      if (gotPdf.size > 0) {
        let pdfInfo = null;
        try {
          pdfInfo = analyzePdf(fs.readFileSync(gotPdf.path));
        } catch (err) {
          console.error("[E2] PDF 解析异常:", err.message);
        }
        if (!pdfInfo) {
          check("E2-b 页数 > 1（多页文档确实跨页）", false, "PDF 解析失败");
          skip("E2-c/E2-h", "PDF 解析失败，无法证明逐页重复");
        } else {
          const pageCount = pdfInfo.pageCount;
          const norm = (s) => String(s).replace(/\s+/g, "");
          const missingHeader = pdfInfo.pageTexts.map((t, i) => (norm(t).includes(HEADER_TOKEN) ? -1 : i)).filter((i) => i >= 0);
          const missingFooter = pdfInfo.pageTexts.map((t, i) => (norm(t).includes(FOOTER_TOKEN) ? -1 : i)).filter((i) => i >= 0);
          const withHeader = pageCount - missingHeader.length;
          const withFooter = pageCount - missingFooter.length;
          const decodedChars = pdfInfo.pageTexts.reduce((a, t) => a + t.replace(/\s/g, "").length, 0);
          const method = decodedChars
            ? `逐页内容流解码(合并ToUnicode ${pdfInfo.cmapSize} 项, 每页字体 ${pdfInfo.fontsPerPage} 个, 解出 ${decodedChars} 字符)`
            : "无法解码文本";
          check("E2-b 页数 > 1（多页文档确实跨页）", pageCount > 1, `页数=${pageCount}`);
          if (decodedChars > 0) {
            check(
              "E2-c 页眉与页脚在每一页都出现（fixed 元素逐页重复）",
              pageCount > 1 && withHeader === pageCount && withFooter === pageCount,
              `含页眉页=${withHeader}/${pageCount}（缺 ${missingHeader.join(",") || "无"}）含页脚页=${withFooter}/${pageCount}（缺 ${
                missingFooter.join(",") || "无"
              }）; ${method}` +
                (missingFooter.includes(0) || missingHeader.includes(pageCount - 1)
                  ? "。注：实测 Edge --print-to-pdf 下『首页缺页脚 / 末页缺页眉』与 generateFixedMarginBoxCss 的**负 offset**（top:-Nmm / bottom:-Nmm）强相关；同机把 offset 改为 0/正值时 9/9 页齐全。"
                  : ""),
            );
          } else {
            check(
              "E2-c 页眉与页脚在每一页都出现（fixed 元素逐页重复）",
              false,
              `PDF 文本不可解码（ToUnicode ${pdfInfo.cmapSize} 项）→ 本项无法自动判定，不伪造结论。页数=${pageCount}`,
            );
          }
          // Chromium 默认页眉页脚泄漏（--print-to-pdf-no-header 实测无效 → 每页带内部临时路径与 x/y 页码）
          const allNorm = norm(pdfInfo.pageTexts.join(""));
          const leakUrl = allNorm.includes("file:///") || allNorm.includes("export_temp.html") || allNorm.includes("lightmd-export");
          const leakPageNo = /\d{1,3}\/\d{1,3}/.test(allNorm);
          check(
            "E2-h 成品 PDF 不含 Chromium 默认页眉页脚（内部临时路径 / x/y 页码）",
            !leakUrl && !leakPageNo,
            `泄漏临时路径=${leakUrl} 泄漏x/y页码=${leakPageNo}（Edge 154 实测 --print-to-pdf-no-header 无效，应改用 --no-pdf-header-footer）`,
          );
          console.log(`[E2] ${gotPdf.path}  ${kb(gotPdf.size)}  页数=${pageCount}  含页眉页=${withHeader}  含页脚页=${withFooter}  ${method}`);
        }
      } else {
        check("E2-b 页数 > 1（多页文档确实跨页）", false, "PDF 未生成");
        skip("E2-c/E2-h", "PDF 未生成（原生「另存为」对话框未被应答）");
      }
    } else {
      skip("E2-d/e/f/g/h", "未能进入 PDF 选项对话框");
    }
  }

  // ═══════════════════════ E3（B2-3）：PNG 公式字形 ═══════════════════════
  await openFileVerified(docE3, mdE3, "B2-3 PNG 公式保真验证");
  const odE3 = await openExportDialog("PNG");
  if (!odE3.ok) {
    check("E3 打开导出对话框并选中 图片(PNG) 格式", false, odE3.reason);
  } else {
    await resetToastLog();
    const consoleMark = consoleLog.length; // 只统计本次导出期间产生的控制台日志
    const clicked = await clickExportPrimary();
    const got = clicked === "ok" ? await runExportAndCollect(pngPath, ".png", DIALOG_WAIT_MS) : { size: 0, path: null };
    const toasts = await toastLog();
    const consoleDuring = consoleLog.slice(consoleMark).join("\n");
    // 双通道取证：DOM toast（3.5s 后自动消失）+ 控制台 notify() 日志（page 重载也丢不掉）
    const fontWarn =
      toasts.some((t) => t.includes("未能加载公式字体")) || consoleDuring.includes("未能加载公式字体");
    const e3Done = got.size > 0 && !!got.path;
    check(
      "E3-a PNG 落盘且 PNG 签名合法",
      e3Done && isPng(got.path) && got.size > 10_000,
      `click=${clicked} 文件=${got.size ? `${kb(got.size)} @ ${got.path}` : "未生成"}`,
    );

    let stats = null;
    if (e3Done && isPng(got.path)) {
      try {
        const img = decodePng(fs.readFileSync(got.path));
        stats = img.pixels ? pngStats(img) : null;
        if (!stats) console.error(`[E3] PNG 解码降级: ${img.reason}`);
      } catch (err) {
        console.error("[E3] PNG 解码异常:", err.message);
      }
    }
    check(
      "E3-b PNG 可解码且非空白（有真实绘制内容）",
      !!stats && stats.width >= 1000 && stats.inkRatio > 0.002 && stats.colors > 5 && stats.bands >= 2,
      stats
        ? `${stats.width}x${stats.height} 墨迹占比=${(stats.inkRatio * 100).toFixed(3)}% 采样色数=${stats.colors} 内容行带=${stats.bands}`
        : "无法解码或非 8bit 非隔行 PNG",
    );
    if (e3Done) {
      check(
        "E3-c 导出过程中应用未告警「未能加载公式字体」（=fontEmbedCSS 已提供，字体确已嵌入）",
        fontWarn === false,
        fontWarn
          ? `捕获到应用自身告警「未能加载公式字体，导出的图片中公式可能显示异常」（toast=${JSON.stringify(
              toasts.filter((t) => t.includes("未能加载公式字体")),
            )}）→ 说明 renderKatexCss() 返回 null、fontEmbedCSS 未提供`
          : `toast=${JSON.stringify(toasts)} 控制台无字体告警`,
      );
    } else {
      skip("E3-c", "PNG 未生成（原生「另存为」对话框未被应答）→ 无 toast 证据可采信");
    }

    // ── 归档 + 视觉对照（字形正确性须人工目视，脚本不伪造判定）──
    let archived = null;
    let previewShot = null;
    try {
      fs.mkdirSync(VERIFY_OUT, { recursive: true });
      if (e3Done) {
        archived = path.join(VERIFY_OUT, "v0110-png-formula.png");
        fs.copyFileSync(got.path, archived);
      }
    } catch (err) {
      console.error("[E3] 归档导出 PNG 失败:", err.message);
    }
    try {
      const renderInfo = await evalJs(`(async () => {
  const latex = "\\\\sum_{n=1}^{\\\\infty} \\\\frac{1}{n^2} = \\\\frac{\\\\pi^2}{6}";
  if (!window.katex) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "/vendor/katex/katex.min.js";
      s.onload = res;
      s.onerror = () => rej(new Error("katex script load failed"));
      document.head.appendChild(s);
    });
  }
  let box = document.getElementById("__v0110_probe_box");
  if (!box) {
    box = document.createElement("div");
    box.id = "__v0110_probe_box";
    box.style.cssText = "position:fixed;left:24px;top:24px;z-index:2147483647;background:#fff;color:#000;padding:16px 20px;border:1px solid #999;width:820px;font-size:16px;box-sizing:border-box";
    document.body.appendChild(box);
  }
  box.innerHTML = '<div style="font:12px sans-serif;color:#666;margin-bottom:8px">KaTeX 参照渲染（前端 /vendor/katex）</div><div id="__v0110_probe_math"></div>';
  katex.render(latex, document.getElementById("__v0110_probe_math"), { displayMode: true, throwOnError: false });
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const el = document.getElementById("__v0110_probe_math");
  const r = el.getBoundingClientRect();
  return JSON.stringify({
    hasKatex: !!window.katex,
    w: Math.round(r.width), h: Math.round(r.height),
    glyphEls: el.querySelectorAll(".mord,.mbin,.mrel,.mfrac").length,
    fontMain: document.fonts ? document.fonts.check("16px KaTeX_Main") : null,
  });
})()`);
      console.log(`[E3] 页面内 KaTeX 参照渲染: ${renderInfo}`);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      if (shot.result?.data) {
        previewShot = path.join(VERIFY_OUT, "v0110-preview-formula.png");
        fs.writeFileSync(previewShot, Buffer.from(shot.result.data, "base64"));
      }
      await evalJs(`(() => { const b = document.getElementById("__v0110_probe_box"); if (b) b.remove(); return "ok"; })()`);
    } catch (err) {
      console.error("[E3] 页面内参照渲染/截图失败:", err.message);
    }
    skip(
      "E3-d 公式字形是否真正正确（KaTeX 字形 vs 回退字体）",
      `视觉判定项。请目视比对：导出图 ${archived || "(未归档)"} 与页面内 KaTeX 参照图 ${
        previewShot || "(未截图)"
      }。脚本不断言此项（像素级字体判定不可靠，不伪造结论）。`,
    );
  }

  // ═══ 汇总 ═══
  console.log("");
  console.log("=== LightMD v0.11.0 导出三项修复 实机验证结果 ===");
  for (const line of results) console.log(line);
  console.log(`共 ${results.length} 项，失败 ${failed} 项，跳过（含人工目视项）${skipped} 项`);
  if (humanPrompted) {
    console.log("注意：本次运行出现过「需人工应答原生保存对话框」的等待；若有条目因此跳过，本次结果不构成导出行为的完整结论。");
  }
  console.log("");
  console.log("产物路径：");
  console.log(`  临时目录: ${tmpDir}`);
  console.log(`  归档目录: ${VERIFY_OUT}`);
  if (consoleLog.length) {
    const hits = consoleLog.filter((l) => l.includes("读取资源失败") || l.includes("字体") || l.includes("导出"));
    if (hits.length) {
      console.log("");
      console.log("页面控制台中的导出/资源相关告警（B2-1 / B2-3 根因线索）：");
      for (const l of hits.slice(0, 10)) console.log(`  ${l}`);
    }
  }
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

function killChildTree() {
  if (!child || !child.pid) return;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  try {
    const t = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    t.on("error", () => {
      /* ignore */
    });
  } catch {
    /* ignore */
  }
}

function cleanup() {
  try {
    cdp?.close();
  } catch {
    /* ignore */
  }
  killChildTree();
}

/** 仅当本文件被直接执行时才跑主流程（便于复用下面的纯解析函数做离线自检） */
const isEntryPoint = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
})();

if (isEntryPoint) {
  const WATCHDOG_MS = Number(process.env.V0110_EXPORT_WATCHDOG_MS || 12 * 60 * 1000);
  const watchdog = setTimeout(() => {
    console.error(`\n[退出码 2] 看门狗超时（${WATCHDOG_MS}ms），强制结束。`);
    cleanup();
    process.exit(2);
  }, WATCHDOG_MS);
  watchdog.unref?.();

  main()
    .then(() => cleanup())
    .catch((err) => {
      console.error("验证脚本执行失败:", err && err.stack ? err.stack : err);
      cleanup();
      process.exit(2);
    });
}

export { analyzePdf, parsePdfObjects, parsePageFontMaps, decodePng, pngStats, buildToUnicodeMap, extractPdfStreamText };
