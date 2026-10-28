# LightMD v0.15.2 交付说明

> 构建时间：2026-10-28
> 产物目录：`lightmd/release/v0.15.2/`
> 基线：v0.15.1
> 定位：**体验优化版**。新增「阅读 ↔ 编辑模式切换的滑入动画」，并修掉标题折叠「折起比展开快」的动效瑕疵。不新增功能面、不改数据格式。

---

## 一、安装包与校验值

| 文件 | 大小 | SHA256 |
|---|---:|---|
| `LightMD_0.15.2_x64-setup.exe`（NSIS 安装包，推荐） | 7.54 MB | `AAF52C8551514175D62904BA759207917E5B7F179886FD0FB8F6D9B795F765D2` |
| `LightMD_0.15.2_x64_en-US.msi`（MSI 安装包） | 10.87 MB | `EFEA124018A98842D24043C6B6A10C20DE62FB6CEBF54103EAE451056A950C55` |
| `lightmd.exe`（免安装单文件，可直接双击） | 23.16 MB | `BE3B64A91F8F7C5B4AA5A836E61EE36AF72A1D5E28D0A7390E80799DD8F38988` |

**产物已验证**：
- 三者都内联本次构建的最新前端产物（`dist/index.html` 指向 `index-CwAk2Zz6.js`，在 exe 字节流中实测命中）。
- 版本号四处一致：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `tauri.conf.json` 均为 `0.15.2`。
- 两个实机探针都直接跑这个 exe（见第四节）。

---

## 二、需求1：模式切换的滑入动画

用户原话：「增加阅读模式和编辑模式切换时的一个滑动效果，让模式切换时文档显得不那么突兀。当阅读模式切换到编辑模式时，编辑模式的左右屏有一个顺滑的**由左往右滑过来**的动画，而从编辑模式切换为阅读模式时，动画效果则为文档**从右往左滑回**的。」

### 实现

新增 `src/styles/modeSwitchSlide.css`（**独立文件**，不改 `editor.css` 这个多人共用的热点）；宿主在 `.editor-main-area` 上挂 `data-lmd-mode-anim="to-edit" | "to-preview"`，CSS 按方向选 `@keyframes`：

| 切换方向 | 进场的那一面 | 位移 | 时长 |
|---|---|---|---|
| 阅读 → 编辑 | 编辑区左栏 `.source-editor-wrapper` + 右屏 `.split-preview-shell`（两栏同时动） | `translateX(-100%) → 0`（从左滑入） | 380ms |
| 编辑 → 阅读 | 阅读面 `.editor-container` / `.plaintext-preview` | `translateX(+100%) → 0`（从右滑回） | 380ms |

两者互为镜像：去程整体"向右推开"、回程整体"向左滑回"。

### 关键设计决策（都有实机数据支撑）

1. **只动进场、不动退场**：两个模式面在 React 里互斥（`display:none`），退场那一面在提交时已不可见，没有可动画的载体。若为退场动画让两面同时挂载，会破坏整套滚动锚点（锚点采集正是靠 `clientHeight > 0` 判断"哪一面可见"，双面可见会采错面）。
2. **用 `transform` 而不是 `width/margin/left`**：`transform` 只触发合成、不触发布局；且**不改 `clientWidth/clientHeight/scrollHeight/scrollTop`**——而 v0.15.1 刚修好的内容锚点链路（`collectPmBlockGeometry` / `measureSourceLineAxis` / `measureOffsetViewportY`）读的就是这些布局值、或 rect 之间的**相对差**（父级整体平移时 `rect.top - scrollerRect.top` 恰好抵消）。实机验证：动画期间与结束后滚动位置 **0.00px** 波动。
3. **与「预览开合」那套 0.42s 宽度过渡互相让路**：进入编辑模式时右屏会同时被打开，两套动画同帧起跑会互相冲淡。动画窗口内（`data-lmd-mode-anim` 存在期）临时把编辑区内部的宽度过渡设为 `none`，窗口结束由 JS 移除属性自动恢复。
4. **快速连切幂等**：收尾定时器带自增 token，旧一轮到期先比对 token，不一致直接返回（避免把新一轮动画腰斩）。与 v0.15.1 滚动恢复的"代际"同一套路。
5. **时长单源**：`MODE_SLIDE_MS = 380`（TS）与 `--lmd-mode-slide-duration`（CSS）必须相等，由单测锁死——否则 JS 会在动画播完前摘掉属性，画面会跳一下。
6. **`prefers-reduced-motion`**：完全不位移，模式照常切换。

---

## 三、需求2：标题折叠「折起比展开快」

用户原话：「标题折叠还有点小瑕疵，这个和之前左侧栏子文件夹展开和折起有同样的问题，就是**折起来的动画太快**，而展开的动画时间是符合我要求的。」

