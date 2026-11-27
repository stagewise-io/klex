//! Legacy cut text and the Extended Clipboard pseudo-encoding.

use std::io::Write;

use flate2::Compression;
use flate2::write::ZlibEncoder;

/// Extended Clipboard pseudo-encoding (0xC0A1E5CE).
pub const EXTENDED_CLIPBOARD: i32 = 0xc0a1_e5ce_u32 as i32;

pub const CLIPBOARD_TEXT: u32 = 1;
pub const CLIPBOARD_CAPS: u32 = 1 << 24;
pub const CLIPBOARD_REQUEST: u32 = 1 << 25;
pub const CLIPBOARD_PEEK: u32 = 1 << 26;
pub const CLIPBOARD_NOTIFY: u32 = 1 << 27;
pub const CLIPBOARD_PROVIDE: u32 = 1 << 28;
const ACTIONS: u32 = 0xff00_0000;
const FORMATS: u32 = 0x0000_ffff;

/// Largest clipboard text accepted or offered, in UTF-8 bytes.
pub const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;

const SERVER_CUT_TEXT: u8 = 3;

#[derive(Debug, PartialEq, Eq)]
pub enum ClipboardMessage {
    Caps,
    Request(u32),
    Peek,
    Notify(u32),
    Provide(Option<String>),
    Unknown,
}

/// ServerCutText carrying an extended clipboard payload.
fn server_cut_text(payload: &[u8]) -> Vec<u8> {
    let mut out = vec![SERVER_CUT_TEXT, 0, 0, 0];
    out.extend_from_slice(&(-(payload.len() as i32)).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// The server's capabilities: UTF-8 text with request, notify and provide.
pub fn clipboard_caps() -> Vec<u8> {
    let mut payload = (CLIPBOARD_CAPS
        | CLIPBOARD_REQUEST
        | CLIPBOARD_PEEK
        | CLIPBOARD_NOTIFY
        | CLIPBOARD_PROVIDE
        | CLIPBOARD_TEXT)
        .to_be_bytes()
        .to_vec();
    payload.extend_from_slice(&(MAX_CLIPBOARD_BYTES as u32).to_be_bytes());
    server_cut_text(&payload)
}

pub fn clipboard_notify(has_text: bool) -> Vec<u8> {
    let formats = if has_text { CLIPBOARD_TEXT } else { 0 };
    server_cut_text(&(CLIPBOARD_NOTIFY | formats).to_be_bytes())
}

pub fn clipboard_request() -> Vec<u8> {
    server_cut_text(&(CLIPBOARD_REQUEST | CLIPBOARD_TEXT).to_be_bytes())
}

fn crlf(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push_str("\r\n");
            }
            '\n' => out.push_str("\r\n"),
            _ => out.push(character),
        }
    }
    out
}

/// Text as the protocol wants it: UTF-8, CRLF line ends, NUL-terminated.
pub fn clipboard_provide(text: &str) -> Vec<u8> {
    let mut encoded = crlf(text).into_bytes();
    encoded.push(0);
    let mut body = (encoded.len() as u32).to_be_bytes().to_vec();
    body.extend_from_slice(&encoded);
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    let _ = encoder.write_all(&body);
    let mut payload = (CLIPBOARD_PROVIDE | CLIPBOARD_TEXT).to_be_bytes().to_vec();
    payload.extend_from_slice(&encoder.finish().unwrap_or_default());
    server_cut_text(&payload)
}

