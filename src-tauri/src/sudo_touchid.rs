//! Offer to enable Touch ID for sudo when a terminal is sitting at a sudo
//! password prompt. Modelled on iTerm2 3.7's offer, including how it gets
//! root: there is none of our own. The bundled script re-execs itself under
//! `sudo` in a terminal tab the user can see, so the password goes to sudo
//! and the change is a PAM line anyone can read in `/etc/pam.d/sudo_local`.
//!
//! Detection does not match prompt text (sudo's prompt is configurable and
//! localised). It asks the tty: echo off with line mode on is "reading a
//! password", and the foreground process group leader named `sudo` says who
//! is reading it. Both are one syscall on the PTY master.
//!
//! AppleScript `with administrator privileges` is deliberately not used:
//! iTerm2 shipped that first and pulled it because writing under
//! `/etc/pam.d/` that way fails with EPERM on macOS 26.

use std::sync::atomic::{AtomicBool, Ordering};

/// The user's "Don't ask again", mirrored from the frontend pref so an
/// opted-out user pays no syscall per small read. Defaults on: a prompt in
/// the first moments before the pref lands just shows one offer the
/// frontend then drops.
static OFFER_ENABLED: AtomicBool = AtomicBool::new(true);

/// A read bigger than this is output, not a prompt. Checked before any
/// syscall so bulk output (a build log, `cat`) never touches the tty.
// The watcher is macOS only; the pure helpers below stay compiled on every
// platform so their tests run where they are written, hence the allows.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const PROMPT_READ_MAX: usize = 512;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SUDO_PAM: &str = "/etc/pam.d/sudo";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SUDO_LOCAL: &str = "/etc/pam.d/sudo_local";
const SCRIPT_BODY: &str = include_str!("enable-touchid-sudo.sh");

/// E2E seam (`e2e`-feature binary only, set by wdio.conf.ts). A real sudo
/// prompt can't be scripted and no CI runner has a Touch ID sensor, so the
/// suite stands `perl` in for sudo and skips the eligibility probe. The
/// detection itself (termios, foreground pgrp, the event) stays real. The
/// script becomes a stub: GitHub's macOS runners have passwordless sudo, and
/// a spec that clicked Run would otherwise really edit /etc/pam.d.
#[cfg(feature = "e2e")]
fn e2e_fake() -> bool {
    std::env::var_os("TERMIC_E2E_FAKE_SUDO").is_some()
}
#[cfg(not(feature = "e2e"))]
fn e2e_fake() -> bool {
    false
}
const E2E_STUB_SCRIPT: &str = "#!/bin/sh\necho termic-e2e-touchid-stub\n";

#[derive(Clone, serde::Serialize)]
pub struct SudoOffer {
    pub show: bool,
}

/// True when a non-comment line of `sudo_local` loads `pam_tid.so`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn pam_tid_enabled(sudo_local: &str) -> bool {
    sudo_local
        .lines()
        .map(str::trim)
        .any(|l| !l.starts_with('#') && l.contains("pam_tid.so"))
}

/// True when `/etc/pam.d/sudo` includes `sudo_local` (macOS 14+). On older
/// systems the script would write a file nothing reads.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn sudo_local_included(sudo_pam: &str) -> bool {
    sudo_pam
        .lines()
        .map(str::trim)
        .any(|l| !l.starts_with('#') && l.contains("sudo_local"))
}

