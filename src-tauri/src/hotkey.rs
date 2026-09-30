//! v0.9.1 需求1：**被输入法抢走的快捷键**回收。
//!
//! ## 问题（实测结论）
//! 用户按 `Ctrl+,` 打不开设置。用真实硬件级 `SendInput` 注入 + 页面内 keydown 取证：
//!   - 页面只收到 `Control` 的 keydown，**逗号的 keydown 根本不存在**；
//!   - 对照：`Ctrl+F` / `Ctrl+P` / `Ctrl+;` / `F11` 都能正常到达页面；
//!   - 中文环境下 `Ctrl+.`（微软拼音「中/英文标点切换」）同样被吞。
//! 即 `Ctrl+,` 被**中文输入法（TSF 保留键）**在消息进入应用之前消费掉了。
//! 这一层在应用与 Chromium 之外——WebView2 的 `AreBrowserAcceleratorKeysEnabled`
//! 管不到它（该项我们也已关闭并实测：F11 因此恢复到达页面，但 `Ctrl+,` 依旧被吞）。
//!
//! ## 为什么用 RegisterHotKey 而不是低级键盘钩子
//! 先用过 `WH_KEYBOARD_LL`：它确实能先于输入法看到按键，但
//!   ① 回调有 `LowLevelHooksTimeout`（默认 300ms）限制，超时会被 Windows **静默摘掉**
//!      （第一版在回调里调了 Tauri API，钩子只生效了一次）；
//!   ② 输入法自己也会装钩子，钩子链按安装顺序（后装的先调用）执行，
//!      输入法在前台切换时重装钩子就会插到我们前面，拦截变成"看运气"。
//! `RegisterHotKey` 注册在 win32k 的原始输入线程里，位于**所有用户态钩子与输入法之前**，
//! 因此是稳定且官方支持的抢键方式。
//!
//! ## 安全约束（避免变成全局快捷键劫持）
//!   - **只在本应用有窗口处于前台时注册**（Tauri `WindowEvent::Focused` 驱动），
//!     失焦立即注销 —— 其它应用/输入法照常使用 `Ctrl+,`；
//!   - 只抢精确组合 `Ctrl + ,`（不含 Alt / Shift / Win，且 MOD_NOREPEAT）；
//!   - 抢到后只发一个应用内事件 `lightmd:accelerator`，由前端按**当前生效键位**
//!     复核（用户把「打开设置」改绑到别的键后，`Ctrl+,` 不再触发设置）；
//!   - 注册失败（被别的程序占用）只记一行日志，功能退化为原生行为，不影响其它功能。

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicUsize, Ordering};
    use std::sync::mpsc::{channel, Sender};
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter};
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, MOD_CONTROL, MOD_NOREPEAT, VK_OEM_COMMA,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW, RegisterClassW,
        TranslateMessage, HWND_MESSAGE, MSG, WNDCLASSW, WM_APP, WM_HOTKEY,
    };

    /// 本应用注册的热键 id（进程内唯一即可）
    const HOTKEY_ID: i32 = 0x4C4D;
    /// "按当前前台状态同步注册"的自定义消息（必须由消息窗口所在线程处理：
    /// RegisterHotKey 要求传入属于**调用线程**的窗口，跨线程会返回
    /// 0x80070580 "无效窗口；它属于另一线程"）
    const WM_SYNC_HOTKEY: u32 = WM_APP + 1;
    /// 提示事件名（前端监听，见 App.tsx）
    const EVENT: &str = "lightmd:accelerator";

    static TX: OnceLock<Sender<&'static str>> = OnceLock::new();
    /// 消息窗口句柄（由专职线程创建并抽消息）
    static MSG_HWND: AtomicIsize = AtomicIsize::new(0);
    /// 当前是否已注册
    static REGISTERED: AtomicBool = AtomicBool::new(false);
    /// 期望状态：本应用是否有窗口处于前台
    static WANT_REGISTERED: AtomicBool = AtomicBool::new(false);
    /// 处于前台的本应用窗口数（多窗口下只有 0→1 注册、1→0 注销）
    static FOCUSED_WINDOWS: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "system" fn msg_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_HOTKEY && wparam.0 as i32 == HOTKEY_ID {
            if let Some(tx) = TX.get() {
                let _ = tx.send("view.settings");
            }
            return LRESULT(0);
        }
        // 前台状态变化 → 在本线程内注册/注销（线程亲和性要求）
        if msg == WM_SYNC_HOTKEY {
            if WANT_REGISTERED.load(Ordering::SeqCst) {
                register();
            } else {
                unregister();
            }
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// 安装：起一个专职线程建消息窗口 + 抽消息；事件派发另有线程（emit 不在抽消息线程里做重活）
    pub fn install(app: &AppHandle) {
        let (tx, rx) = channel::<&'static str>();
        let _ = TX.set(tx);

        let app_for_dispatch = app.clone();
        std::thread::spawn(move || {
            while let Ok(id) = rx.recv() {
                let _ = app_for_dispatch.emit(EVENT, serde_json::json!({ "id": id }));
            }
        });

        std::thread::spawn(|| unsafe {
            let Ok(hinstance) = GetModuleHandleW(None) else {
                eprintln!("[LightMD] 热键消息窗口初始化失败：取模块句柄失败");
                return;
            };
            let class_name = w!("LightMDHotkeySink");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(msg_wnd_proc),
                hInstance: hinstance.into(),
                lpszClassName: class_name,
                ..Default::default()
            };
            if RegisterClassW(&wc) == 0 {
                eprintln!("[LightMD] 热键消息窗口注册失败（Ctrl+, 可能仍被输入法占用）");
                return;
            }
            let hwnd = match CreateWindowExW(
                Default::default(),
                class_name,
                w!(""),
                Default::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(hinstance.into()),
                None,
            ) {
                Ok(h) if !h.0.is_null() => h,
                _ => {
                    eprintln!("[LightMD] 热键消息窗口创建失败（Ctrl+, 可能仍被输入法占用）");
                    return;
                }
            };
            MSG_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
            // 消息窗口建立后若已有前台窗口（启动即前台），补一次注册
            if FOCUSED_WINDOWS.load(Ordering::SeqCst) > 0 {
                WANT_REGISTERED.store(true, Ordering::SeqCst);
                register();
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
    }

    fn register() {
        let raw = MSG_HWND.load(Ordering::SeqCst);
        if raw == 0 || REGISTERED.load(Ordering::SeqCst) {
            return;
        }
        unsafe {
            match RegisterHotKey(
                Some(HWND(raw as _)),
                HOTKEY_ID,
                MOD_CONTROL | MOD_NOREPEAT,
                VK_OEM_COMMA.0 as u32,
            ) {
                Ok(()) => {
                    REGISTERED.store(true, Ordering::SeqCst);
                }
                Err(e) => {
                    eprintln!("[LightMD] 注册 Ctrl+, 热键失败（该组合已被其它程序占用？）: {e}");
                }
            }
        }
    }

    fn unregister() {
        let raw = MSG_HWND.load(Ordering::SeqCst);
        if raw == 0 || !REGISTERED.swap(false, Ordering::SeqCst) {
            return;
        }
        unsafe {
            let _ = UnregisterHotKey(Some(HWND(raw as _)), HOTKEY_ID);
        }
    }

    /// 本应用窗口获得/失去前台时调用（只在本应用前台期间占用 Ctrl+,）
    pub fn set_foreground(focused: bool) {
        if focused {
            FOCUSED_WINDOWS.fetch_add(1, Ordering::SeqCst);
        } else if FOCUSED_WINDOWS.load(Ordering::SeqCst) > 0 {
            FOCUSED_WINDOWS.fetch_sub(1, Ordering::SeqCst);
        }
        let want = FOCUSED_WINDOWS.load(Ordering::SeqCst) > 0;
        WANT_REGISTERED.store(want, Ordering::SeqCst);
        // 注册/注销必须发生在消息窗口所属线程：投递自定义消息让它自己处理
        let raw = MSG_HWND.load(Ordering::SeqCst);
        if raw != 0 {
            unsafe {
                let _ = PostMessageW(
                    Some(HWND(raw as _)),
                    WM_SYNC_HOTKEY,
                    Default::default(),
                    Default::default(),
                );
            }
        }
    }
}

#[cfg(windows)]
pub use imp::{install, set_foreground};

/// 非 Windows 平台：输入法不会占用 Ctrl+,，无需处理
#[cfg(not(windows))]
pub fn install(_app: &tauri::AppHandle) {}

/// 非 Windows 平台：空实现
#[cfg(not(windows))]
pub fn set_foreground(_focused: bool) {}
