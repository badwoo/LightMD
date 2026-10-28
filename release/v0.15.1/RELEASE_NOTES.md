# LightMD v0.15.1 交付说明

> 构建时间：2026-10-28
> 产物目录：`lightmd/release/v0.15.1/`
> 基线：v0.15.0
> 定位：**问题修复版**。v0.15.0 新功能在用户实机使用中暴露的 7 项缺陷全部修复并回归验证，不新增功能、不改数据格式。

---

## 一、安装包与校验值

| 文件 | 大小 | SHA256 |
|---|---:|---|
| `LightMD_0.15.1_x64-setup.exe`（NSIS 安装包，推荐） | 7.54 MB | `E5080793E1E2A905237B152656ECF59C65994C9707F5E0A453C3320F7DA50847` |
| `LightMD_0.15.1_x64_en-US.msi`（MSI 安装包） | 10.87 MB | `BDC6168D651F07211E68F22C7D2782323F235ED26A1DC5949FDB213A3431EF16` |
| `lightmd.exe`（免安装单文件，可直接双击） | 23.16 MB | `2F34131E57F12D31E3C7661D3910E3A5E6A92BD720448E2219F547249E1E628F` |

**产物已验证**：
- 三者都内联本次构建的最新前端产物（`dist/index.html` 指向 `index-DKw6Lhx-.js`，在 exe 字节流中实测命中 —— 未踩 `cargo build --release` 出 dev 二进制的坑）。
- `lightmd.exe` 实测双击可启动（进程正常驻留、无报错、无「拒绝连接」）。exe 内的 `localhost:1420` 仅出现在 CSP 的 `connect-src` 里（Tauri 生成的固定策略串），**不是** devUrl —— 判据是 dist 入口 hash 是否内联（已命中）。
- 版本号四处一致：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `tauri.conf.json` 均为 `0.15.1`，且无 BOM。

---

## 二、本版修复的 7 项问题（用户实测反馈）

| # | 用户反馈 | 根因 | 修复 |
|---|---|---|---|
| 1 | 「跨模式撤销两套栈统一还有问题，随便编辑撤销恢复几次后就会出现"已经到这个模式的边界"然后撤销和恢复就不能用了，另外进行撤销时候文档会滚动底」 | **五个独立缺陷叠加**（见下方详解） | 逐条修复 + 12 条回归用例 + 撤销相关 115 条既有用例全绿 |
| 2 | 「阅读区标题折叠。增加折叠收起打开的顺滑动效」 | 折叠终态是 `display:none` → 一帧跳变，没有动画 | 改「高度 0 + 裁切 + 不可见」终态，配 `interpolate-size` 让 `height:auto↔0` 可插值；三角改固定字符 + `transform` 旋转 |
| 3 | 「通过不断双击 Ctrl 键进行阅读模式和编辑模式切换时…屏幕不断会滚动位置偏移」 | 内容锚点只采了**阅读→编辑**方向，反向仍走百分比；两种排版几何不同 → 每轮累积偏移 | 双向采集内容锚点；实机探针 10 轮切换实测 **0 累积漂移** |
| 4 | 「搜索整个工作区搜索到的文件以及对应位置没有像查找所有打开文件夹那样，可以点击跳转到对应文件和对应位置」 | ① `fileKey` 是归一化键（小写/正斜杠），App 用原始 `tab.path` 严格比较 → 永远匹配不到；② 命中文件可能**没打开**，App 只在已打开标签里找 | 统一 `pathCompareKey` 归一化；未打开时按路径打开并给出失败提示 |
| 5 | 「搜索框尺寸放大要放大一倍」 | — | 面板宽度 460 → **920px** 固定宽（窄屏 `max-width: 92vw` 自适应） |
| 6 | 「搜索框…因为搜索到文件导致搜索框会自动变大，现在需要对这个搜索框突然变大或缩小增加一个过度效果。另外搜索框变大后两个按钮位置变了，请不要改变这两个按钮位置」 | 条幅条件渲染 → 面板高度一帧跳变；选项行 `flex-wrap: wrap` + 各自 `margin-left:auto` → 内容变长就折行、按钮漂移 | 条幅外壳常驻 + 高度/透明度/位移过渡；选项行改「勾选组（可压缩）+ 右侧动作组（固定）」两段布局，按钮位置恒定 |
| 7 | 「图片灯箱相关功能还未实现，当前单击图片是选中…灯箱这个功能入口请改为双击图片进行图片全屏查看，缩放 / 前后切换 / Esc 关闭」 | ① 入口闸门是 `editable === false`（只反映"只读标签"，与 viewMode 无关）→ **普通文档阅读模式下灯箱根本打不开**；② 入口是单击，与"单击选中"语义冲突 | 闸门改 `viewMode === "preview"`；入口改 **双击**（三面：阅读 PM / 编辑预览 iframe / 编辑 NodeView）；单击语义保持不变 |