这是**两个独立原因叠加**，实机帧采样 + 五条反事实逐条证实：

### 主因：折叠态的 `max-height: 0` 把 `height` 过渡钳死

- 展开态**没有** `max-height` 声明 → 计算值是 `none`；`none → 0` **不可插值**。
- 不可插值的属性**即使列进 `transition` 也不会被插值**（浏览器按离散属性处理，第一帧直接取终值）。
- 而 `max-height` 是 `height` 的上限 → 第一帧就被钳到 0，`height: auto → 0` 的过渡**整体失效**。
- 实测：折起 **t90 = 2.2ms（第 0 帧即终值）**，而展开方向没有这个钳制、能走满 440ms（t90 = 260ms）——正是"折起快、展开正常"。

**修法：彻底不声明 `max-height` / `min-height`**（收起靠 `height: 0 + overflow: hidden` 已足够）。

> ⚠️ **踩过并已记录的弯路**：第一版以为是"没参与过渡"，于是把 `max-height` 写进 `transition` —— **无效**（反事实 C4：`max-height:0` + 列进 transition → t90 仍 1.6ms）。起点 `none` 不可插值，写了等于没写。必须**彻底删掉**（反事实 C5：t90 = 259~264ms）。

### 次因：CSS 特异性让折起时的 `visibility` 延迟被覆盖

- 展开基态规则用 `:not(.a):not(.b):not(.c):not(.d)` 链 —— `:not()` 会把**参数的特异性计入**，四个类 → 该规则特异性 **(0,5,0)**；而折叠态规则 `.ProseMirror .lmd-fold-hidden` 只有 **(0,2,0)**。
- 于是折起时前者压过后者，实际生效的是它的 `visibility 0s linear 0s` → 内容第一帧就 invisible（只剩一块空白在收）。
- 修法：改用 `*:not(:where(.a, .b, .c, .d))`（`:where()` 特异性恒为 0）→ 该规则降到 **(0,1,0)**，折叠态 (0,2,0) 稳定胜出，正确采用 `visibility 0s linear 440ms`。
- 附带修掉两面不一致：iframe 面的基态是 `body > *`（0,0,1），折叠规则本来就赢，所以**只有 PM 面**是这个次因。

### 实机前后对比（`scripts/v0152-probe-fold-timing.mjs`）

| 项 | 修复前 | 修复后 | 期望 |
|---|---|---|---|
| 折起 t90 | 2.2ms | **266.9ms** | ~260ms ✅ |
| 展开 t90 | 260.4ms | **267.2ms** | ~260ms ✅ |
| 折起/展开 比值 | **0.01** | **1.00** | ≈1 ✅ |
| 折起 visibility 翻转 | 第 0 帧 / 3ms | **第 27 帧 / 447.1ms** | ~440ms ✅ |
| 折起 height 稳定 | 第 0 帧 | **第 24 帧 / 396.4ms** | 有过渡 ✅ |
| 折起态生效规则 | `.ProseMirror > *:not(...)` (0,5,0) | **`.lmd-fold-hidden` (0,2,0)** | ③ ✅ |
| 折起态 max-height 声明 | `0 !important` | **无** | 不得声明 ✅ |
| iframe 面 折起 t90 | 1.4ms（钳死） | **270.4ms** | ~260ms ✅ |

---

## 四、验证结果

| 项目 | 结果 |
|---|---|
| 前端测试 | **339 文件 / 6199 用例全部通过**（v0.15.1 基线 6190，净增 9） |
| `tsc --noEmit` | **0 错误**（strict） |
| 折叠动效用例 | `v0150-reading-fold` **104 条全绿**（新增/反转 3 条特异性与 max-height 回归锁） |
| 模式切换动画用例 | 新增 `v0152-mode-slide` **7 条全绿**（时长单源、双方向镜像、只动 transform、reduced-motion 降级） |
| 实机探针 · 模式切换动画 | **22 PASS / 0 FAIL** |
| 实机探针 · 折叠计时 | **22 PASS / 0 FAIL** |
| 实机探针 · 双击 Ctrl 漂移（回归） | 两面漂移 **0.00px**（v0.15.1 成果未被本轮改动破坏） |
| 打包产物 | NSIS + MSI + 单文件 exe，均内联最新 dist（探针内置 hash 校验） |

### 模式切换动画实测（`scripts/v0152-probe-mode-slide.mjs`）

采样方法：**Web Animations API 确定性步进**（`pause()` + `currentTime` 设到 0/25/50/75/100%），不受帧率与 iframe 重写影响。

