//! Write beside the destination, then replace it only after a complete, synced write.
use std::collections::HashSet;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

const TEMP_PREFIX: &str = ".opds-save-";
const TEMP_SUFFIX: &str = ".tmp";
/// A staged file this old is left over from a crash or a killed save.
const STALE_TEMP_AGE: Duration = Duration::from_secs(24 * 60 * 60);

struct StagedFile(PathBuf);
impl Drop for StagedFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn mismatch() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "append-mismatch: the file changed on disk")
}

pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_with(path, |file| file.write_all(bytes), |_| Ok(()))
}

/// Append `extra` to the file at `path`, atomically: the result is staged
/// beside it (current contents, then `extra`), synced, and moved over it.
/// Refuses, leaving the file as it is, unless the file still has
/// `expected_len` bytes and starts with `head` and ends with `tail` (the
/// bytes the caller built its append on), and is still the same unchanged
/// file (length, modification time and, on Unix, inode) just before the move.
pub fn append(path: &Path, expected_len: u64, head: &[u8], tail: &[u8], extra: &[u8]) -> io::Result<()> {
    append_inner(path, expected_len, head, tail, extra, || {})
}

fn append_inner(
    path: &Path,
    expected_len: u64,
    head: &[u8],
    tail: &[u8],
    extra: &[u8],
    after_copy: impl FnOnce(),
) -> io::Result<()> {
    if head.len() as u64 > expected_len || tail.len() as u64 > expected_len {
        return Err(mismatch());
    }
    let mut source = File::open(path)?;
    let before = source.metadata()?;
    if before.len() != expected_len {
        return Err(mismatch());
    }
    let mut buffer = vec![0u8; head.len().max(tail.len())];
    source.read_exact(&mut buffer[..head.len()])?;
    if &buffer[..head.len()] != head {
        return Err(mismatch());
    }
    source.seek(SeekFrom::Start(expected_len - tail.len() as u64))?;
    source.read_exact(&mut buffer[..tail.len()])?;
    if &buffer[..tail.len()] != tail {
        return Err(mismatch());
    }
    write_with(
        path,
        |file| {
            // Stream the current contents instead of holding a second copy in memory.
            source.seek(SeekFrom::Start(0))?;
            if io::copy(&mut (&mut source).take(expected_len), file)? != expected_len {
                return Err(mismatch());
            }
            file.write_all(extra)?;
            after_copy();
            Ok(())
        },
        |target| {
            let now = fs::metadata(target)?;
            if same_unchanged_file(&before, &now) { Ok(()) } else { Err(mismatch()) }
        },
    )
}

fn same_unchanged_file(before: &Metadata, now: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != now.dev() || before.ino() != now.ino() {
            return false;
        }
    }
    before.len() == now.len() && before.modified().ok() == now.modified().ok()
}

fn write_with(
    path: &Path,
    write_bytes: impl FnOnce(&mut File) -> io::Result<()>,
    before_replace: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    // Follow existing symlinks, like an ordinary write, instead of replacing the link.
    let target = match fs::canonicalize(path) {
        Ok(target) => target,
        // Not there yet, or a drive that cannot resolve paths (some network,
        // RAM and virtual drives): write to the path as given.
        Err(_) => path.to_path_buf(),
    };
    let original = match fs::metadata(&target) {
        Ok(meta) => {
            if !meta.is_file() || meta.permissions().readonly() {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "Destination is not a writable file"));
            }
            // Check write permission without truncating the original.
            OpenOptions::new().write(true).open(&target)?;
            Some(meta)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let (staged, mut file) = loop {
        let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!("{TEMP_PREFIX}{}-{}{TEMP_SUFFIX}", std::process::id(), serial));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // Replacing: private until the original's owner and mode are copied.
            // New: the mode an ordinary new file gets (0666 less the umask).
            options.mode(if original.is_some() { 0o600 } else { 0o666 });
        }
        match options.open(&temp) {
            Ok(file) => break (StagedFile(temp), file),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    };
    // Close the handle before cleanup or rename, including on Windows error paths.
    let result = (|| {
        write_bytes(&mut file)?;
        if let Some(meta) = &original {
            copy_owner(&file, meta);
            // After the owner: a change of owner can clear set-id bits.
            file.set_permissions(meta.permissions())?;
        }
        file.sync_all()
    })();
    drop(file);
    result?;
    before_replace(&target)?;
    replace(&staged.0, &target)?;
    sync_directory(parent);
    sweep_stale_temps_once(parent);
    Ok(())
}

/// Give the staged file the original's owner and group where this process
/// may (its own files, or any as root); otherwise at least the group.
#[cfg(unix)]
fn copy_owner(file: &File, meta: &Metadata) {
    use std::os::unix::fs::{fchown, MetadataExt};
    if fchown(file, Some(meta.uid()), Some(meta.gid())).is_err() {
        let _ = fchown(file, None, Some(meta.gid()));
    }
}

#[cfg(not(unix))]
fn copy_owner(_file: &File, _meta: &Metadata) {}

/// Make the rename itself durable: sync the directory entry (Unix).
fn sync_directory(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = File::open(dir) {
        // Some file systems refuse to sync a directory; the data is synced already.
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Remove staged files that a crashed or killed save left in `dir`, once per
/// directory per run. Only old ones from other processes: a save running now
/// in another instance keeps its file.
fn sweep_stale_temps_once(dir: &Path) {
    static SWEPT: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);
    {
        let Ok(mut swept) = SWEPT.lock() else { return };
        if !swept.get_or_insert_with(HashSet::new).insert(dir.to_path_buf()) {
            return;
        }
    }
    sweep_stale_temps(dir, STALE_TEMP_AGE);
}

fn sweep_stale_temps(dir: &Path, older_than: Duration) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let own = format!("{TEMP_PREFIX}{}-", std::process::id());
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(TEMP_PREFIX) || !name.ends_with(TEMP_SUFFIX) || name.starts_with(&own) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let old = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age >= older_than);
        if meta.is_file() && old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Move the staged file over the destination. A failed replacement must leave
