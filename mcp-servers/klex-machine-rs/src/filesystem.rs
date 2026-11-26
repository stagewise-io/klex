use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::collate::locale_compare;
use crate::fs_error::{self, message, message2};
use crate::paths::{MachinePathResolver, display};
use crate::platform;
use crate::time::iso_from_system_time;

pub const MAX_READ_BYTES: u64 = 1024 * 1024;
const MAX_RANGED_SOURCE_BYTES: u64 = 64 * 1024 * 1024;

type Result<T> = std::result::Result<T, String>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOptions {
    pub path: String,
    pub encoding: Option<String>,
    pub start_line: Option<f64>,
    pub end_line: Option<f64>,
}

#[derive(Deserialize)]
pub struct WriteOptions {
    pub path: String,
    pub content: String,
    pub encoding: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub old_string: String,
    pub new_string: String,
    pub replace_all: Option<bool>,
}

#[derive(Deserialize)]
pub struct CopyOptions {
    pub source: String,
    pub destination: String,
    pub r#move: Option<bool>,
    pub overwrite: Option<bool>,
}

#[derive(Clone)]
pub struct FilesystemService {
    pub paths: MachinePathResolver,
}

impl FilesystemService {
    pub fn new(paths: MachinePathResolver) -> Self {
        Self { paths }
    }

    pub fn read(&self, options: ReadOptions) -> Result<Value> {
        let path = self.paths.resolve(&options.path)?;
        let metadata = fs::metadata(&path).map_err(|error| message(&error, "stat", &path))?;
        if !metadata.is_file() {
            return Err(format!("Not a file: {}", display(&path)));
        }
        let ranged = options.start_line.is_some() || options.end_line.is_some();
        if !ranged && metadata.len() > MAX_READ_BYTES {
            return Err(format!(
                "File is {} bytes; use startLine/endLine for text or another tool for large binary data",
                metadata.len()
            ));
        }
        if ranged && metadata.len() > MAX_RANGED_SOURCE_BYTES {
            return Err(format!(
                "File is too large for ranged reading: {} bytes",
                metadata.len()
            ));
        }
        let encoding = options.encoding.as_deref().unwrap_or("utf8");
        let bytes = fs::read(&path).map_err(|error| message(&error, "open", &path))?;
        if encoding == "base64" {
            if ranged {
                return Err("Line ranges are only valid with utf8 encoding".into());
            }
            return Ok(json!({
                "path": display(&path),
                "encoding": encoding,
                "content": BASE64.encode(&bytes),
                "truncated": false,
            }));
        }
        let text = match String::from_utf8(bytes) {
            Ok(text) if !text.contains('\0') => text,
            _ => return Err("File is not valid UTF-8; use encoding \"base64\"".into()),
        };
        if !ranged {
            return Ok(json!({
                "path": display(&path),
                "encoding": encoding,
                "content": text,
                "truncated": false,
            }));
        }
        let lines = split_lines(&text);
        let total = lines.len() as f64;
        let start_line = options.start_line.unwrap_or(1.0);
        let end_line = options.end_line.unwrap_or(total);
        if start_line.fract() != 0.0 || start_line < 1.0 {
            return Err("startLine must be a positive integer".into());
        }
        if end_line.fract() != 0.0 || end_line < start_line {
            return Err("endLine must be an integer greater than or equal to startLine".into());
        }
        let first = (start_line as usize - 1).min(lines.len());
        let last = (end_line.min(total) as usize).max(first);
        Ok(json!({
            "path": display(&path),
            "encoding": encoding,
            "content": lines[first..last].join("\n"),
            "startLine": start_line as u64,
            "endLine": end_line.min(total) as u64,
            "totalLines": lines.len(),
            "truncated": end_line < total,
        }))
    }

