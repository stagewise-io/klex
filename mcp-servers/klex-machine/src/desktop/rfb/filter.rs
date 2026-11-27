//! Client-to-server RFB parsing for the Cloud stream relay: viewer input is
//! dropped unless the viewer holds the desktop.

const SECURITY_NONE: u8 = 1;
/// Larger client messages are refused instead of buffered without bound.
pub const MAX_RFB_CLIENT_MESSAGE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RfbProtocolError(pub String);

impl std::fmt::Display for RfbProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn protocol_error(message: impl Into<String>) -> RfbProtocolError {
    RfbProtocolError(message.into())
}

/// The minor version of an `RFB 003.xxx\n` greeting.
pub fn parse_version(message: &[u8]) -> Result<u32, RfbProtocolError> {
    let invalid = || protocol_error("Invalid RFB protocol version");
    if message.len() != 12 || !message.starts_with(b"RFB 003.") || message[11] != b'\n' {
        return Err(invalid());
    }
    let digits = &message[8..11];
    if !digits.iter().all(u8::is_ascii_digit) {
        return Err(invalid());
    }
    Ok(digits
        .iter()
        .fold(0, |value, digit| value * 10 + u32::from(digit - b'0')))
}

/// Length of the client message at the start of `data`, or `None` until
/// enough of it has arrived to tell.
pub fn message_length(data: &[u8]) -> Result<Option<usize>, RfbProtocolError> {
    let Some(&kind) = data.first() else {
        return Ok(None);
    };
    let length = match kind {
        0 => return Ok(Some(20)),
        3 | 150 => return Ok(Some(10)),
        4 => return Ok(Some(8)),
        5 => return Ok(Some(6)),
        2 => (data.len() >= 4).then(|| 4 + 4 * u16::from_be_bytes([data[2], data[3]]) as usize),
        // ClientCutText; negative lengths carry extended clipboard data.
        6 => (data.len() >= 8).then(|| {
            8 + i64::from(i32::from_be_bytes([data[4], data[5], data[6], data[7]])).unsigned_abs()
                as usize
        }),
        248 => return Ok((data.len() >= 9).then(|| 9 + data[8] as usize)),
        251 => (data.len() >= 8).then(|| 8 + 16 * data[6] as usize),
        255 => {
            let Some(&sub) = data.get(1) else {
                return Ok(None);
            };
            if sub == 0 {
                return Ok(Some(12));
            }
            return Err(protocol_error(format!(
                "Unsupported QEMU client message {sub}"
            )));
        }
        _ => {
            return Err(protocol_error(format!(
                "Unsupported RFB client message type {kind}"
            )));
        }
    };
    if let Some(length) = length
        && length > MAX_RFB_CLIENT_MESSAGE_BYTES
    {
        return Err(protocol_error(format!(
            "RFB client message exceeds {MAX_RFB_CLIENT_MESSAGE_BYTES} bytes"
        )));
    }
    Ok(length)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Version,
    Security,
    Init,
    Messages,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InputCounts {
    pub forwarded: u64,
    pub dropped: u64,
}

/// Parses the client-to-server half of an RFB 3.3/3.7/3.8 session and drops
/// input (keys, pointer, clipboard, resize) unless input is allowed. Messages
/// are reassembled across arbitrary chunk boundaries; an unknown message type
/// cannot be skipped safely, so it ends the stream.
pub struct RfbClientFilter {
    phase: Phase,
    buffer: Vec<u8>,
    pub input: InputCounts,
}

impl Default for RfbClientFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl RfbClientFilter {
    pub fn new() -> Self {
        Self {
            phase: Phase::Version,
            buffer: Vec::new(),
            input: InputCounts::default(),
        }
    }

    pub fn push(&mut self, chunk: &[u8], allow_input: bool) -> Result<Vec<u8>, RfbProtocolError> {
        self.buffer.extend_from_slice(chunk);
        let mut forward = Vec::new();
        let mut start = 0;
        loop {
            let data = &self.buffer[start..];
            let length = match self.phase {
                Phase::Version => Some(12),
                Phase::Security | Phase::Init => Some(1),
                Phase::Messages => message_length(data)?,
            };
            let Some(length) = length.filter(|length| data.len() >= *length) else {
                break;
            };
            let message = &data[..length];
            match self.phase {
                Phase::Version => {
                    // 3.3 has no client security choice; the server picks None.
                    self.phase = if parse_version(message)? >= 7 {
                        Phase::Security
                    } else {
                        Phase::Init
                    };
                    forward.extend_from_slice(message);
                }
                Phase::Security => {
                    if message[0] != SECURITY_NONE {
                        return Err(protocol_error("Only RFB security type None is relayed"));
                    }
                    self.phase = Phase::Init;
                    forward.extend_from_slice(message);
                }
                Phase::Init => {
                    self.phase = Phase::Messages;
                    // Never let a viewer disconnect other clients with a non-shared init.
                    forward.push(1);
                }
                Phase::Messages => {
                    if !matches!(message[0], 4 | 5 | 6 | 251 | 255) {
                        forward.extend_from_slice(message);
                    } else if allow_input {
                        self.input.forwarded += 1;
                        forward.extend_from_slice(message);
                    } else {
                        self.input.dropped += 1;
                    }
                }
            }
            start += length;
        }
        self.buffer.drain(..start);
        Ok(forward)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_init_and_drops_input_without_control() {
        let mut filter = RfbClientFilter::new();
        let mut handshake = b"RFB 003.008\n".to_vec();
        handshake.extend_from_slice(&[1, 0]);
        assert_eq!(
            filter.push(&handshake[..5], false).unwrap(),
            Vec::<u8>::new()
        );
        let out = filter.push(&handshake[5..], false).unwrap();
        assert_eq!(&out[..12], b"RFB 003.008\n");
        assert_eq!(&out[12..], &[1, 1]);
        let pointer = [5, 1, 0, 10, 0, 20];
        let request = [3, 0, 0, 0, 0, 0, 0, 10, 0, 10];
        let mut both = pointer.to_vec();
        both.extend_from_slice(&request);
        assert_eq!(filter.push(&both, false).unwrap(), request.to_vec());
        assert_eq!(filter.push(&pointer, true).unwrap(), pointer.to_vec());
        assert_eq!(
            filter.input,
            InputCounts {
                forwarded: 1,
                dropped: 1
            }
        );
    }

    #[test]
    fn refuses_unknown_and_oversized_messages() {
        let mut filter = RfbClientFilter::new();
        filter.push(b"RFB 003.003\n\x01", false).unwrap();
        assert_eq!(
            filter.push(&[9], false).unwrap_err().0,
            "Unsupported RFB client message type 9"
        );
        assert_eq!(
            message_length(&[6, 0, 0, 0, 0x80, 0, 0, 0]).unwrap_err().0,
            "RFB client message exceeds 1048576 bytes"
        );
        assert_eq!(
            message_length(&[255, 1]).unwrap_err().0,
            "Unsupported QEMU client message 1"
        );
    }
}
