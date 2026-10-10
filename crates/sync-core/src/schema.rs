//! Field types: how an app reads a field's entries (PROTOCOL.md table).
//! The server never sees these; they only shape writes and reads on the
//! phone. Fields an app doesn't declare read as `value` when they only
//! have a plain entry, and as a `{sub: value}` map otherwise.

use crate::SyncError;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FieldKind {
    /// One value; the newest write wins.
    Value,
    /// A fractional position string (see `position_between`).
    Position,
    /// A document id in the same collection, or null. Loops are refused.
    Parent,
    /// Members added and removed independently.
    Set,
    /// A number every device adds to independently.
    Counter,
    /// A reference to a file stored elsewhere (e.g. a content hash).
    Blob,
}

impl FieldKind {
    pub fn parse(s: &str) -> Option<FieldKind> {
        Some(match s {
            "value" => FieldKind::Value,
            "position" => FieldKind::Position,
            "parent" => FieldKind::Parent,
            "set" => FieldKind::Set,
            "counter" => FieldKind::Counter,
            "blob" => FieldKind::Blob,
            _ => return None,
        })
    }
}

/// Either an app's schema file as it is,
///
/// `{ "collections": { "groceries": { "name": { "merge": "value", "type": "string" } } } }`
///
/// (keys starting with `$` and a field's `type` are ignored here), or the
/// short form `{ "groceries": { "name": "value", "tags": "set" } }`.
#[derive(Clone, Debug, Default)]
pub struct Schema {
    collections: HashMap<String, HashMap<String, FieldKind>>,
}

impl Schema {
    pub fn from_json(json: &str) -> Result<Schema, SyncError> {
        let bad = |e: String| SyncError::Schema(e);
        let mut root: serde_json::Value =
            serde_json::from_str(json).map_err(|e| bad(e.to_string()))?;
        // The schema file wraps its collections and spells each field as an
        // object; the short form (which may itself have a collection named
        // "collections") spells fields as strings.
        let wrapped = root
            .get("collections")
            .and_then(|c| c.as_object())
            .is_some_and(|cs| {
                cs.iter()
                    .filter(|(k, _)| !k.starts_with('$'))
                    .all(|(_, fields)| {
                        fields.as_object().is_some_and(|fs| {
                            fs.iter()
                                .filter(|(k, _)| !k.starts_with('$'))
                                .all(|(_, f)| f.is_object())
                        })
                    })
            });
        if wrapped {
            root = root["collections"].take();
        }
        let raw = root
            .as_object()
            .ok_or_else(|| bad("expected an object of collections".into()))?;
        let mut collections = HashMap::new();
        for (c, fields) in raw.iter().filter(|(k, _)| !k.starts_with('$')) {
            let fields = fields
                .as_object()
                .ok_or_else(|| bad(format!("{c}: expected an object of fields")))?;
            let mut kinds = HashMap::new();
            for (f, spec) in fields.iter().filter(|(k, _)| !k.starts_with('$')) {
                let kind = spec
                    .as_str()
                    .or_else(|| spec.get("merge").and_then(|m| m.as_str()));
                let k = kind
                    .and_then(FieldKind::parse)
                    .ok_or_else(|| bad(format!("{c}.{f}: unknown field type {spec}")))?;
                kinds.insert(f.clone(), k);
            }
            collections.insert(c.clone(), kinds);
        }
        Ok(Schema { collections })
    }

    pub fn kind(&self, c: &str, f: &str) -> Option<FieldKind> {
        self.collections.get(c)?.get(f).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_schema_file_and_the_short_form() {
        let file = r#"{
          "$comment": "an app's schema",
          "collections": {
            "groceries": {
              "name": { "merge": "value", "type": "string", "$comment": "shown" },
              "tags": { "merge": "set", "type": "string" }
            }
          }
        }"#;
        let short = r#"{ "groceries": { "name": "value", "tags": "set" } }"#;
        for json in [file, short] {
            let s = Schema::from_json(json).unwrap();
            assert_eq!(s.kind("groceries", "name"), Some(FieldKind::Value));
            assert_eq!(s.kind("groceries", "tags"), Some(FieldKind::Set));
            assert_eq!(s.kind("groceries", "nope"), None);
        }
        // A short-form collection that happens to be called "collections".
        let s = Schema::from_json(r#"{ "collections": { "name": "value" } }"#).unwrap();
        assert_eq!(s.kind("collections", "name"), Some(FieldKind::Value));
        assert!(Schema::from_json(r#"{ "g": { "x": { "merge": "nope" } } }"#).is_err());
    }
}
