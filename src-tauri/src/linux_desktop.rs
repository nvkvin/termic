//! Desktop integration for the Linux AppImage: a menu entry, an icon, and the
//! `termic://` scheme handler.
//!
//! An AppImage is one executable file and nothing else. Running it registers
//! nothing, so out of the box Termic has no launcher entry, no icon anywhere,
//! and, the part that is an actual broken feature rather than a missing
//! convenience, no `termic://` handler. macOS and Windows get the scheme from
//! the bundle and the installer; an AppImage has no install step, so on Linux
//! nothing ever writes `x-scheme-handler/termic` and a deep link has nowhere
//! to go.
//!
//! What integration means is two files in the user's own home, per the XDG
//! desktop-entry spec:
//!
//!   ~/.local/share/applications/<id>.desktop
//!   ~/.local/share/icons/hicolor/256x256/apps/<id>.png
//!
//! That is the same pair on GNOME, KDE, XFCE and Cinnamon. The genuine
//! per-distro variance is only whether `update-desktop-database` and
//! `gtk-update-icon-cache` exist to refresh the caches, and how fast the menu
//! notices. Both are best-effort here: a missing binary is not a failure,
//! because the entry is already written and every desktop picks it up
//! eventually.
//!
//! NOT moving the AppImage. Linux will happily move a running executable, but
//! then `Exec=` has to be rewritten to match and the user's file has been
//! relocated behind their back. AppImageLauncher already owns that behaviour
//! for people who want it, and this has to coexist with it rather than fight
//! it: `X-AppImage-Integrate=false` tells it we have already done this one.

use std::path::{Path, PathBuf};

/// Whether integration is possible here, and whether it is already done.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DesktopStatus {
    /// True only for a Linux AppImage run. Everywhere else the whole feature
    /// is hidden rather than offered and refused.
    pub available: bool,
    pub integrated: bool,
    /// The running AppImage, from `$APPIMAGE`. Empty when not one.
    pub appimage_path: String,
    /// Where the entry goes, so the UI can name it instead of describing it.
    pub desktop_path: String,
}

/// The `$APPIMAGE` the runtime exports, if this is one.
///
/// This is the whole availability test. An AppImage's runtime sets it to the
/// absolute path of the file the user launched; a `cargo run` build, a `.deb`
/// install and a dev server all leave it unset, and none of them should be
/// offered this.
pub fn appimage_path() -> Option<PathBuf> {
    // The one platform gate in this module. Everything else here is plain std
    // and compiles anywhere ON PURPOSE: gating the whole file meant the format
    // tests below never ran on a Mac, which is where they are written and
    // where a broken `Exec=` would be introduced.
    if !cfg!(target_os = "linux") { return None; }
    let raw = std::env::var_os("APPIMAGE")?;
    let p = PathBuf::from(raw);
    // Absolute and real, or the Exec= line we write points at nothing. An
    // AppImage that has been moved or deleted since launch is the case.
    if !p.is_absolute() || !p.exists() { return None; }
    Some(p)
}

fn data_home() -> Option<PathBuf> {
    if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
        let p = PathBuf::from(x);
        if p.is_absolute() { return Some(p); }
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
}

pub fn desktop_file_path(id: &str) -> Option<PathBuf> {
    Some(data_home()?.join("applications").join(format!("{id}.desktop")))
}

pub fn icon_file_path(id: &str) -> Option<PathBuf> {
    Some(data_home()?.join("icons/hicolor/256x256/apps").join(format!("{id}.png")))
}

/// Quote a path for a desktop entry's `Exec=`.
///
/// The spec's own rules, not shell rules: a field containing a reserved
/// character is double-quoted, and inside those quotes backslash and
/// double-quote are backslash-escaped. Left alone when it needs nothing, so
/// the common case reads as a plain path. A home directory with a space in it
/// is the ordinary case this exists for, not a hypothetical.
pub fn quote_exec(path: &str) -> String {
    let needs = path.chars().any(|c| " \t\n\"'\\><~|&;$*?#()`".contains(c));
    if !needs { return path.to_string(); }
    let mut out = String::with_capacity(path.len() + 2);
    out.push('"');
    for c in path.chars() {
        if c == '"' || c == '\\' { out.push('\\'); }
        out.push(c);
    }
    out.push('"');
    out
}

/// The desktop entry's contents.
///
/// Pure, because the format is the part worth pinning: a missing
/// `MimeType` line silently costs deep links, and a wrong `Exec` costs the
/// launcher entirely, and neither shows up as an error anywhere.
pub fn desktop_entry(id: &str, name: &str, exec: &str, scheme: &str) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={name}\n\
         Comment=One window, many parallel coding agents\n\
         Exec={exec} %u\n\
         Icon={id}\n\
         Terminal=false\n\
         Categories=Development;Utility;\n\
         MimeType=x-scheme-handler/{scheme};\n\
         StartupWMClass={name}\n\
         X-AppImage-Integrate=false\n",
        exec = quote_exec(exec),
    )
}

