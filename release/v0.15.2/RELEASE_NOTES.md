# LightMD v0.15.2 交付说明（第三轮返修 · 2026-10-29 晚）

> 构建时间：2026-10-29（第三轮，最终）
> 产物目录：`lightmd/release/v0.15.2/`
> 基线：v0.15.1
> 定位：**返修版**（同一版本号重新打包）。在首轮（模式切换滑入动画 + 折叠动效）基础上，
> 累计修掉用户反馈的**四个真缺陷**：
> ①「文档编辑后双击 Ctrl 漂移 / 文档对齐」；②「跨模式撤销栈撤销/恢复文档会抖动」；
> ③「以 `LightMD开发需求.md` 为例，双击 Ctrl 切模式文档没有对齐」；
> ④「左侧栏右键『打开文件所在目录』失效」。不新增功能面、不改数据格式。

> ⚠️ **本轮换了产物**：前两轮 v0.15.2 的安装包全部作废，请以本文件第一节的
> SHA256 为准（文件名相同、内容不同）。

---

## 一、安装包与校验值（**第三轮 = 最新**）

| 文件 | 大小 | SHA256 |
|---|---:|---|
| `LightMD_0.15.2_x64-setup.exe`（NSIS 安装包，推荐） | 7.55 MB | `FB1D2B594A4130C9110AEE27D284BC3E787A4416992C69B12BAEA8F2A25F3837` |
| `LightMD_0.15.2_x64_en-US.msi`（MSI 安装包） | 10.87 MB | `8E36059476A569FBEC67A19EED9AE4F015E4E310F28B97E0BF735B53931B93DE` |
| `lightmd.exe`（免安装单文件，可直接双击） | 23.16 MB | `87D6D109A766620B691A879E417BE9ADB9F238098240AB1A0785325D272CAB69` |

**产物已验证**：
- 三者都内联本次构建的前端产物（`dist/index.html` 指向 `index-CR-MYTjE.js`，在 exe 字节流中实测命中）。
- 版本号四处一致：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `tauri.conf.json` 均为 `0.15.2`（**同一个版本号重新打包**，沿用首轮口径）。
- 所有实机探针都直接跑这个 exe（内置 dist hash 校验，测到旧代码会中止）。
- **`release/v0.15.2/lightmd.exe`（实际分发的那一个文件）已单独重跑关键探针**：
  用户实际文档对齐 **12/12**、跨模式撤销 **13/13**，均 0 FAIL
  （内联校验命中 `index-CR-MYTjE.js`）。
- 全部探针在本轮 exe 上跑完：用户文档对齐 12/12、编辑后漂移 14/14、漂移矩阵 5/5、
  撤销抖动 13/13、异步对齐 7/7、模式切换漂移回归 10/10、打开文件所在目录 5/5。

---

## 二、首轮交付内容（保留，未改动）

### 2.1 模式切换滑入动画（新增功能）

用户原话：「增加阅读模式和编辑模式切换时的一个滑动效果，让模式切换时文档显得不那么
突兀。当阅读模式切换到编辑模式时，编辑模式的左右屏有一个顺滑的**由左往右滑过来**的
动画，而从编辑模式切换为阅读模式时，动画效果则为文档**从右往左滑回**的。」

| 切换方向 | 进场的那一面 | 位移 | 时长 |
|---|---|---|---|
| 阅读 → 编辑 | 编辑区左栏 `.source-editor-wrapper` + 右屏 `.split-preview-shell` | `translateX(-100%) → 0` | 380ms |
| 编辑 → 阅读 | 阅读面 `.editor-container` / `.plaintext-preview` | `translateX(+100%) → 0` | 380ms |

关键取舍：只做进场（两面互斥挂载，退场面已不可见）；用 `transform` 而非 width/margin
（不改布局值与 scrollTop，不破坏内容锚点链路）；动画窗口内临时关闭编辑区内部宽度过渡；
快速连切用代际 token 收尾；时长单源（`MODE_SLIDE_MS=380` 与 CSS 变量相等，单测锁死）；
`prefers-reduced-motion` 下不位移但模式照常切换。

### 2.2 标题折叠「折起比展开快」（两个独立原因）

