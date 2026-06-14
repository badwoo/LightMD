// Release 模式隐藏控制台窗口，Debug 模式保留以便查看日志
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lightmd_lib::run()
}
