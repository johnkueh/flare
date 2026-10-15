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
    /// Each field's value JSON type (`string`, `number`, `boolean`,
    /// `object`, `array`), when the schema file gives one.
    types: HashMap<String, HashMap<String, String>>,
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
        let mut types = HashMap::new();
        for (c, fields) in raw.iter().filter(|(k, _)| !k.starts_with('$')) {
            let fields = fields
                .as_object()
                .ok_or_else(|| bad(format!("{c}: expected an object of fields")))?;
            let mut kinds = HashMap::new();
            let mut field_types = HashMap::new();
            for (f, spec) in fields.iter().filter(|(k, _)| !k.starts_with('$')) {
                let kind = spec
                    .as_str()
                    .or_else(|| spec.get("merge").and_then(|m| m.as_str()));
                let k = kind
                    .and_then(FieldKind::parse)
                    .ok_or_else(|| bad(format!("{c}.{f}: unknown field type {spec}")))?;
                kinds.insert(f.clone(), k);
                if let Some(t) = spec.get("type").and_then(|t| t.as_str()) {
                    field_types.insert(f.clone(), t.to_string());
                }
            }
            collections.insert(c.clone(), kinds);
            types.insert(c.clone(), field_types);
        }
        Ok(Schema { collections, types })
    }

    pub fn kind(&self, c: &str, f: &str) -> Option<FieldKind> {
        self.collections.get(c)?.get(f).copied()
    }

    /// Where an app's record and this schema disagree, for a test in the
    /// app. `sample` is one record as the app writes it (its `put_doc`
    /// JSON) with every field filled in; `id` is ignored. Reports fields
    /// the record writes that the schema lacks, fields the schema lists
    /// that the record never writes, and values of the wrong JSON type.
    /// Empty when they agree.
    pub fn check_sample(&self, c: &str, sample: &serde_json::Value) -> Vec<String> {
        let Some(fields) = self.collections.get(c) else {
            return vec![format!("{c}: not in the schema")];
        };
        let Some(sample) = sample.as_object() else {
            return vec![format!("{c}: the sample isn't a JSON object")];
        };
        let mut out = Vec::new();
        for (f, v) in sample.iter().filter(|(f, _)| f.as_str() != "id") {
            let Some(kind) = fields.get(f) else {
                out.push(format!("{c}.{f}: written but not in the schema"));
                continue;
            };
            if v.is_null() {
                out.push(format!("{c}.{f}: null in the sample; fill every field in"));
                continue;
            }
            let expected = self.types.get(c).and_then(|t| t.get(f)).map(String::as_str);
            let wrong = match kind {
                FieldKind::Set => match v.as_array() {
                    None => Some(format!("{}, not an array (a set)", json_type(v))),
                    Some(members) => expected.and_then(|t| {
                        members.iter().find(|m| json_type(m) != t)
                            .map(|m| format!("a {} member, not {t}", json_type(m)))
                    }),
                },
                FieldKind::Counter if !v.is_number() => Some(format!("{}, not number (a counter)", json_type(v))),
                FieldKind::Position if !v.is_string() => Some(format!("{}, not string (a position)", json_type(v))),
                _ => expected.filter(|t| json_type(v) != *t).map(|t| format!("{}, not {t}", json_type(v))),
            };
            if let Some(why) = wrong {
                out.push(format!("{c}.{f}: {why}"));
            }
        }
        let mut missing: Vec<&String> = fields.keys().filter(|f| !sample.contains_key(*f)).collect();
        missing.sort();
        for f in missing {
            out.push(format!("{c}.{f}: in the schema but the record never writes it"));
        }
        out
    }
}

fn json_type(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
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

    #[test]
    fn checks_a_sample_record_against_the_schema() {
        let s = Schema::from_json(r#"{ "collections": { "groceries": {
          "name": { "merge": "value", "type": "string" },
          "done": { "merge": "value", "type": "boolean" },
          "tags": { "merge": "set", "type": "string" },
          "position": { "merge": "position", "type": "string" }
        } } }"#).unwrap();
        let good = serde_json::json!({"id": "x", "name": "Milk", "done": false, "tags": ["dairy"], "position": "V"});
        assert_eq!(s.check_sample("groceries", &good), Vec::<String>::new());
        let bad = serde_json::json!({"name": 3, "done": null, "tags": [1], "qty": 2});
        assert_eq!(s.check_sample("groceries", &bad), vec![
            "groceries.done: null in the sample; fill every field in",
            "groceries.name: number, not string",
            "groceries.qty: written but not in the schema",
            "groceries.tags: a number member, not string",
            "groceries.position: in the schema but the record never writes it",
        ]);
        assert_eq!(s.check_sample("nope", &good), vec!["nope: not in the schema"]);
        // The short form has no types: only names and merge shapes are checked.
        let short = Schema::from_json(r#"{ "groceries": { "name": "value", "tags": "set" } }"#).unwrap();
        assert_eq!(short.check_sample("groceries", &serde_json::json!({"name": 3, "tags": ["a"]})), Vec::<String>::new());
    }
}
