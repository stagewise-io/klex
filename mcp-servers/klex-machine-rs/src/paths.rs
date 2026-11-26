use std::path::{Component, Path, PathBuf};

/// Resolves tool paths like Node's `path.resolve`: lexically, against the
/// server's default working directory, without touching the filesystem.
#[derive(Clone, Debug)]
pub struct MachinePathResolver {
    pub default_cwd: PathBuf,
}

impl MachinePathResolver {
    pub fn new(default_cwd: impl Into<PathBuf>) -> Self {
        Self {
            default_cwd: default_cwd.into(),
        }
    }

    pub fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        if path.is_empty() {
            return Err("Path must not be empty".into());
        }
        Ok(resolve_from(&self.default_cwd, Path::new(path)))
    }
}

pub fn resolve_from(base: &Path, path: &Path) -> PathBuf {
    normalize(&base.join(path))
}

/// Removes `.` and `..` segments and trailing separators.
pub fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => result.push(prefix.as_os_str()),
            Component::RootDir => result.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(
                    result.components().next_back(),
                    None | Some(Component::RootDir | Component::Prefix(_))
                ) {
                    result.pop();
                } else if !result.has_root() {
                    result.push("..");
                }
            }
            Component::Normal(name) => result.push(name),
        }
    }
    if result.as_os_str().is_empty() {
        result.push(".");
    }
    result
}

/// Node's `path.relative(from, to)` joined with `/`, for already-normalized
/// absolute paths.
pub fn relative_slash(from: &Path, to: &Path) -> String {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts: Vec<String> = Vec::new();
    for _ in common..from.len() {
        parts.push("..".into());
    }
    for component in &to[common..] {
        parts.push(component.as_os_str().to_string_lossy().into_owned());
    }
    parts.join("/")
}

pub fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn resolves_like_node() {
        let resolver = MachinePathResolver::new("/work/dir");
        assert_eq!(
            resolver.resolve("a/b").unwrap(),
            PathBuf::from("/work/dir/a/b")
        );
        assert_eq!(
            resolver.resolve("../x/./y/").unwrap(),
            PathBuf::from("/work/x/y")
        );
        assert_eq!(
            resolver.resolve("/abs//p/..").unwrap(),
            PathBuf::from("/abs")
        );
        assert_eq!(resolver.resolve("/../..").unwrap(), PathBuf::from("/"));
        assert_eq!(resolver.resolve("").unwrap_err(), "Path must not be empty");
        assert_eq!(
            relative_slash(Path::new("/a/b"), Path::new("/a/b/c/d")),
            "c/d"
        );
        assert_eq!(relative_slash(Path::new("/a/b"), Path::new("/a/x")), "../x");
        assert_eq!(relative_slash(Path::new("/a/b"), Path::new("/a/b")), "");
    }
}
