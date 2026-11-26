//! The subset of fast-glob the search tools use: picomatch-style segment
//! patterns (`*`, `?`, `**`, classes, braces, extglobs), the `dot` rule,
//! ignore patterns, no symlink following, and a bounded candidate count.

use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;

use crate::fs_error;

pub const MAX_CANDIDATES: usize = 100_000;

pub struct EnumerateOptions<'a> {
    pub dot: bool,
    pub ignore: &'a [String],
    pub only_files: bool,
}

pub struct Entry {
    pub path: PathBuf,
    pub is_dir: bool,
}

pub struct Enumeration {
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

#[derive(Debug)]
enum Segment {
    Globstar,
    Literal(String),
    Pattern { regex: Regex, explicit_dot: bool },
}

#[derive(Debug)]
struct Pattern {
    segments: Vec<Segment>,
}

impl Pattern {
    fn parse(source: &str) -> Vec<Self> {
        expand_braces(source)
            .into_iter()
            .map(|expanded| {
                let trimmed = expanded.strip_prefix("./").unwrap_or(&expanded);
                let mut segments: Vec<Segment> = Vec::new();
                for (index, part) in trimmed.split('/').enumerate() {
                    if part.is_empty() && index > 0 {
                        continue;
                    }
                    let segment = compile_segment(part);
                    if matches!(segment, Segment::Globstar)
                        && matches!(segments.last(), Some(Segment::Globstar))
                    {
                        continue;
                    }
                    segments.push(segment);
                }
                Self { segments }
            })
            .collect()
    }

    /// Pattern states reachable after `**` segments match nothing.
    fn closure(&self, states: &mut Vec<usize>) {
        let mut index = 0;
        while index < states.len() {
            let state = states[index];
            if matches!(self.segments.get(state), Some(Segment::Globstar))
                && !states.contains(&(state + 1))
            {
                states.push(state + 1);
            }
            index += 1;
        }
    }

    fn step(&self, states: &[usize], name: &str, dot: bool) -> Vec<usize> {
        let mut next = Vec::new();
        let hidden = name.starts_with('.');
        for &state in states {
            match self.segments.get(state) {
                Some(Segment::Globstar)
                    if (dot || !hidden)
                        && name != "."
                        && name != ".."
                        && !next.contains(&state) =>
                {
                    next.push(state);
                }
                Some(Segment::Literal(literal))
                    if literal == name && !next.contains(&(state + 1)) =>
                {
                    next.push(state + 1);
                }
                Some(Segment::Pattern {
                    regex,
                    explicit_dot,
                }) if (dot || !hidden || *explicit_dot)
                    && name != "."
                    && name != ".."
                    && regex.is_match(name)
                    && !next.contains(&(state + 1)) =>
                {
                    next.push(state + 1);
                }
                _ => {}
            }
        }
        self.closure(&mut next);
        next
    }

    fn start(&self) -> Vec<usize> {
        let mut states = vec![0];
        self.closure(&mut states);
        states
    }

    fn states_for(&self, segments: &[String], dot: bool) -> Vec<usize> {
        let mut states = self.start();
        for name in segments {
            if states.is_empty() {
                break;
            }
            states = self.step(&states, name, dot);
        }
        states
    }

    fn matches(&self, segments: &[String], dot: bool) -> bool {
        self.states_for(segments, dot)
            .contains(&self.segments.len())
    }

    /// Whether some descendant of the directory could match.
    fn may_descend(&self, segments: &[String], dot: bool) -> bool {
        self.states_for(segments, dot)
            .iter()
            .any(|state| *state < self.segments.len())
    }

    /// Leading literal segments: the directory a walk can start from.
    fn base(&self) -> Vec<String> {
        let mut base = Vec::new();
        for segment in &self.segments[..self.segments.len().saturating_sub(1)] {
            match segment {
                Segment::Literal(literal) => base.push(literal.clone()),
                _ => break,
            }
        }
        base
    }

