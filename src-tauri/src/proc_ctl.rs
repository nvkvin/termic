//! Process signalling, one API over two process models.
//!
//! Unix: children the app spawns with `new_group` lead their own process
//! group, and `signal_group(pgid)` is `kill(-pgid, sig)`, so a language
//! server's `cargo check` or a run script's dev server dies with its
//! leader. `signal_pid` is a plain `kill(pid, sig)`.
//!
//! Windows has no process groups in that sense (CREATE_NEW_PROCESS_GROUP
//! only scopes console Ctrl events). The equivalent here is a tree kill:
//! snapshot the process table, collect every descendant of the root by
//! parent pid, and TerminateProcess each one, children first. There is
//! no graceful SIGTERM for console programs either, so `Sig::Term` is
//! forceful on Windows; the callers that wait for a graceful exit (the
//! run-script port release, the transcript flush before archive) just
//! see the process gone sooner. A PTY child is tree-killed too: its
//! leader is often `cmd.exe` running an npm `.cmd` shim, and killing
//! only the shim would leave `node.exe` holding the worktree open, which
//! blocks archive from deleting it.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sig {
    Term,
    Kill,
}

/// Signal one process.
pub fn signal_pid(pid: i32, sig: Sig) {
    imp::signal_pid(pid, sig)
}

/// Signal a process group (unix) or a process tree (Windows) led by
/// `pgid`. The child must have been spawned through `new_group`.
pub fn signal_group(pgid: i32, sig: Sig) {
    imp::signal_group(pgid, sig)
}

/// Whether `pid` is still running (a probe, sends nothing).
pub fn pid_alive(pid: i32) -> bool {
    imp::pid_alive(pid)
}

/// Whether any member of the group led by `pgid` is still running. On
/// Windows this is the leader only.
pub fn group_alive(pgid: i32) -> bool {
    imp::group_alive(pgid)
}

/// Make `cmd`'s child lead its own group, so `signal_group` reaches its
/// descendants. On Windows it also suppresses the console window a GUI
/// app's console child would otherwise flash.
pub fn new_group(cmd: &mut std::process::Command) -> &mut std::process::Command {
    imp::new_group(cmd)
}

/// Keep a background console program from flashing a console window.
/// A no-op off Windows. Every `Command` the app runs for its own
/// purposes (git, gh, rg, docker, LSPs) goes through this or
/// `new_group`; a PTY child does not need it (ConPTY owns its console).
pub fn hide_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    imp::hide_console(cmd)
}

#[cfg(unix)]
mod imp {
    use super::Sig;

    fn raw(sig: Sig) -> libc::c_int {
        match sig {
            Sig::Term => libc::SIGTERM,
            Sig::Kill => libc::SIGKILL,
        }
    }

    pub fn signal_pid(pid: i32, sig: Sig) {
        // SAFETY: kill(2) takes plain ints; a stale pid just fails.
        unsafe { libc::kill(pid, raw(sig)) };
    }

    pub fn signal_group(pgid: i32, sig: Sig) {
        // SAFETY: as above; a negative pid addresses the process group.
        unsafe { libc::kill(-pgid, raw(sig)) };
    }

    pub fn pid_alive(pid: i32) -> bool {
        // kill(pid, 0) probes without signalling; a reaped pid is ESRCH.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    pub fn group_alive(pgid: i32) -> bool {
        unsafe { libc::kill(-pgid, 0) == 0 }
    }

    pub fn new_group(cmd: &mut std::process::Command) -> &mut std::process::Command {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0)
    }

    pub fn hide_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
        cmd
    }
}