    pub fn list(&self, input: &str) -> Result<Value> {
        let path = self.paths.resolve(input)?;
        let entries = fs::read_dir(&path).map_err(|error| message(&error, "scandir", &path))?;
        let mut results = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| message(&error, "scandir", &path))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let entry_path = path.join(&name);
            let metadata = fs::symlink_metadata(&entry_path)
                .map_err(|error| message(&error, "lstat", &entry_path))?;
            let file_type = entry
                .file_type()
                .map_err(|error| message(&error, "lstat", &entry_path))?;
            let kind = if file_type.is_file() {
                "file"
            } else if file_type.is_dir() {
                "directory"
            } else if file_type.is_symlink() {
                "symlink"
            } else {
                "other"
            };
            let modified = metadata
                .modified()
                .map(iso_from_system_time)
                .unwrap_or_default();
            results.push((
                name.clone(),
                json!({
                    "name": name,
                    "path": display(&entry_path),
                    "type": kind,
                    "size": metadata.len(),
                    "modifiedAt": modified,
                }),
            ));
        }
        results.sort_by(|left, right| locale_compare(&left.0, &right.0));
        Ok(Value::Array(
            results.into_iter().map(|(_, value)| value).collect(),
        ))
    }

    pub fn write(&self, options: WriteOptions) -> Result<Value> {
        let path = self.paths.resolve(&options.path)?;
        let bytes = if options.encoding.as_deref() == Some("base64") {
            if !is_canonical_base64(&options.content) {
                return Err("content must be valid base64".into());
            }
            BASE64
                .decode(&options.content)
                .map_err(|_| "content must be valid base64".to_string())?
        } else {
            options.content.into_bytes()
        };
        atomic_write(&path, &bytes)?;
        Ok(json!({ "path": display(&path), "bytesWritten": bytes.len() }))
    }

    pub fn multi_edit(&self, input: &str, edits: Vec<TextEdit>) -> Result<Value> {
        if edits.is_empty() {
            return Err("At least one edit is required".into());
        }
        let path = self.paths.resolve(input)?;
        let bytes = fs::read(&path).map_err(|error| message(&error, "open", &path))?;
        let mut content = String::from_utf8_lossy(&bytes).into_owned();
        for (index, edit) in edits.iter().enumerate() {
            if edit.old_string.is_empty() {
                return Err(format!("Edit {} has an empty oldString", index + 1));
            }
            if !content.contains(&edit.old_string) {
                return Err(format!(
                    "Edit {} did not match; file was not changed",
                    index + 1
                ));
            }
            content = js_replace(
                &content,
                &edit.old_string,
                &edit.new_string,
                edit.replace_all == Some(true),
            );
        }
        atomic_write(&path, content.as_bytes())?;
        Ok(json!({ "path": display(&path), "editsApplied": edits.len() }))
    }

    pub fn mkdir(&self, input: &str) -> Result<Value> {
        let path = self.paths.resolve(input)?;
        let existed = fs::symlink_metadata(&path).is_ok();
        fs::create_dir_all(&path).map_err(|error| message(&error, "mkdir", &path))?;
        Ok(json!({ "path": display(&path), "created": !existed }))
    }

    pub fn delete(&self, input: &str) -> Result<Value> {
        let path = self.paths.resolve(input)?;
        let existed = path_exists(&path)?;
        if existed {
            remove_all(&path)?;
        }
        Ok(json!({ "path": display(&path), "deleted": existed }))
    }

    pub fn copy(&self, options: CopyOptions) -> Result<Value> {
        let source = self.paths.resolve(&options.source)?;
        let destination = self.paths.resolve(&options.destination)?;
        let overwrite = options.overwrite.unwrap_or(false);
        let moved = options.r#move.unwrap_or(false);
        let result = json!({
            "source": display(&source),
            "destination": display(&destination),
            "moved": moved,
        });
        if source == destination {
            return Ok(result);
        }
        fs::symlink_metadata(&source).map_err(|error| message(&error, "lstat", &source))?;
        if !overwrite && path_exists(&destination)? {
            return Err(format!(
                "Destination already exists: {}",
                display(&destination)
            ));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| message(&error, "mkdir", parent))?;
        }
        if moved {
            let attempt = if overwrite {
                replace_path(&source, &destination)
            } else {
                fs::rename(&source, &destination)
                    .map_err(|error| FsFailure::io(error, "rename", &source, Some(&destination)))
            };
            match attempt {
                Ok(()) => {}
                Err(FsFailure { error, .. }) if fs_error::is(&error, "EXDEV") => {
                    let staging = sibling_temporary_path(&destination, "move");
                    let outcome = (|| {
                        copy_tree(&source, &staging, false, true)?;
                        if overwrite {
                            replace_path(&staging, &destination)
                                .map_err(FsFailure::into_message)?;
                        } else {
                            publish_path_exclusively(&staging, &destination)?;
                        }
                        make_directories_owner_writable(&source)?;
                        remove_all(&source)
                    })();
                    let _ = remove_all(&staging);
                    outcome?;
                }
                Err(failure) => return Err(failure.into_message()),
            }
        } else {
            copy_tree(&source, &destination, overwrite, !overwrite)?;
        }
        Ok(result)
    }
}

