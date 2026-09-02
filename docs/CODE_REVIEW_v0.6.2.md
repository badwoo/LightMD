# LightMD v0.6.2 代码审核报告

- 审核范围：v0.6.0 ~ v0.6.2 引入的 **AI 翻译**功能全链路（前端 service/store/component + Rust 命令层/provider/segment/prompt），并兼顾其对编辑器主体的影响
- 审核方式：全量代码走查 + 实证验证（构造输入运行切分/清洗逻辑）+ 回归验证（`tsc --noEmit` 零错误；`vitest` 87 文件 / 1772 用例全绿）
- 结论：**测试全绿但存在 3 个可导致文档数据损坏/丢失的 P0 缺陷**，均出在「纯函数已测、接线层未测」的缝隙里。建议按 P0 → P1 顺序修复后再发版。

> **验证范围说明**：前端 `tsc --noEmit` 与 `vitest`（87 文件 / 1772 用例）已在本地完整执行并全绿。
> Rust 侧 `cargo test --lib` 因需冷编译整个 Tauri 依赖树、耗时超过 15 分钟而在本次审核环境中未能跑完（非代码问题）。
> `src-tauri/src/translate/` 下的 `#[cfg(test)]` 用例已逐个人工复核（含 `mod.rs` 中针对 v0.6.0 死锁 bug 的回归测试），
> **建议修复后在 CI 中执行一次 `cargo test` 以确认**。

---

## 一、总体评价

### 做得好的地方

| 方面 | 说明 |
|---|---|
| 分层清晰 | `fullTranslate.ts` 为纯函数（无 React/PM 依赖），`translateBridge.ts` 隔离 PM 与 Markdown，`provider.rs` / `segment.rs` 各自可单测 —— 结构上是可测的 |
| 占位符双层防御 | Rust `segment.rs` 四层 mask（围栏代码 → 行内代码 → 链接 URL → 裸 URL）+ `validate()` 回填校验，是本项目最扎实的一块；`unmask` 容忍 `{0}` / `{{ 0 }}` 变体，对 LLM 输出兼容性好 |
| API Key 安全 | Key 只进 keyring，`has_translate_key` 只回布尔值，前端永不接触明文；错误码协议不透出请求头 |
| 失败安全默认值 | 段级失败保留原文、`finish_reason="length"` 视为截断禁止回写、翻译回写抑制自动保存 —— 设计取向正确 |
| 单元测试密度 | 87 文件 1772 用例，`segment.rs` / `provider.rs` / `prompt.rs` / `mod.rs` 均带 `#[cfg(test)]`，Rust 侧覆盖到位 |

### 核心问题

**架构与单测都做了，但「并发与生命周期」这一层整体缺失。** 翻译是一个跨越数十秒、跨越用户多次交互的异步过程，而代码把它当成了一次同步函数调用来处理：没有任务与文档的绑定、没有文档内容版本校验、没有任务互斥、没有退避重试。三个 P0 全部源于此。

---

## 二、P0 —— 会导致文档数据损坏或丢失

### P0-1 全文翻译的「标签切换中止」检测恒为 `false`，译文会写入另一个文档

**位置**：`src/components/editor/EditorContainer.tsx:1389-1399`

```js
fullTranslateFileRef.current = filePath;          // ① 写入当前值
fullTranslateKeyRef.current = forceUpdateKey ?? 0;
...
const shouldAbort = () => {
  const s = useFullTranslateStore.getState();
  if (s.cancelRequested) return true;
  return filePath !== fullTranslateFileRef.current                    // ② 拿同一个值比
      || (forceUpdateKey ?? 0) !== fullTranslateKeyRef.current;       // ③ 同样恒 false
};
```

`fullTranslateFileRef` 在整个文件中**只有 1390 行这一处赋值**（已全局核实），赋的就是闭包捕获的同一个 `filePath`。所以 `filePath !== fullTranslateFileRef.current` 结构性地恒等于 `false`；`forceUpdateKey` 同理。

**后果**：全文翻译进行中切换到另一个标签页 → 任务继续跑完 → `shouldAbort()` 返回 `false` → `applyFullTranslation(newContent)` 写入 `viewRef.current` / `sourceContentRef.current`，而这两个 ref 此时指向的是**切换后的新文档**。A 文件的译文被写进 B 文件。

**这段代码注释声称的"避免译文写入错误文档"保护，实际上一行都没有生效。**

**修复**：用一个在每次渲染都更新的 ref 保存「当前活跃文档」，与任务启动时快照比对：

