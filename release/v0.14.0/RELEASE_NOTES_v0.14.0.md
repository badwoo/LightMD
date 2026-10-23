# LightMD v0.14.0 发布说明

> 发布日期：2026-10-23 ｜ 基线：v0.13.2 ｜ 定位：**交互收敛（三模式 → 二模式）+ 搜索能力增强 + 实机缺陷修复**
>
> 本版不再推进 CodeMirror 6 迁移（0.14.0 原 CM6 实施方案作废），改为按用户重新评估后的三条需求重做：
> ① 三模式合并为二模式（编辑与分屏合并，右屏可滑出/滑回）；② 搜索替换增强（全词 / 大小写 / 选取范围内 / 查找所有打开文件）；
> ③ 修复分屏分割线单向拖拽缺陷。
>
> 全部 45 项验收在**打包产物 + WebView2 CDP 真实鼠标键盘手势**下逐条实测通过（`scripts/real-machine-v0140.mjs`）。

## 一、安装包

| 文件 | 说明 |
|---|---|
| `LightMD_0.14.0_x64-setup.exe` | NSIS 安装包（推荐，单文件、免管理员） |
| `LightMD_0.14.0_x64_en-US.msi` | MSI 安装包（企业分发） |

```
0e53494c63d3ccf227437a76b19f37861faee4db83d62b219ce8b1d4b6bb6e12  LightMD_0.14.0_x64-setup.exe
a6e746af10d6fb2e8d5aee31fa9bb1f4f95ac05b27c06feff19b6510f2775a40  LightMD_0.14.0_x64_en-US.msi
```

> `lightmd.exe` 的 `FileVersion` / `ProductVersion` 实测均为 `0.14.0`。

## 二、需求 1：三模式合并为二模式

### 2.1 菜单只剩「阅读 / 编辑」

- 标题栏模式按钮组由「阅读 / 编辑 / 分屏」收敛为**两格**：阅读、编辑。
- **点「编辑」直接进入原「分屏」观感**（左源码 + 右预览），不再有独立的「分屏」入口。
- 双击 `Ctrl`：阅读 ↔ 编辑（进入编辑时右侧预览自动打开）。
- 双击 `Shift`：
  - 在阅读模式 → 进入编辑并展开右侧预览；
  - 已在编辑模式 → 纯切换右侧预览（等同下面的「关闭预览 / 打开预览」）。
- 命令面板里原「分屏模式」改为「切换预览面板（编辑模式）」（命令总数不变）。

### 2.2 分割线上的竖排呼吸小字

- 鼠标移到**右屏**（或分割条）时，分割线正中浮现一列**灰色竖排**小字「关闭预览」：
  - `writing-mode: vertical-rl` + `text-orientation: upright`，11px、字距 2px；
  - 带 2.4s `ease-in-out` 的呼吸动画（透明度 0.55 ↔ 1.0）；
  - 平时不可见（`opacity: 0`），符合「隐约出现」的诉求。
- 点「关闭预览」→ 右屏**顺滑往右滑到语法辅助栏左侧**（宽度 `(1-比例)` → 0，280ms 缓动），
  源码区同时铺满整区；文字变成「打开预览」。
- 点「打开预览」→ 右屏**从右往左顺滑滑出**，恢复分屏样子。
- 预览关闭后，编辑区右缘保留一条 18px 的静默窄 rail（常驻半透明「打开预览」竖排字），
  它是重新打开预览的入口，也是「右屏滑到语法辅助栏左侧」的视觉落点。

### 2.3 行为细节

- `Esc` / 切标签 / 切阅读模式都不会改变「预览开关」的记忆：下次进入编辑按上次状态展开。
- 大文件（>5MB）降级为编辑模式时**自动关闭预览**（与旧版「强制纯源码」等价，避免渲染超大 HTML 卡顿）。
- 无 markdown 内容时预览区自动清空（不会残留上一个文档的 HTML）。

## 三、需求 2：搜索增强

### 3.1 四个勾选项（默认全部不勾）

| 勾选项 | 语义 |
|---|---|
| **全词匹配** | 按 Unicode 词边界（`\p{L}\p{N}_`）判定：`cat` 不匹配 `concat` / `cats`，中文「测试」不匹配「我的测试」 |
| **匹配大小写** | 区分 `cat` / `Cat` / `CAT` |
| **选取范围内** | 只在**勾选瞬间的选区**内查找与替换 |
| **正则** | 沿用旧行为，替换支持 `$1` / `$&` 捕获组；非法表达式红字提示不崩溃 |

「选取范围内」的三条硬约定：