#[cfg(windows)]
mod imp {
    use super::Sig;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, STILL_ACTIVE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE,
    };

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    fn terminate(pid: u32) {
        // SAFETY: plain Win32 calls; a stale pid just fails to open.
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !h.is_null() {
                TerminateProcess(h, 1);
                CloseHandle(h);
            }
        }
    }

    /// Every (pid, parent pid) pair in the process table.
    fn process_table() -> Vec<(u32, u32)> {
        let mut out = Vec::new();
        // SAFETY: standard ToolHelp snapshot walk over a zeroed entry
        // whose dwSize is set as the API requires.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return out;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut e) != 0 {
                loop {
                    out.push((e.th32ProcessID, e.th32ParentProcessID));
                    if Process32NextW(snap, &mut e) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
        }
        out
    }

    /// Process creation time (FILETIME ticks), or None if the process is
    /// gone or not ours to query.
    fn created(pid: u32) -> Option<u64> {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::GetProcessTimes;
        // SAFETY: query-only handle, closed before return; FILETIMEs are
        // plain out-params.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let z = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut c, mut e, mut k, mut u) = (z, z, z, z);
            let ok = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0;
            CloseHandle(h);
            ok.then(|| ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
        }
    }

    /// The root and all its descendants, deepest first.
    ///
    /// Windows never updates a process's parent pid when the parent dies,
    /// and it reuses pids. So an unrelated orphan whose long-dead parent
    /// happened to hold one of these pids would look like a child. A real
    /// child is created after its parent, so anything created earlier than
    /// the pid it claims as parent is not adopted. `created` is injected
    /// so the ordering logic is testable without real processes.
    pub(super) fn tree(
        root: u32,
        table: &[(u32, u32)],
        created: &dyn Fn(u32) -> Option<u64>,
    ) -> Vec<u32> {
        let mut order = vec![root];
        let mut i = 0;
        while i < order.len() {
            let parent = order[i];
            let parent_born = created(parent);
            for &(pid, ppid) in table {
                if ppid != parent || pid == 0 || order.contains(&pid) {
                    continue;
                }
                let adopt = match (parent_born, created(pid)) {
                    (Some(p), Some(c)) => c >= p,
                    // Cannot tell (the process exited meanwhile, or is not
                    // queryable): leave it alone rather than risk a stranger.
                    _ => false,
                };
                if adopt {
                    order.push(pid);
                }
            }
            i += 1;
        }
        order.reverse();
        order
    }

    pub fn signal_pid(pid: i32, _sig: Sig) {
        // Tree kill even for a single pid: see the module doc.
        signal_group(pid, Sig::Kill)
    }

    pub fn signal_group(pgid: i32, _sig: Sig) {
        if pgid <= 0 {
            return;
        }
        for pid in tree(pgid as u32, &process_table(), &created) {
            terminate(pid);
        }
    }

    pub fn pid_alive(pid: i32) -> bool {
        if pid <= 0 {
            return false;
        }
        // SAFETY: query-only handle, closed before return.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
            if h.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code) != 0;
            CloseHandle(h);
            ok && code == STILL_ACTIVE as u32
        }
    }

    pub fn group_alive(pgid: i32) -> bool {
        pid_alive(pgid)
    }

    pub fn new_group(cmd: &mut std::process::Command) -> &mut std::process::Command {
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
    }

    pub fn hide_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
        cmd.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn tree_orders_descendants_first_and_skips_stale_parent_pids() {
        // 10 -> 11 -> 13, 10 -> 12; 20 is unrelated. 14 claims 10 as its
        // parent but was created BEFORE 10: a reused pid, not a child.
        let table = [(10, 1), (11, 10), (12, 10), (13, 11), (20, 1), (14, 10)];
        let born = |p: u32| Some(match p { 14 => 1, 10 => 5, _ => 9 });
        let t = super::imp::tree(10, &table, &born);
        assert_eq!(*t.last().unwrap(), 10);
        let pos = |p| t.iter().position(|&x| x == p).unwrap();
        assert!(pos(13) < pos(11));
        assert!(t.contains(&12));
        assert!(!t.contains(&20));
        assert!(!t.contains(&14));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn group_kill_reaches_the_leader_and_reports_it_gone() {
        let mut cmd = std::process::Command::new("sleep");
        cmd.arg("30");
        new_group(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let pid = child.id() as i32;
        assert!(pid_alive(pid));
        signal_group(pid, Sig::Kill);
        child.wait().unwrap();
        assert!(!pid_alive(pid));
    }
}

/// Method-chain form of `new_group`, for builder chains
/// like `Command::new(x).stdout(..).new_group().spawn()`.
pub trait CommandProcExt {
    fn new_group(&mut self) -> &mut Self;
}

impl CommandProcExt for std::process::Command {
    fn new_group(&mut self) -> &mut Self {
        new_group(self)
    }
}

/// `Command::new` for the app's own background work (git, gh, rg, docker,
/// language servers, scripts): identical off Windows, and on Windows it
/// never flashes a console window. Release builds are GUI-subsystem, so
/// every console child would otherwise get a fresh black window for the
/// length of its run, which for a `git status` poll means a flicker every
/// few seconds.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    hide_console(&mut cmd);
    // A Linux AppImage's bundled-library environment stops here: a no-op
    // everywhere else. See appimage_env.rs.
    crate::appimage_env::scrub(&mut cmd);
    cmd
}
