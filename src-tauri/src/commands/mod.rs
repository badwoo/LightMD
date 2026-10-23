pub mod file_ops;
pub mod config;
pub mod export;
pub mod image;
pub mod translate;
pub mod ai_assist;
// v0.8.4 需求10：目录实时监听
pub mod watcher;
// v0.9.0：多窗口生命周期 / 会话 / 冲突检测命令
pub mod window_cmds;
// v0.14.0 需求1：软件更新（GitHub release 检查 / 下载安装包 / 启动安装）
pub mod update;