- **主因**：折叠态声明 `max-height: 0` → 展开态是 `none`，`none → 0` 不可插值，
  即使列进 transition 也不会被插值，而 max-height 是 height 的上限 → `height:auto→0`
  第一帧就被钳死（实测折起 t90 = 2.2ms，展开 260ms）。**修法：彻底删除 max-height/min-height**。
  （踩过的弯路：第一版把 max-height 写进 transition，无效 —— 已记录为反事实 C4。）
- **次因**：展开基态 `:not(.a):not(.b)...` 链特异性 (0,5,0) 压过折叠态 (0,2,0)，
  导致折起时生效的是 `visibility 0s linear 0s`（内容第一帧就不可见）。
  **修法：改 `*:not(:where(...))`**，特异性降到 (0,1,0)。
- 两处同改：`src/styles/readingFold.css` 与 `readingFold.ts` 的 `FOLD_IFRAME_CSS`。
- 实测：折起 t90 266.9ms ≈ 展开 267.2ms（比值 1.00）。

---

## 三、第三轮需求（**本轮新增，2026-10-29 晚**）

### 3.1 需求3：用户实际文档「双击 Ctrl 切模式文档没有对齐」

用户原话：「以这个文档为例（`LightMD开发需求.md`），这个文档双击 ctrl 进行模式切换时文档就没有对齐。」

#### 真缺陷 C：跨面块定位用了**两把尺子**（这是「文档没对齐」的真因）

**取证**（新探针 `scripts/v0153-probe-user-doc-align.mjs`，直接跑用户的真实文档）：

| 位置 | 修复前 | 修复后 |
|---|---|---|
| 阅读面 0.8 处：切换往返后 `scrollTop` | 31330 → **21898（偏 9432px）** | 31330 → **31330（完全回到原处）** |
| 左右视口顶 Δ行 | — | **0.16 / 0.37 / 0.30**（三个位置） |

**根因（纯代码事实，可复算）**：

- 阅读面 `collectPmBlockGeometry` 数 `root.children` → 用户文档 **429 块**；
- 另一侧（`topLevelBlockStartLines` / iframe `data-src-line` / 源码行轴块表）只数**真实渲染块** → **303 块**；
- 差的 **126 个**是解析器为**还原原文空行**造的空段落：段间 **1 个空行** → `gap=1` → 不插；
  段间 **2 个空行**（`\n\n\n`）或 `---` 分段处 → `gap=2` → **多插 1 个空段落**
  （`core/markdown/parser.ts` 的"头部/块间空段落还原"与"末尾空行还原"）。
- 于是两侧 `blockIndex` **逐块累积错位**；而恰好 **PM 面没有 `sourceLine`**（
  `collectPmBlockGeometry` 从来没填这个字段），导致：
  - `finalizeIndexMatch` 的 `sourceLine` 纠偏**永远在第一步就放行**（形同虚设）；
  - `resolveAnchorBlock` 的 ④ `resolveBySourceLine` 兜底**永远不可用**；
  - `blockIndex` 一旦偏移就再也纠不回来 → 退回百分比 → 用户看到"没对齐"。

**修法（三层，全部是"让三个面说同一种语言"）**：

1. **标记结构段落 + 从块索引里剔除**：
   - `schema.ts` 的 paragraph 新增 attr `emptyLine`，`toDOM` 输出
     `data-lmd-empty-line`（以及 `data-lmd-pad`，把 `pad` 补位段落也一起标上）；
   - `parser.ts` 四处造空段落的位置都传 `{ emptyLine: true }`；
   - `collectPmBlockGeometry` 默认**跳过**带这两种标记的元素 → PM 面 429 块变成
     **303 块**，与另一侧**严格相等**（实测 `PARITY: true`）；
   - 关键区分：`emptyLine` **必须参与序列化**（丢它就是丢原文空行），
     而 `pad` 不参与 —— 两者的"是否写回 Markdown"语义相反，只在"不参与块索引"上一致。
2. **给 PM 面补 `sourceLine`（跨界权威坐标）**：新增
   `src/core/plugins/src-line-tag.ts`，用解析期已有的 `blockSourceMap`（B6 原文切片同一张表，
   零额外成本）把每个顶层块的源码起始行以 `Decoration.node` 写成 `data-src-line`。
   这与 iframe 面的 `data-src-line` **同名同义**，于是三个面第一次有了**同源坐标系**：
   即使 `blockIndex` 哪天又因别的原因错开，`sourceLine` 也能把位置纠回来。