---

## 三、需求1 的五个真实缺陷（重要：v0.15.0「撤销统一」其实只接线了一半）

用户报的「撤几次就报边界、然后撤销恢复全废」不是单一 bug，而是五个缺陷叠加。逐条列出（便于后续维护）：

### 缺陷 1（最关键）：阅读模式（PM）的编辑**从来没进过时间线**

- `pmAdapter` 的 `serialize` 生产实现是 `getMarkdownFromDoc(doc)`（期望 PM **doc**），
  而 `core/editor.ts` 的 `onTransactions` 传进来的是 **`EditorState`**。
- `EditorState` 没有 `.content` → 序列化抛错被 `catch` 吞掉返回 `""` →
  `commit({before:"", after:""})` 因无变化返回 null → **每一个字都不入库**。
- 后果：在阅读模式打的字，切到编辑模式按 Ctrl+Z 撤不掉（正是用户"跨模式撤销还是有问题"的主因）。
- 修法：`pmAdapter` 内部剥一层（有 `.doc` 取 `.doc`），两处 `serialize` 调用都走 `unwrapDoc`。

### 缺陷 2：首挂时时间线基线从未建立

- `begin(docKey, content)` 只写在「换文档 effect」里，而那个 effect 在
  `content === lastContentRef.current` 时提前 return —— 首次挂载正好命中。
- 于是 `documentHistory.currentText(key)` 恒为 null → 协调器 `syncBaseline` 跳过 →
  `commit` 里 `ensureDoc` 用 `before ?? ""` 建了条 `knownText=""` 的空时间线 → before 失配 → 静默拒绝。
- 修法：`onReady` 里补首挂基线（`pmAdapter.reset` + `sourceAdapter.reset` + `historyBegin`）。

### 缺陷 3：8 处源码编辑仍写**已退休**的旧 diff 栈

`pushUndoEntry` 写进 `undoStackRef`，而 v0.15.0 把 `doLocalUndo/doLocalRedo` 改成只走
`documentHistory` —— 旧栈**没有任何人消费**。这 8 处是：格式工具栏（加粗/标题/行内代码…）、
斜杠命令插入、`insertTextAtCursor`（对话框插入）、格式 ghost 退格、格式刷应用、块级粘贴回写等。

双重后果：
1. 这些操作**不可撤销**（功能回归）；
2. 更严重——它们改了文本却**没推进时间线已知文本**（`knownText`），
   下一次普通打字的 `commit(before=旧文本)` 与 knownText 失配 → 协调器
   `rebaseText(force:true)` 强制对齐 → `force` 触发 **`truncateRedo` 把 redo 分支整段删掉**。
   反复几次后时间线被推平 → 每次都走"空栈"分支 → 弹「已到本模式撤销边界」，恢复也一并失效。
3. 右键菜单的「撤销/恢复」禁用态读的也是旧栈（永远为空）→ 恒为灰色不可点。

修法：新增 `recordDiscreteSourceEdit()`，8 处全部改走统一时间线（带 `beforeSelection` 现场）；
右键菜单可用性改读 `documentHistory.canUndo/canRedo`。

### 缺陷 4：撤销/重做后 `pmAdapter` 基线未同步

