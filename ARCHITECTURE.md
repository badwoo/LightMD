# LightMD 架构文档

## 一、概述

LightMD 是一款基于 **Tauri v2 + React + ProseMirror** 构建的轻量级 Windows Markdown 编辑器。采用 WYSIWYG（所见即所得）编辑模式，光标所在行显示原始 Markdown 语法标记，其余部分渲染为富文本。

## 二、技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Tauri | v2.x |
| 后端语言 | Rust | stable (Edition 2021) |
| 前端框架 | React | 18.3 |
| 构建工具 | Vite | 5.4 |
| 编辑器核心 | ProseMirror | 1.x (model/state/view/transform) |
| Markdown 解析 | markdown-it | 14.x |
| 代码高亮 | PrismJS | 1.30 |
| 状态管理 | Zustand | 4.5 |
| 数据库 | SQLite (tauri-plugin-sql) | 可选 |

## 三、项目结构

```
lightmd/
├── src/                          # 前端源码 (TypeScript + React)
│   ├── main.tsx                  # React 入口
│   ├── App.tsx                   # 应用根组件（快捷键、文件操作、通知）
│   ├── components/
│   │   ├── editor/
│   │   │   ├── EditorContainer.tsx  # ProseMirror 编辑器挂载点
│   │   │   └── Outline.tsx          # 文档大纲（右侧面板）
│   │   ├── layout/
│   │   │   ├── AppShell.tsx         # 三栏布局容器
│   │   │   ├── TitleBar.tsx         # 顶部标题栏（菜单按钮）
│   │   │   └── StatusBar.tsx        # 底部状态栏
│   │   ├── sidebar/
│   │   │   ├── FileTree.tsx         # 侧边栏文件树
│   │   │   ├── FileNode.tsx         # 单个文件/文件夹节点
│   │   │   └── RecentFiles.tsx      # 最近文件列表
│   │   └── dialogs/
│   │       ├── SettingsDialog.tsx    # 设置面板
│   │       ├── ExportDialog.tsx      # 导出 HTML/PDF
│   │       └── ImagePasteDialog.tsx  # 图片粘贴处理
│   ├── core/
│   │   ├── editor.ts              # ProseMirror EditorView 工厂
│   │   ├── schema.ts              # ProseMirror Schema（块/内联节点定义）
│   │   ├── keymap.ts              # 键盘快捷键映射
│   │   ├── inputrules.ts          # Markdown 语法即时转换规则
│   │   ├── markdown/
│   │   │   ├── parser.ts          # markdown-it → ProseMirror Doc
│   │   │   └── serializer.ts      # ProseMirror Doc → Markdown 字符串
│   │   └── plugins/
│   │       ├── wysiwyg.ts         # 光标行显示语法标记（#、>、```）
│   │       ├── image-paste.ts     # 图片粘贴/拖拽处理
│   │       ├── focus-mode.ts      # 专注模式（dim 非活跃段落）
│   │       ├── code-block.ts      # 代码块 NodeView（双层高亮）
│   │       └── table-editor.ts    # 表格 NodeView（可视化编辑）
│   ├── stores/
│   │   ├── useEditorStore.ts      # 编辑器状态（文件路径、dirty、光标）
│   │   ├── useFileStore.ts        # 文件树状态（rootPath、recentFiles）
│   │   └── useSettingsStore.ts    # 设置状态（主题、字体、自动保存）
│   ├── services/
│   │   ├── fileService.ts         # 文件操作服务（invoke Rust 命令）
│   │   ├── configService.ts       # 配置服务（读取/保存设置）
│   │   └── notificationService.ts # 全局通知服务（toast 消息）
│   ├── hooks/
│   │   └── useAutoSave.ts         # 自动保存 Hook
│   ├── utils/
│   │   ├── path.ts                # 路径工具函数
│   │   ├── highlight.ts           # PrismJS 代码高亮封装
│   │   └── constants.ts           # 常量定义
│   └── styles/
│       ├── global.css             # 全局样式 + CSS 变量
│       ├── editor.css             # 编辑器内容样式
│       ├── code-theme.css         # 代码高亮主题
│       └── themes/
│           ├── light.css          # 亮色主题变量
│           └── dark.css           # 暗色主题变量
├── src-tauri/                    # Rust 后端源码
│   ├── Cargo.toml                # Rust 依赖配置
│   ├── tauri.conf.json           # Tauri 应用配置
│   ├── capabilities/
│   │   └── default.json          # 权限声明
│   ├── build.rs                  # Tauri 构建脚本
│   └── src/
│       ├── main.rs               # Rust 入口（隐藏控制台窗口）
│       ├── lib.rs                # Tauri Builder 配置 + 命令注册
│       ├── commands/
│       │   ├── mod.rs            # 命令模块声明
│       │   ├── file_ops.rs       # 文件 I/O 命令（CRUD）
│       │   ├── config.rs         # 配置读写命令
│       │   ├── export.rs         # 导出命令（占位）
│       │   └── image.rs          # 图片保存命令
│       ├── db/
│       │   ├── mod.rs            # 数据库模块
│       │   └── models.rs         # 数据模型（RecentFile、Setting）
│       └── utils/
│           └── mod.rs            # Rust 工具函数
├── package.json                  # 前端依赖
├── vite.config.ts               # Vite 构建配置
├── tsconfig.json                # TypeScript 配置
├── index.html                   # HTML 入口
├── ARCHITECTURE.md              # 架构文档（本文档）
└── USER_GUIDE.md                # 用户使用文档
```

## 四、数据流架构

### 4.1 文件操作流程

```
用户操作 (UI)
    │
    ├─ FileTree 组件
    │   └─ fileService.listDir() → invoke("list_dir") → [Rust] file_ops::list_dir
    │
    ├─ 打开文件 (Ctrl+O / 点击文件)
    │   ├─ dialog.open() → 用户选择文件
    │   └─ fileService.readFile() → invoke("read_file") → [Rust] file_ops::read_file
    │       └─ dispatchEvent("lightmd:openFile") → App.tsx 更新 content state
    │
    └─ 保存文件 (Ctrl+S)
        ├─ docToMarkdown(editorView.state.doc) → Markdown 字符串
        └─ fileService.writeFile() → invoke("write_file") → [Rust] file_ops::write_file
