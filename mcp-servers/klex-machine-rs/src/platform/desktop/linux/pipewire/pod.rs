//! SPA pods, PipeWire's self-describing binary values: an 8-byte header
//! (body size, type) and a body padded to 8 bytes.

pub const TYPE_NONE: u32 = 1;
pub const TYPE_BOOL: u32 = 2;
pub const TYPE_ID: u32 = 3;
pub const TYPE_INT: u32 = 4;
pub const TYPE_LONG: u32 = 5;
pub const TYPE_FLOAT: u32 = 6;
pub const TYPE_DOUBLE: u32 = 7;
pub const TYPE_STRING: u32 = 8;
pub const TYPE_BYTES: u32 = 9;
pub const TYPE_RECTANGLE: u32 = 10;
pub const TYPE_FRACTION: u32 = 11;
pub const TYPE_ARRAY: u32 = 13;
pub const TYPE_STRUCT: u32 = 14;
pub const TYPE_OBJECT: u32 = 15;
pub const TYPE_FD: u32 = 18;
pub const TYPE_CHOICE: u32 = 19;

pub const CHOICE_RANGE: u32 = 1;
pub const CHOICE_ENUM: u32 = 3;
pub const CHOICE_FLAGS: u32 = 4;

const MAX_DEPTH: usize = 32;

#[derive(Clone, Debug, PartialEq)]
pub struct Property {
    pub key: u32,
    pub flags: u32,
    pub value: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    None,
    Bool(bool),
    Id(u32),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    String(String),
    Bytes(Vec<u8>),
    Rectangle(u32, u32),
    Fraction(u32, u32),
    /// Index into the message's file descriptors.
    Fd(i64),
    Struct(Vec<Value>),
    Object {
        kind: u32,
        id: u32,
        properties: Vec<Property>,
    },
    /// The first value is the default.
    Choice {
        kind: u32,
        values: Vec<Value>,
    },
    Array(Vec<Value>),
    /// A type this client never interprets, kept as its raw body.
    Other(u32, Vec<u8>),
}

impl Value {
    pub fn object(kind: u32, id: u32, properties: Vec<(u32, Value)>) -> Self {
        Self::Object {
            kind,
            id,
            properties: properties
                .into_iter()
                .map(|(key, value)| Property {
                    key,
                    flags: 0,
                    value,
                })
                .collect(),
        }
    }

    pub fn string(text: &str) -> Self {
        Self::String(text.into())
    }

    pub fn as_id(&self) -> Option<u32> {
        match self {
            Self::Id(value) => Some(*value),
            _ => None,
        }
    }

