# LightMD v0.13.2 发布说明

> 发布日期：2026-10-17 ｜ 基线：v0.13.1 ｜ 定位：**实机复测第二批 10 项 + 安装后复测 7 项返修（版本仍为 0.13.2）**
>
> 本说明汇总 **v0.13.1 与 v0.13.2** 两个版本：v0.13.1 修复实机反馈 16 项（未单独发说明，本文一并补记），
> v0.13.2 修复第二批 10 项；用户安装 0.13.2 后复测又报 9 项未达预期，同版本内返修（见第二节“实机复测返修”）。
> v0.13.2 的共同特征是「单点已可用、组合起来不成立」——
> 复制单个代码块没问题但粘到别的文档不渲染、渲染区能看不能改、两个文档各自撤销都对但顺序不对。
> 因此本版把测试全部下沉到**真实交互链**（真实 ProseMirror 事务、真实鼠标事件序列、真实定时器推进、真实 `localStorage`），
> 并对分屏联动、Mermaid 上半区编辑、代码块跨文档粘贴做了**真实 Chrome 实机验证**。

## 一、安装包

| 文件 | 说明 |
|---|---|
| `LightMD_0.13.2_x64-setup.exe` | NSIS 安装包（推荐） |
| `LightMD_0.13.2_x64_en-US.msi` | MSI 安装包（企业分发） |

```
fe018774abb657afdc1cf3a109ff6a44bbfecd31c3381fa0efb7c0b443b3ee6a  LightMD_0.13.2_x64-setup.exe
f84a6da4d9cfa5783b04c6db31f5383579fdfe7fe7f4ef817a78c4b95025b344  LightMD_0.13.2_x64_en-US.msi
```

> 这是 **2026-10-18 00:05 返修后的重新打包**（同版本号 0.13.2），请以本组校验值为准；
> `lightmd.exe` 的 `FileVersion` / `ProductVersion` 均为 `0.13.2`。

## 二、版本内容（v0.13.2，10 项）