```js
const activeFileRef = useRef(filePath);
activeFileRef.current = filePath;          // 每次渲染刷新
const activeKeyRef = useRef(forceUpdateKey ?? 0);
activeKeyRef.current = forceUpdateKey ?? 0;

const shouldAbort = () => {
  if (useFullTranslateStore.getState().cancelRequested) return true;
  return filePath !== activeFileRef.current || (forceUpdateKey ?? 0) !== activeKeyRef.current;
};
```

同时补一条集成测试：任务启动后改变 `filePath`，断言 `shouldAbort()` 为 `true` 且 `.then()` 分支走 `reset()` 而非回写。

---

### P0-2 「取消翻译」快照跨标签/跨文件不清理，点击会把 A 文件的原文灌进 B 文件

**位置**：
- `src/stores/useEditorStore.ts:159`（`setActiveTab`）、`:160-178`（`closeTab`）—— 均未重置 `translateUndoSnapshot`
- `src/components/editor/EditorContainer.tsx:2503` —— `<TranslateUndoToast onUndo={undoTranslation} />` 无条件渲染，仅凭 `snapshot !== null` 决定是否显示
- `src/components/editor/EditorContainer.tsx:1336-1349` —— `undoTranslation()` 直接 `applyFullTranslation(original)`

`openFile` 和 `markSaved` 会清快照，但**标签切换和关闭标签不会**。

**复现路径**（比 P0-1 更容易命中）：
1. 文件 A 执行翻译 → `translateUndoSnapshot = A 的原文`，`suppressAutoSave = true`
2. 切换到标签 B（`setActiveTab` 不清快照）→ 「取消翻译」气泡**依然悬浮在 B 的界面上**
3. 点击它 → `applyFullTranslation(A 的原文)` → **B 文件的内容被 A 的原文整体覆盖**

**修复**（三条都要做）：
1. `setActiveTab` / `closeTab` 中重置 `translateUndoSnapshot: null, suppressAutoSave: false`
2. 快照结构带上归属文档标识，回写前校验：`{ content: string; filePath: string | null; key: number }`，`undoTranslation` 中比对当前 `filePath`/`forceUpdateKey` 不匹配则拒绝执行
3. `TranslateUndoToast` 增加 `filePath` 校验后再渲染

---

### P0-3 全文翻译期间的文档编辑会被回写整体覆盖

**位置**：`src/components/editor/EditorContainer.tsx:1368-1430`

`startFullTranslate` 在 t0 时刻取 `fullText` 快照并切分出基于该快照的 `units`（字符偏移）。整篇翻译耗时可达数分钟。回写时：

```js
const newContent = rebuildTranslatedDocument(fullText, units, outcome.translations);
applyFullTranslation(newContent, fullText);   // 用 t0 的快照整体覆盖当前文档
```

`applyFullTranslation` 是一次性 `replaceWith(0, doc.content.size, newDoc.content)`，**不 diff、不合并**。t0 之后用户敲的每一个字都会被静默丢弃。

**修复**（任选，推荐组合）：
- **最小改动**：回写前比较当前文档内容与 `fullText`，不一致则**中止回写**并提示「文档已变更，翻译结果未应用」（与 P0-1 的 abort 语义一致，用户可重试）
- **更稳妥**：记录期间的用户编辑（或禁用编辑），回写时以「当前文档 + 译文块替换」的方式做三段合并
- **体验侧**：全文翻译进行中给编辑器加只读锁 + 明确提示，从源头消除竞态

---

## 三、P1 —— 明确的功能缺陷

### P1-1 frontmatter 误判：文档首行是 `---` 分割线时，中间正文被整体跳过

**位置**：`src/services/fullTranslate.ts:134-143`

判定条件只看「首行是 `---` 且后面某处还有 `---`」，不校验 YAML 结构、不限制闭合行距离。

**实证**（构造输入直接运行 `splitDocumentForTranslation`）：

```
输入: "---\n第一段正文应该被翻译\n第二段正文应该被翻译\n---\n结尾"
输出: ["结尾"]        ← 两段正文全部丢失，永不翻译
```

以 `---` 开篇是很常见的写法（分隔线在标题之前）。此缺陷会让用户以为「翻译过了」，实际大片内容原封不动。

**修复**：加约束 —— 闭合行必须在前 N 行（如 10 行）内，且区间内每行都匹配 `^\s*[\w\u4e00-\u9fa5-]+\s*:` 或 `- ` 的 YAML 形态；否则视为普通分割线。

---

### P1-2 全文翻译进行中触发选中翻译，整篇翻译会被静默中止且进度全丢