/// `text.split(/\r?\n/)`.
pub fn split_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        if let Some(stripped) = line.strip_suffix('\r') {
            *line = stripped;
        }
    }
    lines
}

/// `String.prototype.replace`/`replaceAll` with a string pattern, including
/// `$$`, `$&`, `` $` `` and `$'` in the replacement.
pub fn js_replace(content: &str, pattern: &str, replacement: &str, all: bool) -> String {
    let mut output = String::with_capacity(content.len());
    let mut position = 0;
    while let Some(offset) = content[position..].find(pattern) {
        let start = position + offset;
        let end = start + pattern.len();
        output.push_str(&content[position..start]);
        expand_replacement(&mut output, replacement, content, start, end);
        position = end;
        if !all {
            break;
        }
    }
    output.push_str(&content[position..]);
    output
}

fn expand_replacement(
    output: &mut String,
    replacement: &str,
    content: &str,
    start: usize,
    end: usize,
) {
    let mut characters = replacement.char_indices().peekable();
    while let Some((_, character)) = characters.next() {
        if character != '$' {
            output.push(character);
            continue;
        }
        match characters.peek().map(|(_, next)| *next) {
            Some('$') => output.push('$'),
            Some('&') => output.push_str(&content[start..end]),
            Some('`') => output.push_str(&content[..start]),
            Some('\'') => output.push_str(&content[end..]),
            _ => {
                output.push('$');
                continue;
            }
        }
        characters.next();
    }
}

fn is_canonical_base64(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    if !value.len().is_multiple_of(4) {
        return false;
    }
    let body = value.trim_end_matches('=');
    if value.len() - body.len() > 2
        || !body
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
    {
        return false;
    }
    match BASE64.decode(value) {
        Ok(bytes) => BASE64.encode(bytes) == value,
        Err(_) => false,
    }
}

fn path_exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if fs_error::is(&error, "ENOENT") => Ok(false),
        Err(error) => Err(message(&error, "lstat", path)),
    }
}

fn lstat_optional(path: &Path) -> std::result::Result<Option<fs::Metadata>, FsFailure> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if fs_error::is(&error, "ENOENT") => Ok(None),
        Err(error) => Err(FsFailure::io(error, "lstat", path, None)),
    }
}

/// `fs.rm(path, { force: true, recursive: true })`.
fn remove_all(path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if fs_error::is(&error, "ENOENT") => return Ok(()),
        Err(error) => return Err(message(&error, "lstat", path)),
    };
    let result = if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        remove_file_or_link(path, &metadata)
    };
    match result {
        Err(error) if !fs_error::is(&error, "ENOENT") => Err(message(&error, "rm", path)),
        _ => Ok(()),
    }
}