```
阅读 → 编辑（由左往右）
  .source-editor-wrapper  animationName=lmd-mode-slide-in-from-left  duration=380ms
    0%    left=-729     tx=-1008
    25%   left=-130     tx=-408.99
    50%   left=150.88   tx=-128.12
    75%   left=254.43   tx=-24.57
    100%  left=279      tx=0
  .split-preview-shell 同动画同曲线（左右屏一起滑）

编辑 → 阅读（由右往左）
  .editor-container  animationName=lmd-mode-slide-in-from-right  duration=380ms
    0%    left=2301     tx=2022
    25%   left=1099.43  tx=820.43
    50%   left=536.01   tx=257.01
    75%   left=328.29   tx=49.29
    100%  left=279      tx=0

滚动对齐：连切 5 轮，阅读面 5/5、编辑面 5/5，最大偏移 0.00px，无单调累积
属性清理：切换瞬间 to-edit → +200ms 仍 to-edit → +700ms hasAttribute=false
reduced-motion：transform 全程 none、动画实例 0，模式照常切换
```

### 五条反事实（证明因果，不是"改完碰巧好了"）

| 场景 | 折起 height | 折起 visibility | 判定 |
|---|---|---|---|
| C1 旧 bug 基线（`max-height:0` + visibility 立刻） | 稳定帧 0 / t90 1.7ms | 3ms | bug 复现 |
| C2 只修次因（`max-height:0` + visibility 延迟） | 稳定帧 0 / t90 1.8ms | 438ms | 次因非主因 |
| C3 只修主因（不写 max-height + visibility 立刻） | 稳定帧 24 / t90 258ms | 1.7ms | 主因=height 钳死 |
| C4 **错误修法**（`max-height:0` 且写进 transition） | 稳定帧 0 / t90 2.4ms | 438ms | **无效** |
| C5 **正确修法**（不写 max-height + visibility 延迟） | 稳定帧 24 / t90 259ms | 439ms | **全对** |

---

## 五、改动文件

### 源码
| 文件 | 改动 |
|---|---|
| `src/styles/modeSwitchSlide.css` | **新增**：两个方向的 `@keyframes`、时长变量、动画期屏蔽内部宽度过渡、裁切、reduced-motion 降级 |
| `src/components/editor/EditorContainer.tsx` | `MODE_SLIDE_MS = 380` 常量；`modeAnim` 状态 + 代际 token；模式切换 effect 里按方向启动与收尾；`.editor-main-area` 挂 `data-lmd-mode-anim` |
| `src/styles/readingFold.css` | ② 规则改 `:not(:where(...))`（特异性 0,5,0 → 0,1,0）；③ 规则**删除** `max-height` / `min-height` 及其 transition 项 |
| `src/components/editor/readingFold.ts` | `FOLD_IFRAME_CSS` 折叠态同样删除 `max-height` / `min-height`；展开方向不写 max-height 过渡 |

### 测试
- 新增：`src/__tests__/v0152-mode-slide.test.ts`（7）
- 追加/反转：`src/__tests__/v0150-reading-fold.test.ts`（+2，102 → 104）：新增「折起方向 transition 不被展开基态压过（特异性回归锁）」与「折叠态不得声明 max-height」

### 探针
- 新增：`scripts/v0152-probe-mode-slide.mjs`（动画确定性步进验证）
- 新增：`scripts/v0152-probe-fold-timing.mjs`（折叠按帧计时 + 五条反事实）

---

## 六、安装与重点试用

1. 优先用 NSIS 安装包覆盖安装；也可直接双击 `lightmd.exe` 免安装试用。
2. **重点体验这两项**：
   - **模式切换**：双击 Ctrl 在阅读 ↔ 编辑间切换。进入编辑时左栏 + 右屏应"从左往右滑过来"（380ms）；回阅读时文档"从右往左滑回"。反复连按应始终顺滑、不抖、不残留位移。
   - **标题折叠**：点标题左侧三角。折起与展开应**一样慢、一样顺**（都是 440ms），内容应可见地收完再消失（不再"啪一下没了、只剩空白在收"）。编辑模式右侧预览里的折叠按钮同样如此。

## 七、已知取舍（诚实声明）

1. **只做进场动画、退场瞬间切换**：两个模式面互斥挂载，退场面在提交时已不可见。强行同时挂载会破坏滚动锚点采集（靠可见性判断当前面）。380ms 的进场位移已足以覆盖观感。
2. **动画期间编辑区内部的宽度过渡被临时关闭**：避免与"右屏打开"的 0.42s 宽度过渡互相冲淡。窗口结束后自动恢复，之后开合预览仍是原来那套动画。
3. **折叠动效仍依赖 `interpolate-size: allow-keywords`**（Chromium 129+ / 本机 WebView2 156 支持）；不支持的引擎退化为瞬时显隐。
4. **`prefers-reduced-motion` 下两个动画都不播**（模式切换仍正常、折叠仍正确收放，只是没有过渡）。
5. 沿用 v0.15.1 的全部既有取舍（撤销选区保护窗、阅读面撤销不恢复光标、全文翻译不入撤销栈、搜索高亮上限 2000 处等）。
