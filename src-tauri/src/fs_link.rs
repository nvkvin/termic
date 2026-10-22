//! Symlinks across platforms.
//!
//! Unix: a plain symlink. Windows has to be told up front whether the
//! target is a directory or a file, and creating either kind needs
//! Developer Mode (or SeCreateSymbolicLinkPrivilege). Without it the
//! call fails, so a directory falls back to a junction (no privilege
//! needed, same-machine absolute targets, which is every link the app
//! makes) and a file to a hard link (same volume only; an editor that
//! saves by rename breaks the sharing, which a symlink would not).

use std::io;
use std::path::Path;

/// Create `link` pointing at `target`.
pub fn symlink_any(target: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
    imp::symlink_any(target.as_ref(), link.as_ref())
}

#[cfg(unix)]
mod imp {
    use super::*;

    pub fn symlink_any(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }
}

#[cfg(windows)]
mod imp {
    use super::*;

    pub fn symlink_any(target: &Path, link: &Path) -> io::Result<()> {
        if target.is_dir() {
            match std::os::windows::fs::symlink_dir(target, link) {
                Ok(()) => Ok(()),
                Err(e) => junction(target, link).map_err(|_| e),
            }
        } else {
            match std::os::windows::fs::symlink_file(target, link) {
                Ok(()) => Ok(()),
                Err(e) => std::fs::hard_link(target, link).map_err(|_| e),
            }
        }
    }

    /// `mklink /J` is a cmd.exe builtin; there is no std API for
    /// junctions. The target must be absolute.
    fn junction(target: &Path, link: &Path) -> io::Result<()> {
        let target = if target.is_absolute() {
            target.to_path_buf()
        } else {
            std::env::current_dir()?.join(target)
        };
        let out = crate::proc_ctl::command("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(&target)
            .output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(String::from_utf8_lossy(&out.stderr).trim().to_string()))
        }
    }

    #[test]
    fn removes_a_dangling_junction() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        // Force the unprivileged fallback even when symlinks are available.
        junction(&target, &link).unwrap();
        std::fs::remove_dir(&target).unwrap();
        assert!(std::fs::symlink_metadata(&link).is_ok());
        super::remove_link(&link).unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_a_directory_and_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("d");
        std::fs::create_dir(&d).unwrap();
        std::fs::write(d.join("x.txt"), "hi").unwrap();
        let f = dir.path().join("f.txt");
        std::fs::write(&f, "yo").unwrap();

        let dl = dir.path().join("dl");
        symlink_any(&d, &dl).unwrap();
        assert_eq!(std::fs::read_to_string(dl.join("x.txt")).unwrap(), "hi");

        let fl = dir.path().join("fl.txt");
        symlink_any(&f, &fl).unwrap();
        assert_eq!(std::fs::read_to_string(&fl).unwrap(), "yo");
    }

    #[test]
    fn removes_a_link_and_leaves_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().join("d");
        std::fs::create_dir(&d).unwrap();
        std::fs::write(d.join("x.txt"), "hi").unwrap();
        let dl = dir.path().join("dl");
        symlink_any(&d, &dl).unwrap();

        remove_link(&dl).unwrap();
        assert!(std::fs::symlink_metadata(&dl).is_err());
        assert_eq!(std::fs::read_to_string(d.join("x.txt")).unwrap(), "hi");
    }

    #[test]
    fn removes_a_dangling_directory_link() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        std::fs::create_dir(&target).unwrap();
        symlink_any(&target, &link).unwrap();
        std::fs::remove_dir(&target).unwrap();
        assert!(std::fs::symlink_metadata(&link).is_ok());
        remove_link(&link).unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
    }
}

/// Remove a link made by `symlink_any` without touching its target. On
/// Windows a directory link (a junction, or a directory symlink) is a
/// directory entry that `remove_file` refuses with "Access is denied", and
/// `remove_dir` removes the link alone; everywhere else it is `remove_file`.
pub fn remove_link(link: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        // Inspect the link itself: is_dir() follows the target and returns
        // false for a dangling directory symlink or junction.
        if std::fs::symlink_metadata(link)?.file_type().is_symlink_dir() {
            return std::fs::remove_dir(link);
        }
    }
    std::fs::remove_file(link)
}

/// `fs::remove_dir_all`, patient on Windows.
///
/// Windows refuses to delete a directory while any process still has a
/// handle or its working directory inside it (os error 32, a sharing
/// violation, or 5 for a file mid-delete). Archive stops the task's agents
/// and scripts first, but a killed process lets go of its handles slightly
/// AFTER TerminateProcess returns, so the first attempt can lose that race.
/// Retry for a few seconds on exactly those errors. Unix deletes open
/// directories fine, so there it is a single call.
pub fn remove_dir_all_settled(path: &Path) -> io::Result<()> {
    if !cfg!(windows) {
        // Parity with the loop below: a dir that vanished between the
        // caller's exists() and this call is the goal already met.
        return match std::fs::remove_dir_all(path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        };
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut wait = std::time::Duration::from_millis(50);
    loop {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e)
                if matches!(e.raw_os_error(), Some(32) | Some(5) | Some(145))
                    && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(wait);
                wait = (wait * 2).min(std::time::Duration::from_millis(500));
            }
            Err(e) => return Err(e),
        }
    }
}
