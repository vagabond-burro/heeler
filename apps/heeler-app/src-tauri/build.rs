mod build_identity;

fn main() {
    // The build identity that About reports. "have a build number. This
    // is the kind of information I will need from users sending emails
    // for licenses and bugs." The commit
    // count is the number (monotonic, human-sized), the short hash is
    // the receipt. A build that reaches anyone else is made by
    // scripts/dist.py, which computes both from
    // the commit and pass them in HEELER_BUILD_NUMBER and
    // HEELER_BUILD_HASH; this script bakes what it is given. A build
    // made by hand (tauri dev, cargo test, a bare cargo build) is given
    // no explicit stamp and reads "build dev (dev)", even with an old
    // number or hash in the shell. Packaging sets HEELER_BUILD_STAMPED=1.
    //
    // This script used to run git itself and watch .git/HEAD, the branch's ref and
    // packed-refs, so the number was always right; the price was that every commit
    // re-ran it, changed the baked number, and cargo recompiled the whole desktop
    // crate in the owner's running dev app, fifty-six times on one branch
    // (2026-09-24: "I have noticed that in the building process that it hangs up
    // here much longer than before"). "I am okay with this, since its
    // only me looking at dev builds." Nothing here watches the repository now;
    // identity changes watch environment inputs; Tauri also watches its resources.
    let stamped = std::env::var("HEELER_BUILD_STAMPED").ok();
    let number = std::env::var("HEELER_BUILD_NUMBER").ok();
    let hash = std::env::var("HEELER_BUILD_HASH").ok();
    let (number, hash) = build_identity::identity(stamped.as_deref(), number.as_deref(), hash.as_deref());
    println!("cargo:rustc-env=HEELER_BUILD_NUMBER={number}");
    println!("cargo:rustc-env=HEELER_BUILD_HASH={hash}");
    println!("cargo:rerun-if-env-changed=HEELER_BUILD_STAMPED");
    println!("cargo:rerun-if-env-changed=HEELER_BUILD_NUMBER");
    println!("cargo:rerun-if-env-changed=HEELER_BUILD_HASH");
    // build-identity:end (scripts/test_release.py compiles main up to this
    // line on its own, so the identity runs without Tauri). Whether this
    // build calls itself a pre-release. The setting lives in version.rs
    // (PRE_RELEASE_DEFAULT); a build can overrule it either way with
    // HEELER_PRE_RELEASE=1 or =0, which the build scripts set on
    // --pre-release and --no-pre-release, so a tester bundle is stamped on
    // the fly rather than by editing a constant back and forth
    // (2026-09-15). Unset, or anything else, is passed through empty and
    // the code's setting stands. The variable is watched, so flipping it
    // recompiles the crate that reads it.
    let pre_release = match std::env::var("HEELER_PRE_RELEASE").as_deref() {
        Ok("1") => "1",
        Ok("0") => "0",
        _ => "",
    };
    println!("cargo:rustc-env=HEELER_PRE_RELEASE={pre_release}");
    println!("cargo:rerun-if-env-changed=HEELER_PRE_RELEASE");
    // Tauri's Windows resource carries the icon and the version block
    // only; the manifest is ours, below, so that every linked target
    // gets it and none gets it twice.
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("tauri-build failed");
    windows_manifest();
}

/// The Windows application manifest, embedded by the linker into every
/// executable and DLL this crate links: the app binary, the cdylib, the
/// lib's unit-test harness and the integration tests.
///
/// Tauri's build used to embed it for the app binary alone, inside the
/// resource it hands to bins through rustc-link-arg-bins, so test
/// executables ran with no manifest. Without one the loader binds
/// comctl32.dll to the 5.82 copy in System32, which has no
/// TaskDialogIndirect. That import reaches a test binary through rfd
/// and muda (under tauri) as soon as any test reaches the dialog
/// plugin or event emission, and the MSVC linker keeps a raw-dylib
/// import once loaded even after discarding the code that used it, so
/// the loader refuses the whole process with STATUS_ENTRYPOINT_NOT_FOUND
/// (0xc0000139) before a single test runs. That is what stopped the
/// 26.3 release test run on Windows (2026-09-20); nothing native had
/// changed, only what the tests reach. Cargo offers no link-arg key
/// that reaches the lib's own harness and not the bin (-tests covers
/// integration tests only), so the manifest goes to all targets through
/// the linker, and Tauri's resource no longer carries one. The content
/// is Tauri's default manifest: the Common Controls 6 dependency that
/// gives the app themed controls and the task dialog. The lib test
/// the_test_executable_asks_for_common_controls_6 reads it back.
fn windows_manifest() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }
    let out_dir = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    let manifest = out_dir.join("heeler-windows.manifest");
    std::fs::write(&manifest, WINDOWS_MANIFEST).expect("write the Windows manifest into OUT_DIR");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    // No requestedExecutionLevel fragment from the linker: the manifest
    // is exactly the text below, as Tauri's was.
    println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
}

/// Tauri's default Windows application manifest, verbatim.
const WINDOWS_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;
