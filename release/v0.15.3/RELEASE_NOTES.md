# LightMD v0.15.3 交付说明（AI 配置深化 · 2026-11-01）

> 构建时间：2026-11-01
> 产物目录：`lightmd/release/v0.15.3/`
> 基线：v0.15.2
> 定位：**AI 功能深化版**。设置窗口加宽 50%、AI 配置改为树状、模型配置双页签、上下文窗口滑条、
> 默认 Ollama 与厂商 Plan 服务商、自定义模型 API（三协议 + 模型目录），并把 AI 翻译重构进同一棵树。
> 同时修掉 0.15.0 遗留缺口：三协议此前只传到命令边界，实际仍固定走 OpenAI Chat。

---

## 一、安装包与校验值

| 文件 | 大小 | SHA256 |
|---|---:|---|
| `LightMD_0.15.3_x64-setup.exe`（NSIS 安装包，推荐） | 7.59 MB | `414A1C335B921F1CAEA3AAF586BF808E38324E3A58693B3775202F24C4650AFF` |
| `LightMD_0.15.3_x64_en-US.msi`（MSI 安装包） | 10.94 MB | `56CE1A0562C7CF4DE5D1BA180C8108B9D6FAAB824B7B72E63F708F0BB245FAFA` |
| `lightmd.exe`（免安装单文件，可直接双击） | 23.37 MB | `EDAAFDC377A630B2D375C6A0954060857D3BC1B46E10D5944258ECED278F0AFF` |

**产物已验证**：
- 前端 dist 入口 hash = `index-57dYOtDu.js`；该 hash 在**免安装 exe** 与 **MSI 安装包** 字节流中实测命中。
- NSIS 安装包经 7-Zip 解包，内嵌 `lightmd.exe` **23.37 MB / FileVersion=0.15.3 / ProductVersion=0.15.3**，
  且其中同样命中 `index-57dYOtDu.js` ⇒ 安装包里就是本次构建的前端。
  （NSIS 内嵌 exe 与独立 exe 的 SHA256 不同是**预期**：打包时会按 bundle 类型写入 nsis/msi 信息。
  NSIS 本体经 LZMA 压缩，故不能直接在安装包字节流里搜 hash。）
- 版本号四处一致：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `tauri.conf.json` 均为 `0.15.3`。
- 免安装 exe 的 `FileVersion` / `ProductVersion` 均为 `0.15.3`。

---

## 二、实机验证（直接跑**实际分发**的 `release/v0.15.3/lightmd.exe`）

探针：`scripts/v0153-probe-ai-settings.mjs`（真机 WebView2 + 真实 Tauri 命令，非 mock；
内置 exe 内联 dist 校验，测到旧代码会中止）

| # | 判据 | 结果 |
|---|---|---|
| E1 | 设置窗宽度 780px（视口 2560） | ✅ 实测 780 |
| E1 | AI 树顺序 模型配置 → AI 翻译 → AI 指令库 | ✅ `["ai-model-settings","translate-section","ai-instruction-section"]` |
| E2 | 默认服务商 Ollama、免密钥、地址正确 | ✅ `127.0.0.1:11434/v1`，`noAuth=true` |
| E3 | 「获取模型列表」成功 | ✅ 提示「模型列表已更新，请选择模型」 |
| E3 | 检出本机 Qwen3-VL | ✅ `qwen3-vl:8b`、`qwen3-vl:8b-instruct`（另有 bge-m3、intent 模型） |
| E4 | 选择模型后出现上下文滑条并停在最大档 | ✅ 滑条 `value=max`，显示 **262K** |
| E5 | 测试连接（真实 1-token 请求） | ✅ 「连接测试成功」 |
| E6 | 总开关关闭折叠整棵子树、开启恢复 | ✅ 双向可逆 |
| E7 | 自定义 API 三种协议 | ✅ `openai-chat / openai-responses / anthropic-messages` |
| E7 | 模型目录六档推理 | ✅ `off / low / medium / high / xhigh / max` |

**合计 10 项，通过 10，失败 0。**

---

## 三、回归与构建数据

| 项目 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过（strict） |
| 前端全量 `vitest run --no-file-parallelism` | **347 文件 / 6269 用例通过**（1 条既有 skip） |
| Rust `cargo test` | **270 通过 / 0 失败**（3 ignored；doc-test 1 ignored） |
| `npx tauri build`（含安装包） | 成功，产出 NSIS + MSI |

---

## 四、本版变更要点

### 1. 设置窗口
- 520px → **780px**（+50%），`max-width: calc(100vw - 32px)` 保留小窗口安全边距。

### 2. AI 树状结构
- 「启用 AI 功能」为总开关，开启后依次嵌套：
  **模型配置 → AI 翻译 → AI 指令库**。
- 总开关关闭：整棵子树收起。
- 翻译子开关关闭：仅收起翻译子项（语言/语体/结果模式/气泡颜色/自定义 Prompt）。
- `SettingsDialog` 不再重复保留模型字段，避免两套配置同屏。

### 3. 模型配置双页签（`components/settings/AiModelSettings.tsx`）
- **左「服务商」**：服务商、API 密钥、API 地址、模型名称、采样温度、获取模型列表、测试连接。
- 获取/选择模型后出现上下文滑条，**默认最大档**；1M 级模型中间增加 **600K** 档
  （普通模型为「应用下限(8K) / 模型上限」两档）。