/// Echo off + canonical mode: what `readpassphrase` and sudo's own
/// `tgetpass` set. Raw-mode TUIs (vim, agent CLIs) clear ICANON too, so
/// they never qualify.
#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn is_password_mode(lflag: libc::tcflag_t) -> bool {
    lflag & libc::ECHO == 0 && lflag & libc::ICANON != 0
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::os::unix::io::RawFd;

    /// Per-PTY detector, owned by the PTY's reader thread.
    pub struct SudoWatch {
        /// A `dup` of the master: the slot's own fd is closed when the slot
        /// drops, possibly while this thread is still draining, and a
        /// recycled fd number would then point at somebody else's file.
        fd: RawFd,
        offered: bool,
    }

    impl SudoWatch {
        pub fn new(master_fd: RawFd) -> Option<Self> {
            let fd = unsafe { libc::dup(master_fd) };
            (fd >= 0).then_some(SudoWatch { fd, offered: false })
        }

        /// Called after every read. Returns the new offer state when it
        /// flips, `None` otherwise. Costs nothing for large reads and, once
        /// the user opted out, nothing at all.
        pub fn on_read(&mut self, n: usize) -> Option<bool> {
            if self.offered {
                // Withdrawn when sudo is no longer the foreground job, as
                // iTerm2 does. Any output (the shell's next prompt) gets here.
                if self.foreground_is_sudo() {
                    return None;
                }
                self.offered = false;
                return Some(false);
            }
            if n > PROMPT_READ_MAX || !OFFER_ENABLED.load(Ordering::Relaxed) {
                return None;
            }
            if !self.password_mode() || !self.foreground_is_sudo() {
                return None;
            }
            if !eligible() {
                return None;
            }
            self.offered = true;
            Some(true)
        }

        pub(super) fn password_mode(&self) -> bool {
            let mut t: libc::termios = unsafe { std::mem::zeroed() };
            unsafe { libc::tcgetattr(self.fd, &mut t) == 0 && is_password_mode(t.c_lflag) }
        }

        pub(super) fn foreground_is_sudo(&self) -> bool {
            let pgrp = unsafe { libc::tcgetpgrp(self.fd) };
            if pgrp <= 0 {
                return false;
            }
            match process_name(pgrp) {
                Some(name) => name == "sudo" || (e2e_fake() && name == "perl"),
                None => false,
            }
        }
    }

    /// `struct proc_bsdshortinfo` from <sys/proc_info.h>, which the libc
    /// crate does not declare.
    #[repr(C)]
    struct ProcBsdShortInfo {
        pid: u32,
        ppid: u32,
        pgid: u32,
        status: u32,
        comm: [u8; 16], // MAXCOMLEN, not NUL-terminated when full
        flags: u32,
        uid: u32,
        gid: u32,
        ruid: u32,
        rgid: u32,
        svuid: u32,
        svgid: u32,
        rfu: u32,
    }
    const PROC_PIDT_SHORTBSDINFO: libc::c_int = 13;

    /// A process's executable name, for ANY user's process.
    ///
    /// Not `proc_name`: that goes through PROC_PIDTBSDINFO, which is refused
    /// with EPERM for a process of another user, and sudo is setuid root. It
    /// passed a test against a user-owned stand-in and then never matched the
    /// real sudo. The short info flavour is what `ps` can read for everyone.
    pub(super) fn process_name(pid: libc::pid_t) -> Option<String> {
        let mut info: ProcBsdShortInfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<ProcBsdShortInfo>() as libc::c_int;
        let n = unsafe {
            libc::proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, (&mut info as *mut ProcBsdShortInfo).cast(), size)
        };
        if n != size {
            return None;
        }
        let end = info.comm.iter().position(|&b| b == 0).unwrap_or(info.comm.len());
        Some(String::from_utf8_lossy(&info.comm[..end]).into_owned())
    }

    impl Drop for SudoWatch {
        fn drop(&mut self) {
            unsafe { libc::close(self.fd) };
        }
    }

    /// The expensive checks, run once per sudo prompt rather than per read.
    fn eligible() -> bool {
        if e2e_fake() {
            return true;
        }
        let included = std::fs::read_to_string(SUDO_PAM)
            .map(|s| sudo_local_included(&s))
            .unwrap_or(false);
        // Missing or unreadable sudo_local is "not enabled".
        let enabled = std::fs::read_to_string(SUDO_LOCAL)
            .map(|s| pam_tid_enabled(&s))
            .unwrap_or(false);
        included && !enabled && touch_id_available()
    }

    #[link(name = "LocalAuthentication", kind = "framework")]
    extern "C" {}

    /// `LAContext.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)`.
    /// False on a Mac with no sensor, with the lid closed and no Touch ID
    /// keyboard, or with no finger enrolled: every case where pam_tid would
    /// just fall through to the password anyway.
    pub fn touch_id_available() -> bool {
        use objc2::rc::{autoreleasepool, Retained};
        use objc2::runtime::{AnyClass, AnyObject, Bool};
        use objc2::msg_send;
        autoreleasepool(|_| {
            let Some(cls) = AnyClass::get(c"LAContext") else { return false };
            let ctx: Option<Retained<AnyObject>> = unsafe { msg_send![cls, new] };
            let Some(ctx) = ctx else { return false };
            // LAPolicyDeviceOwnerAuthenticationWithBiometrics
            const BIOMETRICS: isize = 1;
            let err: *mut *mut AnyObject = std::ptr::null_mut();
            let ok: Bool = unsafe { msg_send![&*ctx, canEvaluatePolicy: BIOMETRICS, error: err] };
            ok.as_bool()
        })
    }
}

#[cfg(target_os = "macos")]
pub use imp::SudoWatch;

/// Stub so the reader thread has one code path on every platform.
#[cfg(not(target_os = "macos"))]
pub struct SudoWatch;

#[cfg(not(target_os = "macos"))]
impl SudoWatch {
    pub fn on_read(&mut self, _n: usize) -> Option<bool> {
        None
    }
}

#[tauri::command]
pub fn sudo_touchid_set_offer(enabled: bool) {
    OFFER_ENABLED.store(enabled, Ordering::Relaxed);
}

#[derive(serde::Serialize)]
pub struct SudoTouchIdScript {
    /// Absolute path of the script. Run it as is: it re-execs under sudo.
    pub path: String,
    /// What "Copy command" puts on the clipboard.
    pub command: String,
}