    fn is_absolute(&self) -> bool {
        matches!(self.segments.first(), Some(Segment::Literal(first)) if first.is_empty() || is_drive(first))
    }
}

fn is_drive(segment: &str) -> bool {
    crate::platform::path::DRIVE_ROOTS
        && segment.len() == 2
        && segment.as_bytes()[1] == b':'
        && segment.as_bytes()[0].is_ascii_alphabetic()
}

fn compile_segment(part: &str) -> Segment {
    if part == "**" {
        return Segment::Globstar;
    }
    let mut regex = String::from("^");
    let mut literal = String::new();
    let mut dynamic = false;
    let characters: Vec<char> = part.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        match character {
            '\\' if index + 1 < characters.len() => {
                index += 1;
                literal.push(characters[index]);
                regex.push_str(&regex::escape(&characters[index].to_string()));
            }
            '*' | '?' | '+' | '@' | '!' if characters.get(index + 1) == Some(&'(') => {
                if let Some(end) = closing_paren(&characters, index + 1) {
                    let inner: String = characters[index + 2..end].iter().collect();
                    let alternatives: Vec<String> = split_top_level(&inner, '|')
                        .iter()
                        .map(|alt| extglob_body(alt))
                        .collect();
                    let group = alternatives.join("|");
                    dynamic = true;
                    match character {
                        '*' => regex.push_str(&format!("(?:{group})*")),
                        '?' => regex.push_str(&format!("(?:{group})?")),
                        '+' => regex.push_str(&format!("(?:{group})+")),
                        '@' => regex.push_str(&format!("(?:{group})")),
                        // `!(...)` needs lookahead; treat it as "anything".
                        _ => regex.push_str("[^/]*"),
                    }
                    index = end + 1;
                    continue;
                }
                push_wildcard(character, &mut regex, &mut literal, &mut dynamic);
            }
            '*' | '?' => push_wildcard(character, &mut regex, &mut literal, &mut dynamic),
            '[' => {
                if let Some((class, end)) = character_class(&characters, index) {
                    regex.push_str(&class);
                    dynamic = true;
                    index = end + 1;
                    continue;
                }
                literal.push('[');
                regex.push_str("\\[");
            }
            _ => {
                literal.push(character);
                regex.push_str(&regex::escape(&character.to_string()));
            }
        }
        index += 1;
    }
    if !dynamic {
        return Segment::Literal(literal);
    }
    regex.push('$');
    let explicit_dot = part.starts_with('.') || part.starts_with("\\.");
    match Regex::new(&regex) {
        Ok(regex) => Segment::Pattern {
            regex,
            explicit_dot,
        },
        Err(_) => Segment::Literal(part.to_string()),
    }
}

fn push_wildcard(character: char, regex: &mut String, literal: &mut String, dynamic: &mut bool) {
    *dynamic = true;
    literal.push(character);
    if character == '*' {
        if !regex.ends_with("[^/]*") {
            regex.push_str("[^/]*");
        }
    } else {
        regex.push_str("[^/]");
    }
}

fn extglob_body(source: &str) -> String {
    match compile_segment(source) {
        Segment::Literal(literal) => regex::escape(&literal),
        Segment::Pattern { regex, .. } => {
            let text = regex.as_str();
            text[1..text.len() - 1].to_string()
        }
        Segment::Globstar => "[^/]*".into(),
    }
}

fn closing_paren(characters: &[char], open: usize) -> Option<usize> {
    let mut depth = 0;
    let mut index = open;
    while index < characters.len() {
        match characters[index] {
            '\\' => index += 1,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn split_top_level(source: &str, separator: char) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut depth = 0i32;
    let mut escaped = false;
    for character in source.chars() {
        if escaped {
            parts.last_mut().unwrap().push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' => {
                escaped = true;
                parts.last_mut().unwrap().push(character);
                continue;
            }
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            _ => {}
        }
        if character == separator && depth == 0 {
            parts.push(String::new());
        } else {
            parts.last_mut().unwrap().push(character);
        }
    }
    parts
}

fn character_class(characters: &[char], open: usize) -> Option<(String, usize)> {
    let mut index = open + 1;
    let mut class = String::from("[");
    if matches!(characters.get(index), Some('!' | '^')) {
        class.push('^');
        index += 1;
    }
    let first = index;
    while index < characters.len() {
        let character = characters[index];
        if character == ']' && index > first {
            class.push(']');
            return Some((class, index));
        }
        if character == '[' && characters.get(index + 1) == Some(&':') {
            let rest: String = characters[index..].iter().collect();
            if let Some(end) = rest.find(":]") {
                let name = &rest[2..end];
                let posix = match name {
                    "alnum" => "a-zA-Z0-9",
                    "alpha" => "a-zA-Z",
                    "digit" => "0-9",
                    "lower" => "a-z",
                    "upper" => "A-Z",
                    "space" => " \\t\\r\\n\\v\\f",
                    "xdigit" => "A-Fa-f0-9",
                    "word" => "A-Za-z0-9_",
                    "punct" => "\\-!\"#$%&'()\\*+,./:;<=>?@\\[\\]^_`{|}~",
                    _ => "",
                };
                class.push_str(posix);
                index += end + 2;
                continue;
            }
        }
        match character {
            '\\' if index + 1 < characters.len() => {
                index += 1;
                class.push_str(&regex::escape(&characters[index].to_string()));
            }
            '-' => class.push('-'),
            '/' => return None,
            _ => class.push_str(&regex::escape(&character.to_string())),
        }
        index += 1;
    }
    None
}

/// micromatch brace expansion: `{a,b}` lists (nested) and `{1..3}` ranges.
pub fn expand_braces(pattern: &str) -> Vec<String> {
    let characters: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        match characters[index] {
            '\\' => index += 2,
            '{' => {
                let mut depth = 0;
                let mut end = None;
                let mut cursor = index;
                while cursor < characters.len() {
                    match characters[cursor] {
                        '\\' => cursor += 1,
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                end = Some(cursor);
                                break;
                            }
                        }
                        _ => {}
                    }
                    cursor += 1;
                }
                let Some(end) = end else {
                    return vec![pattern.to_string()];
                };
                let prefix: String = characters[..index].iter().collect();
                let body: String = characters[index + 1..end].iter().collect();
                let suffix: String = characters[end + 1..].iter().collect();
                let alternatives = split_top_level(&body, ',');
                let options = if alternatives.len() > 1 {
                    alternatives
                } else if let Some(range) = expand_range(&body) {
                    range
                } else {
                    index = end + 1;
                    continue;
                };
                return options
                    .iter()
                    .flat_map(|option| expand_braces(&format!("{prefix}{option}{suffix}")))
                    .collect();
            }
            _ => index += 1,
        }
    }
    vec![pattern.to_string()]
}

