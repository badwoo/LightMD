# LightMD v0.15.1 交付说明

> 构建时间：2026-10-28
> 产物目录：`lightmd/release/v0.15.1/`
> 基线：v0.15.0
> 定位：**问题修复版**。v0.15.0 上线后用户**两轮实机反馈**的 13 项缺陷全部修复并回归验证，不新增功能、不改数据格式。

---

## 一、安装包与校验值

| 文件 | 大小 | SHA256 |
|---|---:|---|
| `LightMD_0.15.1_x64-setup.exe`（NSIS 安装包，推荐） | 7.54 MB | `4165AAEF7306CB892E06EA3C8E5C139A2D94606C5CE403F4262D69BB570FF20C` |
| `LightMD_0.15.1_x64_en-US.msi`（MSI 安装包） | 10.87 MB | `AA3757E0686BCC5BDA8B8714E5BDFB0D971D9FCC0A96F028C4C8710FD8DC7637` |
| `lightmd.exe`（免安装单文件，可直接双击） | 23.16 MB | `4584D50487F2BA48E1A97BF437BB3FB70F72F991D51B26C83ADD7C297A06D39E` |

**产物已验证**：
- 三者都内联本次构建的最新前端产物（`dist/index.html` 指向 `index-CW_EgXc7.js`，在 exe 字节流中实测命中 —— 未踩 `cargo build --release` 出 dev 二进制的坑）。
- `lightmd.exe` 实测可启动（WebView2 正常驻留、无报错）；两个实机探针都直接跑这个 exe（见第四节）。
- 版本号四处一致：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `tauri.conf.json` 均为 `0.15.1`，且无 BOM。

---

## 二、本版修复的 13 项问题（两轮实机反馈）

### 第一轮（7 项）

| # | 用户反馈 | 根因 | 修复 |
|---|---|---|---|
| 1 | 「跨模式撤销两套栈统一还有问题，随便编辑撤销恢复几次后就会出现"已经到这个模式的边界"然后撤销和恢复就不能用了，另外进行撤销时候文档会滚动底」 | **五个独立缺陷叠加**（见第三节） | 逐条修复 + 12 条回归用例 + 撤销相关既有 115 条用例全绿 |
| 2 | 「阅读区标题折叠。增加折叠收起打开的顺滑动效」 | 折叠终态是 `display:none` → 一帧跳变 | 「高度 0 + 裁切 + 不可见」终态 + `interpolate-size` 让 `height:auto↔0` 可插值；三角改固定字符 + `transform` 旋转 |
| 3 | 「通过不断双击 Ctrl 键进行阅读模式和编辑模式切换时…屏幕不断会滚动位置偏移」 | 只采了阅读→编辑方向的内容锚点，反向走百分比 | 双向采集内容锚点（第一轮修法不彻底，第二轮继续，见第四节 2） |
| 4 | 「搜索整个工作区搜索到的文件以及对应位置没有像查找所有打开文件夹那样，可以点击跳转」 | `fileKey` 归一化键 vs 原始路径严格比较；命中文件可能未打开 | 统一 `pathCompareKey`；未打开时按路径打开并提示 |
| 5 | 「搜索框尺寸放大要放大一倍」 | — | 第一轮先放大到 920px（第二轮按观感反馈重做为 620×38，见第四节 3） |
| 6 | 「搜索框突然变大或缩小增加一个过度效果。另外搜索框变大后两个按钮位置变了」 | 条幅条件渲染 → 面板高度一帧跳变；选项行 `flex-wrap` + `margin-left:auto` → 按钮漂移 | 条幅外壳常驻 + 高度/透明度/位移过渡；选项行改「勾选组（可压缩）+ 右侧动作组（固定）」 |
| 7 | 「图片灯箱功能入口请改为双击图片进行图片全屏查看，缩放 / 前后切换 / Esc 关闭」 | 入口闸门是 `editable === false`（与 viewMode 无关）→ 普通文档阅读模式下打不开；入口是单击 | 闸门改 `viewMode === "preview"`；入口改**双击**（三面）；单击语义不变 |

