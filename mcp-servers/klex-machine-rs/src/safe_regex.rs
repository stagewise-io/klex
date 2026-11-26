//! `safe-regex2`: a pattern is unsafe when a repetition is nested inside
//! another (star height above one), when it has more than 25 repetitions, or
//! when it cannot be parsed.

const REPETITION_LIMIT: usize = 25;

pub fn is_safe(pattern: &str) -> bool {
    let characters: Vec<char> = pattern.chars().collect();
    let mut parser = Parser {
        characters: &characters,
        index: 0,
        repetitions: 0,
    };
    match parser.sequence(0) {
        Some(_) => parser.index == characters.len(),
        None => false,
    }
}

struct Parser<'a> {
    characters: &'a [char],
    index: usize,
    repetitions: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.characters.get(self.index).copied()
    }

    /// Parses alternatives until `)` or the end. Returns the largest star
    /// height inside, or `None` when unsafe or malformed.
    fn sequence(&mut self, depth: usize) -> Option<usize> {
        let mut height = 0;
        let mut previous: Option<usize> = None;
        while let Some(character) = self.peek() {
            match character {
                ')' => {
                    if depth == 0 {
                        return None;
                    }
                    return Some(height);
                }
                '|' => {
                    self.index += 1;
                    previous = None;
                }
                '(' => {
                    self.index += 1;
                    if self.peek() == Some('?') {
                        self.index += 1;
                        match self.peek() {
                            Some(':' | '=' | '!') => self.index += 1,
                            Some('<') => {
                                self.index += 1;
                                if matches!(self.peek(), Some('=' | '!')) {
                                    self.index += 1;
                                } else {
                                    while self.peek().is_some_and(|next| next != '>') {
                                        self.index += 1;
                                    }
                                    self.peek()?;
                                    self.index += 1;
                                }
                            }
                            _ => return None,
                        }
                    }
                    let inner = self.sequence(depth + 1)?;
                    if self.peek() != Some(')') {
                        return None;
                    }
                    self.index += 1;
                    height = height.max(inner);
                    previous = Some(inner);
                }
                '[' => {
                    self.index += 1;
                    if self.peek() == Some('^') {
                        self.index += 1;
                    }
                    loop {
                        match self.peek()? {
                            ']' => break,
                            '\\' => self.index += 2,
                            _ => self.index += 1,
                        }
                    }
                    self.index += 1;
                    previous = Some(0);
                }
                '\\' => {
                    self.index += 1;
                    self.peek()?;
                    self.index += 1;
                    previous = Some(0);
                }
                '*' | '+' | '?' => {
                    let inner = previous.take()?;
                    self.index += 1;
                    if self.peek() == Some('?') {
                        self.index += 1;
                    }
                    height = height.max(self.repeat(inner)?);
                }
                '{' if self.quantifier_end().is_some() => {
                    let end = self.quantifier_end()?;
                    let inner = previous.take()?;
                    self.index = end + 1;
                    if self.peek() == Some('?') {
                        self.index += 1;
                    }
                    height = height.max(self.repeat(inner)?);
                }
                '^' | '$' => {
                    self.index += 1;
                    previous = None;
                }
                _ => {
                    self.index += 1;
                    previous = Some(0);
                }
            }
        }
        if depth > 0 {
            return None;
        }
        Some(height)
    }

    fn repeat(&mut self, inner: usize) -> Option<usize> {
        self.repetitions += 1;
        let height = inner + 1;
        if height > 1 || self.repetitions > REPETITION_LIMIT {
            return None;
        }
        Some(height)
    }

    /// End index of a `{n}`, `{n,}` or `{n,m}` quantifier at the cursor.
    fn quantifier_end(&self) -> Option<usize> {
        let mut index = self.index + 1;
        let start = index;
        while self.characters.get(index)?.is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return None;
        }
        if self.characters.get(index) == Some(&',') {
            index += 1;
            while self.characters.get(index)?.is_ascii_digit() {
                index += 1;
            }
        }
        (self.characters.get(index) == Some(&'}')).then_some(index)
    }
}

#[cfg(test)]
mod tests {
    use super::is_safe;

    #[test]
    fn flags_nested_repetition() {
        assert!(is_safe("needle"));
        assert!(is_safe("a+b*c?"));
        assert!(is_safe("(ab)+"));
        assert!(is_safe("[a-z]+\\d{2,3}"));
        assert!(is_safe("(?:foo|bar)baz"));
        assert!(!is_safe("(a+)+$"));
        assert!(!is_safe("(a*)*"));
        assert!(!is_safe("(x{1,2})+"));
        assert!(!is_safe("["));
        assert!(!is_safe("(a"));
        assert!(!is_safe("a)"));
        assert!(!is_safe("*a"));
        assert!(!is_safe(&"a*".repeat(26)));
        assert!(is_safe(&"a*".repeat(25)));
    }
}