1. 选区在**勾选那一刻**捕获一次（之后手动改光标不跟随，这是确认过的语义）；
2. **替换后范围随文本增量自动平移** —— 范围不会被第一次替换撑破；
3. 勾了但**当前没有选区** → 匹配数显示 0 并红字提示「请先在编辑器中选中一段文本」，
   **绝不静默退回全文搜索**（否则一次「全部替换」会改掉整篇文档，不可逆）。
4. 切标签 / 切模式后旧选区快照作废并提示重新选取（避免跨文档错位改写）。

### 3.2 查找所有打开文件

- 点「查找所有打开文件」→ 搜索框下方展开结果条幅，每条为「**文件名 + 命中行内容**」，
  行内的关键字用 `<mark>` 高亮；同一条里多处命中全部高亮。
- 条幅顶部有汇总：`{命中数} 处（{文件数} 个文件）`。
- **点击条目跳到对应文件的对应位置**：当前文档就地定位并高亮；其他文件先切标签，
  文档就绪后按「第 N 次出现」定位（源码空间与渲染空间行号不同，用出现次序换算），
  跳不到时给出可见提示而不是「点了没反应」。
- 上限：单文件 500 行、最多 200 个文件，超出显示「结果过多，仅显示前 N 条」。
- 勾了「选取范围内」时，条幅**只列当前文档**的结果（选区是当前文档的文本坐标，
  套到别的文件上毫无意义且会把结果全误杀）。

### 3.3 两种模式都生效

- 编辑模式走源码文本，阅读模式走 ProseMirror 渲染文本，高亮与替换都是各自坐标系里的精确位置。
- 阅读模式跨段落选区：落在块间隙的位置会收敛到前一块末尾（换行符上的匹配不计入）。

## 四、需求 3：分屏分割线可以来回拖

### 4.1 缺陷与根因（真实 WebView2 实测取证）

用户反馈「往左拖拽调整大小后没法往右拖回来」。探针（`scripts/v0140-probe-split-divider.mjs`，旧版 exe + 真实鼠标手势）：

| 手势 | 发出的 mouseMoved | 父文档收到 | ratio |
|---|---|---|---|
| 往左拖 | 6 | **6** | 0.424 → 0.305 |
| 往右拖 | 6 | **0** | 冻结在 0.305 |

`document.elementFromPoint` 每一步都返回 `IFRAME.split-preview` —— 分割条右侧紧贴右侧预览 iframe，
指针一进入 iframe，父文档的 `mousemove` / `mouseup` 全部丢失，拖拽链路中断；`mouseup` 丢失还让
`body` 卡在 `col-resize` / `user-select:none`。

### 4.2 修复

- 按下时用 `setPointerCapture` 把指针捕获到分割条 → 进入 iframe 后事件仍能回到拖拽逻辑；
- 拖拽期间临时屏蔽页面内 `iframe/embed/object` 的 `pointer-events`（结束时恢复**原值**，不是清空），
  并注入一条只在拖拽期生效的运行期样式表，覆盖「拖拽中新挂载的 iframe」；
- 新增 `pointermove/pointerup/pointercancel` 通道，保留 `mousemove/mouseup` 兼容路径，
  两条通道用一个 `pointerSeenRef` 去重（保证一次手势只触发一次 `setWidth`）；
- 修掉一个潜在缺陷：`initialRatio` 原来只在挂载时读一次，外部比例变化后第二次拖拽的起点是旧值 →
  现在外部值变化会同步内部 ratio，但**拖拽进行中不覆盖**（防跟手抖动）；
- 四个方向（侧栏 / 大纲 / 分屏比例 / 竖向分节）的拖拽**数学一行未改**，`v0.8.2` 的
  「按键全松 → 立即结束」与「窗口失焦 → 结束」兜底语义保留。

### 4.3 顺带修掉的实机缺陷

「关闭预览 / 打开预览」竖排小字**点击无反应**。根因：它是分割条的**子元素**，
在分割条上启动拖拽后 `setPointerCapture` 把指针捕获到分割条，随后的 `click` 被重定向，
按钮的 `onClick` 永不触发。修复：分割条的 `onMouseDown` 对落在竖排按钮上的按下直接放行。
修复后实测：点一下右屏 1071px → 0px、文案变「打开预览」，再点回到 1071px。