### 第二轮（6 项，本轮新增）

| # | 用户反馈 | 根因 | 修复 |
|---|---|---|---|
| 8 | 「折叠动效再放慢一倍」 | — | 折叠/展开 220ms → **440ms**，三角旋转 180ms → **360ms**（PM 面与 iframe 面同口径） |
| 9 | 「双击 Ctrl 漂移还未完全解决，阅读模式刚开始切到编辑没问题，但连续多次双击后编辑模式开始细微偏移，然后阅读模式也开始跟着偏移」 | **取锚点的那一帧被切走的面已经被 `display:none`**：`useLayoutEffect` 在 DOM 提交之后跑，`clientHeight/clientWidth` 已是 0 → 只能用滚动期旧缓存；且"块内比例"按元素 rect 高算，块间空隙被钳成 1 丢掉 | ①两个方向都在 **render 期**（旧面仍可见）现量几何；②比例改按**连续区域**（块顶 → 下一块顶）归一，空隙不再丢失。实机探针两面漂移 **0.00px**（见第四节 2） |
| 10 | 「搜索框的观感不好，太长了，高度又太低，观感不协调，请美学的设计下」 | 第一轮把宽度加到 920px、输入框仍 34px → 宽高比 27:1，又长又扁 | 面板 **620×38**（宽高比 16.3:1），圆角/内边距/字号/阴影分层重做；窄屏 `max-width:92vw`；两按钮位置几何实测不变 |
| 11 | 「工作区搜索到 4 处内容（同一文档），点第一处跳过去后再点其他 3 处没反应；且每处都跳到文档第一个搜索；行号跟右下角显示的行列不一致」（并要求同样检查「查找所有打开文件」） | ①接收端只依赖 `docKey` 变化 → 目标文档已打开时 effect 不重跑；②同一行多处命中无法区分、`occurrence` 全相同；③条幅行列用的是源码文本坐标，与状态栏的 PM 逻辑块坐标不同口径 | ①加 `SEARCH_JUMP_EVENT` 自监听 + 自增 `seq`；②每处命中带 `hitOffsets` + 行内 `hitIndex`，按 occurrence 精确定位；③条幅改显示与状态栏同一套 PM「逻辑块行:列」（CRLF 已核对）。「查找所有打开文件」同源同修，实机 44/44 PASS |
| 12 | 「搜索到的内容高亮，当前需要点上一个下一个才能高亮，请改为只要搜索到那么所有内容都高亮，但点击上一个下一个定位到具体高亮内容时可以换个其他醒目的颜色」 | 只有一个 `searchHighlightKey`（单区间），只在跳转时设置 | 新增 `searchMatchesKey`（全量区间，上限 2000，超出显式提示）+ 保留 `searchHighlightKey` 作当前项；阅读面两层 Decoration，源码面 overlay 等价实现；当前项随 ↑/↓ 移动 |
| 13 | 「跨模式撤销栈统一再检查下看有没有问题」 | 独立审计再抓出 **2 个真实缺陷**（见第四节 6） | ①撤销选区兜底定时器抢光标 → 代际 token 作废；②6 处源码通道外部写回不进时间线 → 全部接入 `recordDiscreteSourceEdit` |

---

## 三、第一轮 · 需求1 的五个真实缺陷（v0.15.0「撤销统一」其实只接线了一半）

用户报的「撤几次就报边界、然后撤销恢复全废」不是单一 bug，而是五个缺陷叠加：

### 缺陷 1（最关键）：阅读模式（PM）的编辑**从来没进过时间线**

- `pmAdapter` 的 `serialize` 生产实现是 `getMarkdownFromDoc(doc)`（期望 PM **doc**），
  而 `core/editor.ts` 的 `onTransactions` 传进来的是 **`EditorState`**。