#[cfg(windows)]
fn remove_file_or_link(path: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    use std::os::windows::fs::FileTypeExt;
    if metadata.file_type().is_symlink_dir() {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(not(windows))]
fn remove_file_or_link(path: &Path, _metadata: &fs::Metadata) -> io::Result<()> {
    fs::remove_file(path)
}

/// An I/O error with its Node-style message, kept for code checks like EXDEV.
struct FsFailure {
    error: io::Error,
    text: String,
}

impl FsFailure {
    fn io(error: io::Error, syscall: &str, path: &Path, destination: Option<&Path>) -> Self {
        let text = match destination {
            Some(destination) => message2(&error, syscall, path, destination),
            None => message(&error, syscall, path),
        };
        Self { error, text }
    }

    fn into_message(self) -> String {
        self.text
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|error| message(&error, "mkdir", parent))?;
    let temporary_directory = make_temporary_directory(parent)?;
    let temporary_path = temporary_directory.join("content");
    let outcome = (|| {
        let existing = lstat_optional(path).map_err(FsFailure::into_message)?;
        if let Some(existing) = &existing
            && !existing.is_file()
            && !existing.file_type().is_symlink()
        {
            return Err(format!("Not a file: {}", display(path)));
        }
        let existing_mode = existing
            .as_ref()
            .filter(|metadata| metadata.is_file())
            .map(platform::mode);
        let mut file = create_exclusive(&temporary_path, existing_mode.unwrap_or(0o666))?;
        if let Some(mode) = existing_mode {
            platform::chmod(&temporary_path, mode)
                .map_err(|error| message(&error, "fchmod", &temporary_path))?;
        }
        file.write_all(bytes)
            .map_err(|error| message(&error, "write", &temporary_path))?;
        file.sync_all()
            .map_err(|error| message(&error, "fsync", &temporary_path))?;
        drop(file);
        replace_path(&temporary_path, path).map_err(FsFailure::into_message)
    })();
    let _ = fs::remove_dir_all(&temporary_directory);
    outcome
}

fn create_exclusive(path: &Path, mode: u32) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    options
        .open(path)
        .map_err(|error| message(&error, "open", path))
}

/// `fs.mkdtemp(join(parent, '.klex-machine-'))`.
fn make_temporary_directory(parent: &Path) -> Result<PathBuf> {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    loop {
        let random = uuid::Uuid::new_v4();
        let suffix: String = random.as_bytes()[..6]
            .iter()
            .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
            .collect();
        let candidate = parent.join(format!(".klex-machine-{suffix}"));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(message(
                    &error,
                    "mkdtemp",
                    &parent.join(".klex-machine-XXXXXX"),
                ));
            }
        }
    }
}

fn sibling_temporary_path(path: &Path, purpose: &str) -> PathBuf {
    let parent = path.parent().unwrap_or(Path::new("."));
    parent.join(format!(
        ".klex-machine-{purpose}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

fn replace_path(source: &Path, destination: &Path) -> std::result::Result<(), FsFailure> {
    let source_metadata = fs::symlink_metadata(source)
        .map_err(|error| FsFailure::io(error, "lstat", source, None))?;
    let destination_metadata = lstat_optional(destination)?;
    let requires_backup = cfg!(windows)
        || destination_metadata
            .as_ref()
            .is_some_and(|metadata| source_metadata.is_dir() || metadata.is_dir());
    let rename = |from: &Path, to: &Path| {
        fs::rename(from, to).map_err(|error| FsFailure::io(error, "rename", from, Some(to)))
    };
    if !requires_backup {
        return rename(source, destination);
    }
    let backup = sibling_temporary_path(destination, "backup");
    if destination_metadata.is_some() {
        rename(destination, &backup)?;
    }
    if let Err(error) = rename(source, destination) {
        if destination_metadata.is_some() {
            rename(&backup, destination)?;
        }
        return Err(error);
    }
    if destination_metadata.is_some() {
        let _ = remove_all(&backup);
    }
    Ok(())
}

struct PublishedPath {
    path: PathBuf,
    identity: Option<(u64, u64)>,
    directory: bool,
    mode: u32,
}

fn publish_path_exclusively(source: &Path, destination: &Path) -> Result<()> {
    let mut published = Vec::new();
    if let Err(error) = publish_exclusive_entry(source, destination, &mut published) {
        rollback_published_paths(published);
        return Err(error);
    }
    Ok(())
}

fn publish_exclusive_entry(
    source: &Path,
    destination: &Path,
    published: &mut Vec<PublishedPath>,
) -> Result<()> {
    let metadata =
        fs::symlink_metadata(source).map_err(|error| message(&error, "lstat", source))?;
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(source).map_err(|error| message(&error, "readlink", source))?;
        create_symlink(&target, destination, source)?;
        record_published_path(destination, published, None)?;
        return Ok(());
    }
    if !metadata.is_dir() {
        fs::hard_link(source, destination)
            .map_err(|error| message2(&error, "link", source, destination))?;
        record_published_path(destination, published, None)?;
        return Ok(());
    }
    let mode = platform::mode(&metadata);
    platform::chmod(source, mode | 0o700).map_err(|error| message(&error, "chmod", source))?;
    create_dir_with_mode(destination, mode | 0o700)?;
    record_published_path(destination, published, Some(mode))?;
    let mut names: Vec<_> = fs::read_dir(source)
        .map_err(|error| message(&error, "scandir", source))?
        .filter_map(|entry| entry.ok().map(|entry| entry.file_name()))
        .collect();
    names.sort();
    for name in names {
        publish_exclusive_entry(&source.join(&name), &destination.join(&name), published)?;
    }
    platform::chmod(destination, mode).map_err(|error| message(&error, "chmod", destination))
}

fn record_published_path(
    path: &Path,
    published: &mut Vec<PublishedPath>,
    final_mode: Option<u32>,
) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| message(&error, "lstat", path))?;
    published.push(PublishedPath {
        path: path.to_path_buf(),
        identity: platform::identity(path),
        directory: metadata.is_dir(),
        mode: final_mode.unwrap_or_else(|| platform::mode(&metadata)),
    });
    Ok(())
}