| # | 用户反馈 | 根因 | 修复 |
|---|---|---|---|
| 1 | 点代码块右上角「复制」，粘到其他文档不立即渲染 | 写进 `text/plain` 的是**裸代码**（没有围栏），粘贴端看不到「这是一个完整代码块」的证据，只能按普通文本插入；另外 `writeBlockClipboard` 在系统剪贴板不可用时返回的仍是「内存兜底成功」，调用方无法区分 | 新增 `writeCodeBlockClipboard(code, lang)` 专线：围栏长度取 `max(3, 最长反引号串 + 1)`；`BlockClipboardData` 增加可选 `plain` 字段，`text/plain` 写 `plain ?? markdown`，应用内「复制代码块 → 粘贴」由 `inAppBlockMarkdown` 命中并还原成围栏块；新增 `writeBlockClipboardDetailed` 回报**系统剪贴板**真实结果，只有真写入才显示「已复制」 |
| 2 | 有序列表里按 `Ctrl+T`，任务列表没加到列表前，而是回车换行 | `insert.taskList` 只会在光标处插一个**空**任务列表；光标在 `list_item` 内时命令被列表的 `splitListItem` 抢走 | 采纳「把当前行提升为任务项」：`pmCommands.liftListItemToTaskList` 把当前项从原列表摘出、以 `task_list` 插到原列表**之前**（单项列表整体替换）；源码模式由 `sourceFormat.liftListLineToTask` 做同一件事。**任务项搬的是整项内容**（含第二段 / 嵌套子列表），不只首段 |
| 3 | Mermaid 只有下半部分能编辑，上半部分渲染结果点不动、也不联动 | 预览层只是「不拦事件」，pointerdown 从未接到「进入编辑态」；编辑时 `getCode()` 读的是 `node.attrs.code`（上次提交值），预览慢一拍 | 采纳「渲染区也是编辑入口 + 实时联动」：`previewLayer` 挂 `handlePreviewPointerDown`，点渲染结果即在落点进入编辑；`getCode()` 在 `isEditing` 时读**活的** `contentDOM.textContent`；编辑中 120ms / 静止 500ms 节流；新增 `renderSeq` 异步竞态守卫丢弃过期渲染；编辑中语法暂时写错时保留上一次成功的 SVG；撤销/重做同样触发重绘 |
| 4 | 无图文档时「译」图标应上移补位，且要有平移动画 | 图片管理按钮靠条件渲染整块消失 → 位移是**跳变**；「译」的 `top` 写死 | `ImageManagerButton` 改为**始终挂载**，无图时只加 `is-hidden`（`opacity`/`pointer-events`/`transform:scale(.86)`）+ `aria-hidden` + `tabIndex=-1`；`FullTranslateButton` 新增 `slot` 属性经 `--ftb-slot` 计算 `top`（返修后：无图 slot=1、有图 slot=2；模式切换固定 slot=0），两者都加 0.22s `top/opacity/transform` 过渡，补 `prefers-reduced-motion` |
| 5 | A 编辑 3 处、B 编辑 2 处，在 B 连续撤销应按顺序回溯到 A（与 Word 一致） | 撤销历史在 `EditorState` 内；v0.13.1 为满足「撤销不跨文档」在换文档时**直接清空**历史 → A 的 3 步永久丢失 | 初版实现为跨文档顺序账本（`docUndoOrder` + `docHistoryStore`）。**用户复测后推翻该语义**（要求严格按文档独立、不跨文档），最终版本已移除账本与切文档路由，只保留 `docHistoryStore` 的按文档保存/装回；详见二·补 #5 |
| 6 | 图片管理弹窗特效改为「从按钮跑出来、关闭再跑回去」 | 原动画是居中缩放淡入，与触发按钮没有空间关联 | 新增 `components/dialogs/GenieDialogShell.tsx`：打开时量取按钮与面板矩形，注入 `--genie-from-x/y`、`--genie-origin-x/y`，双 rAF 后才播入场；关闭时 `useLayoutEffect` **重测**（面板可能已被移动）后播 300ms 退场再卸载。CSS 动画段重写为遮罩 `0.15s/0.22s` + 精灵 `in 0.32s` / `out 0.26s`，`IMAGE_MGR_CLOSE_MS` 160 → 260 对齐 |
| 7 | 大纲不跟随（标题进屏幕下半部分就看不到）、大纲栏没有滚动位置记忆 | `IntersectionObserver` 的 `rootMargin` 是 `-10% 0px -70% 0px`，把可视带压成屏幕顶端 20% → 下半屏标题永远判不到「可见」 | `rootMargin` 改为 `-10% 0px 0px 0px`；新增 `services/outlineScrollMemory`（Map + `localStorage`，LRU 60，400ms 防抖 + **5s 心跳 + `beforeunload`/`pagehide` 立即冲刷**）；`Outline` 订阅 store 的 `docKey`（只读 `openTabs`/`activeTabIdx`，不引用 `viewMode`），滚动即写、按 `[docKey, headings.length]` 恢复（双 rAF + 600ms 宽限期，宽限期内跟随逻辑不抢位置）；关闭标签 / 删除文件时清理该键记忆 |
| 8 | 分屏联动要继续，但左右不共滚动条，而是映射关系，内容要能对齐 | v0.13.1 只有「左 → 右」，回退仍是单一百分比；右屏滚动完全不反馈左屏 | 采纳「双向映射」：`utils/blockScrollAlign` 新增 `PreviewAnchorSet` 与 `locateSourceLine`/`mapSourceLineToPreviewScroll`/`mapPreviewScrollToSourceLine`/`mapSourceLineToScrollTop`，以顶层块源码行做双向插值；`EditorContainer` 重写为双向 `syncToPreview`/`syncToSource`，监听 `textarea`、`iframe.contentWindow`、`contentDocument`（捕获）。**返修后**重入保护升级为时间窗方向锁，并修正了 iframe 内容坐标（见二·补 #7） |
| 9 | 从 A 复制表格到新文档 B 后光标移不到表格下面；点空白处也没有插入符 | 表格/代码块/公式/Mermaid 都是**隔离型**块，文档以它们结尾时光标无处可落（项目未装 gap cursor） | `paragraph` 增加结构性属性 `attrs.pad`；新增 `core/plugins/trailing-paragraph.ts`：`appendTransaction` 在文档结束于上述块时补 pad 段落，段落有内容即清标记，事务带 `addToHistory:false`；序列化器收集块时**跳过 `pad === true`**，补位段落永不写进 `.md`，而用户自己打的尾随空段落（非 pad）仍照常序列化（v0.7.0 起的契约由负向测试守着） |
| 10 | 图片功能调整：右上角小手柄进编辑、点图片改为激活、拖边缘调大小 | 点图片直接开弹窗 → 无法选中/拖动，也没有尺寸调节入口 | 采纳「只记宽度、保持宽高比」：新增 `core/plugins/image-node.ts` 的 `ImageView` NodeView —— 右上角 `.image-node-handle` 悬停显现、点击派发 `lightmd:image-edit`（带 `{pos}`）开弹窗；点图片本身改为 `NodeSelection` 激活（`view.editable === false` 时跳过，保留阅读模式点击放大）；六向 `.image-resize-zone[data-dir]` 拖拽，**只写宽度**、最小 24px、西侧符号反转，拖拽过程不写事务、`mouseup` 一次性 `setNodeMarkup`（一次拖拽 = 一次撤销） |