## 五、质量验证

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0**（strict） |
| 全量单元测试 | **304 文件 / 5262 用例全部通过**（串行，272s） |
| 本版新增测试 | 6 个文件：`v0140-two-modes`(21) · `v0140-split-divider`(23) · `v0140-search-engine`(68) · `v0140-search-ui`(29) · `v0140-search-reading-mode`(8) |
| 实机验收（打包产物 + CDP） | **45 项全 PASS**（`scripts/real-machine-v0140.mjs`，报告见 `_verify-out/v0140-real-machine.txt`） |
| 前端构建 | `pnpm build` 成功 |
| 打包 | MSI 11,247,616 B / NSIS 7,807,572 B；`lightmd.exe` FileVersion + ProductVersion = 0.14.0 |
| 版本号一致性 | `package.json` = `Cargo.toml` = `tauri.conf.json` = `Cargo.lock` = **0.14.0** |

### 实机验收要点（逐条实测，非源码断言）

- 标题栏两格、无「分屏」；点「编辑」右屏展开 1008px；竖排 `vertical-rl` / `upright`；
  鼠标移到右屏 opacity 0 → 0.96、`splitDividerLabelBreathe` 在跑。
- 点「关闭预览」右屏 1008 → **0px**、文案「打开预览」、模式仍是编辑、源码区铺满 2004px；
  点「打开预览」回到 1008px。双击 Shift / 双击 Ctrl 语义正确；阅读模式双击 Shift 进编辑且展开。
- 分割线往左拖 1008 → 1228px，**松手后往右拖 1228 → 968px**，拖拽后无残留
  （`cursor`/`user-select`/`split-resizing` 全部复原）。
- 搜索：默认 6 处 → 勾大小写 4 处 → 再勾全词 2 处 → 取消大小写（保留全词）4 处；
  选取范围内只命中行内 2 处；范围内替换两处（`concat` → `conDOG`）且选区外未被改写；
  反向全部替换后与原文**逐字节一致**；条幅含文件名/命中行/`<mark>`/汇总，点其他文件条目正确切标签；
  阅读模式（ProseMirror 路径）搜索同样生效。

### 本版已知取舍（不是缺陷）

1. 搜索/替换的结果写回**不进**源码模式的撤销栈（`Ctrl+Z` 撤不回替换结果），与 v0.4.2 起的既有语义一致；
   需要回退时用反向替换。
2. 「选取范围内」的选区快照不跟随用户事后手动改选区（勾选瞬间捕获一次，之后只随替换平移）。
3. 结果条幅打开期间修改正文不会自动重算（避免每次键入都全量扫描所有标签）；改搜索词/选项会刷新。
4. 阅读模式下跨段落选区的换行符位置不计入范围。

---

# v0.14.0 第二批（2026-10-23，同一版本号重新打包）

> 定位：**功能新增 + 5 项问题修复 + 1 项观感升级**。7 条需求全部在**打包产物 + WebView2
> 真实鼠标键盘手势**下逐条实测：**34/34 PASS**（`scripts/real-machine-v0140-batch2.mjs`）。

## 一、安装包（本批重新打包）

| 文件 | 说明 |
|---|---|
| `LightMD_0.14.0_x64-setup.exe` | NSIS 安装包（推荐） |
| `LightMD_0.14.0_x64_en-US.msi` | MSI 安装包（企业分发） |

```
b8bf77a0c6d3f305c449f85870a2d6caddbcea3d124cdecfb12ab84cf0f1428f  LightMD_0.14.0_x64-setup.exe
a8b8275afb2de7b576405080f1a22e4a7a5f5a8ed0ae107cdf6f272889aec6ed  LightMD_0.14.0_x64_en-US.msi
```

> `lightmd.exe` 的 `FileVersion` / `ProductVersion` 实测仍为 `0.14.0`（版本号不变，内容更新）。

## 二、7 条需求逐条落地

### 需求1：增加更新功能（设置里最后）

- 设置面板**末尾**新增「软件更新」区：当前版本 + 「检查更新」按钮。
- 有新版本 → 显示 `发现新版本 vX（当前 vY）` + 可折叠「更新说明」+ 「下载并安装」+ 「打开发布页」。
- 下载中显示百分比进度条 → 完成后提示并**启动安装向导**。
- 已最新 → 「已是最新版本 v0.14.0」。
- 失败 → 「检查更新失败：<原因>」+「重试」，不卡界面。

技术要点（为什么这么做）：
- **网络请求必须走 Rust**：`tauri.conf.json` 的 CSP `connect-src` 不含 https，WebView 无法直连
  GitHub；Rust 侧用 `reqwest`（已有依赖）+ 20s 超时 + 必带 `User-Agent`（无 UA GitHub 返回 403）。
- **版本比较按数字段**而非字符串：字典序会误判 `"0.9.0" > "0.14.0"`。
- **下载目录**：`app_cache_dir()/updates/`，流式写盘（大文件不占内存），期间 emit
  `lightmd://update-progress`；失败清理半成品。