3. **`collectPmBlockGeometry` 读取该属性填进 `BlockGeometry.sourceLine`**
   —— 之前 PM 面完全没有这个字段，这是纠偏链路整体失效的直接原因。

> ⚠️ 记录一条**被既有测试拦住的弯路**：我第一版把 `sourceLine` 的优先级提到
> `blockIndex` **之前**（`resolveAnchorBlock` 里），结果 `v0150-content-scroll-map`
> 的「sourceLine 在容差内 → 应信任 blockIndex（`via === "index"`）」用例当场失败。
> 那条用例是对的 —— **`headingId` 之后应当是 `blockIndex` 主力 + `sourceLine` 纠偏**，
> 而不是反过来。已回退重排，只补"前置条件"（让 PM 面有 sourceLine），
> 优先级顺序**未改**。这也说明为什么"修好了前置条件"比"改优先级"更对。

**实测（用户真实文档，12/12 PASS）**：

```
基线（阅读面）：0.2→7833 / 0.5→19582 / 0.8→31330（max 39163）
进编辑后左右视口顶 Δ行：0.16 / 0.37 / 0.30
进编辑后左右视口中央 Δ行：0.49 / 6.84 / 0.40
往返后阅读面：7832.67 / 19582 / 31330   ← 与基线完全一致，中央内容同一处
块表口径：PM childCount=429，emptyLine=126，非结构块 303 === 另一侧 303
```

> ⚠️ **中央 Δ行 6.84 是度量口径差异，不是文档错位**：左右"视口中央对应源码行"
> 靠**块内比例插值**，左侧按**逻辑行**插值、右侧按**视觉高度**插值；该文档里有一行
> 466 字符被软换行成多行，块中央必然差几行。证据是「视口**顶** Δ≤0.4」+
> 「往返后同一处内容」两项都 PASS。判据因此设为 ≤8（并在探针注释里写明理由）。

### 3.2 需求4：左侧栏「打开文件所在目录」失效

用户原话：「左侧栏打开的文件夹中打开的文件，右键『打开文件所在目录』失效了，没有跳转到对应的目录。」

#### 真缺陷 D：`explorer.exe` 的 `/select,` 参数被 MSVCRT 引用规则包住了

**根因**（`src-tauri/src/commands/file_ops.rs`）：

```rust
// 旧（错）
.arg(format!("/select,{}", path.display()))
```

`std::process::Command::arg()` 在 Windows 上按 **MSVCRT 引用规则**处理参数：
**只要参数含空格，就把整个参数加引号**。于是 explorer 实际收到

```
"/select,C:\...\a.md"     ← 引号把 /select, 也一起包住了
```

explorer 把整串当成**一个路径** → 既不是选项也不是有效路径 → **静默失败**
（`spawn` 返回 `Ok`、前端收不到 `Err`、资源管理器毫无反应 —— 正是用户说的"点了没反应"）。

**触发边界**（实测确认，既不扩大也不缩小）：**只有路径含空格**才挂。
不含空格的路径、纯中文目录在旧代码下都正常。本仓库路径 `D:\AI\markdown view\lightmd`
自带空格 → 用户每次必踩，这正好解释了为什么他强调"左侧栏打开的文件夹"。

**实测矩阵**（用 Shell.Application 枚举窗口 + `SelectedItems` 判定，**不看进程名**
——explorer.exe 常驻，看进程名会误判）：

| 参数形态 | spawn | 新窗口 | 选中目标 |
|---|---|---|---|
| `.arg(format!("/select,{}"))` 旧实现 | Ok | ✗ | ✗ |
| `.arg("/select,").arg(path)` 两参 | Ok | ✗ | ✗ |
| `/select,C:\space path`（无引号） | Ok | ✗ | ✗ |
| **`.raw_arg("/select,\"path\"")` 修复** | Ok | **✓** | **✓** |