## 二·补、安装后复测返修（版本仍为 0.13.2，14 项）

用户安装 0.13.2 后分批复测，以下 14 项未达预期，已在本版本内返修并重新打包：

| # | 复测问题 | 根因 | 修复 |
|---|---|---|---|
| 1 | 代码块快捷复制到别的文档，粘贴仍是普通文本（三点菜单复制/粘贴正常） | 代码块按钮写 `text/plain` 的是裸代码，应用内兜底是围栏 Markdown；粘贴端按「`text/plain` 与 `plain` 逐字节相等」判同源。Windows/WebView2 把 `\n` 规范成 `\r\n`，多行代码永远对不上 → 退回字面粘贴。三点菜单直接读应用内数据、不比对文本，故不受影响 | `clipboard-paste` 同源判定改为**归一化比较**（CRLF/CR → LF + trim）；插入的仍是未改写的 `data.markdown`。新增 CRLF 剪贴板 → `code_block` 行为测试 |
| 2 | 有序列表加任务列表后有序列表消失；期望 `- [ ] 1. xxx` | 提升为任务项时丢弃了原序号（任务列表只有 bullet） | 阅读模式 `pmCommands.liftListItemToTaskList` 与源码模式 `liftListLineToTask` 都把**原序号（含 `)` 分隔符）作为字面文本**保留：`- [ ] 2. bb`；整项多段/嵌套内容仍整体搬迁 |
| 3 | Mermaid 在上半部分（渲染区）编辑时，下半部分编辑区不更新 | 预览层是 contenteditable 编辑器的后代；且编辑态下再点渲染区直接 return（不 `preventDefault`）→ 浏览器原生光标进入预览 DOM，键入只改预览、不进 ProseMirror | 预览层显式 `contenteditable=false`；**编辑态下也拦截** mousedown，按点击纵向比例换算源码行并把选区/焦点交回 `contentDOM` |
| 4 | 「译」字图标与分屏编辑图标重叠 | 槽位算错：模式切换占 slot 0，「译」无图也用 0、有图与图片管理同用 1 → 完全重合 | 固定为 模式切换 0 / 图片管理 1 /「译」无图 1、有图 2 |
| 5 | 撤销/恢复应严格按文档独立，不再跨文档 | 上一轮的跨文档顺序账本会在当前文档撤完后自动切标签继续撤另一个文档 | 移除 `services/docUndoOrder.ts` 与 `lightmd:undo-switch-doc` 路由；`Ctrl+Z`/`Ctrl+Y` 回到原生 `undo`/`redo`，只作用于当前文档。保留 `docHistoryStore`：切走保存、切回按内容严格配对装回，各文档互不干扰 |
| 6 | 关闭图片管理弹窗报 React error #300 | `if (!open) return null;` 之后还有一个 `useMemo`；关闭时壳挂 300ms 播退场仍渲染组件 → 早退跳过 Hook → Hook 数量少于上次 | 所有 Hook 上移到早退之前，并加真实 React「打开→关闭→再打开」回归测试 |
| 7 | 分屏左右滚动完全不联动 | ① `scrollTop=` 派发的 scroll 事件是异步的，同步执行期的 `isSyncingScrollRef` 到那时已释放 → 两屏互推（实测左屏被写成 0）；② `documentElement.getBoundingClientRect().top` 恒等于 `-scrollTop`，锚点坐标被算成 `rect.top + 2*scrollTop`，越滚越虚高、右屏直接顶到底；③ 完整重写预览会换掉 `documentElement`，缓存旧引用写入无效 | 新增 `utils/splitScrollSync.ts` 的**时间窗方向锁**（发起侧 250ms 内拥有同步权，另一侧 scroll 视为回声忽略，同侧连续滚动续期）；锚点坐标改为 `rect.top + scrollTop`；每次同步现取 `scrollingElement`；右屏在 `contentWindow` 与 `contentDocument` 捕获阶段双监听。**真实 Chrome 验证**双向联动，左右顶部标题一致 |
| 8 | 打开新文档编辑内容，切到其他文档再切回来 `Ctrl+Z` 不生效 | 换文档 effect 在保存**离开文档**历史之前就把 `lastContentRef` 覆盖成新文档内容 → 快照是「新文档内容 + 旧文档 history」；切回时内容不匹配，`loadDocHistory` 按安全策略丢弃快照，历史归零 | 内容基线更新移到 `saveDocHistory` **之后**；新增挂载真实 `EditorContainer` 的「编辑 → 切走 → 切回 → undo」集成测试 |
| 9 | 图片管理窗口不能拖拽；关闭没有「顺滑回到图标」动效 | ① 面板保留 `if (!open) return null;`，父组件置 open=false 后子组件先返回 null，壳的退场没有可动画的 DOM；② 没有拖拽实现 | 关闭立即上抛、面板在 `open=false` 期间保持渲染，壳播完 `image-mgr-genie-out` 后统一卸载（真实 Chrome 验证 transform 持续缩向按钮）；标题栏拖拽（位移走 `left/top`，避开 genie 动画占用的 `transform`），限制视口内、重开复位 |
| 10 | 图片管理图标没有浮动文字提示 | 只有原生 `title`，悬停约 1 秒才出现且样式不可控 | 按钮 `data-tip` + CSS `::after` 自绘：提示浮在图标左侧、120ms 淡入/位移、`pointer-events:none`、隐藏态不显示、补 reduced-motion |
| 11 | 图片管理弹窗动画不够顺滑细腻 | 0.32s/0.26s、缩放 0.3×0.18，且叠加 opacity 淡入，与搜索框动画不同族 | 对齐搜索框：入场 0.48s easeOutCubic / 退场 0.38s easeInCubic，起点 scale(0.42,0.3)，**纯 transform 去掉 opacity**；壳延迟卸载 440ms；拖拽保留 |
| 12 | 搜索框「从按钮出现 / 缩回按钮」动画消失 | `GenieSearchDialog` 用泛选择器 `[data-genie-anchor]`；图片管理入口也带该属性且 DOM 更靠前 → 量错按钮 | 只认 `[data-genie-anchor="search"]`；新增「诱饵锚点更靠前」回归测试 |
| 13 | 图片管理 / 新建文件夹弹窗出现时背景闪动 | 整屏半透明遮罩做 opacity 动画，被提升为独立合成层，与下方内容（分屏 iframe 也是独立层）重采样不同步；图片管理弹窗本体还叠加 opacity | 遮罩改为**静态亮度**（首帧即最终明暗，无 animation/will-change）；图片管理弹窗本体只做 transform；新建文件/文件夹共用的遮罩同步改为静态。真实 Chrome 验证 `animationName = none` |
| 14 | 表格单元格内 Enter 在右边新增单元格并跳过去 | Enter 链无表格分支 → 落到 `baseKeymap` 的 `splitBlock`，单元格内容 `paragraph block*` 被拆成第二段，NodeView 铺开后像右边多一格 | 新增 `tableEnter` 置于 Enter 链最前：光标下移到**同列下一格**；末行追加一行并落同列；真实 keydown + 真实表格 DOM 断言 |

