//! Owned buffers erase on ordinary drop, including parser rejection/cancellation.
//! This does not promise erasure of reqwest/serde internal allocations or copies
//! retained by the caller, and cannot cover process termination.
use crate::{EncryptedSessionError as Error, EncryptedSessionResult as Result};
use serde::{
    de::{MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{Map, Number, Value};
use std::{
    fmt,
    sync::atomic::{compiler_fence, Ordering},
};

fn erase(bytes: &mut [u8]) {
    for byte in bytes {
        // SAFETY: each pointer is valid, uniquely borrowed, and within the slice.
        // Volatile writes plus the compiler fence prevent dead-store elimination.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}
fn erase_string(text: String) {
    let mut bytes = text.into_bytes();
    erase(&mut bytes);
}
pub(super) struct SecretBytes(pub Vec<u8>);
impl Drop for SecretBytes {
    fn drop(&mut self) {
        erase(&mut self.0);
    }
}
pub(super) struct SecretJson(pub Value);
impl SecretJson {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let mut parser = serde_json::Deserializer::from_slice(bytes);
        let value = Self::deserialize(&mut parser)
            .map_err(|_| Error::InvalidResponse("invalid or duplicate migration JSON"))?;
        parser
            .end()
            .map_err(|_| Error::InvalidResponse("trailing migration JSON"))?;
        Ok(value)
    }
    pub fn take(mut self) -> Value {
        std::mem::take(&mut self.0)
    }
}
impl Drop for SecretJson {
    fn drop(&mut self) {
        let mut pending = vec![std::mem::take(&mut self.0)];
        while let Some(value) = pending.pop() {
            match value {
                Value::String(text) => erase_string(text),
                Value::Array(values) => pending.extend(values),
                Value::Object(values) => {
                    for (key, value) in values {
                        erase_string(key);
                        pending.push(value);
                    }
                }
                _ => {}
            }
        }
    }
}
impl<'de> Deserialize<'de> for SecretJson {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Strict;
        impl<'de> Visitor<'de> for Strict {
            type Value = SecretJson;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("unambiguous JSON")
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(SecretJson(Value::Null))
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                b: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(SecretJson(Value::Bool(b)))
            }
            fn visit_i64<E: serde::de::Error>(self, n: i64) -> std::result::Result<Self::Value, E> {
                Ok(SecretJson(Value::Number(n.into())))
            }
            fn visit_u64<E: serde::de::Error>(self, n: u64) -> std::result::Result<Self::Value, E> {
                Ok(SecretJson(Value::Number(n.into())))
            }
            fn visit_f64<E: serde::de::Error>(self, n: f64) -> std::result::Result<Self::Value, E> {
                Number::from_f64(n)
                    .map(|n| SecretJson(Value::Number(n)))
                    .ok_or_else(|| E::custom("invalid number"))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                s: &str,
            ) -> std::result::Result<Self::Value, E> {
                self.visit_string(s.to_owned())
            }
            fn visit_string<E: serde::de::Error>(
                self,
                s: String,
            ) -> std::result::Result<Self::Value, E> {
                Ok(SecretJson(Value::String(s)))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut result = SecretJson(Value::Array(Vec::new()));
                while let Some(value) = a.next_element::<SecretJson>()? {
                    result.0.as_array_mut().unwrap().push(value.take());
                }
                Ok(result)
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut result = SecretJson(Value::Object(Map::new()));
                while let Some(key) = a.next_key::<String>()? {
                    let key = SecretJson(Value::String(key));
                    let name = key.0.as_str().unwrap();
                    if result.0.as_object().unwrap().contains_key(name) {
                        return Err(serde::de::Error::custom("duplicate JSON key"));
                    }
                    let value = a.next_value::<SecretJson>()?;
                    let Value::String(name) = key.take() else {
                        unreachable!()
                    };
                    result.0.as_object_mut().unwrap().insert(name, value.take());
                }
                Ok(result)
            }
        }
        d.deserialize_any(Strict)
    }
}