/// the old destination intact, including on Windows when another process has
/// it open without delete sharing. The caller can retry after that process
/// releases the file; copying over it here could truncate the only good PDF.
fn replace(staged: &Path, target: &Path) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(staged, target) {
            Ok(()) => return Ok(()),
            Err(e) if cfg!(windows) && e.kind() == io::ErrorKind::PermissionDenied && target.is_file() => {
                if attempt == 4 { return Err(e); }
                std::thread::sleep(std::time::Duration::from_millis(25 << attempt));
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("opds-atomic-test-{}-{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn creates_and_replaces_file() {
        let dir = TestDir::new();
        let path = dir.0.join("document.pdf");
        write(&path, b"original").unwrap();
        write(&path, b"complete replacement").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"complete replacement");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn append_adds_bytes_and_refuses_a_changed_file() {
        let dir = TestDir::new();
        let path = dir.0.join("document.pdf");
        fs::write(&path, b"original").unwrap();
        append(&path, 8, b"orig", b"nal", b"+more").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"original+more");
        assert!(append(&path, 8, b"orig", b"nal", b"+x").is_err());
        assert!(append(&path, 13, b"orix", b"ore", b"+x").is_err());
        assert!(append(&path, 13, b"original+more+", b"", b"+x").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original+more");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn append_refuses_a_file_changed_while_it_was_staged() {
        let dir = TestDir::new();
        let path = dir.0.join("document.pdf");
        fs::write(&path, b"original").unwrap();
        // Another program writes the file between the copy and the move.
        let result = append_inner(&path, 8, b"orig", b"nal", b"+more", || {
            fs::write(&path, b"original and more from elsewhere").unwrap();
        });
        assert!(result.unwrap_err().to_string().contains("append-mismatch"));
        assert_eq!(fs::read(&path).unwrap(), b"original and more from elsewhere");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
        // Replaced by a file of the same length (another inode): refused too.
        let result = append_inner(&path, 32, b"orig", b"where", b"+x", || {
            let other = dir.0.join("other.pdf");
            fs::write(&other, b"original and more from elsewhere").unwrap();
            fs::rename(&other, &path).unwrap();
        });
        assert!(result.is_err());
    }

    #[test]
    fn partial_write_keeps_original_and_removes_temp() {
        let dir = TestDir::new();
        let path = dir.0.join("document.pdf");
        fs::write(&path, b"original").unwrap();
        let result = write_with(&path, |file| {
            file.write_all(b"partial")?;
            Err(io::Error::new(io::ErrorKind::Other, "simulated full disk"))
        }, |_| Ok(()));
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn failed_replacement_keeps_destination_and_removes_temp() {
        let dir = TestDir::new();
        let path = dir.0.join("document.pdf");
        let result = write_with(&path, |file| {
            file.write_all(b"replacement")?;
            fs::create_dir(&path)?;
            fs::write(path.join("keep"), b"untouched")
        }, |_| Ok(()));
        assert!(result.is_err());
        assert_eq!(fs::read(path.join("keep")).unwrap(), b"untouched");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn sweeps_only_old_temps_of_other_processes() {
        let dir = TestDir::new();
        let old = dir.0.join(".opds-save-1-1.tmp");
        let fresh = dir.0.join(".opds-save-1-2.tmp");
        let other = dir.0.join("notes.tmp");
        for p in [&old, &fresh, &other] {
            fs::write(p, b"x").unwrap();
        }
        let long_ago = SystemTime::now() - Duration::from_secs(3 * 24 * 60 * 60);
        for p in [&old, &other] {
            OpenOptions::new().write(true).open(p).unwrap().set_modified(long_ago).unwrap();
        }
        write(&dir.0.join("document.pdf"), b"saved").unwrap();
        assert!(!old.exists());
        assert!(fresh.exists());
        assert!(other.exists());
    }

    #[cfg(windows)]
    #[test]
    fn held_file_keeps_original_when_replacement_is_denied() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        const FILE_SHARE_WRITE: u32 = 2;
        let dir = TestDir::new();
        let path = dir.0.join("document.pdf");
        fs::write(&path, b"original").unwrap();
        let _viewer = OpenOptions::new().read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).open(&path).unwrap();
        assert!(write(&path, b"replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_symlink_and_permissions() {
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
        let dir = TestDir::new();
        let target = dir.0.join("original.pdf");
        let link = dir.0.join("link.pdf");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        let before = fs::metadata(&target).unwrap();
        symlink(&target, &link).unwrap();
        write(&link, b"new").unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&target).unwrap(), b"new");
        let after = fs::metadata(&target).unwrap();
        assert_eq!(after.permissions().mode() & 0o7777, 0o640);
        assert_eq!((after.uid(), after.gid()), (before.uid(), before.gid()));
        // A wider mode is kept too, not narrowed to the staging mode.
        fs::set_permissions(&target, fs::Permissions::from_mode(0o664)).unwrap();
        write(&target, b"newer").unwrap();
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o7777, 0o664);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn new_file_gets_the_umask_mode_not_the_staging_mode() {
        use std::os::unix::fs::PermissionsExt;
        let status = fs::read_to_string("/proc/self/status").unwrap();
        let umask = status.lines().find_map(|l| l.strip_prefix("Umask:"))
            .map(|v| u32::from_str_radix(v.trim(), 8).unwrap()).unwrap();
        let dir = TestDir::new();
        let path = dir.0.join("new.pdf");
        write(&path, b"fresh").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o666 & !umask);
    }
}