- 撤销走 bridge 事务，`pmAdapter` 按设计**整批忽略**（正确，否则撤销动作本身会被记成新编辑）；
- 但它的内部 `baseline` 仍停在撤销前文本 → 用户一打字 again 触发 force-rebase → truncateRedo。
- 修法：新增 `pmAdapter.setBaseline()`，协调器在**落地成功后**调用 `syncAdapterBaseline`。

### 缺陷 5：边界提示重复 + 误报

- 协调器 `notifyBoundary` 已弹过一次，`handleUndo` 在返回 false 时又无条件弹一次 → 一次撤销两条提示；
- 且 `false` 还可能是「docKey 为空」「跨文件条目过期」等原因，那些与"撤到底"无关。
- 修法：边界提示职责收归协调器，`handleUndo` 不再补提示。

### 缺陷 6（对应「撤销时文档滚到底」）

- 撤销把整篇 doc 换成更短内容 → `scrollHeight` 立刻变小 → 浏览器把 `scrollTop` 钳到**新 max**（= 贴底）；
- `editor.ts` 的"保存/恢复 scrollTop"也写的是旧像素值，同样被钳。
- 修法：**锚内容不锚像素**。撤销前采「视口中央是哪个块 + 块内比例」，落地后按新几何反算
  `scrollTop`，0/60/160ms 各校正一次；用户用 wheel/pointerdown/滚动键接管即停手
  （判据用输入事件而非 scrollTop 差值——浏览器钳位会被误判成用户操作）。

### 附带修复：撤销后光标跳回文首

- `sourceAdapter.plan()` 从不产出 `beforeSelection` → 撤销时光标/滚动无处可恢复；
- 且 `setSourceContent` 是受控组件，React 提交新 value 会**重置 textarea 选区**，
  而那次提交可能晚于我们的 rAF（实测 12 → 0）。
- 修法：新增 `beforeSelection` 采集；选区恢复改走「`useLayoutEffect` 选区保护窗（250ms）」，
  窗口内每次 `sourceContent` 提交都重新应用，用户真实输入立即失效。

---

## 四、验证结果

| 项目 | 结果 |
|---|---|
| 前端测试 | **336 文件 / 6118 用例全部通过**（v0.15.0 基线 6066，净增 52） |
| `tsc --noEmit` | **0 错误** |
| 新增回归用例 | 撤销 12（`v0151-cross-mode-undo`）+ 折叠动效 15（`v0150-reading-fold` 87→102） |
| 既有撤销用例 | 115 条全绿（跨文件撤销 / 每文档独立 / 入口路由 / 边界提示 / 适配器 proof），**未改任何既有断言** |
| 实机探针：模式切换漂移 | **5/5 PASS**（10 轮双击 Ctrl，视口中央内容 10/10 保持一致，scrollTop 恒定 7941，最大偏移 6px、无累积） |
| 打包产物 | 可启动、内联最新 dist（探针内置 hash 校验）、无 dev 二进制陷阱 |

### 实机探针实测数据（需求3，`scripts/v0151-probe-mode-toggle-drift.mjs`）

```
基线（阅读面 50%）：scrollTop=7947 / max=15894，视口中央 = 块 121「小节 31」
R1..R10  编辑: 源码中央行=242 "## 小节 31"  →  阅读: scrollTop=7941 中央块=121 "小节 31"
相对基线漂移：-6.0 × 10（**恒定，无累积**）
中央内容与基线一致：10/10
判定：5 PASS / 0 FAIL
```

> 切换后恒定 6px 的差异来自两种排版的标题盒高差，属设计允许范围（判据是"同一小节仍在中央邻域"，
> 不是像素相等）。关键点在于**它不随轮次累积**——旧实现的百分比恢复会逐轮单向漂移。

---

## 五、改动文件