- `EditorState` 没有 `.content` → 序列化抛错被 `catch` 吞掉返回 `""` →
  `commit({before:"", after:""})` 因无变化返回 null → **每一个字都不入库**。
- 修法：`pmAdapter` 内部剥一层（有 `.doc` 取 `.doc`），两处 `serialize` 调用都走 `unwrapDoc`。

### 缺陷 2：首挂时时间线基线从未建立

- `begin(docKey, content)` 只写在「换文档 effect」里，而那个 effect 在
  `content === lastContentRef.current` 时提前 return —— 首次挂载正好命中。
- 于是 `documentHistory.currentText(key)` 恒为 null → `ensureDoc` 用 `before ?? ""` 建了条
  `knownText=""` 的空时间线 → before 失配 → 静默拒绝。
- 修法：`onReady` 里补首挂基线（`pmAdapter.reset` + `sourceAdapter.reset` + `historyBegin`）。

### 缺陷 3：8 处源码编辑仍写**已退休**的旧 diff 栈

`pushUndoEntry` 写进 `undoStackRef`，而 v0.15.0 把 `doLocalUndo/doLocalRedo` 改成只走
`documentHistory` —— 旧栈**没有任何人消费**。双重后果：这些操作不可撤销；更严重的是它们改了
文本却没推进 `knownText` → 下一次普通打字 `commit` 失配 → `rebaseText(force:true)` →
**`truncateRedo` 把 redo 分支整段删掉** → 反复几次后时间线被推平 → 弹「已到边界」。

### 缺陷 4：撤销/重做后 `pmAdapter` 基线未同步

撤销走 bridge 事务，`pmAdapter` 按设计整批忽略（正确），但内部 `baseline` 仍停在撤销前文本 →
用户一打字又触发 force-rebase → truncateRedo。修法：新增 `pmAdapter.setBaseline()`，协调器在
落地成功后调用 `syncAdapterBaseline`。

### 缺陷 5：边界提示重复 + 误报

协调器已弹过一次，`handleUndo` 返回 false 时又无条件弹一次；且 `false` 还可能是「docKey 为空」
「跨文件条目过期」等原因。修法：边界提示职责收归协调器。

### 缺陷 6（对应「撤销时文档滚到底」）

整篇替换让内容变短 → 浏览器把 `scrollTop` 钳到新 max（= 贴底）。修法：**锚内容不锚像素** ——
撤销前采「视口中央是哪个块 + 块内比例」，落地后按新几何反算，0/60/160ms 校正；
用户用 wheel/pointerdown/滚动键接管即停手（判据用输入事件而非 scrollTop 差值）。

---

## 四、第二轮 · 六项详解

### 1. 折叠动效再放慢一倍

`src/styles/readingFold.css` 与 `readingFold.ts` 注入的 iframe CSS 同口径：
`height/opacity/margin/padding/border` 过渡 220ms → **440ms**，三角 `transform` 旋转 180ms → **360ms**；
`overflow`/`visibility` 的"动画结束才切换"延迟同步改成 440ms（否则会提前裁切/提前隐藏，动画看起来被截断）。

### 2. 双击 Ctrl 漂移（第四、五次返修，本轮彻底解决）

**为什么前三次返修都没根治**（每一版都被实机探针推翻，记录如下便于后续维护）：

| 返修 | 做法 | 为什么仍漂 |
|---|---|---|
| 第一次 | 只给阅读→编辑采内容锚点 | 反向仍走百分比，两种排版几何不同 → 每轮累积 |
| 第二次 | `useLayoutEffect` 里双向现量 | effect 在 DOM 提交**之后**跑，切走那一面已 `display:none`，几何全 0 → 采到 null → 静默退回百分比（探针实测值在 7958/3179 交替） |
| 第三次 | 可见期间缓存几何，切换读缓存 | 缓存是滚动时写的快照；恢复流程之后还会 rAF/60/160ms 校正，**下一轮以"上轮校正前"的位置为基准** → ratio=0.2 时 +45/+103/+170，ratio=0.8 时 −78/−163/−274（**单调同向累积**，正是用户描述的症状） |
| **第四次（本轮）** | **render 期**采锚点（旧面仍可见，现量）+ 比例改按**连续区域**归一 | 通过：两面 0.00px |