```

### 4.2 编辑器渲染流程

```
Markdown 文本
    │
    ▼
markdown-it.parse() → Token[]
    │
    ▼
parser.ts → ProseMirror Doc (Node tree)
    │
    ▼
EditorState.create({ doc, plugins }) → EditorView
    │
    ├─ NodeViews: CodeBlockView (双层高亮), TableView (可编辑表格)
    ├─ Decorations: wysiwygPlugin (语法标记), focusModePlugin (专注模式)
    └─ InputRules: 输入时即时转换 (#, -, >, ```等)
    │
    ▼
用户编辑 (dispatchTransaction)
    │
    ▼
serializer.ts → Markdown 字符串
    │
    ▼
onDocChange 回调 → App.tsx 更新 content state
```

### 4.3 状态管理架构

```
App.tsx (顶层状态协调)
    │
    ├─ useSettingsStore (Zustand + localStorage persist)
    │   ├─ theme, fontSize, fontFamily, autoSaveInterval
    │   └─ 通过 CSS 变量注入全局样式
    │
    ├─ useEditorStore (Zustand)
    │   ├─ filePath, isDirty, cursorLine, wordCount
    │   ├─ focusMode, isSourceMode
    │   └─ openTabs (多标签页预留)
    │
    └─ useFileStore (Zustand)
        ├─ rootPath, fileTree
        └─ recentFiles (最多 20 条)
```

## 五、关键设计决策

### 5.1 双层代码块（CodeBlockView）

代码块使用**双层 DOM 结构**：
- **编辑层**（contentDOM）：ProseMirror 管理，文本颜色透明
- **高亮层**（highlightLayer）：只读 PrismJS 渲染，在编辑层下方

用户看到高亮语法，实际编辑的是透明文本。避免了修改 `contentDOM.innerHTML` 破坏 ProseMirror DOM 追踪的问题。

### 5.2 自定义命令 vs 插件

文件操作使用**自定义 Rust 命令**（`invoke`）而非 `tauri_plugin_fs`：
- 更精确的错误处理和路径校验
- 避免插件 scope 配置冲突
- 支持文件大小限制（50MB）

### 5.3 WYSIWYG 标记装饰

使用 ProseMirror `Decoration.widget` 在光标所在块级节点的内容起始位置插入语法标记（`#`、`>`、` ``` `），实现「所见即所得」效果。标记使用 `side: -1` 确保不干扰内容编辑。

### 5.4 全局通知系统

通过 `notificationService.ts` 实现轻量级的 toast 通知：
- 所有 invoke 错误自动弹出错误 toast
- 3.5 秒自动消失
- 支持 error/warning/success/info 四种类型

## 六、性能优化

- 大文档（>200 块节点）下专注模式跳过距离活跃节点 5000 字符以外节点的装饰
- 字数统计 300ms 节流
- 大纲使用 requestAnimationFrame 替代 setTimeout
- 编辑器挂载只执行一次，文件切换通过 ProseMirror 事务更新文档

## 七、安全考虑

- Rust 命令对文件操作进行路径规范化和存在性检查
- 文件读取限制 50MB
- 目标文件存在时重命名操作拒绝执行
- 全局通知确保错误不会静默失败

## 八、AI 子系统架构（v0.6.0 引入，v0.7.5 扩展）

AI 能力（翻译 / 续写 / 润色 / 摘要 / 对话）共用一套后端基建，前端按功能拆分服务与状态。

### 8.1 分层

```
前端入口层（EditorContainer / StatusBar）
    │  用户操作 → lightmd:command 事件 → EditorContainer 统一接线
    ▼
前端服务层（services/）
    translateService  ── 选中翻译 / 全文翻译（并发槽位）
    aiAssistService   ── 续写 / 润色 / 摘要（单轮任务）
    aiChatService     ── AI 对话（多轮 messages + 上下文截断/历史截断）
    fullTranslate     ── 文档切分 / 重组 / 并发循环
    │  invoke + tauri::ipc::Channel（流式增量）
    ▼
Rust 命令层（commands/）
    translate.rs   ── translate_text / cancel_translate / Key 管理 / 模型列表
    ai_assist.rs   ── ai_assist_text（续写·润色·摘要）/ ai_chat（对话）
    │
    ▼
Rust 领域层（translate/）
    prompt.rs    ── Prompt 模板（翻译 / 续写 / 润色 / 摘要 / 对话 system）
    provider.rs  ── OpenAI 兼容客户端：SSE 解析、错误码协议、
                    stream_chat_completions（翻译与对话共用的流式读取）
    segment.rs   ── {{N}} 占位符提取 / 回填 / 校验（仅翻译通道）
    mod.rs       ── TranslateState：单任务槽 + 全文翻译并发槽位
```

### 8.2 关键设计

| 主题 | 方案 |
|---|---|
| 任务互斥 | `TranslateState` 单任务槽：翻译 / 续写 / 润色 / 摘要 / 对话任一时刻仅一个在途，新任务自动取消旧任务；全文翻译走独立并发槽位（按 task_id 取消，互不干扰） |
| 流式 | Rust 侧 `Channel<String>` 推送增量；前端 rAF 批量刷新（气泡 / 对话窗均同款），避免每个 chunk 触发一次 React 渲染 |
| 取消 | `AtomicBool` 取消标志，SSE 读取循环每次 chunk 前检查；前端另有请求序号守卫，丢弃旧任务的残余 chunk / 迟到结果 |
| 错误协议 | `NETWORK\|` / `AUTH\|` / `RATE\|` / `TRUNCATED\|` / `STREAM\|` / `CANCELLED` / `NO_KEY\|` / `PROVIDER\|{status}\|{msg}` / `DOC_CHANGED`，前端 `parseTranslateError` 统一解析为 i18n 文案 |
| API Key | 存于系统凭据管理器（keyring），按 provider 独立条目；前端只能拿到布尔值 |
| 占位符保护 | 仅翻译通道：发送前把链接 / 行内代码 / 图片整体替换为 `{{N}}`，收到译文后回填并校验；对话与续写等自由生成通道不做 mask（占位符反而会干扰指令） |
| 回写安全 | 一律使用**任务启动时的快照**（PM 选区 from/to + doc 引用；source 通道 textarea 切片位置）定位，禁止用"当前选区"；整篇替换前做 DOC_CHANGED 校验（当前全文 === 发送时快照），不一致则拒绝；回写后记录原文快照，支持一键恢复 |
| 滚动跟随与 Esc（v0.7.5） | 阅读/源码模式的"按键后跟随光标"依赖 keydown 记录的滚动基线。气泡的 Esc 在 `window` 捕获阶段 `stopPropagation()`，编辑器捕获 keydown 收不到该键而 keyup 仍到达，旧实现会用**上一次按键的陈旧基线**恢复 `scrollTop`（表现为"按 Esc 后文档跳回开头"）。现由 `utils/typewriter.ScrollKeyBaseline` 强制 keydown/keyup 配对：未配对的 keyup 一律不参与滚动计算，编辑器 blur 时作废基线 |

### 8.3 v0.7.5 新增文件

```
src/services/aiChatService.ts          对话服务：上下文/历史截断 + 消息组装 + 流式调用
src/stores/aiChatStore.ts              对话窗状态机（开关/几何/消息/流式/上下文预览）
src/components/editor/AiChatDialog.tsx 对话浮动窗 UI
src/components/editor/AiChatDialog.css 对话窗样式（全量主题 CSS 变量）
src/utils/aiChatTemplates.ts           快捷指令模板常量（含 i18n key、默认范围与目标语言解析）
```

### 8.4 v0.7.5 细节优化涉及的关键点

| 项 | 位置 |
|---|---|
| Esc 不再重置阅读进度 | `utils/typewriter.ts`（`ScrollKeyBaseline` 系列）+ `EditorContainer` 两处 keydown/keyup/blur 监听 |
| 气泡颜色同步底部栏 AI 按钮 | `StatusBar.tsx`（`aiEntryColorStyle` 注入 `--ai-entry-color`）+ `StatusBar.css` |
| 续写立即占位 ghost | `core/plugins/ai-ghost.ts`（`AiGhostState.placeholder`）+ `EditorContainer` 的 `runAiGhost` / `runSourceAiGhost` |
| 窗口内嵌 AI 翻译 | `utils/aiChatTemplates.ts`（translate 模板 + `resolveTemplateInstruction`）+ `AiChatDialog` 的「译」动作 |
| 对话窗自由拖动 | `AiChatDialog` 的 `clampChatRect`（只钳制尺寸，不钳制位置）+ `isAiChatRectVisible`（仅作重开时的安全网） |

Rust 侧：`translate/prompt.rs` 新增 `AI_CHAT_SYSTEM_PROMPT`；`translate/provider.rs`
新增 `ChatMessage` / `build_chat_body` / `chat_temperature` / `chat_stream`（与
`translate_stream` 共用 `stream_chat_completions`）；`commands/ai_assist.rs` 新增
`ai_chat` 命令并在 `lib.rs` 注册。