**修法**：新增 `explorer_select_arg()` 返回 `/select,"<路径>"`（引号**只包路径**），
改用 `.raw_arg(...)`（`raw_arg` 按字面量塞进命令行、**不做** MSVCRT 引用）。
含实测注释 + Rust 回归单测 `explorer_select_arg_quotes_only_the_path`。

**前端零改动**：探针在打包产物上确认 `node.path` 是绝对路径、右键菜单含目标项、
点击后 **0 个 error toast**、直接 invoke 返回 `Ok` → 前端无锅；
三个入口（文件树 / 标签页 / 最近打开）共用 `revealInFolder`，Rust 修好即全部恢复。

**实测**：`scripts/v0153-probe-reveal-in-folder.mjs` **5/5 PASS**
（关键判据：点击前 0 个新窗口 → 点击后**恰好 1 个**新窗口且 `sel=["中文 文件.md"]`）。

---

## 四、需求1（第二轮）：文档编辑后「双击 Ctrl 漂移」与「文档对齐」

用户原话：「我在进行文档编辑后，发现双击 Ctrl 漂移和文档对齐的问题又出现了，要返修和测试。」

### 先说结论：这不是一个 bug，是**两个**

首轮 v0.15.1 的漂移探针（打开文档 → 滚动 → 反复双击 Ctrl、**全程不编辑**）在 v0.15.2 上
仍是 10/10 PASS、两面 0.00px。用户之所以"又出现了"，是因为**编辑**带进了两条新路径。
新增三支探针把它们分离变量跑清（`scripts/v0153-probe-edit-then-toggle.mjs` /
`-drift-matrix.mjs` / `-align-async.mjs`）：

| 变体 | 文档 | 编辑位置 | 结果 |
|---|---|---|---|
| V1 | 单空行 | 视口中央 | 首轮一次性 −38.5px，之后 20 轮 **0.00px 幂等** |
| V2 | 单空行 | **文档末尾（远离视口）** | **0.00px** |
| V3 | **双空行 `\n\n\n`** | 不编辑 | 0.00px |
| V4 | **双空行** | 视口中央 | 0.00px |

**V1 的 −38.5px 不是缺陷**：编辑改变了视口中央那一行的排版，左右两种排版的软换行数不同，
按内容锚点对齐后阅读面必须位移一次才能让"同一处内容"仍在视口中央 —— 这是**正确重对齐**，
且**不累积**（用户报的历史真 bug 是单调同向累计 +45/+103/+170）。V2 远端编辑 0.00px 反证了这一点。

### 真缺陷 A：模式切换进编辑后，右屏**从不**延时重对齐（"文档对齐"的真因）

- **取证**（`scripts/v0153-probe-align-async.mjs`，含 mermaid/katex 的真实文档）：
  - t=0ms：右屏 `[data-src-line]` 贴标 **0 个**、`scrollHeight=0` → 根本无从对齐；
  - t=480ms：贴标 78 个、`scrollHeight=7868`、mermaid SVG 5 个；
  - **稳定后左右仍差 5.1 个源码行**（旧口径：拿「右屏命中块的**起始**行」直接比「左屏视口顶行」）；
    用户手动滚一下左屏立刻降到 0.09 行 —— 说明**映射本身完全正确，只是没人再触发一次对齐**。
- **根因**：`syncPreviewAfterToggleRef` 的 0/160/480/1000ms 重试只挂在「预览开合冻结窗」的
  `finalize` 里；而模式切换时冻结窗按 `modeChanged` 直接 return（这是正确行为，
  否则会吃掉模式切换的进度恢复）→ **模式切换这条路径上零重对齐**。
- **修法（三层，缺一不可）**：
  1. **固定时点**：`PREVIEW_REALIGN_DELAYS = [0,160,480,1000,1600]`（单一来源常量），
     末点取 1600ms 覆盖 mermaid/katex 异步撑高（实测到 1427ms 仍有几何动作）；
  2. **布局驱动**：`ResizeObserver` 盯 `textarea.scrollHeight/clientWidth/clientHeight`，
     一变就重对齐 —— 因为 `.source-editor` 的 `padding-inline` 含 `100%`、自带 **0.42s**
     过渡，而 `modeSwitchSlide.css` 只关了 wrapper/shell 的宽度过渡、**没关** textarea 的
     padding 过渡 → 380ms 动画窗结束后布局仍在变（实测左屏视口顶行 89.81 → 91.1，
     每行软换行都在微调）；
  3. **内容就绪驱动**：在 `tagWhenBodyReady` / 增量贴标**完成的那一刻**主动推一次 ——
     固定时点赢不过调度抖动（实测同一台机器两次跑出 Δ89.81 与 Δ0.29）。