**位置**：`src/services/translateService.ts:89`（`await this.cancel()`）+ `src/services/fullTranslate.ts:318`（`CANCELLED → cancelled = true; break`）

`translateService.translate()` 无条件先取消旧任务。而 `startTranslate`（F6 / 右键 / 「译」按钮 / 命令面板）**没有检查全文翻译是否正在运行**。

**后果**：整篇翻译跑到 30/60 段时，用户随手选中一句话按了 F6 → 当前段收到 `CANCELLED` → 循环 break → `EditorContainer.tsx:1410` 走 `s.reset()` → **状态栏与进度静默消失，已完成的 30 段译文全部作废，用户得不到任何提示**。

**修复**：
- `startTranslate` 开头加守卫：全文翻译运行中则提示「全文翻译进行中」并拒绝（或弹确认「将中止全文翻译，是否继续」）
- 若允许中止，则 `runFullTranslateLoop` 取消时应保留已完成段落的译文，提供「应用到已完成部分」选项，而不是直接丢弃

---

### P1-3 句子边界正则缺英文句点与换行，超长块被硬切在单词/表格行中间

**位置**：`src/services/fullTranslate.ts:208`

```js
const SENTENCE_END = /[。．！？!?…]/;   // 没有 ASCII '.'，也没有 '\n'
```

对英文或超大表格，找不到边界就 `cut = segStart + max` 硬切。

**实证**（英文长段落，max=4000）：

```
第1段尾部: "The quick brown fox jumps over the lazy "
第2段头部: "dog. The quick brown fox jumps over the "
```

单词 `lazy dog` 被劈成两半。对 **>4000 字符的表格**，切点会落在某一行的中间，两段都是结构损坏的 Markdown 片段，LLM 输出垃圾，`rebuildTranslatedDocument` 再原样拼接 → **表格被写坏**。

**修复**：边界优先级改为 `行边界(\n) > 句末标点(含 `.` `!` `?` 后跟空白) > 空格 > 硬切`；对表格/列表优先按行切并保留表头行到每一片段。

---

### P1-4 429 限流无退避、无重试，限流场景下整篇翻译 100% 失败

**位置**：`src/services/fullTranslate.ts:302-330`

`runFullTranslateLoop` 串行打完全部 N 段，段失败只 `failedCount++` 继续下一段。服务端返回 429 时，N 个请求会在几十毫秒内全部撞墙，整篇失败。而免费/低价 API 配额恰恰最容易触发限流。

**修复**：
- 对 `RATE`（可考虑加 `NETWORK`/`STREAM`）做**指数退避重试**（如 1s / 2s / 4s，单段最多 2~3 次），并在段间插入基础间隔
- `RATE` 连续命中 N 次则中止整轮并上报 `RATE`，避免烧完配额
- 状态栏提示「服务商限流，正在重试 (2/3)」

---

### P1-5 全部段落失败时错误码固定为 `STREAM`，误导排查

**位置**：`src/components/editor/EditorContainer.tsx:1419-1422`

```js
if (outcome.failedCount >= units.length) { s.fail("STREAM"); return; }
```

真实原因可能是 429 限流或 Key 失效，状态栏却显示「连接中断，请重试」。

**修复**：`FullTranslateOutcome` 增加 `lastErrorCode` 字段（段级失败时记录最后一个错误码），此处上报 `outcome.lastErrorCode ?? "STREAM"`。

---

### P1-6 `hasTranslatableText` 未覆盖图片语法与纯数字块，无效请求浪费 token

**位置**：`src/services/fullTranslate.ts:56, 64-66`

**实证**：

```
hasTranslatableText("2024")              → true   ← 纯数字，无需翻译
hasTranslatableText("![img](a.png)")     → true   ← 无 alt 的图片，无需翻译
```

v0.6.2 只剔除了裸 URL 与邮箱。图片语法的 `alt` 为空时整块无可译内容，仍会发出请求。

**修复**：在剔除正则中增加 `!?\[[^\]]*\]\([^)]*\)`（无 alt 的图片/链接整块剔除；有 alt 时保留 alt 参与判断），并对剔除后仅剩数字/标点的块判为不可译。

---