- **安全**：`launch_installer` 三重校验——路径必须存在、扩展名只能 `.exe`/`.msi`、
  canonicalize 后必须在 `updates/` 目录内（按路径组件判定，`/updates-evil` 不能绕过）。
  绝不执行网络返回的任意可执行文件；`asset_url` 只用于下载。
- 安装包筛选排除 `.sig` / `SHA256SUMS` 这类非安装文件。

### 需求2：阅读 ↔ 编辑来回切换丢失阅读进度

- 实测取证（CDP 采样）：阅读 50% → 点「编辑」→ 右屏 iframe **0.006**、左栏 textarea **0**。
- 根因两层：
  1. `applyScroll` 的双 rAF 在 ~44ms 执行，此时左栏还不可滚动 → 旧代码
     `scrollTop = newTop ?? 0` **当场写 0 且不重试**；`splitScrollSync` 随即把这个 0
     推给右屏 → 两屏都掉 0。
  2. 右屏的待恢复值只在「iframe 内容写入 effect」里被消费，而该 effect 的依赖是
     `previewHtml` —— 阅读→编辑切换时它**根本没变**（右屏内容早渲染好了，只是外壳
     宽度从 0 变正）→ effect 不重跑 → pending 永远没人消费。
- 修法：
  - 新增纯函数 `planScrollRestore(percent, scrollHeight, clientHeight, attempt)`：
    **永不在"容器不可滚动"时写 0**；期望非顶部则按 60ms × 最多 24 次重试
    （覆盖 mermaid/katex 异步撑高的场景）。
  - 右屏独立走 `restorePendingIframeScroll()`，与内容写入 effect 的消费互为双保险。
- 实测：50% → 编辑（左 0.50 / 右 0.52）→ 回阅读 0.50。

### 需求3：关闭文档重新打开进度被重置

- 删掉 `App.tsx` 里 4 处「关闭 / 重新打开即清进度」的 `fileScrollProgress.clear(...)`
  （v0.7.0 旧语义，与本次诉求相反）；另有一处「标签迁移到新窗口」也一并按同口径处理。
- 保留：`clearAll()`（关闭"启动载入上次文件"开关 / 会话恢复失败时仍要清）、
  `clearOutlineScroll` / `forgetDocHistory`（大纲位置与撤销历史跨关闭保留有位置敏感风险）。
- 实测：关闭前 0.62 → 重新打开 0.62。
- 取舍：进度留在**当前会话内存**，所以同一会话内关闭→重开可恢复；关闭后该键不再出现在
  快照的 keys 里 → 重启应用不恢复已关闭文件（快照语义仍保持"打开标签的进度"）。

### 需求4：查找到多文件后替换，应替换所有文件

- 新增 `applyFileText(fileKey, newText)` 写回通道 + `replaceAllAcrossFiles()`：
  - 对每个文件**按自身文本重算命中**（不复用条幅的行内偏移快照）；
  - 逆序拼接避免偏移漂移；CRLF 用 `buildRawOffsetMap` 换算回原文坐标；
  - 与查找共用同一 `SearchOptions`（全词/大小写/正则/范围）；
  - 当前文档走编辑区写回（与既有「全部替换」同一条路径），其他标签写 store
    **并置脏**（否则关窗口不提示保存 → 用户以为改成功、磁盘还是旧的）；
  - 勾了「选取范围内」时其他文件跳过（选区只有当前文档有坐标）。
- 条幅展开时按钮文案改为「全部替换（所有文件）」；完成后提示「已替换 N 个文件」。
- 条幅收起时保持旧的「只替换当前文档」语义，避免误改未展示的文件。
- 实测：条幅列出 A+B 两个文件 4 处命中 → 替换后「已替换 2 个文件」→ 两个标签都置脏
  → 切到 B 内容确实变成 DOG（2 处）。

### 需求5：搜索要跨文档生效（切文档后立即在新文档搜索）

- 新增 `contentVersion` prop（宿主传 `forceUpdateKey`）+ 换文档重搜 effect。
- 为什么必须显式监听：阅读模式下换文档时 `editorView` 是**同一对象**、`sourceContent`
  在阅读模式也不变 → `performSearch` 的依赖全都没变，effect 不会重跑 → 搜索永远停在旧文档。
- 实机验收又抓到一个更隐蔽的 bug：换文档瞬间文本还是旧的，此刻排的定时器捕获了**旧闭包**；
  等文本更新后 `performSearch` 换了身份，但 effect 依赖没变 → 不重跑也不 cleanup →
  旧定时器照常触发，把刚算对的结果**覆盖回"无结果"**。
  修法：`performSearchRef` 永远用最新闭包 + 世代序号丢弃迟到回调。