fn rollback_published_paths(mut published: Vec<PublishedPath>) {
    for entry in &published {
        if !entry.directory {
            continue;
        }
        if let Some(current) = matching_published_path(entry) {
            let _ = platform::chmod(&entry.path, platform::mode(&current) | 0o700);
        }
    }
    published.reverse();
    for entry in &published {
        if matching_published_path(entry).is_none() {
            continue;
        }
        if !entry.directory {
            let _ = fs::remove_file(&entry.path);
            continue;
        }
        if fs::remove_dir(&entry.path).is_err() {
            let _ = platform::chmod(&entry.path, entry.mode);
        }
    }
}

fn matching_published_path(entry: &PublishedPath) -> Option<fs::Metadata> {
    let current = fs::symlink_metadata(&entry.path).ok()?;
    if entry.identity.is_none() || platform::identity(&entry.path) != entry.identity {
        return None;
    }
    Some(current)
}

fn make_directories_owner_writable(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| message(&error, "lstat", path))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Ok(());
    }
    platform::chmod(path, platform::mode(&metadata) | 0o700)
        .map_err(|error| message(&error, "chmod", path))?;
    for entry in fs::read_dir(path).map_err(|error| message(&error, "scandir", path))? {
        let entry = entry.map_err(|error| message(&error, "scandir", path))?;
        make_directories_owner_writable(&entry.path())?;
    }
    Ok(())
}

fn create_dir_with_mode(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    let result = {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(mode).create(path)
    };
    #[cfg(not(unix))]
    let result = {
        let _ = mode;
        fs::DirBuilder::new().create(path)
    };
    result.map_err(|error| message(&error, "mkdir", path))
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path, _source: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, link)
        .map_err(|error| message2(&error, "symlink", target, link))
}

#[cfg(windows)]
fn create_symlink(target: &Path, link: &Path, source: &Path) -> Result<()> {
    use std::os::windows::fs::{FileTypeExt, symlink_dir, symlink_file};
    let directory = fs::symlink_metadata(source)
        .map(|metadata| metadata.file_type().is_symlink_dir())
        .unwrap_or(false);
    let result = if directory {
        symlink_dir(target, link)
    } else {
        symlink_file(target, link)
    };
    result.map_err(|error| message2(&error, "symlink", target, link))
}