## 三、版本内容（v0.13.1，16 项）

| # | 问题 | 修复 |
|---|---|---|
| 1 | 块粘贴后不自动渲染 | `utils/blockClipboard` 成为 `looksLikeMarkdown` 唯一实现；两层判定：自包含块构造单命中即解析，其余走「特征 ≥2」。顺带修 turndown 无 GFM 表格规则、HTML 优先级高于无损 Markdown 导致 `language` 丢失 |
| 2 | 空单元格无法拖拽选中 → 无法合并 | 判据由「是不是空格」改为「布点后的**逻辑列**是否越界」，真实空格保留、markdown-it 补齐幻影格才裁；单元格补 `min-height` |
| 3 | 退格跨格吞内容 | `core/keymap` 在单元格**内容边界**上吞掉 `Backspace`/`Delete`（不派发事务、不动光标）；`table_row` 加 `isolating` 作第二道防线 |
| 4 | 对齐只作用于选中单元格 | 新增 `tableMerge.setRangeAlign`，按逻辑网格写矩形内锚点格；有选区只改选中格，无选区维持整列 |
| 5 | 拖列框线变成选中内容 | 热区 `mousedown` 补 `preventDefault`；仲裁改按**主导轴**（列热区+横向 = 列宽，行热区+纵向 = 行高，其余才是范围选区） |
| 6 | 公式/Mermaid 编辑窗过大、点别处不恢复、抖动 | 新增 `core/plugins/inlineBlockEditor`：单行型收窄到内容、多行型限高 45vh、内边距收紧、两态样式一致；点块外立即退出；修 `toggleEditMode` 先取反导致双击退不出 |
| 7 | 图片管理图标挡住「译」的设置按钮 | 悬浮按钮槽位重排（模式切换 10 / 图片管理 50 /「译」90 / 齿轮 124 / 气泡 170），图片管理固定 slot=1 |
| 8 | 撤销跨文档污染 | 换文档事务加 `addToHistory:false` + `resetHistory:true`；源码模式 `undoStackRef`/`redoStackRef` 按文档重置（**v0.13.2 在此基础上补回顺序跨文档撤销**） |
| 9 | 图片管理「本地文件」徽标 → 打开所在文件夹 | 徽标改可点击，复用 `revealTargetOf` + `fileService.revealInFolder`；远程/base64 不可点 |
| 10 | 图片管理弹窗动画 | 自建 `image-mgr-scrim/dialog-in/out` keyframes，遮罩移到 `::before`，`closing` 状态 + 160ms 退场（**v0.13.2 改为精灵弹出**） |
| 11 | 大纲拖拽发灰、看不见标题与落点 | 去掉源项双重 `opacity`，改虚线描边 + 强调底纹；新增 portal 到 body 的 `DragOverlay` 幽灵 + 落点插入线 + 目标行高亮；`SortableContext.items` 排除折叠行 |
| 12 | 大纲不跟随文档滚动 | 活动标题滚出可视带时平滑滚入；守卫（1.2s 内不打扰、折叠行不滚、已可见不滚、尊重 reduced-motion）；监听改用 **callback ref** 挂载 |
| 13 | 分屏滚动强绑定 | 去掉「右屏回写左屏」，只保留左 → 右；内容重渲染后主动重同步一次；补 `topLevelBlockStartLines` + 按块锚点对齐（**v0.13.2 升级为双向映射**） |
| 14 | 切换标签误报「已在其他窗口保存」 | `save()` 混用三个不同时刻状态，竞态下会把 **B 的内容写进 A 文件**；改为入口一次性捕获 `path`、每个 `await` 后复仍活动、按路径定位标签标记、全局脏标记与逐标签更新解耦 |
| 15 | 两位数有序列表序号竖排 | `.pm-block-marker::before` 补 `white-space: nowrap` |
| 16 | 右键菜单缺剪贴板四件套 | 阅读/源码菜单顶部新增 剪切/复制/粘贴/粘贴为纯文本；新增 `utils/textClipboardOps`（两格式写入、先复制后删除的剪切、纯文本不解析 Markdown）；菜单高度按实际项数计算 |