- 实测：A 搜「李四」无结果 → 不关面板切到含「李四」的文档 → 立即 `1/1`。

### 需求6：竖排小字改艺术字体 / 颜色更浅 / 呼吸带金属光泽（性能优先）

- **字体**：系统自带衬线字体栈（Palatino Linotype / Book Antiqua / Georgia →
  华文中宋 / 宋体 / Noto Serif CJK → serif）。**不引任何字体文件**：离线无网络、
  中文艺术字体动辄数 MB、还会带来首屏字体加载抖动。
- **颜色**：`color-mix(in srgb, var(--text-tertiary) 72%, transparent)`，明显更浅。
- **金属光泽**：**静态** 7 段银色渐变（银灰→亮银→银灰→高光→银灰）+ `background-clip: text`；
  呼吸动画**只动 `opacity` 与 `transform`**，光泽的"流动感"来自"渐变静止、透明度在动"。
- **性能实测**（headless Edge 155 = WebView2 内核，CDP `Performance.getMetrics` 采 3 秒）：

  | 实现 | LayoutCount | RecalcStyleCount | TaskDuration |
  |---|---|---|---|
  | 本版（静态渐变 + opacity/transform） | **0** | **1** | **3.4ms** |
  | 旧版（纯 opacity） | 0 | 1 | 3.8ms |
  | 反面教材（动画 `background-position`） | 0 | **180（每帧一次样式重算）** | 93.6ms |

- `prefers-reduced-motion` 时停动画但**文字仍可见**；`.app-blurred` 时暂停动画。
- 两个实测踩掉的坑（已写进代码注释与测试，防回归）：
  1. 药丸底**不能**用 `::before` + `z-index:-1`（`background-clip:text` 下字形是元素自身
     背景，伪元素会盖住渐变，对比度 3:1 → 1.3:1）；改多层 background + `padding-box`。
  2. `text-shadow` + `background-clip:text` 在本引擎会**吃掉字形**（墨迹像素 8000→240，
     单深色阴影直接 0）→ 放弃该"可选加分"项。

### 需求7：表格拖拽改行高/列宽，重开失效

- 根因：尺寸只写在 PM 节点 attrs，GFM 管道表格语法无法表达 → 序列化即丢弃 → 重开为 null。
- 方案：**旁路注释指令**，写在表格**后空一行**（紧贴表格下一行会被 GFM 当数据行，
  实测会让表格凭空多一行、指令进单元格）：

  ```markdown
  | A | B |
  | --- | --- |
  | 1 | 2 |

  <!-- lightmd-table-size: {"columnWidths":[120,240],"rowHeights":[40,40,60]} -->
  ```

- 无尺寸时**一个字节都不加**（纯管道表格零 diff，v0.9.0 B6 契约保持）。
- parser 读回写入 attrs 并**整段吞掉**指令行（正文里没有这行）；坏 JSON / 键名不对 /
  值不是数组 → 静默忽略，表格照常解析。
- B6 原文切片：把表格块的原文区间**扩展到覆盖指令行** → 未编辑表格切片自带指令；
  被拖拽改过尺寸的是新节点 → 走逐块路径按当前 attrs 重新输出。两条路径都恰好一份，不丢不重。
- 输出前按**实际列/行数**归一化（超长截断、不足补 列100/行30）：不归一化会不收敛
  （第一次写 3 个、读回补成 2 个、第二次写 2 个 → 每次保存都改写文件）。
- 顺带修复：列表内的表格，`listToMarkdown` 原本丢掉续行空行 → 指令被贴回表格尾部。
- 实测：拖拽列表头 246px → 316px → 存盘含 `{"columnWidths":[316,176,246]}` →
  关闭重开 → 单元格内联宽度仍 316px、源码仍有指令。

## 三、质量验证

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0**（strict） |
| 全量单元测试 | **309 文件 / 5369 用例全部通过** |
| 本批新增测试 | `v0140-update-version`(13) · `v0140-update-ui`(9) · `v0140-table-size`(35) · `v0140-search-crossfile`(9) · `v0140-divider-art`(38) |
| 实机验收（打包产物 + CDP 真实手势） | **34/34 PASS**（`_verify-out/v0140-batch2-real-machine.txt`） |
| Rust 单测 | `cargo test update::` 19 passed / 1 ignored（真实网络用例手动跑） |
| 版本号一致性 | `package.json` = `Cargo.toml` = `tauri.conf.json` = `Cargo.lock` = **0.14.0** |