/// `fs.cp(source, destination, { recursive: true, dereference: false })`
/// with Node's `force` and `errorOnExist` options.
fn copy_tree(source: &Path, destination: &Path, force: bool, error_on_exist: bool) -> Result<()> {
    let metadata =
        fs::symlink_metadata(source).map_err(|error| message(&error, "lstat", source))?;
    let destination_metadata = lstat_optional(destination).map_err(FsFailure::into_message)?;
    if metadata.is_dir() {
        if let Some(existing) = &destination_metadata
            && !existing.is_dir()
        {
            return Err(cp_error(
                "ERR_FS_CP_DIR_TO_NON_DIR",
                "EISDIR",
                &format!(
                    "cannot overwrite non-directory {} with directory {}",
                    display(destination),
                    display(source)
                ),
                destination,
            ));
        }
        if destination.starts_with(source) {
            return Err(cp_error(
                "ERR_FS_CP_EINVAL",
                "EINVAL",
                &format!(
                    "cannot copy {} to a subdirectory of self {}",
                    display(source),
                    display(destination)
                ),
                destination,
            ));
        }
        let created = destination_metadata.is_none();
        if created {
            fs::create_dir(destination).map_err(|error| message(&error, "mkdir", destination))?;
        }
        let entries = fs::read_dir(source).map_err(|error| message(&error, "opendir", source))?;
        for entry in entries {
            let entry = entry.map_err(|error| message(&error, "opendir", source))?;
            copy_tree(
                &entry.path(),
                &destination.join(entry.file_name()),
                force,
                error_on_exist,
            )?;
        }
        if created {
            platform::chmod(destination, platform::mode(&metadata))
                .map_err(|error| message(&error, "chmod", destination))?;
        }
        return Ok(());
    }
    if let Some(existing) = &destination_metadata {
        if existing.is_dir() && !metadata.file_type().is_symlink() {
            return Err(cp_error(
                "ERR_FS_CP_NON_DIR_TO_DIR",
                "ENOTDIR",
                &format!(
                    "cannot overwrite directory {} with non-directory {}",
                    display(destination),
                    display(source)
                ),
                destination,
            ));
        }
        if !force {
            if error_on_exist {
                return Err(cp_error(
                    "ERR_FS_CP_EEXIST",
                    "EEXIST",
                    &format!("{} already exists", display(destination)),
                    destination,
                ));
            }
            return Ok(());
        }
    }
    if metadata.file_type().is_symlink() {
        let mut target =
            fs::read_link(source).map_err(|error| message(&error, "readlink", source))?;
        if !target.is_absolute() {
            target = crate::paths::resolve_from(source.parent().unwrap_or(Path::new(".")), &target);
        }
        if destination_metadata.is_some() {
            fs::remove_file(destination).map_err(|error| message(&error, "unlink", destination))?;
        }
        return create_symlink(&target, destination, source);
    }
    if metadata.is_file() {
        if let Some(existing) = &destination_metadata
            && existing.file_type().is_symlink()
        {
            fs::remove_file(destination).map_err(|error| message(&error, "unlink", destination))?;
        }
        fs::copy(source, destination)
            .map_err(|error| message2(&error, "copyfile", source, destination))?;
        return Ok(());
    }
    Err(cp_error(
        "ERR_FS_CP_UNKNOWN",
        "EINVAL",
        &format!("cannot copy an unknown file type {}", display(destination)),
        destination,
    ))
}

fn cp_error(name: &str, code: &str, detail: &str, path: &Path) -> String {
    let summary = match name {
        "ERR_FS_CP_EEXIST" => "Target already exists",
        "ERR_FS_CP_DIR_TO_NON_DIR" => "Cannot overwrite non-directory with directory",
        "ERR_FS_CP_NON_DIR_TO_DIR" => "Cannot overwrite directory with non-directory",
        "ERR_FS_CP_EINVAL" => "Invalid src or dest",
        _ => "Cannot copy an unknown file type",
    };
    format!("{summary}: cp returned {code} ({detail}) {}", display(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_javascript() {
        assert_eq!(split_lines("one\r\ntwo\nthree"), ["one", "two", "three"]);
        assert_eq!(split_lines("a\r"), ["a\r"]);
        assert_eq!(split_lines(""), [""]);
        assert_eq!(split_lines("a\n"), ["a", ""]);
    }

    #[test]
    fn replaces_like_javascript() {
        assert_eq!(js_replace("a a b", "a", "x", false), "x a b");
        assert_eq!(js_replace("a a b", "a", "y", true), "y y b");
        assert_eq!(js_replace("ab", "a", "$$-$&-$`-$'-$1", false), "$-a--b-$1b");
    }

    #[test]
    fn validates_canonical_base64() {
        assert!(is_canonical_base64(""));
        assert!(is_canonical_base64("AAEC/w=="));
        assert!(!is_canonical_base64("not base64!"));
        assert!(!is_canonical_base64("AAEC/x=="));
        assert!(!is_canonical_base64("AAE"));
    }
}