    /// An Int or Id read as an unsigned id, the way the C parser accepts both.
    pub fn as_u32(&self) -> Option<u32> {
        match self {
            Self::Int(value) => Some(*value as u32),
            Self::Id(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_fd(&self) -> Option<i64> {
        match self {
            Self::Fd(value) => Some(*value),
            _ => None,
        }
    }

    /// A choice's current value, or the value itself.
    pub fn current(&self) -> &Value {
        match self {
            Self::Choice { values, .. } => values.first().unwrap_or(self),
            _ => self,
        }
    }

    pub fn property(&self, key: u32) -> Option<&Value> {
        match self {
            Self::Object { properties, .. } => properties
                .iter()
                .find(|property| property.key == key)
                .map(|property| &property.value),
            _ => None,
        }
    }

    fn type_id(&self) -> u32 {
        match self {
            Self::None => TYPE_NONE,
            Self::Bool(_) => TYPE_BOOL,
            Self::Id(_) => TYPE_ID,
            Self::Int(_) => TYPE_INT,
            Self::Long(_) => TYPE_LONG,
            Self::Float(_) => TYPE_FLOAT,
            Self::Double(_) => TYPE_DOUBLE,
            Self::String(_) => TYPE_STRING,
            Self::Bytes(_) => TYPE_BYTES,
            Self::Rectangle(..) => TYPE_RECTANGLE,
            Self::Fraction(..) => TYPE_FRACTION,
            Self::Fd(_) => TYPE_FD,
            Self::Struct(_) => TYPE_STRUCT,
            Self::Object { .. } => TYPE_OBJECT,
            Self::Choice { .. } => TYPE_CHOICE,
            Self::Array(_) => TYPE_ARRAY,
            Self::Other(kind, _) => *kind,
        }
    }

    /// The body alone, unpadded.
    fn body(&self, out: &mut Vec<u8>) {
        match self {
            Self::None => {}
            Self::Bool(value) => put(out, u32::from(*value)),
            Self::Id(value) => put(out, *value),
            Self::Int(value) => out.extend_from_slice(&value.to_ne_bytes()),
            Self::Long(value) => out.extend_from_slice(&value.to_ne_bytes()),
            Self::Float(value) => out.extend_from_slice(&value.to_ne_bytes()),
            Self::Double(value) => out.extend_from_slice(&value.to_ne_bytes()),
            Self::String(value) => {
                out.extend_from_slice(value.as_bytes());
                out.push(0);
            }
            Self::Bytes(value) | Self::Other(_, value) => out.extend_from_slice(value),
            Self::Rectangle(a, b) | Self::Fraction(a, b) => {
                put(out, *a);
                put(out, *b);
            }
            Self::Fd(value) => out.extend_from_slice(&value.to_ne_bytes()),
            Self::Struct(values) => {
                for value in values {
                    value.encode(out);
                }
            }
            Self::Object {
                kind,
                id,
                properties,
            } => {
                put(out, *kind);
                put(out, *id);
                for property in properties {
                    put(out, property.key);
                    put(out, property.flags);
                    property.value.encode(out);
                }
            }
            Self::Choice { kind, values } => {
                put(out, *kind);
                put(out, 0);
                packed(out, values);
            }
            Self::Array(values) => packed(out, values),
        }
    }

    /// Appends the pod, padded to 8 bytes.
    pub fn encode(&self, out: &mut Vec<u8>) {
        let start = out.len();
        put(out, 0);
        put(out, self.type_id());
        self.body(out);
        let size = (out.len() - start - 8) as u32;
        out[start..start + 4].copy_from_slice(&size.to_ne_bytes());
        out.resize(start + 8 + (size as usize).next_multiple_of(8), 0);
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.encode(&mut out);
        out
    }

    /// Parses one pod at the start of `data` and returns it with the padded
    /// length it took.
    pub fn decode(data: &[u8]) -> Result<(Value, usize), String> {
        decode(data, 0)
    }
}

fn put(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_ne_bytes());
}

/// Values of one type without headers, as in choices and arrays.
fn packed(out: &mut Vec<u8>, values: &[Value]) {
    let first = values.first().unwrap_or(&Value::None);
    let mut bodies = Vec::new();
    for value in values {
        value.body(&mut bodies);
    }
    let size = if values.is_empty() {
        0
    } else {
        bodies.len() / values.len()
    };
    put(out, size as u32);
    put(out, first.type_id());
    out.extend_from_slice(&bodies);
}

fn u32_at(data: &[u8], at: usize) -> Result<u32, String> {
    data.get(at..at + 4)
        .map(|bytes| u32::from_ne_bytes(bytes.try_into().unwrap_or_default()))
        .ok_or_else(|| "Truncated pod".to_string())
}

fn decode(data: &[u8], depth: usize) -> Result<(Value, usize), String> {
    if depth > MAX_DEPTH {
        return Err("Pod nested too deeply".into());
    }
    let size = u32_at(data, 0)? as usize;
    let kind = u32_at(data, 4)?;
    let body = data
        .get(8..8 + size)
        .ok_or_else(|| "Truncated pod".to_string())?;
    let value = decode_body(kind, body, depth)?;
    Ok((value, (8 + size).next_multiple_of(8).min(data.len())))
}

fn decode_body(kind: u32, body: &[u8], depth: usize) -> Result<Value, String> {
    let fixed = |len: usize| -> Result<&[u8], String> {
        body.get(..len)
            .ok_or_else(|| format!("Pod of type {kind} is too short"))
    };
    Ok(match kind {
        TYPE_NONE => Value::None,
        TYPE_BOOL => Value::Bool(u32_at(body, 0)? != 0),
        TYPE_ID => Value::Id(u32_at(body, 0)?),
        TYPE_INT => Value::Int(u32_at(body, 0)? as i32),
        TYPE_LONG => Value::Long(i64::from_ne_bytes(fixed(8)?.try_into().unwrap_or_default())),
        TYPE_FLOAT => Value::Float(f32::from_ne_bytes(fixed(4)?.try_into().unwrap_or_default())),
        TYPE_DOUBLE => Value::Double(f64::from_ne_bytes(fixed(8)?.try_into().unwrap_or_default())),
        TYPE_STRING => {
            let end = body
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(body.len());
            Value::String(String::from_utf8_lossy(&body[..end]).into_owned())
        }
        TYPE_BYTES => Value::Bytes(body.to_vec()),
        TYPE_RECTANGLE => Value::Rectangle(u32_at(body, 0)?, u32_at(body, 4)?),
        TYPE_FRACTION => Value::Fraction(u32_at(body, 0)?, u32_at(body, 4)?),
        TYPE_FD => Value::Fd(i64::from_ne_bytes(fixed(8)?.try_into().unwrap_or_default())),
        TYPE_STRUCT => {
            let mut values = Vec::new();
            let mut at = 0;
            while at + 8 <= body.len() {
                let (value, used) = decode(&body[at..], depth + 1)?;
                values.push(value);
                at += used;
            }
            Value::Struct(values)
        }
        TYPE_OBJECT => {
            let object_kind = u32_at(body, 0)?;
            let id = u32_at(body, 4)?;
            let mut properties = Vec::new();
            let mut at = 8;
            while at + 16 <= body.len() {
                let key = u32_at(body, at)?;
                let flags = u32_at(body, at + 4)?;
                let (value, used) = decode(&body[at + 8..], depth + 1)?;
                properties.push(Property { key, flags, value });
                at += 8 + used;
            }
            Value::Object {
                kind: object_kind,
                id,
                properties,
            }
        }
        TYPE_CHOICE => Value::Choice {
            kind: u32_at(body, 0)?,
            values: unpack(body.get(8..).unwrap_or_default(), depth)?,
        },
        TYPE_ARRAY => Value::Array(unpack(body, depth)?),
        _ => Value::Other(kind, body.to_vec()),
    })
}

fn unpack(body: &[u8], depth: usize) -> Result<Vec<Value>, String> {
    let size = u32_at(body, 0)? as usize;
    let kind = u32_at(body, 4)?;
    let items = &body[8..];
    if size == 0 {
        return Ok(Vec::new());
    }
    items
        .chunks_exact(size)
        .map(|item| decode_body(kind, item, depth + 1))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_the_spa_builder() {
        assert_eq!(
            Value::Int(7).to_bytes(),
            [4, 0, 0, 0, 4, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(
            Value::string("ab").to_bytes(),
            [3, 0, 0, 0, 8, 0, 0, 0, b'a', b'b', 0, 0, 0, 0, 0, 0]
        );
        let choice = Value::Choice {
            kind: CHOICE_RANGE,
            values: vec![Value::Int(4), Value::Int(1), Value::Int(8)],
        };
        let bytes = choice.to_bytes();
        assert_eq!(&bytes[..8], [28, 0, 0, 0, 19, 0, 0, 0]);
        assert_eq!(
            &bytes[8..24],
            [1, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 4, 0, 0, 0]
        );
        assert_eq!(bytes.len(), 40);
    }

    #[test]
    fn round_trips_nested_values() {
        let value = Value::Struct(vec![
            Value::Int(-3),
            Value::Long(1 << 40),
            Value::string("client-node"),
            Value::Bool(true),
            Value::Fd(2),
            Value::None,
            Value::object(
                0x40003,
                4,
                vec![
                    (1, Value::Id(2)),
                    (
                        0x20003,
                        Value::Choice {
                            kind: CHOICE_RANGE,
                            values: vec![
                                Value::Rectangle(640, 480),
                                Value::Rectangle(1, 1),
                                Value::Rectangle(8192, 8192),
                            ],
                        },
                    ),
                    (0x20004, Value::Fraction(30, 1)),
                ],
            ),
            Value::Array(vec![Value::Id(1), Value::Id(2)]),
        ]);
        let bytes = value.to_bytes();
        assert_eq!(bytes.len() % 8, 0);
        let (decoded, used) = Value::decode(&bytes).unwrap();
        assert_eq!(used, bytes.len());
        assert_eq!(decoded, value);
        assert_eq!(decoded.clone().to_bytes(), bytes);
        let Value::Struct(items) = decoded else {
            unreachable!()
        };
        assert_eq!(
            items[6].property(0x20003).unwrap().current(),
            &Value::Rectangle(640, 480)
        );
    }

    #[test]
    fn rejects_truncated_input() {
        let bytes = Value::string("hello").to_bytes();
        assert!(Value::decode(&bytes[..10]).is_err());
        assert!(Value::decode(&[1, 2]).is_err());
    }
}