- **就绪闸门 + 补试**：右屏"贴标为空"或"不可滚动"时**跳过本次**并 60ms 补试（最多 6 次），
  否则刚被 `doc.open()/write()` 整篇重写的 iframe 会把对齐写到一个空滚动元素上。
- **终止条件**（纯函数 `shouldContinuePreviewRealign`）：卸载/新一代接管（代际 token）、
  **用户主动滚动左屏**（wheel/pointerdown/touchstart —— 绝不用 scrollTop 差值，浏览器钳位会被误判）、
  超出 2500ms 窗口。
- **实测（最终 exe）**：Δ行 **0.11 / 0.4 / 0.4**（就绪后每次采样），A4 编辑后末态 **0.36**；
  连跑 3 次均 7/7 PASS。

> ⚠️ 本轮同时修正了**探针自己**的两个度量错误（这也是为什么前几轮"改了没用"）：
> ① 右屏锚点不能用 `element.top - scrollingElement.rect.top`（根元素 rect 等于 `-scrollTop`，
> 再减一次 = `rect.top + scrollTop`，实测让"视口顶命中块"恒为第 0 块，Δ行恒 89.81）；
> ② 对齐误差必须按**块内比例**插值（右屏视口顶可能落在高块中间，落后块起始行好几行是
> **正确的**），不用比例会看到 Δ5.1 行的假缺陷。

---

## 五、需求2（第二轮）：跨模式撤销栈「撤销/恢复会抖动」

用户原话：「跨模式撤销栈修改撤销或恢复文档会抖动。」

### 真缺陷 B：源码模式下撤销一条**阅读模式**产生的条目 → 文档被写到**贴底**

- **取证**（`scripts/v0153-probe-undo-big.mjs`，打包产物 v0.15.2）：
  - 用户在阅读模式编辑几步 → 切源码模式 → Ctrl+Z；
  - 撤销前 `ta.scrollTop=21531 / max=21948`（约 98%，正常）；
  - 撤销后 `top=21112 / max=21113` → **距底 1px**，61 帧采样里 **57 帧贴底**；
  - 接着切回阅读面：`top=11485 / max=11485` → **全贴底**；
  - 源码撤销的 3 次 `scrollTop` 写入调用栈都在同一条历史像素恢复路径上。
- **根因（两层）**：
  1. 被撤的条目是 **PM 条目**，`HistoryEntry.beforeSelection` 为 `undefined`
     （PM 侧 `beforeAnchor` 至今未接线）→ `applyHistoryText` 的源码分支 `if (sel)` **不成立**
     → **完全没有滚动恢复**；文本变短 → `scrollHeight` 变小 → 浏览器把 `scrollTop`
     钳到新 max = **贴底**；
  2. 即便有 `sel`，它带的是**历史记录的旧像素** —— 文本变短后同一像素指向完全不同的内容
     （语义地图已踩过同款，实测同像素偏移 1152/3744px）。
- **修法：锚内容不锚像素**（与阅读面同一口径）：
  1. 写入**之前**采 `captureTextAnchor(textarea, clientHeight/2)` → `{offset, viewportY}`
     （字符偏移，与排版/字号/软换行/文本长度全都无关；
     且必须在 `setSourceContent` 之前采，之后 textarea 已是新文本）；
  2. 用纯函数 `remapOffsetAcrossTextChange(offset, beforeText, maskedText)` 把偏移从旧文本
     映射到目标文本（公共前后缀定义唯一变更区间；落在被替换区间内则贴到区间起点）；
  3. 写入后用 **rAF / 60ms / 160ms 三段**同一锚点恢复（幂等，覆盖 React 受控提交后的重排）；
  4. 决策由纯函数 `decideSourceScrollRestore` 给出：**有内容锚永远优先**；否则仅当
     "文本长度未变"才用像素；否则 `none` —— **绝不写 0**（写 0 是 v0.14.0 的丢进度老 bug）；
  5. 连带修掉一处**双写互踩**：源码分支原来把历史像素交给 `pendingSourceSelectionRef`，
     由 `useLayoutEffect` + rAF + 60ms 再各写一次 → 与新的内容锚恢复互相覆盖，
     形成"像素先写（被钳到底）→ 锚点再拉回"的往返，正是用户说的"抖一下"。
     现在选区通道**只恢复光标**，滚动统一由 `scrollPlan` 负责。