关键点两条：

1. **render 期读 DOM 是安全的**：`viewMode` 已变、DOM 还没提交，旧面仍在文档里；这里只
   读布局（`clientHeight` / `scrollTop` / `getBoundingClientRect`），不 setState、不改渲染输出。
2. **"块内比例"必须按连续区域算**：阅读面每块是元素 rect（高度不含外边距），块与块之间留着
   真实空隙；源码面按行轴还原的块高**把空行算进上一块**（首尾相接）。用元素高做分母时，
   视口中央落在空隙里比例会被钳到 1、空隙宽度丢失 → 同一几何往返一次就跳一个空隙（实测 11px）。
   改成「本块顶 → 下一可见块顶」为区域后，两侧口径一致，空隙被算进前一块，往返像素级幂等。

**实测数据**（`scripts/v0151-probe-mode-toggle-drift.mjs`，跑在打包产物上）：

```
任意位置往返幂等（0.2 / 0.5 / 0.8 三个位置各 4 轮）
  修复前：ratio=0.2 漂移 +0/+45.5/+103.5/+170.0
          ratio=0.5 漂移 −6.0（恒定，但值本身偏了）
          ratio=0.8 漂移 −78.5/−163.5/−215.0/−274.5
  修复后：ratio=0.2/0.5/0.8 漂移全部 +0.0/+0.0/+0.0/+0.0   ← 像素级幂等

连续双击 Ctrl（FAST 模式 12 轮 = 24 次切换）
  编辑面 ta.scrollTop：14415.0 × 12（净漂移 0.00px）
  阅读面 scrollTop  ：7947.0 × 12（净漂移 0.00px）
  视口中央内容      ：12/12 与基线一致
  切换窗口内写入幅度：0.0（不再有"先写到别处再校正回来"）
  判定：10 PASS / 0 FAIL

慢速模式 20 轮（每轮等稳态）同样 10 PASS / 0 FAIL，两面净漂移 0.00px
```

### 3. 搜索框观感重设计

| 项目 | 第一轮（被反馈"又长又扁"） | 本轮 |
|---|---|---|
| 面板宽度 | 920px | **620px**（`max-width: 92vw`） |
| 输入框高度 | 34px | **38px** |
| 宽高比 | 27.06 : 1 | **16.32 : 1** |
| 圆角 | 混用 | 面板 12 / 控件 8 / 小件 6 三层递减 |
| 阴影 | 单层 | 两层（贴边 + 扩散），与圆角配合 |
| 选项行 | 勾选组 + 固定动作组 | 保持（**按钮位置几何实测：折叠/展开两态坐标完全一致**） |

宽度取 620 的依据：英文标签（"Search all open files" / "Search entire workspace"）+ 勾选项
在 617px 时刚好单行不折行；再窄就会换行、按钮位移。窄屏（窗口 500px）实测面板收到 460px，仍不折行。

### 4. 工作区搜索 / 查找所有打开文件的三个症状

- **"点了没反应"**：接收端 effect 的依赖是 `docKey` 等；第 1 次点击目标文档从别的标签切过来时
  `docKey` 变了会跑，第 2/3/4 次点击时**目标已经是当前文档**，App 的 handler `return` 掉、
  `docKey` 不变 → effect 永不重跑 → pending 一直挂着。修法：`requestSearchJump` 派发
  `SEARCH_JUMP_EVENT`，`SearchReplace` 自己监听并在 `sameJumpKey(pending.fileKey, docKey)` 时
  就地消费；另加自增 `seq` 兜底（放入 effect 依赖）。