## 四、质量验证

| 项目 | 结果 |
|---|---|
| 前端测试 | **298 文件 / 5107 用例**全部通过（v0.13.1 基线 289 文件 / 4924 用例；本版新增 9 个行为级测试文件，返修后同步调整既有断言；另在 `v0131-undo-per-document` 增加真实 `EditorContainer` 集成用例） |
| 新增行为级测试 | 9 个 v0.13.2 专测文件：按文档独立撤销历史（11）、Mermaid 预览区编辑与联动（11）、表格后尾随段落（25）、图片 NodeView 缩放（11）、Ctrl+T 列表提升（25）、图片管理槽位与精灵弹窗（25）、大纲跟随与滚动记忆（16）、分屏双向映射（34）、表格内 Enter 导航（6） |
| 实机验证（真实 Chrome） | 分屏双向联动：左屏 5000→右屏 5765、右屏 8000→左屏 6945；两侧顶部均为「标题 105」。Mermaid：编辑态下点上半区后输入落到源码。代码块复制：CRLF 剪贴板仍渲染为 `code_block`。图片管理：拖拽位移生效、关闭时 `transform` 持续缩向按钮并卸载；图标 hover 提示 `content="图片管理"`；遮罩 `animationName=none`。搜索框：`--genie-from-y=434px` 且收回时出现 `search-genie-out`。表格：单元格内 Enter 后格数不变、光标落在下一行同列 |
| 测试形态 | 真实 `createEditor` + 真实鼠标/键盘事件序列 + 真实定时器（`vi.advanceTimersByTime`）+ 真实 `localStorage`；仅在 jsdom 无法建模布局处 stub `getBoundingClientRect` / `IntersectionObserver`，并在注释标明理由 |
| 类型检查 | `tsc --noEmit` 零错误 |
| 打包 | `npx tauri build` 产出 MSI + NSIS，版本元数据 0.13.2 |

