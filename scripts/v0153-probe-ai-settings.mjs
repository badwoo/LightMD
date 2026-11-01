/**
 * LightMD v0.15.3 实机探针：AI 设置树 / 780px 设置窗 / Ollama 模型探测与上下文滑条。
 *
 * 判据全部来自真实 WebView2 DOM 与真实 Tauri 命令（不走 mock）：
 * E1 设置窗宽度 == 780（父窗口足够宽时），且 AI 树依次为 模型配置 → AI 翻译 → AI 指令库
 * E2 默认服务商 ollama、无需密钥、地址为 127.0.0.1:11434/v1
 * E3 点「获取模型列表」后出现 qwen3-vl:8b-instruct，并带 262144 上下文
 * E4 选择该模型后出现上下文滑条，默认停在最大档（262K）
 * E5 「测试连接」返回成功
 * E6 总开关关闭时整棵子树消失，开启后恢复
 *
 * 用法：node scripts/v0153-probe-ai-settings.mjs
 * 环境变量：V0153AI_PORT（默认 9313）、V0153AI_EXE、V0153AI_TAG
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = "D:\\AI\\markdown view\\lightmd";
const EXE = process.env.V0153AI_EXE || path.join(ROOT, "src-tauri", "target", "release", "lightmd.exe");
const PORT = Number(process.env.V0153AI_PORT || 9313);
const TAG = process.env.V0153AI_TAG || "";
const OUT_DIR = path.join(ROOT, "_verify-out");
const OUT_TXT = path.join(OUT_DIR, `v0153-ai-settings${TAG}.txt`);
const OUT_JSON = path.join(OUT_DIR, `v0153-ai-settings${TAG}.json`);
const DIST_INDEX = path.join(ROOT, "dist", "index.html");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = [];
const log = (line = "") => {
  lines.push(line);
  console.log(line);
};

function verifyExeHasDist() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到打包产物：${EXE}\n请先执行：npx tauri build --no-bundle`);
  if (!fs.existsSync(DIST_INDEX)) throw new Error("找不到 dist/index.html");
  const html = fs.readFileSync(DIST_INDEX, "utf-8");
  const match = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html);
  if (!match) throw new Error("dist/index.html 找不到入口 hash");
  if (!fs.readFileSync(EXE).includes(Buffer.from(match[1], "utf-8"))) {
    throw new Error(`exe 内联 dist 与当前 dist 不一致（找不到 ${match[1]}）→ 请 npx tauri build --no-bundle`);
  }
  log(`[probe] exe 内联 dist 校验通过：${match[1]}`);
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
      const item = pending.get(msg.id);
      if (!item) return;
      pending.delete(msg.id);
      if (msg.error) item.rej(new Error(JSON.stringify(msg.error)));
      else item.res(msg);
    });
    ws.addEventListener("error", () => reject(new Error(`WebSocket 连接失败：${wsUrl}`)));
  });
}

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  verifyExeHasDist();

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lightmd-ai-probe-"));
  const profile = path.join(tmpRoot, "profile");
  fs.mkdirSync(profile, { recursive: true });

  try {
    execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
  } catch {
    /* 没有在跑的实例 */
  }
  await sleep(1200);

  spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
    stdio: "ignore",
    detached: false,
  });

  let cdp = null;
  for (let attempt = 0; attempt < 120 && !cdp; attempt++) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })
      ).json();
      for (const target of list) {
        if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
        try {
          const candidate = await connect(target.webSocketDebuggerUrl);
          await candidate.send("Runtime.enable");
          const ready = await candidate.send("Runtime.evaluate", {
            expression: `typeof window.__TAURI_INTERNALS__ !== "undefined"`,
            returnByValue: true,
          });
          if (ready.result?.result?.value === true) {
            cdp = candidate;
            break;
          }
          candidate.close();
        } catch {
          /* 页面还没就绪 */
        }
      }
    } catch {
      /* 端口还没起来 */
    }
    if (!cdp) await sleep(500);
  }
  if (!cdp) throw new Error("找不到 WebView2 CDP target");

  const evaluate = async (body) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.result?.exceptionDetails) {
      throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 1200));
    }
    return result.result?.result?.value;
  };

  const waitFor = async (expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await evaluate(`return (${expression});`);
      if (value) return value;
      await sleep(200);
    }
    return null;
  };

  const openSettings = async () => {
    await evaluate(`
      window.dispatchEvent(new CustomEvent("lightmd:command", { detail: { id: "view.settings" } }));
      return true;
    `);
    return waitFor(`!!document.querySelector('[data-testid="settings-dialog"], .settings-dialog')`);
  };

  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    await evaluate(`localStorage.clear(); location.reload(); return true;`);
    await sleep(3500);
    await waitFor(`!!document.querySelector('.toolbar, .app-shell, #root > *')`);

    if (!(await openSettings())) throw new Error("设置弹窗未打开");

    // E2：默认 Ollama 与免密钥
    await waitFor(`!!document.querySelector('[data-testid="ai-model-provider"]')`, 10000);
    const initial = await evaluate(`
      const q = (id) => document.querySelector('[data-testid="' + id + '"]');
      const enabled = q("ai-enabled");
      if (enabled && enabled.value !== "on") {
        enabled.value = "on";
        enabled.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 400));
      return {
        provider: q("ai-model-provider")?.value,
        baseUrl: q("ai-model-base-url")?.value,
        noAuth: !!q("ai-model-no-auth"),
        dialogWidth: document.querySelector(".settings-dialog")?.getBoundingClientRect().width,
        viewport: window.innerWidth,
        tree: Array.from(document.querySelectorAll(".ai-tree-children > section"))
          .map((node) => node.getAttribute("data-testid")),
      };
    `);
    check("E1 设置窗宽度 780px（窄窗口按视口收缩）",
      initial.dialogWidth === Math.min(780, initial.viewport - 32),
      `dialog=${initial.dialogWidth} viewport=${initial.viewport}`);
    check("E1 AI 树顺序为 模型配置 → AI 翻译 → AI 指令库",
      JSON.stringify(initial.tree) === JSON.stringify(["ai-model-settings", "translate-section", "ai-instruction-section"]),
      JSON.stringify(initial.tree));
    check("E2 默认服务商为 Ollama 且无需密钥",
      initial.provider === "ollama" && initial.noAuth === true && initial.baseUrl === "http://127.0.0.1:11434/v1",
      JSON.stringify(initial));

    // E3：真实拉取 Ollama 模型目录
    await evaluate(`
      document.querySelector('[data-testid="ai-model-fetch"]').click();
      return true;
    `);
    const fetchNotice = await waitFor(
      `(() => {
        const node = document.querySelector('[data-testid="ai-model-provider-notice"]');
        return node ? node.textContent : null;
      })()`,
      45000,
    );
    const catalog = await evaluate(`
      const list = document.querySelector('datalist[id$="-provider-models"]');
      return list ? Array.from(list.querySelectorAll("option")).map((o) => o.value) : [];
    `);
    check("E3 获取模型列表成功", Boolean(fetchNotice) && /成功|更新|updated/i.test(fetchNotice || ""), `notice=${fetchNotice}`);
    check("E3 检出本机 qwen3-vl:8b-instruct",
      catalog.some((id) => id === "qwen3-vl:8b-instruct"),
      JSON.stringify(catalog));

    // E4：选择模型 → 上下文滑条出现在最大档
    await evaluate(`
      const input = document.querySelector('[data-testid="ai-model-name"]');
      // React 受控输入：必须走原型 setter，直接赋 value 不会触发 onChange。
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "qwen3-vl:8b-instruct");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      return true;
    `);
    const slider = await waitFor(`(() => {
      const el = document.querySelector('[data-testid="ai-model-context-slider"]');
      if (!el) return null;
      return { max: el.max, value: el.value, label: document.querySelector('[data-testid="ai-model-context"] output')?.textContent };
    })()`);
    check("E4 选择模型后出现上下文滑条并停在最大档",
      Boolean(slider) && slider.value === slider.max && /262/.test(slider?.label || ""),
      JSON.stringify(slider));

    // E5：测试连接（真实 1-token 请求）
    await evaluate(`
      document.querySelector('[data-testid="ai-model-test"]').click();
      return true;
    `);
    const testNotice = await waitFor(
      `(() => {
        const node = document.querySelector('[data-testid="ai-model-provider-notice"]');
        const text = node ? node.textContent : "";
        return /成功|success/i.test(text) ? text : null;
      })()`,
      60000,
    );
    check("E5 Ollama 测试连接成功", Boolean(testNotice), `notice=${testNotice}`);

    // E6：总开关关闭 → 子树消失；开启 → 恢复
    const collapsed = await evaluate(`
      const enabled = document.querySelector('[data-testid="ai-enabled"]');
      enabled.value = "off";
      enabled.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return !document.querySelector('[data-testid="ai-model-settings"]') &&
        !document.querySelector('[data-testid="translate-section"]') &&
        !document.querySelector('[data-testid="ai-instruction-section"]');
    `);
    const restored = await evaluate(`
      const enabled = document.querySelector('[data-testid="ai-enabled"]');
      enabled.value = "on";
      enabled.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return !!document.querySelector('[data-testid="ai-model-settings"]');
    `);
    check("E6 总开关关闭折叠整棵子树、开启恢复", collapsed === true && restored === true,
      `collapsed=${collapsed} restored=${restored}`);

    // E7：自定义模型 API 页签的三协议与六档推理
    const custom = await evaluate(`
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      const tab = tabs.find((node) => /custom|自定义/i.test(node.textContent || ""));
      tab.click();
      await new Promise((r) => setTimeout(r, 250));
      const protocol = document.querySelector('[data-testid="ai-model-custom-protocol"]');
      const add = document.querySelector('[data-testid="ai-model-custom-add-model"]');
      add.click();
      await new Promise((r) => setTimeout(r, 250));
      const reasoning = document.querySelector('[data-testid="ai-model-custom-model-reasoning-0"]');
      return {
        protocols: protocol ? Array.from(protocol.options).map((o) => o.value) : [],
        reasoning: reasoning ? Array.from(reasoning.options).map((o) => o.value) : [],
        providerIdReadonly: document.querySelector('[data-testid="ai-model-custom-provider-id"]')?.readOnly,
      };
    `);
    check("E7 自定义 API 支持三种协议",
      JSON.stringify(custom.protocols) === JSON.stringify(["openai-chat", "openai-responses", "anthropic-messages"]),
      JSON.stringify(custom.protocols));
    check("E7 模型目录支持 off/low/medium/high/xhigh/max 六档推理",
      JSON.stringify(custom.reasoning) === JSON.stringify(["off", "low", "medium", "high", "xhigh", "max"]),
      JSON.stringify(custom.reasoning));
  } finally {
    try {
      cdp.close();
    } catch {
      /* ignore */
    }
    try {
      execFileSync("taskkill", ["/IM", "lightmd.exe", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }

  const failed = checks.filter((item) => !item.ok).length;
  log("");
  log(`合计 ${checks.length} 项，通过 ${checks.length - failed}，失败 ${failed}`);
  fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf-8");
  fs.writeFileSync(OUT_JSON, JSON.stringify({ checks, initial: lines }, null, 2), "utf-8");
  if (failed > 0) process.exitCode = 1;
};

main().catch((error) => {
  const message = String(error?.stack || error);
  log(`探针中止：${message}`);
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join("\n") + "\n", "utf-8");
  } catch {
    /* ignore */
  }
  process.exitCode = 2;
});