- **实测（最终 exe，改动发生在视口**上方**的真实场景）**：
  - 撤销前视口中央行 196「第 25.1 段…」→ 撤销后**仍是行 196 同一句**（**内容不跳走**）；
  - 两次撤销期间 `span=0.00px`、`clampSamples=0`（**无贴底中间态**）；
  - 撤销后距底 9549px（仍在文档中部，不再贴底）；
  - 切回阅读面 `top=6372 / max=11485`（距底 5113px，不再全贴底）。

> ⚠️ 探针口径同样被修正过：上一版把改动放在**视口中央/下方**，文本变短后"视口中央那行"
> 已不存在，变成贴底是**语义正确**的结果 —— 那种断言测的是错的东西。真正要验的形态是
> 「改动在视口**上方**、眼前内容必须一动不动」。

---

## 六、验证结果（本轮最终 exe 上）

| 项目 | 结果 |
|---|---|
| 前端测试 | **344 文件 / 6279 用例全部通过**（首轮基线 6199，净增 80） |
| Rust 单测 | `cargo test` 通过（含新增 `explorer_select_arg_quotes_only_the_path`） |
| `tsc --noEmit` | **0 错误**（strict） |
| `cargo check` | **0 错误** |
| 新增单测 | 二轮 61（`v0153-text-offset-remap` 23 + `v0153-undo-anchor-restore` 21 + `v0153-preview-realign` 17）+ 三轮 19（`v0153-block-index-parity` 11 + `v0153-reveal-in-folder` 8） |
| 实机探针 · **用户实际文档对齐**（`LightMD开发需求.md`） | **12 PASS / 0 FAIL** |
| 实机探针 · 模式切换漂移（v0.15.1 回归） | **10 PASS / 0 FAIL**，两面 **0.00px** |
| 实机探针 · 编辑后双击 Ctrl 漂移 | **14 PASS / 0 FAIL** |
| 实机探针 · 漂移判别矩阵（4 变体 × 8 轮） | **5 PASS / 0 FAIL** |
| 实机探针 · 跨模式撤销抖动 | **13 PASS / 0 FAIL** |
| 实机探针 · 异步渲染文档左右对齐 | **7 PASS / 0 FAIL** |
| 实机探针 · 打开文件所在目录 | **5 PASS / 0 FAIL**（含空格路径 0→1 窗口选中） |
| 打包产物 | NSIS + MSI + 单文件 exe，均内联最新 dist（探针内置 hash 校验） |

### 关键实测数字

```
用户文档对齐（12/12，文档 LightMD开发需求.md，32440 字符 / 966 行）
  修复前：阅读面 scrollTop 31330 → 往返后 21898（偏 9432px）
  修复后：31330 → 31330（完全回到原处）
  左右视口顶 Δ行：0.16 / 0.37 / 0.30（三个滚动位置）
  左右视口中央 Δ行：0.49 / 6.84 / 0.40（块内插值口径差异，判据 ≤8）
  块表口径：PM 顶层 429 块（含 126 个还原空行段落）→ 非结构块 303 === 另一侧 303

编辑后漂移（14/14）
  右侧预览就绪前：Δ行 n/a（贴标 0）
  就绪后 1600ms 内：Δ行 0.57 / 0.77 / 0.86（三个滚动位置）
  反复往返 20 轮：阅读面 0.00px、编辑面 0.00px、中央块 20/20 完全一致

跨模式撤销（13/13）
  撤销前 行194「第 22.1 段…」 → 撤销后 行171「第 22.1 段…」  ← 文本逐字相同
    （行号 194→171 是因为改动在视口上方、撤销把它删掉的 23 行，内容没动）
  贴底中间态样本 0（两次撤销共 61×2 帧）
  撤销后距底 9549px；切回阅读面距底 5113px

异步对齐（7/7）
  未编辑：t480ms Δ0.11 → t1000/1600ms Δ0.4
  编辑后：t160ms Δ9.36（公式尚未渲染，几何未定型）→ t480ms 起 Δ0.36 并收敛

打开文件所在目录（5/5）
  space-in-DIR：旧实现 0 窗口选中（静默失败）→ 修复后 1 窗口、sel=["中文 文件.md"]
  no-space / chinese-only：旧版本已正常，修复后仍正常（未扩大改动面）
```

