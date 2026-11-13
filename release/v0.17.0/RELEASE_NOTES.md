# LightMD v0.17.0 发布说明

> 发布日期：2026-11-13 ｜ 基线：v0.16.0 ｜ 定位：**源码面升级 CodeMirror 6 + 统一文档模型基建**
>
> 本说明对应提交 `042c613`（tag `v0.17.0`）。
>
> **范围说明（重要）**：本版经复核后**正式缩减范围**（A 方案，见
> `_plan/lightmd-0.17.0-scope-reduction-decision.md`）。核心交付是**源码面替换为
> CodeMirror 6**；统一文档模型（UnifiedDoc）本版交付的是**模型基建 + 导出出口试点**，
> 「源码 / 阅读 / 预览 / 导出四条出口共用同一份 AST」**尚未完成**，正式移交后续版本。

---

## 一、安装包

| 文件 | 说明 | 大小（字节） |
|---|---|---:|
| `LightMD_0.17.0_x64-setup.exe` | NSIS 安装包（推荐，免管理员权限） | 8,182,287 |
| `LightMD_0.17.0_x64_en-US.msi` | MSI 安装包（企业分发） | 11,689,984 |
| `lightmd.exe` | 免安装单文件，可直接双击 | 24,768,000 |

```
4957B453D8431C96F91651ECE71EF8347DF9A0D2E957E3395826F0FC677206F0  LightMD_0.17.0_x64_en-US.msi
E536947393800E9AE5B25E38187C2A38CE0CB5CAE69EDBA2E7EB15D47D842D20  LightMD_0.17.0_x64-setup.exe
0E4E8FCDFFB7ACB1C99473D5F948BA606E4DF69A76C4F92EACF549D28E23A1AA  lightmd.exe
```

