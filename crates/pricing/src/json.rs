//! A JSON value that keeps object members in `JSON.parse` order. The table version hashes
//! `JSON.stringify` output, so member order and number formatting have to match JavaScript.
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::{collections::HashMap, fmt};

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    /// The members of an object, in order; empty for any other value.
    pub fn members(&self) -> &[(String, Json)] {
        match self {
            Json::Object(members) => members,
            _ => &[],
        }
    }

    /// The named member of an object.
    pub fn get(&self, key: &str) -> Option<&Json> {
        self.members()
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    /// `JSON.stringify(value)`: no whitespace, JavaScript number formatting and string escapes.
    pub fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            // Non-finite numbers stringify as null; `-0` prints as `0`.
            Json::Number(value) if value.is_finite() => out.push_str(ryu_js::Buffer::new().format_finite(*value)),
            Json::Number(_) => out.push_str("null"),
            Json::String(value) => write_string(value, out),
            Json::Array(items) => {
                out.push('[');
                for (at, item) in items.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Object(members) => {
                out.push('{');
                for (at, (key, value)) in members.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    write_string(key, out);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_string(value: &str, out: &mut String) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Object members under JavaScript's property rules: setting an existing key replaces its value in place,
/// and keys that are array indices come first, in numeric order.
#[derive(Default)]
pub(crate) struct ObjectBuilder {
    members: Vec<(String, Json)>,
    index: HashMap<String, usize>,
}

impl ObjectBuilder {
    pub(crate) fn set(&mut self, key: String, value: Json) {
        match self.index.get(&key) {
            Some(&at) => self.members[at].1 = value,
            None => {
                self.index.insert(key.clone(), self.members.len());
                self.members.push((key, value));
            }
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.members.len()
    }

    pub(crate) fn build(mut self) -> Json {
        self.members
            .sort_by_key(|(key, _)| array_index(key).map_or((1u8, 0u32), |index| (0, index)));
        Json::Object(self.members)
    }
}

/// A canonical array index: digits without a leading zero, below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let canonical = !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit()) && (key == "0" || !key.starts_with('0'));
    canonical
        .then(|| key.parse().ok())
        .flatten()
        .filter(|&index| index < u32::MAX)
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Any;
        impl<'de> Visitor<'de> for Any {
            type Value = Json;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
                Ok(Json::Bool(value))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
                Ok(Json::Number(value as f64))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
                Ok(Json::Number(value as f64))
            }
            fn visit_f64<E>(self, value: f64) -> Result<Json, E> {
                Ok(Json::Number(value))
            }
            fn visit_str<E>(self, value: &str) -> Result<Json, E> {
                Ok(Json::String(value.to_owned()))
            }
            fn visit_string<E>(self, value: String) -> Result<Json, E> {
                Ok(Json::String(value))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut object = ObjectBuilder::default();
                while let Some((key, value)) = map.next_entry()? {
                    object.set(key, value);
                }
                Ok(object.build())
            }
        }
        deserializer.deserialize_any(Any)
    }
}