### 源码
| 文件 | 改动 |
|---|---|
| `src/editorHistory/pmAdapter.ts` | `unwrapDoc`（修缺陷 1）+ `setBaseline`（修缺陷 4） |
| `src/editorHistory/sourceAdapter.ts` | `beforeSelection` / `groupStartSelection` 采集（修光标恢复） |
| `src/editorHistory/coordinator.ts` | `syncAdapterBaseline` 钩子 + `commitFromSource` 透传 `beforeSelection` |
| `src/components/editor/EditorContainer.tsx` | 首挂基线、模式切换 flush、8 处置换统一时间线、撤销滚动锚点、选区保护窗、双向模式锚点、边界提示收口、右键菜单可用性 |
| `src/components/editor/readingFold.ts` | 折叠动效（CSS 注入 + 按钮复用 + 折叠态属性 + iframe 复用按钮） |
| `src/styles/readingFold.css` | 折叠/展开过渡、三角旋转、退化路径 |
| `src/core/editor.ts` | `foldController` 可注入（单测独立实例） |
| `src/core/plugins/image-lightbox.ts` | 入口改双击 + 闸门改 viewMode + 灯箱内部事件排除 |
| `src/core/plugins/image-node.ts` | 双击由插件捕获，NodeView 只保留单击激活 |
| `src/utils/imageLightbox.ts` | 导出 `isDoubleClick`（双击口径单一来源） |
| `src/components/editor/SearchReplace.tsx` / `.css` | 面板 920px、条幅高度过渡、选项行两段布局、工作区跳转 key 归一化 |
| `src/App.tsx` | search-jump 监听器归一化 + 未打开文件按路径打开（仅这两处） |

### 测试
- 新增：`src/__tests__/v0151-cross-mode-undo.test.tsx`（12）
- 追加：`src/__tests__/v0150-reading-fold.test.ts`（+15，87→102）
- 更新（逐条说明，语义等价）：`v0110-image-lightbox.test.ts` 1 条断言改为锁新闸门；
  `v0150-image-lightbox-plugin.test.ts` 12 处事件构造 `click`→`dblclick`（断言零弱化）；
  `v0150-search-workspace-ui.test.tsx` 追加工作区跳转/宽度/过渡用例。

### 探针
- 新增：`scripts/v0151-probe-mode-toggle-drift.mjs`（模式切换漂移取证，含 exe 内联 dist 校验）

---

## 六、安装与重点试用

1. 优先用 NSIS 安装包覆盖安装；也可直接双击 `lightmd.exe` 免安装试用。
2. **重点复测这 7 项**（都是用户原话对应的操作）：
   - **撤销**：编辑里改几个字 → 切阅读 → Ctrl+Z（应撤得掉）；再反复撤/恢复 3 轮（不应报边界、恢复应一直可用）；在阅读模式长文档中部撤销（不应跳到文档底部）。
   - **折叠动效**：阅读模式点标题左侧三角，内容应顺滑收起/放出，三角应旋转而非硬跳。
   - **双击 Ctrl 切换**：把文档滚到中间，连按 10 次双击 Ctrl，视口应停在同一小节。
   - **工作区搜索跳转**：搜索整个工作区 → 点结果（含**未打开**的文件）→ 应打开并定位到对应位置。
   - **搜索框**：宽度应约为原来的两倍；展开/收起结果条幅时高度应顺滑过渡；两个作用域按钮不应位移。
   - **图片灯箱**：阅读模式**双击**图片 → 全屏查看、滚轮缩放、←/→ 切图、Esc 关闭；单击图片应只是选中。

## 七、已知取舍（诚实声明）

1. **撤销历史的"现场恢复"有约 250ms 的选区保护窗**：这是为对抗 React 受控组件重置选区所必需；
   窗口内若用户立刻打字，保护窗立即失效，不抢光标。
2. **折叠动效依赖 `interpolate-size: allow-keywords`**（Chromium 129+ / 本机 WebView2 155 支持）；
   不支持的引擎自动退化为瞬时显隐——功能完整，只是没有动画。
3. **模式切换的 6px 恒定差**属两种排版标题盒高差的正常表现，不是漂移；判据是"同一小节仍在中央"。
4. **撤销历史仍是会话内的**（不跨重启持久化），上限 200 步 / 32MB 每文档。
