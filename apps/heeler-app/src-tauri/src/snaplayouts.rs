//! Snap Layouts for the app's own maximize button (Windows 11).
//!
//! The title bar is ours (decorations: false), so Windows has no idea
//! where the maximize button is. Hovering a native maximize button
//! makes the Desktop Window Manager put up the Snap Layouts flyout;
//! hovering ours put up nothing ("the maximize button
//! does not trigger desktop window manager"). DWM decides by asking
//! the window under the cursor WM_NCHITTEST and looking for
//! HTMAXBUTTON in the answer. The window under the cursor is the
//! webview's, and it answers HTCLIENT for everything.
//!
//! So a small child window with nothing painted in it sits over the
//! button, above the webview, and answers HTMAXBUTTON. The window
//! itself is subclassed to answer the same over that spot, since it is
//! not documented which of the two Windows consults. The frontend
//! tells the overlay where the button is (the set_maximize_button_rect
//! command) whenever the button moves or resizes. Because that child
//! now owns the mouse over the button, it also has to do the button's
//! job: a click maximizes or restores, and hover goes back to the
//! frontend as an event so the button still lights up. The event is
//! emitted to the window's label, which reaches a listener registered
//! on that window and not a plain listen on the global bus; the
//! frontend listens accordingly.
//!
//! This is the same trick Tauri itself plays for the resize borders of
//! an undecorated window (its TAURI_DRAG_RESIZE_BORDERS child), and
//! ours sits just under that one in z-order so the top few pixels stay
//! a resize handle, the way they do on a native title bar.

/// The event carrying the overlay's hover state to the frontend, a
/// bool payload. Spelled out on both sides (snaplayouts.ts).
pub const MAXIMIZE_HOVER_EVENT: &str = "heeler:maximize-hover";

/// Where the maximize button sits, in physical pixels of the window's
/// client area, as the frontend measured it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ButtonRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl ButtonRect {
    /// A rect the overlay can take, or None for one it must not: an
    /// unmounted button measures as all zeros, and that has to clear
    /// the overlay rather than plant a 0x0 child that still answers
    /// hit tests along its edge. A negative origin is off the window.
    pub fn checked(x: i32, y: i32, w: i32, h: i32) -> Option<Self> {
        if w <= 0 || h <= 0 || x < 0 || y < 0 {
            return None;
        }
        Some(Self { x, y, w, h })
    }
}

/// Whether a hover report is due. Windows sends WM_NCMOUSEMOVE for
/// every pixel the cursor moves and the button wants one "on" and one
/// "off", so only the edges count.
pub fn hover_edge(hovering: &mut bool, now: bool) -> bool {
    if *hovering == now {
        return false;
    }
    *hovering = now;
    true
}

#[cfg(windows)]
pub mod win {
    use super::{hover_edge, ButtonRect, MAXIMIZE_HOVER_EVENT};
    use tauri::{Emitter, Manager};
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::*;

    const CLASS_NAME: PCWSTR = w!("HEELER_MAXIMIZE_BUTTON");
    /// Tauri's own overlay for the resize borders of an undecorated
    /// window. Ours goes right under it in z-order.
    const RESIZE_BORDERS_CLASS: PCWSTR = w!("TAURI_DRAG_RESIZE_BORDERS");
    /// The subclass id on the window itself, distinct from Tauri's
    /// resize-border subclass (WM_USER + 1).
    const PARENT_SUBCLASS_ID: usize = 0x4845_454C; // "HEEL"

    /// What the overlay needs to reach back into the app from inside
    /// its window procedure. Lives behind the child's GWLP_USERDATA
    /// and is freed on WM_NCDESTROY.
    struct Overlay {
        app: tauri::AppHandle,
        label: String,
        hovering: bool,
    }