## 四、P2 —— 健壮性、一致性与可维护性

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| P2-1 | `NO_KEY` 错误码完全未接线：`translateErrorKey` 的 `known` 数组漏了它，i18n 中也没有 `translate.error.NO_KEY`；且当前无任何代码路径产生该码 | `translateService.ts:23`、`TranslateBubble.tsx:33-39` | 二选一：补齐映射与文案并让「未配置 Key」场景真正产出该码；或删除该死错误码 |
| P2-2 | `translate.error.CANCELLED` 文案不可达 —— `runTranslate` 在 `CANCELLED` 时提前 `return`，永不进入 `fail()` | `EditorContainer.tsx:1124` | 删除该文案，或改为「被新任务取代」的可见提示 |
| P2-3 | `taskActive` / `isTaskActive()` 无任何生产调用方；且并发调用时先结束者的 `finally` 会把仍在进行中的标志复位，语义错误 | `translateService.ts:64, 110, 125` | 删除。真要做互斥，用递增 taskId 而非布尔量 |
| P2-4 | `suppressAutoSave` 在标签切换/关闭标签时不复位，切换后的新文件**永不会自动保存**，直到手动保存或重开文件 | `useEditorStore.ts:159, 160-178` | 同 P0-2 一并重置；并考虑加超时兜底（如 5 分钟后自动解除抑制） |
| P2-5 | Rust `translate_text` 的 `Err` 分支不调用 `end_task`，取消/失败后 `cancel_flag` 残留 `Some(已置位 flag)` | `src-tauri/src/commands/translate.rs:70-77` | `Err` 分支同样调用 `state.end_task(&cancel_flag)` |
| P2-6 | keyring 的 `get_password` / `set_password` 是阻塞调用，直接写在 `async` 命令体内，会占住 async runtime 工作线程（每次翻译与每次打开设置对话框都会触发） | `commands/translate.rs:50, 94, 113, 120` | 用 `tauri::async_runtime::spawn_blocking` 包裹 |
| P2-7 | 译文回写使用陈旧位置信息：source 通道用任务开始时记录的 `ctx.start/end` 字符偏移；PM 通道用**当前** `selection`。翻译期间用户一旦编辑，前者错位拼接、后者在光标处误插 | `EditorContainer.tsx:1246-1247`、`1229` | 回写前校验选区/内容未变；或改为「按原文内容定位」而非按偏移 |
| P2-8 | 双击关闭气泡**不取消任务**（`close()` 无 cancel），且当 `resultMode` 为 `replace`/`bilingual` 时，气泡关掉后译文**仍会自动回写** | `TranslateBubble.tsx:126-135`、`EditorContainer.tsx:1117` | `close()` 时若任务进行中则 `translateService.cancel()`；自动回写前检查气泡是否仍处于 `done` 态 |
| P2-9 | `computeBubblePosition` 使用硬编码 `380×220` 估算气泡尺寸，长译文时实际高度远超估值，底部溢出判断失效，操作按钮被挤出视口 | `TranslateBubble.tsx:46` | 用 `ref + getBoundingClientRect()` 测量实际尺寸后定位 |
| P2-10 | 气泡锚点是固定视口坐标，滚动后气泡停在无关位置 | `TranslateBubble.tsx:147-153` | 监听 scroll/resize 重算，或改用 `Range.getBoundingClientRect()` 实时跟随 |
| P2-11 | `ProviderError` 透出的厂商 `message` 未做长度截断，HTML 错误页会整段灌入气泡 UI | `src-tauri/src/translate/provider.rs:335-349` | 截断至 200 字符 |
| P2-12 | `finish_reason` 为 `content_filter` / `tool_calls` 等系统性值时，按「段级失败」处理并继续跑完剩余段，白白消耗全部配额 | `fullTranslate.ts:310` | 这类值应中止整轮并上报对应错误码 |
| P2-13 | 模块级 `URL_OR_EMAIL` 带 `g` 标志。当前只用于 `String.replace`（会重置 `lastIndex`，安全），但一旦有人改用 `.test()`/`.exec()` 就会出现跨调用状态泄漏 | `fullTranslate.ts:56` | 去掉 `g` 标志，或每次使用时新建正则 |
| P2-14 | `startFullTranslate` 每次都调 `versionSnapshotService.recordSnapshot`，反复触发会把用户真实的版本历史挤掉（上限 5 条） | `EditorContainer.tsx:1385-1387` | 加时间节流，或标记为「AI 翻译前」类型快照并在清理时优先淘汰 |

---

## 五、安全加固（纵深防御，非当前可利用漏洞）