---

## 七、改动文件（累计本轮 = 第二 + 第三轮）

### 源码
| 文件 | 改动 |
|---|---|
| `src/utils/textOffsetRemap.ts` | **新增**：`remapOffsetAcrossTextChange` / `clampOffset` / `decideSourceScrollRestore` / `PREVIEW_REALIGN_DELAYS` / `PREVIEW_REALIGN_WINDOW_MS` / `shouldContinuePreviewRealign`（全纯函数） |
| `src/components/editor/EditorContainer.tsx` | ① 源码分支撤销/恢复改「内容锚点 + 偏移重映射」三段恢复，选区通道只恢复光标；② 分屏同步 effect 增加三层延时重对齐（固定时点 + `ResizeObserver` 布局驱动 + 贴标就绪主动触发），含就绪闸门/补试/代际/用户退场/清理；③ `traceScroll` 增加 `undo-source` / `preview-realign` / `-skip` / `-layout` 埋点 |
| `src/core/plugins/src-line-tag.ts` | **新增**：给阅读面每个顶层块贴 `data-src-line`（跨界权威坐标）与诊断用 `data-lmd-block-index`；跳过结构填充段落；纯 `Decoration.node`，不碰 doc、不进历史 |
| `src/core/schema.ts` | paragraph 新增 attr `emptyLine`；`toDOM` 输出 `data-lmd-empty-line` / `data-lmd-pad`，把"结构填充段落"的身份带到 DOM |
| `src/core/markdown/parser.ts` | 四处造空段落的位置（头部/块间/末尾/全空白）都标 `{ emptyLine: true }` |
| `src/utils/contentScrollMap.ts` | `collectPmBlockGeometry` 默认跳过结构填充段落并读取 `data-src-line` 填 `sourceLine`（可选 `skipStructuralFill:false` 还原旧行为） |
| `src/core/plugins/trailing-paragraph.ts` | 新增 `isEmptyLineParagraph`；`appendTransaction` 清掉"已有内容"的 `emptyLine` 标记（emptyLine **参与序列化**，故只摘标记不丢内容） |
| `src/core/editor.ts` | 注册 `srcLineTagPlugin()` |
| `src-tauri/src/commands/file_ops.rs` | `reveal_in_folder` 改用 `raw_arg("/select,\"<路径>\"")`（新增 `explorer_select_arg`）+ 实测注释 + Rust 回归单测 |

### 测试（全部新增）
- 二轮：`v0153-text-offset-remap`（23）、`v0153-undo-anchor-restore`（21）、`v0153-preview-realign`（17）
- 三轮：`v0153-block-index-parity`（11）、`v0153-reveal-in-folder`（8）

### 探针（全部新增）
- `scripts/v0153-probe-user-doc-align.mjs`（**用户实际文档**的模式切换对齐取证）
- `scripts/v0153-probe-edit-then-toggle.mjs`（先编辑再往返 + 左右对齐 + 内容保真）
- `scripts/v0153-probe-drift-matrix.mjs`（4 变体 × 8 轮，分离"重对齐"与"真漂移"）
- `scripts/v0153-probe-undo-big.mjs`（阅读/源码两种撤销 + 逐帧 setter hook 抓栈）
- `scripts/v0153-probe-align-async.mjs`（含 mermaid/katex 的对齐时序 + 块内比例口径）
- `scripts/v0153-probe-scrollwriter.mjs`（诊断：谁在写 scrollTop）
- `scripts/v0153-probe-reveal-in-folder.mjs`（资源管理器窗口/选中项判定）

---

## 八、安装与重点试用