### 本轮复审修掉的两个实现缺陷（由测试成员上报，Captain 修复）

1. **跨文档撤销顺序错误（顺序不符）**：`noteUndone`/`noteRedone` 原先会把该文档**从本侧账本搬走**，而账本无法知道它还剩几步 —— 于是「在 b 撤 1 次，第 2 次就跳到 a」。改为保留在账本并置末尾（同文档可同时出现在两侧账本），撤不动时才剪枝。
2. **`Ctrl+T` 提升列表项时丢块（数据丢失）**：`liftListItemToTaskList` 原先只搬 `firstParagraphOf(item)`，列表项里的第二段与嵌套子列表被静默丢弃（`1. bb1` + 缩进续段 `bb2` → 只剩 `- [ ] bb1`）。改为搬**整项内容**（任务项内容模型与 `list_item` 同为 `paragraph block*`）。

## 五、已知范围

- **嵌套列表项提升的位置在两模式略有差异**：阅读模式取最内层列表、任务列表留在父项内部；源码模式把连续列表行当一块、任务行提到最外层之前并去缩进。两者都满足「不把任务列表塞进原列表项内部」的原始诉求，但嵌套场景的位置不完全一致，留待后续版本统一。
- 表格/代码块/图表/公式后的**补位空段落不会写进文件**；若在补位段落里输入内容后清空，它会退化成普通空段落并按既有规则照常序列化（与 v0.7.0 起的尾随空行契约一致）。
- 未支持功能清单不变（跨文件全文搜索、标签、frontmatter、双链/反链/图谱、书签、Git 集成等，详见 README）。

## 六、升级说明

- **直接覆盖安装即可**，无破坏性变更；设置、快捷键、收藏、最近打开、会话（含未保存标签）、窗口大小、大纲滚动位置等本地数据全部保留。
- **撤销/重做语义**：严格**按当前文档**生效，不跨文档切换。每个文档的撤销/恢复历史在切走时保存、切回时装回，互不干扰；当前文档撤到底会提示边界，不会自动跳到别的文档。
- **图片交互变化**：点图片 = 激活/选中（不再直接开弹窗），进编辑请点右上角小手柄；拖图片四边/四角调整大小，只记宽度、高度按比例跟随。
- **表格/代码块后面可以接着写了**：文件内容不受影响（补位段落不落盘），无需迁移。