- **"每处都跳第一处"**：同一行多处命中时 `occurrence` 只有一个值。修法：`SearchFileResult` 增加
  `hitOffsets`（每处命中在全文的偏移）与 `SearchLineSegment.hitIndex`，跳转统一用
  `resolveJumpByOccurrence` 精确到"第几处"，不再只认"该行首个命中"。
- **"行号与右下角不一致"**：条幅此前显示源码文本坐标（含 CRLF 的 `\r` 也算一列），而状态栏显示
  PM 逻辑块行列。修法：`clipLineInternal` 记录每段的 `origins[]`，并用 `pmLineColumnOfOffset` /
  `lineColumnOfPos` 换算成与状态栏同一套坐标；`statusLine/statusColumn` 只做显示，
  `line/column` 仍保留文本坐标供跳转使用。

**实机验证**（`scripts/v0151-probe-search-real.mjs`，44 项断言全 PASS）：同一文档 4 处命中的
`scrollTop` 依次 `196 → 1833 → 3469 → 5106`（不再恒定），计数 `1/4 → 4/4`，当前块 `LOC-1..LOC-4`；
行号对照：阅读模式 `8:54 / 32:54 / 56:55 / 80:55` 与状态栏**完全一致**；CRLF 文档
`5:82 / 10:60 / 15:39` 也一致（`\r` 不计列宽，无 off-by-1）。

### 5. 全命中高亮 + 当前项醒目色

- 两层 Decoration：`searchMatchesKey`（全量区间数组）+ `searchHighlightKey`（当前项），
  **两个独立 PluginKey**，避免改动既有 `v0140-search-undo-refresh` 对"当前高亮区间"的断言。
- 范围上限 `MAX_HIGHLIGHT_MATCHES = 2000`；超出时高亮前 2000 处并显示 `.search-highlight-limit`
  徽标「仅高亮前 N 处」（有 i18n，不静默截断）。
- 源码面用 `.source-search-overlay`（与 textarea 逐字符对齐的 overlay），高亮/当前色同口径。
- 搜索关闭 / 清空关键词 / 换文档时两层装饰与 overlay 全部清空（实测残留计数 0，切模式不复发）。

### 6. 跨模式撤销栈再审计（独立审计 38 条用例）

场景覆盖：阅读/编辑连续打字撤销重做的**逐字节**序列、跨模式步序、撤到底提示只一次且之后
仍可用、撤销后输入截断 redo、光标与滚动现场、空文档/多文档/无 docKey、外部写回各一步、
撤销中途切模式后基线不漂。结论：时间线自洽，但抓出 **2 个真实缺陷**：

1. **撤销选区兜底定时器抢光标**（实测）：撤销后 60ms 内打字 → 字符插对了，250ms 后光标被
   `requestAnimationFrame(applySelection)` / `setTimeout(applySelection, 60)` 抢回撤销时的位置
   （`selectionStart` 8 → 输入后 9 → 又被拽回 8）→ 下一个字符插到错误位置。
   修法：新增 `sourceSelectionRestoreTokenRef` 代际 token，`handleSourceChange` 输入时 `++`，
   定时器回调比对代际号，过期即退场。
2. **源码通道的外部写回不进统一时间线**（6 处）：选区翻译回写、AI 润色、AI 对话「替换选区」、
   AI 对话「插入光标处」、AI 续写/摘要插入、AI 续写 ghost 的 Tab 采纳。
   后果：① `Ctrl+Z` 撤不回译文；② 时间线 `knownText` 停在回写前 → 下一次打字 force-rebase →
   **静默清掉 redo 分支**。修法：全部改走 `recordDiscreteSourceEdit`，并给该函数增加可选
   `afterCaret`（撤销回原选区起点、重做回替换内容末尾）。

---

## 五、验证结果