> 版本号四处一致：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` /
> `src-tauri/tauri.conf.json` 均为 `0.17.0`；构建自干净提交 `042c613` 并打了 tag `v0.17.0`。
> `lightmd.exe` 的 `FileVersion` / `ProductVersion` 实测均为 `0.17.0`；
> 前端 dist 入口 `index-CoKP0iBZ.js` 在 exe 字节流中实测命中（旧包为 `index-kxAuAqj5.js`，
> 可据此区分本次重打包）；`release/` 副本与 `src-tauri/target/release/` 产物 SHA256 完全一致。

---

## 二、本版真正交付的内容

### 2.1 源码面升级为 CodeMirror 6（主体交付）

编辑区源码面从原生 `<textarea>` 换成 CodeMirror 6：

- 语法高亮、行号、代码折叠、括号匹配、当前行高亮
- 矩形选择、多光标（`Ctrl+Alt+↑/↓`）
- 软换行（长行不再需要水平滚动）
- 搜索命中高亮改用真实文档范围（Decoration），不再是像素对齐的 overlay

**不再使用 `document.execCommand` 落地配对/缩进**：改走 CodeMirror transaction，
单事务 = 单撤销步。生产代码中仅剩 2 处 `execCommand`（textarea 回退实现的
`insertText`、以及剪贴板 cut/copy 的租用），CM6 路径完全不经过。

**撤销仍归宿主统一时间线**：CM6 侧不安装自带 `history()`，`Ctrl+Z/Y` 交回
`documentHistory` 协调器，跨模式撤销行为不回退。

### 2.2 统一文档模型（基建 + 一个出口）

| 出口 | 本版状态 |
|---|---|
| Word / LaTeX / ePub 导出（Block[]） | ✅ 已切到 UnifiedDoc 树（`parseUnified → treeToBlocks`） |
| 顶层块行号贴标（分屏对齐） | ✅ 已收敛到模型层 SPM |
| 图片尺寸/对齐后缀解析 | ✅ 已单点化（PM 与渲染共用一份） |
| 阅读面（ProseMirror）解析 | ⬜ 仍走既有 markdown-it 链路 |
| 预览 / HTML 导出 | ⬜ 仍走 markdown-it 渲染链路 |
| 阅读 → 源码的序列化 | ⬜ 仍走既有 PM 块序列化 |

交付的模型能力包括：带源码区间的语义树 `MdNode[]`、源码位置索引 `SPM`、
`treeToSource` 序列化器、`DocStore`（LRU 缓存，本版作储备）、往返 fuzz 基建。

### 2.3 数据保真与状态恢复修复（本轮收口）

| 问题 | 修复 |
|---|---|
| **阅读→编辑时未编辑内容被改写** | `normalizeOrderedLists` 跳过原文保真的范围从「整篇」收窄到**仅有序列表块**；其余块继续原文切片。修复了 `\sum_{i=1}^{n}` 被改写为 `\\sum\_{i=1}^{n}`（落盘 +7 字节、公式语义破坏） |
| **关软件重开后阅读进度被覆盖成 0** | 新增启动恢复锁存：恢复完成前禁止 scroll 事件写进度（4 个收尾点全部置位） |
| **跨模式光标记忆失效（落回文首）** | 光标先按**原始文本坐标**映射，再经 `remapOffsetAcrossLineEdits` 重映射到归一化文本，避免「旧区间切新文本」 |
| **百分比滚动兜底写入临时对象** | `restoreScrollWithRetry` 改经可选写入器 `setScrollTop` 落到真实滚动容器；删除 `as never` 临时对象写法 |
| **分屏右屏「拒绝后累积放行」的延迟猛跳** | 二值拒绝改为**有界连续钳制**（每帧最多走 `allowed`，基准每帧更新）；阈值与纯函数抽到 `scrollSyncPolicy` 共享模块，生产与测试同源 |
| **Setext 标题编辑后被归一化成 ATX** | parser 记 `raw.setext`，serializer 编辑后仍输出下划线式（下划线长度按新文字重算） |
| **定义列表 dd 内的代码块/表格被拍平成文本** | `definition_description` 内容模型改 `block+`，dd 内块级结构保留 |

### 2.4 崩溃级缺陷修复（A 线迁移引入，jsdom 无法覆盖）

- 搜索框输入任意字符即导致整个界面崩溃（`setSelectionRange` 被用在非 textarea 上）
- **`Ctrl+Z` 完全失效**（撤销时读取 `textarea.value` 得到 `undefined`）
- **每次输入 1 个字符编辑器被整体重建** → 焦点丢失，连打 10 字只落地 1 个
- **格式 ghost 占位提示不可见**
- **Tab 焦点逃逸 + Shift-Tab 静默失效**
- **CM6 源码面未开软换行**

---

## 三、已知限制（如实告知）

1. **超过 5MB 的文件仅支持编辑模式**（源码面），不支持阅读/预览。这是既有策略的
   完整实现——此前只切换模式但未真正禁用 ProseMirror，导致大文件卡死。
2. **配对增强手势**（括号自动补全 / Tab 跳出 / 成对删除）在源码面不生效；
   **Tab 缩进、撤销、专注模式均正常**。
3. **打字机模式在源码面不生效**（已登记，列入后续版本）。
4. **分屏对齐在视口外为估算**（CM6 视口外行高不可得），行高差异大时可能有偏差。
5. **IME 候选框跟随需人工验证**：候选框由操作系统渲染，自动化工具无法触及该层。
   已实测光标几何（矩形、竖横向移动、折行跟随）均正确。
6. **5MB 输入延迟门禁未严格达标**：实测 p95 = 16.4ms（目标 < 16ms）。对照实验表明
   该口径测量下限受 60Hz 刷新相位支配（空回调地板 16.5–18.2ms），产品已贴测量下限，
   真实 JS 处理成本约 0.4ms。建议后续把门禁改为「处理成本 p95 < 4ms + 跳帧率 < 5%」。

## 四、行为差异说明（不是缺陷）

- **折行时按 `Home`**：先到视觉行首，再按一次到逻辑行首（两段式）。
  这与 VS Code / Sublime / JetBrains 一致；旧 `<textarea>` 只有逻辑行首是因为
  浏览器原生实现较简单。

---

## 五、本版验收记录

| 门禁 | 结果 |
|---|---|
| `tsc --noEmit` | ✅ exit 0 |
| 全量 Vitest（串行） | ✅ **408 文件 / 7399 passed + 1 skipped / 0 failed** |
| `fuzz:full`（本版交付三条 oracle） | ✅ **lossy = 0 / corrupt = 0**（1000 篇） |
| 存量观测 `md-doc-md#reserialize` | ⚠️ 64/1000 corrupt —— **不计门禁**，测的是本版未切换的旧 PM 序列化链路，已登记 |
| `cargo test` | ✅ 281 passed / 0 failed / 3 ignored |
| 四出口一致性矩阵 | ✅ 118 用例（语义事实级） |
| 版本号四处一致 | ✅ 0.17.0 |
| 可复现构建 | ✅ 干净提交 `042c613` + tag `v0.17.0` |

**关于 fuzz 门禁口径**：`md-doc-md#reserialize` 测的是 `docToMarkdown` 这条
**本版未切换到模型树**的旧链路，其 corrupt 数在 P0 阶段就存在、数值稳定，
不是回归、不是本版交付。修它需把序列化切到模型树，而这会引入
`serializer ↔ unified/serialize` 双向依赖且让 5MB 每次保存多一次全量 parse
（`readiness §7.4:223` 已裁定「纯负收益」）。故本版将其降为**存量观测项**：
数字始终可见，但不冒充本版门禁失败。

---

## 六、移交后续版本

| 项 | 说明 |
|---|---|
| 阅读面解析接模型树 | 需新写 `MdNode[] → PM Node` 映射（39 schema 节点 vs 19 kind），实质重写阅读模式内核 |
| 预览 / HTML 导出接模型树 | **前置**需先建 HTML 字节/视觉等价基线（headless DOM diff），成本不低于实现 |
| 阅读 → 源码序列化接模型树 | 需解决双向依赖；`#reserialize` 的 64 篇 corrupt 会随之归零 |
| DocStore 接写路径 / 预览改 revision | 已量化「收益为零」，保持储备定位 |

工时评估见 `_plan/lightmd-0.17.0-unified-completion-feasibility.md` §3。