fn expand_range(body: &str) -> Option<Vec<String>> {
    let (start, end) = body.split_once("..")?;
    if let (Ok(start), Ok(end)) = (start.parse::<i64>(), end.parse::<i64>()) {
        if (start - end).abs() > 10_000 {
            return None;
        }
        let values: Vec<i64> = if start <= end {
            (start..=end).collect()
        } else {
            (end..=start).rev().collect()
        };
        return Some(values.into_iter().map(|value| value.to_string()).collect());
    }
    let (mut start_chars, mut end_chars) = (start.chars(), end.chars());
    let (Some(start), None, Some(end), None) = (
        start_chars.next(),
        start_chars.next(),
        end_chars.next(),
        end_chars.next(),
    ) else {
        return None;
    };
    let (low, high) = (start.min(end) as u32, start.max(end) as u32);
    let mut values: Vec<String> = (low..=high)
        .filter_map(char::from_u32)
        .map(String::from)
        .collect();
    if start > end {
        values.reverse();
    }
    Some(values)
}

fn split_segments(path: &str) -> Vec<String> {
    path.split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

/// Walks `cwd` for entries matching `patterns`, like `fg.stream` with
/// `absolute`, `followSymbolicLinks: false` and `unique`.
pub fn enumerate(
    patterns: &[String],
    cwd: &Path,
    options: &EnumerateOptions<'_>,
) -> Result<Enumeration, String> {
    let mut positive = Vec::new();
    let mut negative: Vec<Pattern> = options
        .ignore
        .iter()
        .flat_map(|pattern| Pattern::parse(pattern))
        .collect();
    for pattern in patterns {
        match pattern.strip_prefix('!') {
            Some(rest) if !rest.starts_with('(') => negative.extend(Pattern::parse(rest)),
            _ => positive.extend(Pattern::parse(pattern)),
        }
    }
    let mut walker = Walker {
        cwd,
        dot: options.dot,
        only_files: options.only_files,
        negative: &negative,
        seen: std::collections::HashSet::new(),
        result: Enumeration {
            entries: Vec::new(),
            truncated: false,
        },
    };
    for pattern in &positive {
        if walker.result.truncated {
            break;
        }
        walker.walk_pattern(pattern)?;
    }
    Ok(walker.result)
}

struct Walker<'a> {
    cwd: &'a Path,
    dot: bool,
    only_files: bool,
    negative: &'a [Pattern],
    seen: std::collections::HashSet<PathBuf>,
    result: Enumeration,
}

