use std::fs;
use std::path::{Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::collate::locale_compare;
use crate::filesystem::split_lines;
use crate::glob::{EnumerateOptions, enumerate};
use crate::paths::{MachinePathResolver, display, normalize, relative_slash};
use crate::safe_regex;

pub const DEFAULT_SEARCH_LIMIT: f64 = 100.0;
pub const MAX_SEARCH_LIMIT: f64 = 1000.0;
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;

type Result<T> = std::result::Result<T, String>;

#[derive(Deserialize)]
pub struct GlobOptions {
    pub patterns: Vec<String>,
    pub cwd: Option<String>,
    pub exclude: Option<Vec<String>>,
    pub hidden: Option<bool>,
    pub gitignore: Option<bool>,
    pub limit: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepOptions {
    pub pattern: String,
    pub cwd: Option<String>,
    pub include: Option<Vec<String>>,
    pub exclude: Option<Vec<String>>,
    pub case_sensitive: Option<bool>,
    pub hidden: Option<bool>,
    pub gitignore: Option<bool>,
    pub context: Option<f64>,
    pub limit: Option<f64>,
}

#[derive(Clone)]
pub struct SearchService {
    paths: MachinePathResolver,
}

impl SearchService {
    pub fn new(paths: MachinePathResolver) -> Self {
        Self { paths }
    }

    pub fn glob(&self, options: GlobOptions) -> Result<Value> {
        if options.patterns.is_empty() {
            return Err("At least one pattern is required".into());
        }
        let cwd = self.paths.resolve(options.cwd.as_deref().unwrap_or("."))?;
        let limit = validate_limit(options.limit)?;
        let exclude = options.exclude.unwrap_or_default();
        let enumeration = enumerate(
            &options.patterns,
            &cwd,
            &EnumerateOptions {
                dot: options.hidden.unwrap_or(false),
                ignore: &exclude,
                only_files: false,
            },
        )?;
        let ignored = if options.gitignore == Some(false) {
            None
        } else {
            load_ignore(&cwd)?
        };
        let mut sorted: Vec<String> = enumeration
            .entries
            .into_iter()
            .filter(|entry| !is_ignored(ignored.as_ref(), &cwd, &entry.path, entry.is_dir))
            .map(|entry| display(&normalize(&entry.path)))
            .collect();
        sorted.sort_by(|left, right| locale_compare(left, right));
        let truncated = enumeration.truncated || sorted.len() > limit;
        sorted.truncate(limit);
        Ok(json!({ "matches": sorted, "truncated": truncated }))
    }

    pub fn grep(&self, options: GrepOptions) -> Result<Value> {
        let cwd = self.paths.resolve(options.cwd.as_deref().unwrap_or("."))?;
        let limit = validate_limit(options.limit)?;
        let context = options.context.unwrap_or(0.0);
        if context.fract() != 0.0 || !(0.0..=20.0).contains(&context) {
            return Err("context must be an integer from 0 to 20".into());
        }
        let context = context as usize;
        if !safe_regex::is_safe(&options.pattern) {
            return Err("pattern is too complex for safe evaluation".into());
        }
        let flags = if options.case_sensitive == Some(false) {
            "i"
        } else {
            ""
        };
        let expression = regress::Regex::with_flags(&options.pattern, flags).map_err(|error| {
            format!(
                "Invalid regular expression: /{}/{flags}: {error}",
                options.pattern
            )
        })?;
        let include = options.include.unwrap_or_else(|| vec!["**/*".into()]);
        let exclude = options.exclude.unwrap_or_default();
        let enumeration = enumerate(
            &include,
            &cwd,
            &EnumerateOptions {
                dot: options.hidden.unwrap_or(false),
                ignore: &exclude,
                only_files: true,
            },
        )?;
        let ignored = if options.gitignore == Some(false) {
            None
        } else {
            load_ignore(&cwd)?
        };
        let mut files: Vec<PathBuf> = enumeration
            .entries
            .into_iter()
            .map(|entry| normalize(&entry.path))
            .filter(|path| !is_ignored(ignored.as_ref(), &cwd, path, false))
            .collect();
        files.sort_by(|left, right| {
            locale_compare(&left.to_string_lossy(), &right.to_string_lossy())
        });

        let mut matches = Vec::new();
        let mut files_searched = 0usize;
        let mut truncated = enumeration.truncated;
        for path in files {
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            if !metadata.is_file() || metadata.len() > MAX_SEARCH_FILE_BYTES {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else { continue };
            if bytes.contains(&0) {
                continue;
            }
            files_searched += 1;
            let text = String::from_utf8_lossy(&bytes);
            let lines = split_lines(&text);
            for (index, line) in lines.iter().enumerate() {
                if expression.find(line).is_none() {
                    continue;
                }
                if matches.len() >= limit {
                    truncated = true;
                    break;
                }
                let before = &lines[index.saturating_sub(context)..index];
                let after =
                    &lines[(index + 1).min(lines.len())..(index + 1 + context).min(lines.len())];
                matches.push(json!({
                    "path": display(&path),
                    "line": index + 1,
                    "text": line,
                    "before": before,
                    "after": after,
                }));
            }
            if truncated && matches.len() >= limit {
                break;
            }
        }
        Ok(json!({ "matches": matches, "filesSearched": files_searched, "truncated": truncated }))
    }
}

fn validate_limit(input: Option<f64>) -> Result<usize> {
    let limit = input.unwrap_or(DEFAULT_SEARCH_LIMIT);
    if limit.fract() != 0.0 || !(1.0..=MAX_SEARCH_LIMIT).contains(&limit) {
        return Err(format!(
            "limit must be an integer from 1 to {MAX_SEARCH_LIMIT}"
        ));
    }
    Ok(limit as usize)
}

fn is_ignored(ignored: Option<&Gitignore>, cwd: &Path, path: &Path, is_dir: bool) -> bool {
    let Some(ignored) = ignored else { return false };
    let Ok(relative) = path.strip_prefix(cwd) else {
        return false;
    };
    if relative.as_os_str().is_empty() {
        return false;
    }
    ignored
        .matched_path_or_any_parents(relative, is_dir)
        .is_ignore()
}

/// Every `.gitignore` under `cwd`, shallowest first, rebased onto `cwd` so
/// one matcher applies them with git's last-match-wins precedence.
fn load_ignore(cwd: &Path) -> Result<Option<Gitignore>> {
    let enumeration = enumerate(
        &["**/.gitignore".to_string()],
        cwd,
        &EnumerateOptions {
            dot: true,
            ignore: &[],
            only_files: true,
        },
    )?;
    if enumeration.entries.is_empty() {
        return Ok(None);
    }
    let mut files: Vec<(usize, String, PathBuf)> = enumeration
        .entries
        .into_iter()
        .map(|entry| {
            let base = relative_slash(cwd, entry.path.parent().unwrap_or(cwd));
            let depth = if base.is_empty() {
                0
            } else {
                base.split('/').count()
            };
            (depth, display(&entry.path), entry.path)
        })
        .collect();
    files.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| locale_compare(&left.1, &right.1))
    });
    let mut builder = GitignoreBuilder::new(cwd);
    for (_, _, path) in files {
        let Ok(source) = fs::read_to_string(&path) else {
            continue;
        };
        let base = relative_slash(cwd, path.parent().unwrap_or(cwd));
        for line in split_lines(&source) {
            for pattern in rebase_ignore_pattern(&base, line) {
                let _ = builder.add_line(None, &pattern);
            }
        }
    }
    Ok(builder.build().ok())
}