/// Best-effort cache refreshes. A distro without these still shows the entry,
/// just not always immediately, so a failure here is never the caller's
/// problem and is deliberately not reported as one.
fn refresh_caches(apps_dir: &Path, icons_root: &Path, id: &str, scheme: &str) {
    let run = |prog: &str, args: &[&str]| {
        // proc_ctl::command, not Command::new: these are the HOST's tools and
        // must not load the AppImage's libraries (appimage_env.rs).
        let _ = crate::proc_ctl::command(prog)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    };
    run("update-desktop-database", &[&apps_dir.to_string_lossy()]);
    run("gtk-update-icon-cache", &["-f", "-t", &icons_root.to_string_lossy()]);
    // Make us the handler for the scheme. Writing MimeType= only advertises
    // that we CAN open it; this is what picks us when several could.
    run("xdg-mime", &["default", &format!("{id}.desktop"), &format!("x-scheme-handler/{scheme}")]);
}

pub fn status(id: &str) -> DesktopStatus {
    let img = appimage_path();
    let desktop = desktop_file_path(id);
    DesktopStatus {
        available: img.is_some(),
        // Read from disk rather than remembered in a pref: the user can delete
        // the file, or another tool can write one, and a pref would then be a
        // claim about the system that the system disagrees with.
        integrated: desktop.as_deref().map(Path::exists).unwrap_or(false),
        appimage_path: img.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        desktop_path: desktop.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

/// Write the entry and the icon. Idempotent: running it again overwrites, so
/// an AppImage that moved is repaired by integrating again.
pub fn integrate(id: &str, name: &str, scheme: &str) -> Result<DesktopStatus, String> {
    let img = appimage_path().ok_or("not running as an AppImage")?;
    let desktop = desktop_file_path(id).ok_or("no XDG data directory")?;
    let icon = icon_file_path(id).ok_or("no XDG data directory")?;
    let apps_dir = desktop.parent().ok_or("bad applications path")?.to_path_buf();
    let icons_root = data_home().ok_or("no XDG data directory")?.join("icons");

    std::fs::create_dir_all(&apps_dir).map_err(|e| format!("{}: {e}", apps_dir.display()))?;
    let body = desktop_entry(id, name, &img.to_string_lossy(), scheme);
    std::fs::write(&desktop, body).map_err(|e| format!("{}: {e}", desktop.display()))?;

    // The icon comes from the running AppDir. Missing is not fatal: an entry
    // with a generic icon still launches and still handles the scheme, and
    // failing the whole thing over a picture would be the wrong trade.
    if let Some(src) = appdir_icon() {
        if let Some(parent) = icon.parent() {
            let _ = std::fs::create_dir_all(parent);
            let _ = std::fs::copy(&src, &icon);
        }
    }
    refresh_caches(&apps_dir, &icons_root, id, scheme);
    Ok(status(id))
}

/// The icon inside the mounted AppDir. `.DirIcon` is the one every
/// integration tool reads, and it is a symlink to the real file.
fn appdir_icon() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("APPDIR")?);
    for cand in [".DirIcon", "termic.png"] {
        let p = dir.join(cand);
        if p.exists() { return Some(p); }
    }
    None
}