/// Write the bundled script to `<global_dir>/bin/` and return where it is.
/// Rewritten on every call, so what runs is always what this build ships.
#[tauri::command]
pub async fn sudo_touchid_script() -> Result<SudoTouchIdScript, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dir = crate::global_dir().map_err(|e| e.to_string())?.join("bin");
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let path = dir.join("enable-touchid-sudo.sh");
        std::fs::write(&path, if e2e_fake() { E2E_STUB_SCRIPT } else { SCRIPT_BODY }).map_err(|e| format!("write {}: {e}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("chmod {}: {e}", path.display()))?;
        }
        let path = path.to_string_lossy().into_owned();
        let command = format!("sudo {}", shell_quote(&path));
        Ok(SudoTouchIdScript { path, command })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stock_template_is_not_enabled() {
        let template = "# sudo_local: local config file which survives system update and is included for sudo\n\
                        # uncomment following line to enable Touch ID for sudo\n\
                        #auth       sufficient     pam_tid.so\n";
        assert!(!pam_tid_enabled(template));
        assert!(!pam_tid_enabled(""));
    }

    #[test]
    fn uncommented_line_is_enabled() {
        assert!(pam_tid_enabled("auth       sufficient     pam_tid.so\n"));
        // pam_reattach goes above it; still enabled.
        assert!(pam_tid_enabled(
            "auth optional /opt/homebrew/lib/pam/pam_reattach.so\n  auth sufficient pam_tid.so\n"
        ));
        assert!(!pam_tid_enabled("   # auth sufficient pam_tid.so\n"));
    }

    #[test]
    fn sudo_local_include_detected() {
        let sonoma = "# sudo: auth account password session\n\
                      auth       include        sudo_local\n\
                      auth       sufficient     pam_smartcard.so\n";
        assert!(sudo_local_included(sonoma));
        let ventura = "# sudo: auth account password session\n\
                       auth       sufficient     pam_smartcard.so\n\
                       auth       required       pam_opendirectory.so\n";
        assert!(!sudo_local_included(ventura));
    }

    #[cfg(unix)]
    #[test]
    fn password_mode_needs_echo_off_and_canonical() {
        let canon = libc::ICANON | libc::ISIG;
        assert!(is_password_mode(canon));
        assert!(!is_password_mode(canon | libc::ECHO), "a normal shell prompt echoes");
        assert!(!is_password_mode(libc::ISIG), "raw mode TUIs are not password prompts");
    }

    /// The detector's two tty probes against a real PTY master. The fake
    /// `sudo` is a small compiled program,
    /// so the test never touches the real sudo or raises a Touch ID sheet.
    #[cfg(target_os = "macos")]
    #[test]
    fn probes_read_the_slave_state_through_the_master() {
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
        use std::time::{Duration, Instant};
        let dir = std::env::temp_dir().join(format!("termic-sudo-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("sudo");
        // Compiled, not copied or linked: proc_name reports the real
        // executable's name (a symlink to bash reads "bash"), and a copied
        // arm64e platform binary is SIGKILLed on launch. Echo on for a
        // second, then off the way a password read does.
        let src = "#include <termios.h>\n#include <unistd.h>\n\
                   int main(void){struct termios t;sleep(1);tcgetattr(0,&t);\
                   t.c_lflag&=~ECHO;tcsetattr(0,TCSANOW,&t);sleep(30);return 0;}";
        std::fs::write(dir.join("sudo.c"), src).unwrap();
        let cc = std::process::Command::new("cc")
            .arg(dir.join("sudo.c")).arg("-o").arg(&fake).output().unwrap();
        assert!(cc.status.success(), "{}", String::from_utf8_lossy(&cc.stderr));

        let pair = NativePtySystem::default()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut child = pair.slave.spawn_command(CommandBuilder::new(&fake)).unwrap();
        let watch = SudoWatch::new(pair.master.as_raw_fd().unwrap()).unwrap();

        let wait = |f: &dyn Fn() -> bool| {
            let t = Instant::now();
            while !f() {
                assert!(t.elapsed() < Duration::from_secs(10), "timed out");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        wait(&|| watch.foreground_is_sudo());
        assert!(!watch.password_mode(), "echo is still on");
        wait(&|| watch.password_mode());

        child.kill().ok();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The real sudo is setuid root, and `proc_name` is refused (EPERM) for
    /// another user's process, so a lookup that only works on our own
    /// processes never matched it. launchd is root-owned on every Mac.
    #[cfg(target_os = "macos")]
    #[test]
    fn names_a_root_owned_process() {
        assert_eq!(imp::process_name(1).as_deref(), Some("launchd"));
        assert_eq!(imp::process_name(-1), None);
    }

    /// Its value depends on the machine (a CI runner has no sensor); what
    /// this pins is that the hand-written message send matches LAContext's
    /// signature, which objc2 verifies in debug builds.
    #[cfg(target_os = "macos")]
    #[test]
    fn touch_id_probe_matches_lacontext_signature() {
        let _ = imp::touch_id_available();
    }

    #[test]
    fn copy_command_survives_spaces_and_quotes() {
        assert_eq!(
            shell_quote("/Users/u/Library/Application Support/termic/bin/x.sh"),
            "'/Users/u/Library/Application Support/termic/bin/x.sh'"
        );
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
    }
}
