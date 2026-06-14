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
