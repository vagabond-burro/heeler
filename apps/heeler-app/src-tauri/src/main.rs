#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Release builds are GUI-subsystem binaries, which Windows starts with
/// no console: println from `heeler serve` would vanish. Attaching to
/// the parent's console makes the subcommand behave like a normal CLI
/// when launched from a terminal, and is a no-op from the file browser.
#[cfg(windows)]
fn attach_console() {
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(pid: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

fn main() {
    // Verification must not start a GUI, service or model.
    let recovery_args: Vec<String> = std::env::args().collect();
    if recovery_args.get(1).map(String::as_str) == Some("recovery") {
        #[cfg(windows)]
        attach_console();
        std::process::exit(heeler_desktop_lib::recovery::cli(&recovery_args[2..]));
    }
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("serve") => {
            #[cfg(windows)]
            attach_console();
            std::process::exit(heeler_desktop_lib::headless::serve_main(&args[2..]));
        }
        // A compositor's gesture: -x runs a script with no window.
        Some("-x") => {
            #[cfg(windows)]
            attach_console();
            std::process::exit(heeler_desktop_lib::batch::batch_main(&args[2..]));
        }
        _ => heeler_desktop_lib::run(),
    }
}