fn rebase_ignore_pattern(base: &str, input: &str) -> Vec<String> {
    if base.is_empty() || input.is_empty() || input.starts_with('#') {
        return vec![input.to_string()];
    }
    let negated = input.starts_with('!');
    let pattern_input = if negated { &input[1..] } else { input };
    let anchored = pattern_input.starts_with('/');
    let pattern = pattern_input.strip_prefix('/').unwrap_or(pattern_input);
    let path_pattern = pattern.strip_suffix('/').unwrap_or(pattern);
    let prefix = if negated { "!" } else { "" };
    let rebased = format!("{prefix}{base}/{pattern}");
    if anchored || path_pattern.contains('/') {
        vec![rebased]
    } else {
        vec![rebased, format!("{prefix}{base}/**/{pattern}")]
    }
}

#[cfg(test)]
mod tests {
    use super::rebase_ignore_pattern;

    #[test]
    fn rebases_nested_patterns() {
        assert_eq!(rebase_ignore_pattern("nested", "/foo"), ["nested/foo"]);
        assert_eq!(
            rebase_ignore_pattern("nested", "bar/"),
            ["nested/bar/", "nested/**/bar/"]
        );
        assert_eq!(
            rebase_ignore_pattern("nested", "!keep"),
            ["!nested/keep", "!nested/**/keep"]
        );
        assert_eq!(rebase_ignore_pattern("", "x"), ["x"]);
    }
}
