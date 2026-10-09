//! What this build calls itself: the version, whether it is a
//! pre-release, and the one-line build identity that goes into About and
//! the log.
//!
//! Its own module because `PRE_RELEASE` is edited by hand every release
//! and lived at line 12582 of a twenty-thousand-line lib.rs, which is
//! not somewhere anyone should have to find it (2026-09-13). The two
//! edits that cut a release are now the workspace Cargo.toml's
//! `version` and this file.

/// Heeler's versions are YEAR.UPDATE.PATCH, the way some desktop apps have
/// numbered themselves since 2024: a release is the year it shipped and the
/// update within that year, and a third number only when a patch is needed
/// (2026-09-02: "Map a version to the year its release, and the iteration within
/// the year"). There is no roadmap toward a version 2; the app is bought once
/// and updated.
///
/// The crate carries it as YY.UPDATE.PATCH, because a Windows MSI's
/// ProductVersion caps the major number at 255 and Cargo wants semver,
/// and 2026 fits neither. This turns 26.1.0 into "2026.1" and 26.1.2
/// into "2026.1.2": the century put back, and a zero patch left unsaid.
pub(crate) fn display_version_of(cargo: &str) -> String {
    let mut parts = cargo.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let yy = parts.next().unwrap_or(0);
    let update = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    let year = if yy < 100 { 2000 + yy } else { yy };
    if patch == 0 {
        format!("{year}.{update}")
    } else {
        format!("{year}.{update}.{patch}")
    }
}

/// The version as the app says it: About and the log.
pub(crate) fn display_version() -> String {
    display_version_of(env!("CARGO_PKG_VERSION"))
}

/// Whether this build calls itself a pre-release. The number does not
/// change before a release (the year scheme has no 0.x), so this is
/// what tells a tester's About and log apart from the
/// release: "2026.1 pre-release build 412 ".
///
/// The setting: what a build says when nothing overrules it. Left
/// false; the app is a released product (2026-09-15: "the app is
/// released").
pub(crate) const PRE_RELEASE_DEFAULT: bool = false;

/// The verdict for this build: the setting above, unless the build was
/// told otherwise. build.rs passes HEELER_PRE_RELEASE through from the
/// build's environment as "1", "0" or empty, and the build scripts set
/// it on --pre-release and --no-pre-release, so a tester bundle is
/// stamped on the fly (2026-09-15: "you can leave the setting in place
/// in the code for pre release, but it should be overwrite-able with a
/// flag... So I am not going back and forth changing a value").
pub(crate) const PRE_RELEASE: bool = resolve(env!("HEELER_PRE_RELEASE"), PRE_RELEASE_DEFAULT);

/// "1" overrules to on, "0" to off; anything else keeps the setting.
const fn resolve(s: &str, setting: bool) -> bool {
    match s.as_bytes() {
        b"1" => true,
        b"0" => false,
        _ => setting,
    }
}

/// What this binary is, precisely enough to answer a bug report or a
/// license email: the version people see, whether it is a pre-release,
/// then the commit count as the build number and the commit it was cut
/// from.
pub(crate) fn build_string() -> String {
    format!(
        "{}{} build {} ({})",
        display_version(),
        if PRE_RELEASE { " pre-release" } else { "" },
        env!("HEELER_BUILD_NUMBER"),
        env!("HEELER_BUILD_HASH")
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_flag_overrules_the_setting_either_way_and_only_when_given() {
        for setting in [false, true] {
            assert!(super::resolve("1", setting));
            assert!(!super::resolve("0", setting));
            assert_eq!(super::resolve("", setting), setting);
            assert_eq!(super::resolve("true", setting), setting);
            assert_eq!(super::resolve("11", setting), setting);
        }
    }

    /// A build made by hand (this test harness among them) carries no
    /// identity: the scripts stamp one, and nothing else does, so a
    /// commit no longer recompiles the crate in a dev app.
    #[test]
    fn a_hand_build_reads_dev_unless_the_scripts_stamped_it() {
        // The compile-time value, not the process's: cargo exports a
        // build script's variables into the test process too, so the
        // runtime environment says "dev" for a hand build as well.
        let s = super::build_string();
        if env!("HEELER_BUILD_NUMBER") == "dev" {
            assert!(s.ends_with("build dev (dev)"), "{s}");
        } else {
            // A stamped pair has a form, and the string ends with it:
            // the number all digits, the hash 7 to 40 hex characters
            // (the third pre-merge review's R6: comparing the string
            // with its own definition proved nothing).
            let (number, hash) = (env!("HEELER_BUILD_NUMBER"), env!("HEELER_BUILD_HASH"));
            assert!(!number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()), "number {number:?}");
            assert!((7..=40).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_hexdigit()), "hash {hash:?}");
            assert!(s.ends_with(&format!("build {number} ({hash})")), "{s}");
        }
    }

    /// The word follows the flag the build was given, and nothing else.
    #[test]
    fn the_build_string_says_pre_release_only_when_the_build_was_told() {
        let s = super::build_string();
        assert_eq!(s.contains(" pre-release "), super::PRE_RELEASE, "{s}");
    }
}

#[cfg(test)]
#[path = "../build_identity.rs"]
mod build_identity;

/// What About and the bundle report.
#[cfg(test)]
mod identity_tests {
    /// A bug email that does not say which build it came
    /// from starts with a round trip asking. The string carries the
    /// version, a build number, and the commit.
    #[test]
    fn the_build_string_names_version_and_commit() {
        let s = super::build_string();
        assert!(s.contains(&super::display_version()));
        assert!(s.contains(" build "));
        assert!(s.ends_with(')'), "the commit rides in parentheses: {s}");
    }

    /// The bundle's version and the binary's cannot disagree.
    ///
    /// They used to be written twice, in the workspace Cargo.toml and in
    /// tauri.conf.json, with nothing holding them together: a release
    /// that updated one and not the other would have shipped an
    /// installer named for one version while About reported another, and
    /// the update check compares About's version against the manifest.
    /// The config's `version` is removed instead, which Tauri documents
    /// as "if removed the version number from Cargo.toml is used", so
    /// there is one number and the drift cannot happen.
    ///
    /// This test holds that: the key stays absent, or if someone puts it
    /// back it must say what the crate says.
    #[test]
    fn the_bundle_version_is_the_crate_version() {
        let conf = include_str!("../tauri.conf.json");
        let v: serde_json::Value = serde_json::from_str(conf).expect("tauri.conf.json parses");
        match v.get("version") {
            None => {} // Cargo.toml is the only source, which is the point.
            Some(declared) => assert_eq!(
                declared.as_str(),
                Some(env!("CARGO_PKG_VERSION")),
                "tauri.conf.json declares a version that is not the crate's; \
                 either delete it and let Cargo.toml be the one source, or \
                 make the two agree"
            ),
        }
    }

    /// YEAR.UPDATE.PATCH as people read it, from the YY.UPDATE.PATCH the
    /// crate carries for the installers' sake.
    #[test]
    fn the_version_reads_as_year_update_patch() {
        assert_eq!(super::display_version_of("26.1.0"), "2026.1");
        assert_eq!(super::display_version_of("26.1.2"), "2026.1.2");
        assert_eq!(super::display_version_of("27.3.0"), "2027.3");
        assert!(super::display_version().starts_with("20"));
        // Before the release, every build says so.
        if super::PRE_RELEASE {
            assert!(super::build_string().contains(" pre-release build "));
        }
    }
}