impl Walker<'_> {
    fn walk_pattern(&mut self, pattern: &Pattern) -> Result<(), String> {
        let base = pattern.base();
        let start = if pattern.is_absolute() {
            let mut root = if base.first().is_some_and(|first| first.is_empty()) {
                PathBuf::from("/")
            } else {
                PathBuf::from(format!("{}\\", base[0]))
            };
            for part in &base[1..] {
                root.push(part);
            }
            root
        } else {
            let mut root = self.cwd.to_path_buf();
            for part in &base {
                root.push(part);
            }
            root
        };
        let absolute = pattern.is_absolute();
        self.walk_directory(pattern, &start, base, absolute)
    }

    fn walk_directory(
        &mut self,
        pattern: &Pattern,
        directory: &Path,
        segments: Vec<String>,
        absolute: bool,
    ) -> Result<(), String> {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if fs_error::is(&error, "ENOENT") || fs_error::is(&error, "ENOTDIR") => {
                return Ok(());
            }
            Err(error) => return Err(fs_error::message(&error, "scandir", directory)),
        };
        let mut children = Vec::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => return Err(fs_error::message(&error, "scandir", directory)),
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            children.push((entry.file_name().to_string_lossy().into_owned(), file_type));
        }
        for (name, file_type) in children {
            if self.result.truncated {
                return Ok(());
            }
            let mut child_segments = segments.clone();
            child_segments.push(name.clone());
            let path = directory.join(&name);
            let relative = if absolute {
                self.relative_to_cwd(&path)
            } else {
                Some(child_segments.clone())
            };
            if let Some(relative) = &relative
                && self.is_ignored(relative)
            {
                continue;
            }
            let is_dir = file_type.is_dir();
            let pattern_segments = if absolute {
                split_segments(&path.to_string_lossy().replace('\\', "/"))
            } else {
                child_segments.clone()
            };
            if pattern.matches(&self.pattern_view(&pattern_segments, absolute), self.dot)
                && (!self.only_files || file_type.is_file())
                && !self.seen.contains(&path)
            {
                if self.result.entries.len() >= MAX_CANDIDATES {
                    self.result.truncated = true;
                    return Ok(());
                }
                self.seen.insert(path.clone());
                self.result.entries.push(Entry {
                    path: path.clone(),
                    is_dir,
                });
            }
            if is_dir
                && pattern.may_descend(&self.pattern_view(&pattern_segments, absolute), self.dot)
            {
                self.walk_directory(pattern, &path, child_segments, absolute)?;
            }
        }
        Ok(())
    }

    fn pattern_view(&self, segments: &[String], absolute: bool) -> Vec<String> {
        if absolute && !crate::platform::path::DRIVE_ROOTS {
            let mut view = vec![String::new()];
            view.extend(segments.iter().cloned());
            return view;
        }
        segments.to_vec()
    }

    fn relative_to_cwd(&self, path: &Path) -> Option<Vec<String>> {
        path.strip_prefix(self.cwd).ok().map(|relative| {
            relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect()
        })
    }

    fn is_ignored(&self, relative: &[String]) -> bool {
        self.negative
            .iter()
            .any(|pattern| pattern.matches(relative, true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segments(path: &str) -> Vec<String> {
        split_segments(path)
    }

    fn matches(pattern: &str, path: &str, dot: bool) -> bool {
        Pattern::parse(pattern)
            .iter()
            .any(|pattern| pattern.matches(&segments(path), dot))
    }

    #[test]
    fn matches_like_picomatch() {
        assert!(matches("**/*", "src/a.ts", false));
        assert!(matches("**/*", "src", false));
        assert!(!matches("**/*", ".hidden", false));
        assert!(!matches("**/*", "src/.x/a", false));
        assert!(matches("**/*", ".hidden", true));
        assert!(matches("**/.gitignore", ".gitignore", false));
        assert!(matches("**/.gitignore", "a/b/.gitignore", false));
        assert!(matches("src/**/*.ts", "src/a.ts", false));
        assert!(matches("src/**/*.ts", "src/x/y/a.ts", false));
        assert!(!matches("src/**/*.ts", "lib/a.ts", false));
        assert!(matches("*.{ts,tsx}", "a.tsx", false));
        assert!(matches("file[0-9].txt", "file3.txt", false));
        assert!(!matches("file[!0-9].txt", "file3.txt", false));
        assert!(matches("@(a|b).txt", "b.txt", false));
        assert!(matches("nested/**", "nested/deeper/foo/file", true));
        assert!(matches("a?c", "abc", false));
        assert!(matches("x{1..3}", "x2", false));
        assert!(matches("\\*.txt", "*.txt", false));
        assert!(!matches("\\*.txt", "a.txt", false));
    }

    #[test]
    fn expands_braces() {
        assert_eq!(expand_braces("a{b,c{d,e}}f"), ["abf", "acdf", "acef"]);
        assert_eq!(expand_braces("a{b}c"), ["a{b}c"]);
    }
}
