//! OS-specific code lives only in `src/platform/`. Test modules may still
//! gate themselves on an OS, so each file is checked up to its first
//! `#[cfg(test)]` or `#[cfg(all(test, …))]` item.

use std::path::{Path, PathBuf};

use regex::Regex;

fn rust_files(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
}

fn os_cfg() -> Regex {
    Regex::new(
        r"\bcfg(_attr)?!?\s*\([^\]]*\b(unix|windows|target_os|target_family|target_env|target_vendor)\b",
    )
    .unwrap()
}

#[test]
fn os_specific_code_stays_in_the_platform_module() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let platform = source.join("platform");
    assert!(platform.join("mod.rs").is_file());
    let os_cfg = os_cfg();
    let os_api = Regex::new(r"\b(libc|windows_sys|portable_pty)\b|\bstd::os::").unwrap();
    let test_module = Regex::new(r"^\s*#\[cfg\((all\()?test\b").unwrap();

    let mut files = Vec::new();
    rust_files(&source, &mut files);
    files.sort();
    let mut leaks = Vec::new();
    for file in files.iter().filter(|file| !file.starts_with(&platform)) {
        let text = std::fs::read_to_string(file).unwrap();
        for (index, line) in text.lines().enumerate() {
            if test_module.is_match(line) {
                break;
            }
            if line.trim_start().starts_with("//") {
                continue;
            }
            if os_cfg.is_match(line) || os_api.is_match(line) {
                let relative = file.strip_prefix(&source).unwrap().display();
                leaks.push(format!("src/{relative}:{}: {}", index + 1, line.trim()));
            }
        }
    }
    assert!(
        leaks.is_empty(),
        "OS-specific code outside src/platform/:\n{}",
        leaks.join("\n")
    );
}

#[test]
fn the_check_catches_os_specific_code() {
    let os_cfg = os_cfg();
    for line in [
        "#[cfg(windows)]",
        "#[cfg(not(unix))]",
        "#[cfg(any(target_os = \"macos\", windows))]",
        "#[cfg_attr(unix, allow(dead_code))]",
        "if cfg!(windows) {",
        "let drive = cfg!(target_family = \"windows\");",
    ] {
        assert!(os_cfg.is_match(line), "{line}");
    }
    for line in ["#[cfg(test)]", "#[cfg(feature = \"desktop\")]"] {
        assert!(!os_cfg.is_match(line), "{line}");
    }
}