## 四、已知取舍

1. **需求1 的完整链路需要线上真有新版本**：本机验收时外网不通（GitHub API 不可达），
   已验证「失败路径 + 本地化文案 + 重试」正确且不卡界面；「发现新版本 → 下载 → 启动安装」
   需在本版发布到 GitHub 后复验一次。
2. **阅读进度只保留在当前会话内存**：同一会话内关闭→重开可恢复；关闭后重启应用不恢复
   已关闭文件（快照仍只覆盖打开标签，这是刻意的，避免无限累积）。
3. **表格尺寸是 LightMD 扩展语法**：其它编辑器会把那行当 HTML 注释忽略（不影响渲染）；
   在 LightMD 的 Read 模式下不可见。
4. **搜索/替换写回不进源码撤销栈**（v0.4.2 起的既有语义）：`Ctrl+Z` 撤不回替换结果，
   需用反向替换；跨文件批量替换同理。

---

# v0.14.0 第三批（2026-10-23，同一版本号再次打包）

> 定位：**问题修复 5 条 + 观感/布局调整 1 条**。6 条需求全部在**打包产物 +
> WebView2 真实鼠标键盘手势**下逐条实测通过。

## 一、安装包（本批重新打包）

| 文件 | 大小 |
|---|---|
| `LightMD_0.14.0_x64-setup.exe` | 7,831,375 B |
| `LightMD_0.14.0_x64_en-US.msi` | 11,300,864 B |

```
918c6e4d3415d544d090e68c631c822eb494d61ebafa6a8e75273d116ff1808d  LightMD_0.14.0_x64-setup.exe
d02b2c0b404c55a905a4fe6a791b2096a84c530b86c0ea4d5e47613760dee638  LightMD_0.14.0_x64_en-US.msi
```

> `lightmd.exe` 的 `FileVersion` / `ProductVersion` 实测仍为 `0.14.0`（版本号不变，内容更新）。

## 二、6 条需求逐条落地

### 需求1：阅读模式下搜索/替换没有立即生效

实机定位到**两层**根因（`scripts/v0140-probe-req1-crossfile-preview.mjs`，T1/T2/T3）：

1. 条幅**展开**时点「全部替换（所有文件）」→ `replaceAllAcrossFiles` 对**当前文档**
   也调用 `onSourceContentChange`，而那是**源码态**写回通道 → 只更新了隐藏 textarea
   的 state 与 localStorage，**ProseMirror 一个字都没动** → 阅读视图毫无反应。
2. 更糟：下一次切模式会用 PM 内容反序列化回写，**把替换结果冲掉**
   （实测：替换后切到编辑模式，源码又变回 `cat`）。

修法：新增**统一写回入口** `writeBackCurrentDoc(newText)`，按视图模式分流：
- **阅读模式 + md** → dispatch `replaceWith(0, size, newDoc)` 事务（阅读视图立即更新），
  序列化/标签内容/脏标记由 `onDocChange` 顺带完成；
- **源码模式 / 非 md 阅读模式** → 写 textarea 状态（+ 记撤销，见需求2）。

两个调用方（面板自己的替换、跨文件替换的当前文档写回）都归口到它。

实测：T1-a 阅读视图立即变 PASS；T2 切编辑后源码仍是 `DOG` PASS；T3 对照组 PASS。

### 需求2：搜索替换进撤销栈；跨文件替换后切过去也能撤销/恢复

未激活标签此刻**没有** EditorView、也没有 textarea 撤销栈（内容只在 store 的
`openTabs[i].content`），且切过去时 PM state 是按内容**重建**的 → 天然没有"替换"这一步。

修法：`services/docHistoryStore.ts` 新增按文档键的**整篇文本级**记录：
- `recordCrossFileEdit(key, before, after)`：未激活标签写回时登记；
  同一文档连续替换**合并**为「最早的 before + 最新的 after」（用户心智是
  "撤回那轮批量替换"，不是逐处撤）；
- `doLocalUndo` / `doLocalRedo` **先**消费它，再落回常规 PM/diff 撤销栈；
- **位置敏感护栏**：只有当前文本仍与记录逐字节一致才应用，否则**丢弃记录**
  并落到常规撤销栈 —— 宁可少撤一步，也绝不整篇覆盖回去抹掉用户的手工编辑
  （与 `loadDocHistory` 同一套安全纪律）。
- 源码态替换通道（`onSourceContentChange`）补 `recordUndoEntry`，编辑模式下也能 Ctrl+Z。