/// Legacy ServerCutText: Latin-1 only.
pub fn legacy_cut_text(text: &str) -> Vec<u8> {
    let body: Vec<u8> = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .map(|character| {
            let code = character as u32;
            if code <= 0xff { code as u8 } else { b'?' }
        })
        .collect();
    let mut out = vec![SERVER_CUT_TEXT, 0, 0, 0];
    out.extend_from_slice(&(body.len() as i32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

/// Text from a legacy ClientCutText, which is Latin-1.
pub fn decode_legacy_cut_text(data: &[u8]) -> String {
    normalize(
        &data
            .iter()
            .map(|byte| char::from(*byte))
            .collect::<String>(),
    )
}

/// Parses the payload of a ClientCutText with a negative length.
pub fn parse_clipboard_message(payload: &[u8]) -> ClipboardMessage {
    if payload.len() < 4 {
        return ClipboardMessage::Unknown;
    }
    let value = u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]);
    let actions = value & ACTIONS;
    let formats = value & FORMATS;
    if actions & CLIPBOARD_CAPS != 0 {
        return ClipboardMessage::Caps;
    }
    match actions {
        CLIPBOARD_REQUEST => ClipboardMessage::Request(formats),
        CLIPBOARD_PEEK => ClipboardMessage::Peek,
        CLIPBOARD_NOTIFY => ClipboardMessage::Notify(formats),
        CLIPBOARD_PROVIDE => ClipboardMessage::Provide(read_provided_text(payload, formats)),
        _ => ClipboardMessage::Unknown,
    }
}

/// Viewers flush rather than finish the stream, so it has no end marker.
fn inflate_flushed(data: &[u8], limit: usize) -> Option<Vec<u8>> {
    let mut inflater = flate2::Decompress::new(true);
    let mut out = Vec::with_capacity(limit.min(64 * 1024) + 1);
    loop {
        if out.len() == out.capacity() {
            if out.len() > limit {
                return None;
            }
            out.reserve((out.len()).clamp(1024, limit + 1 - out.len()));
        }
        let read = inflater.total_in() as usize;
        let written = inflater.total_out();
        let status = inflater
            .decompress_vec(&data[read..], &mut out, flate2::FlushDecompress::Sync)
            .ok()?;
        if out.len() > limit {
            return None;
        }
        let progressed = inflater.total_in() as usize != read || inflater.total_out() != written;
        if status == flate2::Status::StreamEnd || !progressed {
            return Some(out);
        }
    }
}

fn read_provided_text(payload: &[u8], formats: u32) -> Option<String> {
    if formats & CLIPBOARD_TEXT == 0 {
        return None;
    }
    let data = inflate_flushed(&payload[4..], MAX_CLIPBOARD_BYTES + 4)?;
    // Formats follow in bit order; text is the lowest, so it comes first.
    if data.len() < 4 {
        return None;
    }
    let size = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    if size > MAX_CLIPBOARD_BYTES || data.len() < 4 + size {
        return None;
    }
    Some(normalize(&String::from_utf8_lossy(&data[4..4 + size])))
}

pub fn normalize(text: &str) -> String {
    text.trim_end_matches('\0')
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::FlushCompress;

    #[test]
    fn provide_round_trips_through_a_flushed_stream() {
        let message = clipboard_provide("one\ntwo\r\nthree");
        assert_eq!(message[0], 3);
        let payload = &message[8..];
        assert_eq!(
            parse_clipboard_message(payload),
            ClipboardMessage::Provide(Some("one\ntwo\nthree".into()))
        );

        let mut body = 3u32.to_be_bytes().to_vec();
        body.extend_from_slice(b"hi\0");
        let mut compressor = flate2::Compress::new(Compression::default(), true);
        let mut flushed = Vec::with_capacity(64);
        compressor
            .compress_vec(&body, &mut flushed, FlushCompress::Sync)
            .unwrap();
        let mut viewer = (CLIPBOARD_PROVIDE | CLIPBOARD_TEXT).to_be_bytes().to_vec();
        viewer.extend_from_slice(&flushed);
        assert_eq!(
            parse_clipboard_message(&viewer),
            ClipboardMessage::Provide(Some("hi".into()))
        );
    }

    #[test]
    fn legacy_text_is_latin1() {
        assert_eq!(&legacy_cut_text("a\r\nb€")[8..], b"a\nb?");
        assert_eq!(decode_legacy_cut_text(b"x\r\ny\0"), "x\ny");
        assert_eq!(
            parse_clipboard_message(&CLIPBOARD_NOTIFY.to_be_bytes()),
            ClipboardMessage::Notify(0)
        );
    }
}
