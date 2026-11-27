//! JavaScript strings are measured in UTF-16 code units. Cursors, buffer
//! bounds and output tails keep those units so clients see the same numbers.

pub fn len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(text.length - max)`, without splitting a surrogate pair.
pub fn tail(text: &str, max: usize) -> &str {
    let total = len(text);
    if total <= max {
        return text;
    }
    let mut skip = total - max;
    for (index, character) in text.char_indices() {
        if skip == 0 {
            return &text[index..];
        }
        skip = skip.saturating_sub(character.len_utf16());
    }
    ""
}

/// Incremental UTF-8 decoding with `StringDecoder` semantics: incomplete
/// trailing sequences wait for the next chunk, invalid bytes become U+FFFD.
#[derive(Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn write(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let keep = incomplete_suffix(&self.pending);
        let complete = self.pending.len() - keep;
        let text = String::from_utf8_lossy(&self.pending[..complete]).into_owned();
        self.pending.drain(..complete);
        text
    }

    pub fn end(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}

fn incomplete_suffix(bytes: &[u8]) -> usize {
    let start = bytes.len().saturating_sub(3);
    for index in (start..bytes.len()).rev() {
        let byte = bytes[index];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue;
        }
        let needed = match byte {
            0b1100_0000..=0b1101_1111 => 2,
            0b1110_0000..=0b1110_1111 => 3,
            0b1111_0000..=0b1111_0111 => 4,
            _ => return 0,
        };
        let available = bytes.len() - index;
        return if available < needed { available } else { 0 };
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_and_tails_in_code_units() {
        assert_eq!(len("a😀"), 3);
        assert_eq!(tail("abc😀", 2), "😀");
        assert_eq!(tail("abc😀", 3), "c😀");
        assert_eq!(tail("abc", 10), "abc");
    }

    #[test]
    fn decodes_split_sequences() {
        let mut decoder = Utf8Decoder::default();
        let bytes = "ü😀".as_bytes();
        assert_eq!(decoder.write(&bytes[..1]), "");
        assert_eq!(decoder.write(&bytes[1..4]), "ü");
        assert_eq!(decoder.write(&bytes[4..]), "😀");
        assert_eq!(decoder.write(&[0xff, b'a']), "\u{fffd}a");
        assert_eq!(decoder.write(&[0xe2]), "");
        assert_eq!(decoder.end(), "\u{fffd}");
    }
}