实机验收（`scripts/v0140-probe-crossfile-undo.mjs`，每轮全新临时目录+独立 profile，
阅读模式与源码模式各一轮）全部 PASS：
- 未激活的 B 被跨文件替换成 DOG ✔
- 切到 B（从未激活过）后**能撤销**（DOG → cat）✔
- 撤销后**能恢复**（cat → DOG）✔
- 当前文档 A 也能撤销该替换 ✔
- 磁盘文件仍为原始内容（跨文件替换不自动写盘，需用户保存）✔

### 需求3：最近打开点时钟不出面板

**两个独立根因**（均在真实应用复现，`scripts/v0140-probe-recent.mjs`）：

1. **渲染条件口径不一致**：`RecentFiles` 自 v0.8.5 需求8 起是「文件+文件夹」混排、
   任一类有记录即渲染，但布局层三处判定（`favRecentCompact` / `ordered` /
   `SlideWrap visible`）还停在旧的「只看 `recentFiles`」→ 只开过文件夹时
   `recentFiles=[]` → **按钮已 active，但面板一次都不挂载**（`panelExists=false`）。
2. **面板挂在滚动视口之外**：侧栏溢出时面板已挂载、高 200px、16 条数据全渲染，
   但 `top=860.5px` 而滚动容器可视区只有 `121.5..824`、`scrollTop=0`
   → 面板 100% 在视口下方，用户视线里"什么都没变"。

修法：抽出 `recentHasData = files>0 || folders>0` 统一三处口径（与 `RecentFiles`
的空判定严格对齐）；新增多拍复查 effect（`REVEAL_CHECK_DELAYS=[0,40,160,320,560]ms`，
**只在"未完整可见"时才 scrollTo**，已可见绝不动）。
> 踩坑：第一版用双 rAF（≈32ms）量一次无效——侧栏 section 有 `transition: height 0.3s`
> 且「打开的文件栏收缩」effect 会再改一次 temp 高度，那一刻量到的是过渡中间态。

实测：干净态 `panelExists=true`；溢出态 `panelFullyVisible=true`（`scrollTop` 0→236）；
只有文件夹历史态 `panelExists=true` 高 343px。

### 需求4：文件夹栏只有 7 个条目 → 11 条 + 末尾留空

实测（不是估算）：标题栏 `.filetree-root-path` = **32px**
（`padding 6+6` + `font-size 11px` 行高 17.6 + 上下各 1px border），
条目行高 `.filetree-node` = **30px**，旧默认 250px → 内容区 218px → **完整可视 7 条**
（与用户"只有7个条目"完全吻合）。

新默认 **392px** = `32 + (11 + 1) × 30` → 内容区 360px → 可视 **12 条**，
比 11 行多出**恰好 30px = 1 个条目位留白**（方便右键：新建文件/新建文件夹/刷新/粘贴）。

导出常量（可读表达式，不写死魔法数字）：
```ts
export const FOLDER_VISIBLE_ROWS = 11;
export const FOLDER_HEADER_HEIGHT = 32;                 // 实测值
export const DEFAULT_FOLDER_SECTION_HEIGHT =
  FOLDER_HEADER_HEIGHT + (FOLDER_VISIBLE_ROWS + 1) * SIDEBAR_ITEM_HEIGHT;  // = 392
export function defaultSectionHeight(key)               // sizeOf 的默认值来源
```

⚠️ **老用户迁移（重要）**：`sizeOf()` 是 `sectionSizes[key] ?? defaultSectionHeight(key)`，
而用户**拖拽过任何一栏**时整张 `sidebarSectionSizes` 都会持久化（含 `folder:` 的旧默认
250）→ 只改默认值对老用户**完全不生效**，他们升级后仍是 7 条。
因此新增 persist version **4→5** 迁移：清掉 `folder:` 中 `<= 250` 的项，让其回落到
392px；**用户明确拖大过（> 250）的一律保留**。直接删键而非写 392 —— 保持常量只有一处定义。

### 需求5：竖排小字换字体风格，简单呼吸渐变、不要金属光泽

从「衬线艺术字 + 七段金属色带 + 径向柔光」换成**等宽 / 几何「轻线条」**：
- **字体**：`Cascadia Code / Cascadia Mono / Consolas / ui-monospace` + 中文**无衬线**
  （微软雅黑 / PingFang SC，**不回退宋体**——宋体就是被否掉的衬线观感）。
  全部系统自带：零字体文件、零网络、无首屏字体抖动。
- 配套：`font-weight: 400`（原 500，细字重=轻线条）、`letter-spacing: 3px`（原 2px）、
  `font-variant: full-width`（原 small-caps）。