| 项目 | 结果 |
|---|---|
| 前端测试 | **338 文件 / 6190 用例全部通过**（v0.15.0 基线 6066 → v0.15.1 首轮 6118 → 本轮 6190，累计净增 124） |
| `tsc --noEmit` | **0 错误**（strict） |
| 撤销相关用例 | **10 文件 / 162 条全绿**（含本轮新增 50：跨模式 12 + 独立审计 38），**未改任何既有断言** |
| 搜索相关用例 | 193 条全绿（`v0150-search-workspace-ui` 30 / `v0151-search-highlight-all` 20 / `v0140-search-undo-refresh` 11 / 工作区搜索 / 正则搜索等） |
| 折叠相关用例 | `v0150-reading-fold` 102 条全绿（含动画时长 440/360 断言） |
| 几何算法用例 | `v0150-content-scroll-map` 57 条全绿（新增 5 条「块间空隙往返幂等」） |
| 实机探针 · 模式切换漂移 | **10 PASS / 0 FAIL**（FAST 12 轮 + 慢速 20 轮，两面漂移 0.00px） |
| 实机探针 · 搜索功能 | **44 PASS / 0 FAIL**（工作区 4 处跳转 / 打开文件 4 处跳转 / 行号三类对照 / 全命中高亮 / 源码 overlay / 清理） |
| 打包产物 | NSIS + MSI + 单文件 exe 均内联最新 dist（探针内置 hash 校验） |

### 实机探针（新增）

| 脚本 | 用途 | 结果 |
|---|---|---|
| `scripts/v0151-probe-mode-toggle-drift.mjs` | 双击 Ctrl 反复切换的滚动漂移取证（含任意位置往返幂等、两面时间序列采样、exe 内联 dist 校验） | 10/10 PASS |
| `scripts/v0151-probe-search-real.mjs` | 搜索/替换实机验证（工作区与打开文件跳转、行列对照含 CRLF、全命中高亮、源码 overlay、清理） | 44/44 PASS |
| `scripts/v0151-probe-mode-toggle-drift.mjs` 内置诊断 | 页面内 `window.__LMD_SCROLL_TRACE = []` 可开启"采锚点/反算/写入"埋点（默认关闭、零开销） | 用于定位本轮根因 |

---

## 六、改动文件

### 源码
| 文件 | 改动 |
|---|---|
| `src/components/editor/EditorContainer.tsx` | render 期双向采锚点、源码面几何现量/缓存、连续区域锚点接线、恢复保护窗（400ms 代际）、撤销选区代际 token、6 处外部写回接入时间线、诊断埋点 |
| `src/utils/contentScrollMap.ts` | `contentRegionsOf` / `regionAtY`（连续区域口径），`captureContentAnchor` / `restoreContentAnchor` 改用它 |
| `src/components/editor/readingFold.ts` / `src/styles/readingFold.css` | 折叠动效时长 440ms / 三角 360ms（含 iframe 面） |
| `src/components/editor/SearchReplace.tsx` / `.css` | 620×38 重设计、两层高亮与当前项色、`SEARCH_JUMP_EVENT` 自监听 + `seq`、就地跳转、条幅行列口径、`hitIndex` 点击定位 |
| `src/core/editor.ts` | `searchMatchesKey`（全量区间）+ `searchHighlightKey`（当前项）两层装饰，`SearchHighlightPayload {ranges, current}` 兼容旧 `{from,to}` |
| `src/utils/searchEngine.ts` | `hitOffsets`、`hitIndex`、`statusLine/statusColumn`、`pmLineColumnOfOffset`、`lineColumnOfPos`、`clipLineInternal.origins` |
| `src/utils/searchJump.ts` | `hitIndex` / `seq` / `peekSearchJumpSeq` / `takeSearchJump(fileKey, seq)` |
| `src/services/workspaceSearch.ts` | 命中行/列与 hitOffsets 透传 |
| `src/utils/highlight.ts` | `buildSearchOverlayHtml(text, ranges, current)`（源码面 overlay） |
| `src/App.tsx` | search-jump 监听器归一化 + 未打开文件按路径打开 |
| `src/i18n/locales/{zh-CN,en-US}.ts` | 新增 `search.highlightTruncated`（仅高亮前 N 处） |