/// Remove what `integrate` wrote. Missing files are a success: the caller
/// asked for them to be gone.
pub fn remove(id: &str) -> Result<DesktopStatus, String> {
    if let Some(p) = desktop_file_path(id) {
        if p.exists() { std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?; }
    }
    if let Some(p) = icon_file_path(id) {
        let _ = std::fs::remove_file(p);
    }
    if let (Some(d), Some(root)) = (desktop_file_path(id), data_home()) {
        if let Some(apps) = d.parent() {
            refresh_caches(apps, &root.join("icons"), id, "termic");
        }
    }
    Ok(status(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_carries_the_scheme_handler() {
        // The line that makes `termic://` work at all. Without it the entry is
        // a launcher icon and deep links still go nowhere, which is the bug
        // this whole module exists for.
        let e = desktop_entry("termic", "Termic", "/home/alice/Apps/Termic.AppImage", "termic");
        assert!(e.contains("MimeType=x-scheme-handler/termic;"), "{e}");
        // %u, or the URL is never passed to the process we launch.
        assert!(e.contains("Exec=/home/alice/Apps/Termic.AppImage %u"), "{e}");
    }

    #[test]
    fn it_tells_appimagelauncher_to_leave_it_alone() {
        // Coexistence, not competition: without this the user gets two entries
        // the moment AppImageLauncher notices the file.
        let e = desktop_entry("termic", "Termic", "/a/b.AppImage", "termic");
        assert!(e.contains("X-AppImage-Integrate=false"), "{e}");
    }

    #[test]
    fn a_path_with_spaces_is_quoted_the_way_the_spec_says() {
        // "~/My Apps/" is ordinary, and an unquoted Exec would silently launch
        // nothing.
        let e = desktop_entry("termic", "Termic", "/home/alice/My Apps/Termic.AppImage", "termic");
        assert!(e.contains(r#"Exec="/home/alice/My Apps/Termic.AppImage" %u"#), "{e}");
    }

    #[test]
    fn quoting_escapes_what_the_spec_requires_and_nothing_else() {
        assert_eq!(quote_exec("/plain/path"), "/plain/path");
        assert_eq!(quote_exec("/with space"), "\"/with space\"");
        assert_eq!(quote_exec(r#"/odd"name"#), "\"/odd\\\"name\"");
        assert_eq!(quote_exec(r"/back\slash"), "\"/back\\\\slash\"");
        // A dollar in a path must not reach the launcher as an expansion.
        assert_eq!(quote_exec("/has$var"), "\"/has$var\"");
    }

    #[test]
    fn the_entry_is_a_valid_desktop_file_shape() {
        let e = desktop_entry("termic", "Termic", "/a/b.AppImage", "termic");
        assert!(e.starts_with("[Desktop Entry]\n"));
        assert!(e.ends_with('\n'), "desktop files end with a newline");
        for key in ["Type=Application", "Name=Termic", "Icon=termic", "Terminal=false"] {
            assert!(e.contains(key), "missing {key} in {e}");
        }
    }

    #[test]
    fn not_an_appimage_means_unavailable_rather_than_broken() {
        // A dev build, a .deb, a cargo run: the feature is hidden, not offered
        // and then refused.
        temp_env_absent("APPIMAGE", || {
            let s = status("termic");
            assert!(!s.available);
            assert_eq!(s.appimage_path, "");
        });
    }

    #[test]
    fn a_stale_appimage_path_does_not_count_as_one() {
        // $APPIMAGE pointing at a file that is gone would write an Exec= line
        // that launches nothing.
        temp_env_set("APPIMAGE", "/definitely/not/here/Termic.AppImage", || {
            assert!(appimage_path().is_none());
        });
    }

    /// The requirement in one test: this appears on Linux and nowhere else.
    ///
    /// `$APPIMAGE` is just an environment variable, so a parent process can
    /// set it on any OS, and the availability check must not be "is this
    /// variable present". Points at a file that really exists, so the only
    /// thing left refusing it is the target.
    #[test]
    #[cfg(not(target_os = "linux"))]
    fn a_non_linux_build_is_unavailable_even_with_appimage_set() {
        let real = std::env::current_exe().expect("test binary has a path");
        temp_env_set("APPIMAGE", &real.to_string_lossy(), || {
            assert!(appimage_path().is_none(), "macOS/Windows must never offer this");
            let st = status("termic");
            assert!(!st.available);
            assert_eq!(st.appimage_path, "");
        });
    }

    /// And the mirror, so the gate is pinned from both sides: on Linux the
    /// same conditions DO make it available. Without this the test above is
    /// satisfied by a function that always returns None.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_linux_build_with_a_real_appimage_is_available() {
        let real = std::env::current_exe().expect("test binary has a path");
        temp_env_set("APPIMAGE", &real.to_string_lossy(), || {
            assert_eq!(appimage_path().as_deref(), Some(real.as_path()));
            assert!(status("termic").available);
        });
    }

    #[test]
    fn a_relative_appimage_path_is_refused() {
        temp_env_set("APPIMAGE", "Termic.AppImage", || {
            assert!(appimage_path().is_none());
        });
    }

    /// Serializes every test that touches `$APPIMAGE`.
    ///
    /// The environment is PROCESS-wide and cargo runs tests in threads. Without
    /// this, one test's `remove_var` landed between another's two reads: on
    /// Linux CI the "real AppImage" case saw the path and then, one line
    /// later, saw nothing, roughly one run in three.
    static APPIMAGE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn temp_env_set(key: &str, val: &str, f: impl FnOnce()) {
        // LOCK FIRST, then read what we are replacing (see
        // `test_support::with_scratch_data_dir` for what the other order costs).
        let _g = APPIMAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let old = std::env::var_os(key);
        unsafe { std::env::set_var(key, val) };
        f();
        match old {
            Some(v) => unsafe { std::env::set_var(key, v) },
            None => unsafe { std::env::remove_var(key) },
        }
    }

    fn temp_env_absent(key: &str, f: impl FnOnce()) {
        let _g = APPIMAGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let old = std::env::var_os(key);
        unsafe { std::env::remove_var(key) };
        f();
        if let Some(v) = old { unsafe { std::env::set_var(key, v) } }
    }
}