- 上下文元数据只取端点真实返回（OpenAI `/models` 字段，或 Ollama 原生 `/api/tags` 的
  `details.context_length`），**不按模型名猜测**。
- 默认服务商 = 本地 Ollama（`authMode=none`，不发 Authorization）。

### 4. 厂商 Plan 服务商（新增）
| 服务商 | 地址 | 协议 |
|---|---|---|
| Kimi Plan | `https://api.kimi.com/coding` | Anthropic Messages |
| 火山引擎 Coding Plan | `https://ark.cn-beijing.volces.com/api/plan/v3` | OpenAI Chat |
| 智谱 GLM Coding Plan | `https://open.bigmodel.cn/api/coding/paas/v4` | OpenAI Chat |
| 阿里云 Token Plan | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | OpenAI Chat |

> 四个端点 `/models` 在无鉴权探测下均返回 **401**（路径有效、需鉴权）。
> 有公开目录数据的型号已内置上下文；其余靠「获取模型列表」动态拉取。

### 5. 自定义模型 API（右页签）
- **Provider ID**：按 `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` 校验，同时作为凭据槽位
  （切换服务商不会串用旧 Key），创建后只读。
- 显示名称、API 地址、**API 协议（三种）**、API 密钥。
- **模型目录**：模型 ID、模型名称、上下文窗口、推理档
  `off(默认) / low / medium / high / xhigh / max`。
- `off` 归一为「不发送推理参数」；支持增删模型、选定当前模型、保存并启用。

### 6. 后端三协议（修 0.15.0 遗留缺口）
- `ai_chat` / `ai_assist_text` / `translate_text` 统一接入 `AiRequest` + 三协议 HTTP/SSE：
  - OpenAI Chat：`{base}/chat/completions`
  - OpenAI Responses：`{base}/responses`（`input` / `instructions` / `max_output_tokens` / `reasoning.effort`）
  - Anthropic Messages：`{base}/v1/messages`（`x-api-key` + `anthropic-version`）
- 全链路无 400 后自动换参重试；`max_tokens` 与 `max_completion_tokens` 互斥；
  入参 `system` 被过滤，system 由 Rust 侧唯一注入。
- 翻译保留 `build_prompt`、`{{N}}` 占位符 mask/unmask 校验与并发任务槽。

### 7. 其他修正
- 翻译运行时改用**当前 AI 档案**（旧 `translate` 连接字段仅作迁移兼容），消掉「上方改了、翻译没改」的隐性不一致。
- `temperature` 未配置时改传 `null`（不再误发 `0`）。
- 新增两条 Tauri 命令并在 `invoke_handler` 注册：`list_ai_models`、`test_ai_connection`。

---

## 五、已知取舍 / 验证边界

1. **Plan 未做真实对话联调**：没有你的 Plan Key，只实测了端点可达性与鉴权要求（401）。首次使用请点一次「测试连接」。
2. **模型目录覆盖范围**：只收录有明确公开目录数据的型号；Anthropic 协议无标准 `/models` 端点，厂商不提供时需手填模型 ID。
3. **`contextWindowTokens` 语义**：目前是档案元数据（驱动滑条与预算校验），**Rust 请求层不据此裁剪上下文**。
4. **设置窗几何**：780px 已在实机测得；窄窗口按 `calc(100vw - 32px)` 收缩。
5. 本轮**未**推送 GitHub、未创建 GitHub Release，改动仍在工作区（`git diff --check` 通过）。

---

## 六、安装与验证指引

1. **推荐**：双击 `LightMD_0.15.3_x64-setup.exe` 安装（NSIS 会处理文件关联与卸载项）。
   或安装 `LightMD_0.15.3_x64_en-US.msi`。
2. 免安装验证：直接双击 `release/v0.15.3/lightmd.exe`（无需安装；注意与已安装版本的单实例互斥）。
3. 打开设置（`Ctrl+,`）→ AI 功能开启 → 模型配置：
   - 默认应是 **Ollama（本地）**，地址 `http://127.0.0.1:11434/v1`，无密钥输入框。
   - 点「获取模型列表」→ 应列出本机 `qwen3-vl:8b` / `qwen3-vl:8b-instruct`。
   - 选中 `qwen3-vl:8b-instruct` → 出现上下文滑条，停在 **262K** 最大档。
   - 点「测试连接」→ 应显示「连接测试成功」。
4. 切右页签「自定义模型 API」，填 Provider ID（如 `acme-api`）、地址、选协议、加模型，保存启用。
5. 期望观感：设置窗明显更宽、AI 区块呈缩进树状、关闭总开关整块收起。

---

## 七、产物清单

```
release/v0.15.3/
├── LightMD_0.15.3_x64-setup.exe   (7.59 MB, NSIS)
├── LightMD_0.15.3_x64_en-US.msi   (10.94 MB, MSI)
├── lightmd.exe                    (23.37 MB, 免安装)
└── RELEASE_NOTES.md               (本文件)
```

探针报告：`_verify-out/v0153-ai-settings.txt` / `.json`