已确认 Markdown 渲染链路是干净的：`markdown-it` 配置 `html: false`，`renderCodeFilePreview` 走 Prism / `escapeHtml`，mermaid 的 SVG 注入受其默认 `securityLevel` 约束。因此以下属于**加固项**而非现存漏洞。

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| S-1 | `"csp": null` —— 完全没有内容安全策略 | `src-tauri/tauri.conf.json` | 配置 CSP，禁止 inline/eval 与外域脚本加载 |
| S-2 | `"withGlobalTauri": true` —— 全局暴露 `window.__TAURI__`。一旦出现任何脚本注入，攻击者可直接调用 `write_file` / `delete_file` / `set_translate_key` | 同上 | 设为 `false`，改用 `@tauri-apps/api` 显式导入 |
| S-3 | `assetProtocol.scope: ["**"]` —— 资产协议作用域全开 | 同上 | 收敛到实际需要的目录（如当前打开文件所在目录 + appData） |
| S-4 | `base_url` 无协议/主机校验：用户可填 `http://`（Bearer Key 明文传输），或指向内网地址 | `provider.rs:180, 208` | 设置 UI 中对非 `https://` 给出显式警告；可选加协议白名单 |
| S-5 | S-1~S-3 的组合放大了 S-4：若发生脚本注入，攻击者可改写 `localStorage` 中的 `translateBaseUrl`，再触发一次翻译即可把 keyring 中的 API Key 送到自己的服务器 | 组合风险 | 优先修 S-1 / S-2 |

---

## 六、测试缺口分析（P0 缺陷逃逸的根因）

**现状**：87 文件 / 1772 用例全绿，`tsc --noEmit` 零错误，Rust 侧 `segment` / `provider` / `prompt` / `TranslateState` 单测完备。

**问题**：翻译相关的 8 个测试文件（`v0.6.0-*` / `v0.6.1-*` / `v0.6.2-*`）**全部只覆盖纯函数与服务层**：

- `splitDocumentForTranslation` / `rebuildTranslatedDocument` / `runFullTranslateLoop` —— 纯函数，覆盖充分
- `translateService` 的错误码解析 —— 覆盖充分
- store 状态流转 —— 覆盖充分
- **`EditorContainer` 中的接线层 —— 零覆盖**

而三个 P0 全部出在接线层：`shouldAbort` 闭包、undo 快照生命周期、翻译期间的文档变更。

更值得警惕的是 `v0.6.1-full-translate.test.ts:306` 有一条名为「**shouldAbort 中止（用户取消/标签切换）**」的用例，它测的是**注入的假 `shouldAbort`**，与生产代码里的真实实现毫无关系 —— 这条用例制造了「标签切换保护已验证」的假象，是 P0-1 长期未被发现的重要原因。

**建议补充的测试层级**：

1. **接线层集成测试**：挂载 EditorContainer，断言「任务启动后改变 filePath → 不回写」「切换标签 → undo 快照失效」「翻译中修改文档 → 不覆盖」
2. **删除/重写那条假 shouldAbort 用例**，改为对真实闭包行为的断言
3. **切分逻辑的对抗性用例**：首行 `---`、`>4000` 字符英文段落、`>4000` 字符表格、无闭合围栏、CRLF 换行
4. Rust 侧补充 `end_task` 在 Err 路径下的状态清理测试

---

## 七、整改优先级建议

### 立即（阻断发版）

1. **P0-1** 修复 `shouldAbort` 恒 false —— 3 行改动，风险极低
2. **P0-2** `setActiveTab` / `closeTab` 重置 undo 快照与自动保存抑制 + 快照绑定文档标识 —— 约 20 行
3. **P0-3** 回写前做文档内容一致性校验，不一致则中止并提示 —— 约 15 行

这三个都是**小改动、高收益**，且都属于「宁可不写入也不要写错」的保守语义，不会引入新行为风险。

### 本迭代内

4. **P1-1** frontmatter 误判（会让用户以为翻译成功，实际漏译，属静默错误，优先级其实很高）
5. **P1-3** 句子边界正则（表格损坏风险）
6. **P1-4** 限流退避重试（决定全文翻译在真实 API 上能否用）
7. **P1-2** 全文/选中翻译互斥守卫
8. **P1-5** 错误码透传

### 下个迭代

9. P2 全部（其中 P2-4 / P2-7 / P2-8 建议与本迭代的 P0 修复一并处理，它们在同一片代码里）
10. S-1 / S-2 安全加固
11. 补第六节的接线层集成测试，并**先写测试再改**，把 P0-1~P0-3 锁死在回归网里

---

## 八、一句话总结

代码的分层、纯函数与 Rust 侧占位符防御都做得相当扎实，单测密度也够；**失手在「异步任务跨越用户交互」这件事上**——翻译能跑几十秒，代码却假设这期间文档、标签、用户操作都不会变。三个 P0 是同一个根因的三种表现，补上「任务 ↔ 文档绑定 + 回写前校验」这一层，整条链路就站得住了。