### 测试
- 新增：`src/__tests__/v0151-search-highlight-all.test.tsx`（20）
- 新增：`src/__tests__/v0151-cross-mode-undo-audit.test.tsx`（38）
- 追加：`src/__tests__/v0150-content-scroll-map.test.ts`（+5，52→57）
- 追加：`src/__tests__/v0150-search-workspace-ui.test.tsx`、`v0150-reading-fold.test.ts`、`v0140-search-ui.test.tsx`（逐条语义等价更新，未弱化断言）

### 探针
- 新增：`scripts/v0151-probe-mode-toggle-drift.mjs`（模式切换漂移，两轮改写）
- 新增：`scripts/v0151-probe-search-real.mjs`（搜索功能实机验证）

---

## 七、安装与重点试用

1. 优先用 NSIS 安装包覆盖安装；也可直接双击 `lightmd.exe` 免安装试用。
2. **重点复测这 13 项**（都是用户原话对应的操作）：
   - **撤销**：编辑里改几个字 → 切阅读 → `Ctrl+Z`（应撤得掉）；反复撤/恢复 3 轮（不应报边界）；
     在长文档中部撤销（不应跳到文档底部）；撤销后立刻打字（光标不应跳回）；选区翻译 / AI 润色后 `Ctrl+Z`（应能撤回）。
   - **折叠动效**：点标题左侧三角，收起/展开应比上一版明显更慢更顺（440ms），三角旋转平滑。
   - **双击 Ctrl 切换**：滚到中间，连按 20 轮，编辑面与阅读面都应停在原处（0 漂移）。
   - **搜索框**：比例应协调（不再又长又扁），展开/收起条幅高度平滑，两个作用域按钮不位移。
   - **工作区搜索 / 查找所有打开文件**：同一文档命中 4 处，依次点第 1/2/3/4 条都应跳到**各自**位置；
     条幅行号应与右下角状态栏一致（含 CRLF 文档）。
   - **全命中高亮**：一搜出结果所有命中就都高亮；点 ↑/↓ 时当前那一处换成强调色。
   - **图片灯箱**：双击图片全屏，滚轮缩放、←/→ 切图、Esc 关闭；单击只是选中。

## 八、已知取舍（诚实声明）

1. **撤销现场恢复有约 250ms 的选区保护窗**：对抗 React 受控组件重置选区所必需；用户真实输入立即失效。
2. **阅读模式撤销后光标不回到编辑前位置**：PM 时间线条目没有位置数据（`beforeAnchor/afterAnchor`
   需适配器采集锚点才能填上）。不会跳回文首；源码模式撤销则精确恢复光标与滚动位置。
3. **「全文翻译」的整篇回写不作为可撤销步骤**（沿用 v0.13.1 需求8 的既有口径，用「取消翻译」气泡恢复）。
   代价说明：它会推进时间线基线；因为整篇内容已被重写，redo 分支本就失去意义。
   而"选区翻译 / AI 润色 / AI 替换选区 / AI 插入光标处 / AI 续写采纳"都**算一步可撤销**。
4. **折叠动效依赖 `interpolate-size: allow-keywords`**（Chromium 129+ / 本机 WebView2 155 支持）；
   不支持的引擎自动退化为瞬时显隐——功能完整，只是没有动画。
5. **搜索高亮上限 2000 处**：超过只高亮前 2000 处并显式提示，不静默截断。
6. **编辑模式的搜索条幅只显示行号、不显示列号**：这是改造前既有行为（本轮未改），
   行号与状态栏一致；阅读模式下条幅显示「行:列」，与状态栏完全一致。
7. **模式切换的 `scrollTop` 恢复保护窗 400ms**：窗口内的自动校正不写缓存、不更新阅读进度；
   用户此时主动滚动/输入立即接管。
8. **撤销历史仍是会话内的**（不跨重启持久化），上限 200 步 / 32MB 每文档。