- **金属光泽全部删除**：`--label-metal` 七段色带、radial 柔光层都没了；
  只留**一层静态极淡线性渐变** `--label-sheen`（180deg、2 色标、只画一次、**不参与动画**），
  `background-clip` 从 `text,text,padding-box` 三层降为 `text,padding-box` 两层。
- **呼吸**：关键帧**只** `opacity`（0.55 ↔ 1）+ 极小 `scale`（0.97 ↔ 1）。

实机量测：`font-weight=400`、`letter-spacing=3px`、`font-variant=full-width`、
`text-shadow/filter=none`、关键帧属性 `["transform","opacity"]`、
关闭态标签宽 **16.75px ≤ 18px**、呼吸采样 0.58→0.85→1.00→0.83→0.57（动画 `running`）。

### 需求6：标题栏菜单被编辑区挡住

**真根因不是"缺个 z-index"**，而是 stacking context **三层**失效：
1. `.titlebar` 是 `position:relative; z-index:auto` → **不创建 SC**，与后出现的
   `.app-shell`/编辑区同处 `<body>` 根上下文，按 DOM 顺序**被后绘制的编辑区覆盖**；
2. 下拉菜单自己的 `z-index:1000` **救不了** —— 它被 `.titlebar-left{z-index:1}`
   夹在那个 z-index=1 的小 SC 里（z-index 只在最近 SC 内比较）；
3. 新开软件时编辑区盖着 `.editor-empty-state`（absolute / `z-index:10` /
   整块不透明白底 / `pointer-events:none`），画在菜单之上把下探那截吃掉。

> **⚠️ 取证陷阱（非常重要）**：`elementFromPoint` 全程报"35/35 命中菜单项"——
> **假阳性**。因为它跳过 `pointer-events:none` 的层：指针确实穿得过白底，
> 但白底**照样画在菜单上面**。必须用**像素 diff** 才能证伪。

修法：`.titlebar` 加 `z-index: var(--z-titlebar, 100)` + `overflow: visible`；
`:root` 新增 `--z-titlebar: 100`（低于弹窗 1000/1100/1200、Toast 10000）。
**不给** `.app-shell` / `.app-sidebar` / `.app-outline` / `.editor-main-area` 加 z-index
—— 那会创建 SC，把内部 `position:fixed` 弹层（搜索面板等）关进低上下文，反被标题栏压住。
未改 DOM/JSX，**未用 `position:fixed`**。

A/B 实机对照（同 exe，仅切 `.titlebar` 的 z-index）：
- 修复前：菜单内文字暗色像素 = **0**（完全看不见）；隐藏空状态后像素变化
  **17243/221520 (7.8%)** → 空状态画在菜单之上。
- 修复后：文字暗色像素 = **3425**（完整可读）；隐藏空状态后变化 **0** → 空状态在菜单之下。

## 三、质量验证

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| 全量单元测试 | **313 文件 / 5453 用例全部通过** |
| 本批新增测试 | `v0140-search-replace-undo`(18) · `v0140-sidebar-recent`(30) · `v0140-divider-style-v2`(25) · `v0140-titlebar-zindex`(15) |
| 实机验收脚本 | `v0140-probe-req1-crossfile-preview` · `v0140-probe-crossfile-undo` · `v0140-probe-recent` · `v0140-probe-titlebar-menu` · `v0140-probe-divider-style-v2` —— 全部 PASS |
| 版本号一致性 | `package.json` = `Cargo.toml` = `tauri.conf.json` = `Cargo.lock` = **0.14.0** |

## 四、已知取舍

1. **跨文件撤销是「整篇文本级」**：一次 `Ctrl+Z` 撤回"那轮批量替换"（而不是逐处撤），
   且只在该文件本轮**未被手工编辑过**时生效（护栏，宁可少撤一步也不抹掉手改）。
2. **老用户文件夹栏**：若以前把文件夹栏**拖大过**（> 250px），会保留自己的值，
   需手动拖一次或用默认值重置才看到 392px。
3. **字体**全部系统自带（零字体文件/零网络）；不同 Windows 版本的等宽字体可用性
   略有差异，回退栈已兜底到通用 `monospace`。
4. **`--z-titlebar: 100`** 让整个标题栏高于内容区：目前所有弹窗层级都 ≥ 1000，无冲突；
   若将来有内容区元素需要盖住标题栏，需复核该变量。
5. **标题栏菜单**的修复依赖 stacking context 秩序，后续新增内容区样式时
   **不要**给 `.app-shell` 等容器加 z-index（会把内部 fixed 弹层关进低层级）。
