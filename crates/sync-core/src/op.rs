//! Ops: one write to one entry (PROTOCOL.md "Entries and ops").

use crate::hlc::{Hlc, ZERO};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The reserved field that marks a document deleted.
pub const DELETED: &str = "_del";
/// The only `k` there is: asks the server to refuse parent loops.
pub const KIND_PARENT: &str = "parent";
pub const MAX_VALUE_BYTES: usize = 64 * 1024;
pub const MAX_PUSH: usize = 500;
/// The server refuses timestamps further ahead of its clock than this.
pub const MAX_AHEAD_MS: u64 = 10 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Op {
    pub c: String,
    pub d: String,
    pub f: String,
    #[serde(default)]
    pub s: String,
    pub v: Value,
    pub t: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k: Option<String>,
}

impl Op {
    /// A correction saying "there is no entry here".
    pub fn is_absent(&self) -> bool {
        self.t == ZERO
    }

    pub fn validate(&self) -> Result<(), String> {
        check_name("c", &self.c, 64)?;
        check_name("d", &self.d, 128)?;
        check_name("f", &self.f, 64)?;
        if self.f.starts_with('_') && self.f != DELETED {
            return Err(format!("field {:?} is reserved", self.f));
        }
        if self.s.chars().count() > 256 {
            return Err("s is longer than 256 characters".into());
        }
        if serde_json::to_string(&self.v).map(|s| s.len()).unwrap_or(usize::MAX) > MAX_VALUE_BYTES {
            return Err("v is larger than 64 KiB".into());
        }
        if Hlc::parse(&self.t).is_none() {
            return Err(format!("t {:?} is not a timestamp", self.t));
        }
        if let Some(k) = &self.k {
            if k != KIND_PARENT {
                return Err(format!("unknown k {k:?}"));
            }
        }
        Ok(())
    }
}

pub fn is_name(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn check_name(key: &str, s: &str, max: usize) -> Result<(), String> {
    if is_name(s, max) {
        Ok(())
    } else {
        Err(format!("{key} {s:?} must be 1–{max} characters of A-Z a-z 0-9 _ . : -"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn op(f: &str) -> Op {
        Op { c: "groceries".into(), d: "a1".into(), f: f.into(), s: String::new(), v: json!(true),
             t: "001760000000000-0000-0123456789abcdef".into(), k: None }
    }

    #[test]
    fn validates() {
        assert!(op("done").validate().is_ok());
        assert!(op("_del").validate().is_ok());
        assert!(op("_x").validate().is_err());
        assert!(op("a b").validate().is_err());
        let mut o = op("done");
        o.k = Some("tree".into());
        assert!(o.validate().is_err());
        o.k = Some("parent".into());
        assert!(o.validate().is_ok());
        o.v = json!("x".repeat(MAX_VALUE_BYTES));
        assert!(o.validate().is_err());
    }

    #[test]
    fn wire_shape() {
        let o: Op = serde_json::from_str(r#"{"c":"g","d":"a","f":"done","v":true,"t":"001760000000000-0000-0123456789abcdef"}"#).unwrap();
        assert_eq!(o.s, "");
        assert_eq!(serde_json::to_string(&o).unwrap(),
                   r#"{"c":"g","d":"a","f":"done","s":"","v":true,"t":"001760000000000-0000-0123456789abcdef"}"#);
    }
}