    /// Puts the overlay over `rect` in the window whose native handle
    /// is `hwnd`, making it the first time. None hides it. Must run on
    /// the thread that owns the window, which is where sync commands
    /// run: a child window belongs to its creating thread.
    pub fn place(
        app: &tauri::AppHandle,
        label: &str,
        hwnd: isize,
        rect: Option<ButtonRect>,
    ) -> Result<(), String> {
        let parent = HWND(hwnd as _);
        let existing =
            unsafe { FindWindowExW(Some(parent), None, CLASS_NAME, PCWSTR::null()) }.ok();
        let Some(rect) = rect else {
            if let Some(child) = existing {
                unsafe {
                    let _ = ShowWindow(child, SW_HIDE);
                }
            }
            return Ok(());
        };
        let child = match existing {
            Some(c) => c,
            None => create(app, label, parent)?,
        };
        let above =
            unsafe { FindWindowExW(Some(parent), None, RESIZE_BORDERS_CLASS, PCWSTR::null()) }
                .unwrap_or(HWND_TOP);
        unsafe {
            SetWindowPos(
                child,
                Some(above),
                rect.x,
                rect.y,
                rect.w,
                rect.h,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
            )
        }
        .map_err(|e| e.to_string())
    }

    fn create(app: &tauri::AppHandle, label: &str, parent: HWND) -> Result<HWND, String> {
        let instance = unsafe { GetModuleHandleW(PCWSTR::null()) }
            .map(|h| HINSTANCE(h.0))
            .unwrap_or_default();
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(overlay_proc),
            hInstance: instance,
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };
        // A second window (a pop-out) finds the class registered
        // already; that failure is the right answer and is ignored.
        unsafe { RegisterClassExW(&class) };
        let data = Box::new(Overlay {
            app: app.clone(),
            label: label.to_string(),
            hovering: false,
        });
        let child = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                CLASS_NAME,
                PCWSTR::null(),
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                0,
                0,
                Some(parent),
                None,
                Some(instance),
                Some(Box::into_raw(data) as _),
            )
        }
        .map_err(|e| e.to_string())?;
        // The window itself answers the same way over the button, for
        // whichever of the two Windows asks. Its data is its own copy;
        // the child's goes with the child.
        let parent_data = Box::new(Overlay {
            app: app.clone(),
            label: label.to_string(),
            hovering: false,
        });
        unsafe {
            let _ = SetWindowSubclass(
                parent,
                Some(parent_proc),
                PARENT_SUBCLASS_ID,
                Box::into_raw(parent_data) as usize,
            );
        }
        Ok(child)
    }

    /// Whether a screen point lies on the overlay child of `parent`,
    /// while the overlay is up.
    unsafe fn on_overlay(parent: HWND, x: i32, y: i32) -> bool {
        let Ok(child) = FindWindowExW(Some(parent), None, CLASS_NAME, PCWSTR::null()) else {
            return false;
        };
        if !IsWindowVisible(child).as_bool() {
            return false;
        }
        let mut rect = RECT::default();
        if GetWindowRect(child, &mut rect).is_err() {
            return false;
        }
        x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
    }

    fn point_of(lparam: LPARAM) -> (i32, i32) {
        ((lparam.0 & 0xffff) as i16 as i32, ((lparam.0 >> 16) & 0xffff) as i16 as i32)
    }

    unsafe extern "system" fn parent_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        data: usize,
    ) -> LRESULT {
        match msg {
            WM_NCHITTEST => {
                let (x, y) = point_of(lparam);
                if on_overlay(hwnd, x, y) {
                    return LRESULT(HTMAXBUTTON as isize);
                }
            }
            WM_NCLBUTTONDOWN if wparam.0 == HTMAXBUTTON as usize => {
                let o = &*(data as *const Overlay);
                toggle(o);
                return LRESULT(0);
            }
            WM_NCLBUTTONUP | WM_NCLBUTTONDBLCLK if wparam.0 == HTMAXBUTTON as usize => {
                return LRESULT(0);
            }
            WM_NCDESTROY => {
                let p = data as *mut Overlay;
                if !p.is_null() {
                    drop(Box::from_raw(p));
                }
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    unsafe fn overlay<'a>(hwnd: HWND) -> Option<&'a mut Overlay> {
        let p = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Overlay;
        if p.is_null() {
            None
        } else {
            Some(&mut *p)
        }
    }

    /// The click, done through Tauri rather than a WM_SYSCOMMAND so
    /// the runtime's own idea of "maximized" stays right, and off this
    /// thread: asking a window its state from inside a window
    /// procedure on the thread that answers is a deadlock.
    fn toggle(o: &Overlay) {
        let app = o.app.clone();
        let label = o.label.clone();
        tauri::async_runtime::spawn(async move {
            let Some(w) = app.get_webview_window(&label) else { return };
            let _ = if w.is_maximized().unwrap_or(false) {
                w.unmaximize()
            } else {
                w.maximize()
            };
        });
    }

    fn hover(o: &Overlay, on: bool) {
        let app = o.app.clone();
        let label = o.label.clone();
        tauri::async_runtime::spawn(async move {
            let _ = app.emit_to(label.as_str(), MAXIMIZE_HOVER_EVENT, on);
        });
    }

    unsafe extern "system" fn overlay_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_CREATE => {
                let cs = lparam.0 as *const CREATESTRUCTW;
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*cs).lpCreateParams as isize);
            }
            // The whole point: DWM asks, and hears "a maximize button".
            WM_NCHITTEST => return LRESULT(HTMAXBUTTON as isize),
            WM_NCLBUTTONDOWN => {
                if let Some(o) = overlay(hwnd) {
                    toggle(o);
                }
                return LRESULT(0);
            }
            // Swallowed: DefWindowProc would act on a caption-button
            // code for a frame this child does not have.
            WM_NCLBUTTONUP | WM_NCLBUTTONDBLCLK | WM_NCRBUTTONDOWN | WM_NCRBUTTONUP => {
                return LRESULT(0)
            }
            WM_NCMOUSEMOVE => {
                if let Some(o) = overlay(hwnd) {
                    if hover_edge(&mut o.hovering, true) {
                        let mut track = TRACKMOUSEEVENT {
                            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                            dwFlags: TME_LEAVE | TME_NONCLIENT,
                            hwndTrack: hwnd,
                            dwHoverTime: 0,
                        };
                        let _ = TrackMouseEvent(&mut track);
                        hover(o, true);
                    }
                }
            }
            WM_NCMOUSELEAVE => {
                if let Some(o) = overlay(hwnd) {
                    if hover_edge(&mut o.hovering, false) {
                        hover(o, false);
                    }
                }
            }
            WM_NCDESTROY => {
                let p = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) as *mut Overlay;
                if !p.is_null() {
                    drop(Box::from_raw(p));
                }
            }
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_real_button_rect_passes_through() {
        assert_eq!(
            ButtonRect::checked(2378, 7, 39, 35),
            Some(ButtonRect { x: 2378, y: 7, w: 39, h: 35 })
        );
    }

    #[test]
    fn an_unmounted_or_off_window_button_clears_the_overlay() {
        assert_eq!(ButtonRect::checked(0, 0, 0, 0), None, "all zeros is 'no button'");
        assert_eq!(ButtonRect::checked(10, 10, 0, 30), None);
        assert_eq!(ButtonRect::checked(10, 10, 30, -1), None);
        assert_eq!(ButtonRect::checked(-5, 10, 30, 30), None);
        assert_eq!(ButtonRect::checked(10, -5, 30, 30), None);
    }

    #[test]
    fn hover_reports_only_on_the_edges() {
        let mut hovering = false;
        assert!(hover_edge(&mut hovering, true), "entering reports");
        assert!(!hover_edge(&mut hovering, true), "moving inside does not");
        assert!(!hover_edge(&mut hovering, true));
        assert!(hover_edge(&mut hovering, false), "leaving reports");
        assert!(!hover_edge(&mut hovering, false), "a second leave does not");
        assert!(!hovering);
    }

    /// The event name and the command name are a handshake with the
    /// frontend, spelled out independently on each side.
    #[test]
    fn the_frontend_speaks_the_same_names() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let ts = std::fs::read_to_string(root.join("../src/snaplayouts.ts"))
            .expect("snaplayouts.ts sits next to the desktop crate");
        assert!(
            ts.contains(&format!(r#"MAXIMIZE_HOVER_EVENT = "{MAXIMIZE_HOVER_EVENT}""#)),
            "frontend MAXIMIZE_HOVER_EVENT no longer matches ({MAXIMIZE_HOVER_EVENT})"
        );
        let bridge = std::fs::read_to_string(root.join("../src/bridge.ts"))
            .expect("bridge.ts sits next to the desktop crate");
        assert!(
            bridge.contains(r#""set_maximize_button_rect""#),
            "the frontend no longer calls set_maximize_button_rect"
        );
    }
}