1. 优先用 NSIS 安装包覆盖安装；也可直接双击 `lightmd.exe` 免安装试用。
2. **重点验这四项**（都是用户本轮的原话场景）：
   - **用 `LightMD开发需求.md` 那份文档双击 Ctrl**：阅读模式滚到任意位置 →
     双击 Ctrl 进编辑 → 左右两屏应立刻对齐；再双击 Ctrl 回阅读 →
     眼前内容应还在原处（不再"切一次偏一点"）。
   - **编辑后双击 Ctrl**：进编辑 → **在正文里打几个字** → 双击 Ctrl 回阅读 →
     反复切换多次。阅读焦点应始终停在同一处内容；右屏应在**一秒内**自动对齐。
   - **跨模式撤销**：阅读模式里改几处 → 切到编辑模式 → 再改几处 → 按 Ctrl+Z / Ctrl+Y
     来回撤。文档**不应跳到底部、也不应来回抖**；眼前那一段内容应基本停在原处。
   - **打开文件所在目录**：在左侧栏打开一个**路径含空格**的文件夹（例如
     `D:\AI\markdown view`），右键其中文件 →「打开文件所在目录」→
     资源管理器应打开并**选中该文件**。这是本次的 bug 场景（旧版静默无反应）。
3. 首轮的两项（模式切换滑入动画、标题折叠动效）保持不变，可一并回归。

## 九、已知取舍（诚实声明）

1. **本轮沿用同一个版本号 `0.15.2` 重新打包**（用户要求"继续打包到 0.15.2"）。文件名相同、
   内容不同 → **装机/分发以本文件 SHA256 为准**，首轮旧包作废。
2. **模式切换的退场仍是瞬切**（进场面 380ms 滑入）；这是首轮已声明的取舍，本轮未改。
3. **右屏对齐是"最终收敛"，不是"全程逐帧无损"**：异步渲染（mermaid/katex/图片）期间几何本就不定型，
   实测编辑后 160ms 仍可能有 ~9 行偏差，但 **480ms 内必收敛到 <0.5 行**且此后保持。
   若把判据收成"任何时刻 ≤3 行"就要求等渲染完成才切换，会牺牲切换手感。
4. **PM 侧 `beforeAnchor` 仍未接线**：阅读模式撤销后的**光标**不回现场（内容/滚动已由内容锚保住）。
   这是 v0.15.1 就存在的既有取舍，本轮只补齐了滚动与内容，未补 PM 光标位。
5. **源码面内容锚恢复是"视口中央那一行"粒度**：若撤销把那一行本身删掉，会贴到变更区间起点
   （此时视口会向删除点靠拢 —— 这是正确行为，否则会凭空造一个位置）。
6. **`data-src-line` / `data-lmd-empty-line` 是"纯渲染属性"**：它们只由 `Decoration.node`
   与 `toDOM` 输出到 DOM，**从不写回 Markdown**。因此文档格式、文件内容、磁盘字节完全不受影响
   （`\n\n\n` 的原文空行由 `emptyLine` 段落照常序列化回写，往返逐字节相等有测试锁定）。
7. **跨面定位的权威坐标是 `sourceLine`，但它会随编辑漂移**：在前面插入/删除内容后，
   同一块的源码行号会整体平移，所以优先级仍是 `headingId` → `blockIndex`（+ `sourceLine` 纠偏）
   → 兜底按 `sourceLine`。这是**有意的顺序**，不是遗漏（既有 `v0150-content-scroll-map`
   用例锁定 `via === "index"`，本轮只补前置条件、未改该顺序）。
8. **左右「视口中央」对齐差几行是度量口径差异**：左侧按逻辑行插值、右侧按视觉高度插值，
   长段落被软换行时块中央必然有差值（用户文档实测 6.84 行）。判据因此用"视口**顶** ≤3 行"
   作为主判据，"中央 ≤8 行"只作辅助 —— 否则会为了一个不存在的问题破坏手感。
9. **`reveal_in_folder` 的修复只覆盖 Windows**：`raw_arg` 是 Windows 专有 API
   （`std::os::windows::process::CommandExt`）；macOS / Linux 分支代码未改。
10. 沿用 v0.15.1 的全部既有取舍（撤销选区保护窗、全文翻译不入撤销栈、搜索高亮上限 2000 处等）。
