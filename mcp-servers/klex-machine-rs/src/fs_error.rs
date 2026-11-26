//! Node-style filesystem error messages, e.g.
//! `ENOENT: no such file or directory, stat '/missing'`.

use std::io;
use std::path::Path;

pub fn code(error: &io::Error) -> Option<&'static str> {
    errno_entry(error).map(|(code, _)| code)
}

pub fn is(error: &io::Error, expected: &str) -> bool {
    code(error) == Some(expected)
}

pub fn message(error: &io::Error, syscall: &str, path: &Path) -> String {
    format_message(error, syscall, path, None)
}

pub fn message2(error: &io::Error, syscall: &str, path: &Path, destination: &Path) -> String {
    format_message(error, syscall, path, Some(destination))
}

fn format_message(
    error: &io::Error,
    syscall: &str,
    path: &Path,
    destination: Option<&Path>,
) -> String {
    let Some((code, description)) = errno_entry(error) else {
        return error.to_string();
    };
    let mut text = format!("{code}: {description}, {syscall} '{}'", path.display());
    if let Some(destination) = destination {
        text.push_str(&format!(" -> '{}'", destination.display()));
    }
    text
}

const TABLE: &[(&str, &str)] = &[
    ("EACCES", "permission denied"),
    ("EBUSY", "resource busy or locked"),
    ("EEXIST", "file already exists"),
    ("EINVAL", "invalid argument"),
    ("EIO", "i/o error"),
    ("EISDIR", "illegal operation on a directory"),
    ("ELOOP", "too many symbolic links encountered"),
    ("EMFILE", "too many open files"),
    ("ENAMETOOLONG", "name too long"),
    ("ENOENT", "no such file or directory"),
    ("ENOSPC", "no space left on device"),
    ("ENOTDIR", "not a directory"),
    ("ENOTEMPTY", "directory not empty"),
    ("EPERM", "operation not permitted"),
    ("EROFS", "read-only file system"),
    ("EXDEV", "cross-device link not permitted"),
    ("ETXTBSY", "text file is busy"),
    ("EFBIG", "file too large"),
];

fn entry(code: &str) -> Option<(&'static str, &'static str)> {
    TABLE
        .iter()
        .copied()
        .find(|(candidate, _)| *candidate == code)
}

#[cfg(unix)]
fn errno_entry(error: &io::Error) -> Option<(&'static str, &'static str)> {
    let code = match error.raw_os_error()? {
        libc::EACCES => "EACCES",
        libc::EBUSY => "EBUSY",
        libc::EEXIST => "EEXIST",
        libc::EINVAL => "EINVAL",
        libc::EIO => "EIO",
        libc::EISDIR => "EISDIR",
        libc::ELOOP => "ELOOP",
        libc::EMFILE => "EMFILE",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::ENOENT => "ENOENT",
        libc::ENOSPC => "ENOSPC",
        libc::ENOTDIR => "ENOTDIR",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::EPERM => "EPERM",
        libc::EROFS => "EROFS",
        libc::EXDEV => "EXDEV",
        libc::ETXTBSY => "ETXTBSY",
        libc::EFBIG => "EFBIG",
        _ => return None,
    };
    entry(code)
}

#[cfg(windows)]
fn errno_entry(error: &io::Error) -> Option<(&'static str, &'static str)> {
    // libuv's uv_translate_sys_error for the codes filesystem calls produce.
    let code = match error.raw_os_error()? {
        2 | 3 | 15 | 53 | 67 | 123 | 161 | 1392 => "ENOENT",
        5 | 19 | 1314 => "EPERM",
        17 => "EXDEV",
        32 | 33 | 170 => "EBUSY",
        80 | 183 => "EEXIST",
        87 => "EINVAL",
        112 | 39 => "ENOSPC",
        145 => "ENOTEMPTY",
        206 => "ENAMETOOLONG",
        267 => "ENOTDIR",
        1921 => "ELOOP",
        4 => "EMFILE",
        _ => return None,
    };
    entry(code)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn formats_like_node() {
        let error = std::fs::metadata("/nonexistent/zzz").unwrap_err();
        assert_eq!(
            message(&error, "stat", Path::new("/nonexistent/zzz")),
            "ENOENT: no such file or directory, stat '/nonexistent/zzz'"
        );
        assert_eq!(
            message2(&error, "rename", Path::new("/a"), Path::new("/b")),
            "ENOENT: no such file or directory, rename '/a' -> '/b'"
        );
        assert!(is(&error, "ENOENT"));
    }
}
