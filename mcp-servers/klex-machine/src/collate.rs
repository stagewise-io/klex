//! `String.prototype.localeCompare` with Node's default ICU collation, used
//! wherever the TypeScript server sorts names or paths.

use std::cmp::Ordering;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};

static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(Default::default(), CollatorOptions::default())
        .expect("compiled collation data is available")
});

pub fn locale_compare(left: &str, right: &str) -> Ordering {
    COLLATOR.compare(left, right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_like_icu_root() {
        let mut names = vec!["z.txt", "B.txt", "a.txt", "_x", "ü.ts", "u.ts", "10", "9"];
        names.sort_by(|left, right| locale_compare(left, right));
        assert_eq!(
            names,
            ["_x", "10", "9", "a.txt", "B.txt", "u.ts", "ü.ts", "z.txt"]
        );
    }
}
