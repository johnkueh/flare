use flare_flags::{Flags, FlagsError, Kind, Schema};
use serde_json::{json, Map};

const SCHEMA: &str = r#"{
  "$schema": "https://flare.jkyf.dev/flags.schema.json",
  "flags": {
    "new-checkout": { "default": false, "description": "The redesigned checkout" },
    "upload-limit": { "default": 10 },
    "sample-rate":  { "default": 0.5 },
    "checkout-copy": { "default": "Buy now" },
    "paywall": { "default": { "price": "4.99" } },
    "kill-import": { "default": false, "live": true }
  }
}"#;

fn response(values: serde_json::Value) -> String {
    let flags: Vec<_> = values
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| json!({ "key": k, "value": v, "reason": "TARGETING_MATCH" }))
        .collect();
    json!({ "flags": flags }).to_string()
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("flare-flags-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir.join("flags.json")
}

#[test]
fn kinds_come_from_defaults() {
    let s = Schema::from_json(SCHEMA).unwrap();
    let kind = |k: &str| s.get(k).unwrap().kind;
    assert_eq!(kind("new-checkout"), Kind::Bool);
    assert_eq!(kind("upload-limit"), Kind::Int);
    assert_eq!(kind("sample-rate"), Kind::Number);
    assert_eq!(kind("checkout-copy"), Kind::String);
    assert_eq!(kind("paywall"), Kind::Json);
    assert!(s.get("kill-import").unwrap().live);
    assert!(!s.get("new-checkout").unwrap().live);
}

#[test]
fn bad_schemas_say_why() {
    for (json, needle) in [
        (r#"{}"#, "expected"),
        (r#"{"flags":{"x":{}}}"#, "default"),
        (r#"{"flags":{"9x":{"default":1}}}"#, "keys start"),
        (r#"{"flags":{"x":{"default":null}}}"#, "null"),
        (
            r#"{"flags":{"x":{"default":"a","type":"boolean"}}}"#,
            "match",
        ),
    ] {
        match Schema::from_json(json) {
            Err(FlagsError::Schema(m)) => assert!(m.contains(needle), "{json}: {m}"),
            other => panic!("{json}: {other:?}"),
        }
    }
}

#[test]
fn defaults_before_any_response() {
    let mut f = Flags::open(SCHEMA, None, None).unwrap();
    assert!(!f.bool("new-checkout"));
    assert_eq!(f.int("upload-limit"), 10);
    assert_eq!(f.number("sample-rate"), 0.5);
    assert_eq!(f.string("checkout-copy"), "Buy now");
    assert_eq!(f.value("paywall"), Some(json!({ "price": "4.99" })));
    assert_eq!(f.value("nope"), None);
}

#[test]
fn unread_flags_update_at_once_read_ones_wait() {
    let mut f = Flags::open(SCHEMA, None, None).unwrap();
    assert!(!f.bool("new-checkout")); // on screen now
    let changed = f
        .apply(
            200,
            Some("\"a\""),
            &response(json!({ "new-checkout": true, "upload-limit": 25, "kill-import": true })),
        )
        .unwrap();
    assert_eq!(changed, vec!["kill-import", "upload-limit"]);
    assert!(!f.bool("new-checkout"), "a read flag keeps its value");
    assert_eq!(
        f.int("upload-limit"),
        25,
        "an unread one takes the new value"
    );
    assert!(f.bool("kill-import"), "live flags change at once");
    assert_eq!(f.activate(), vec!["new-checkout"]);
    assert!(f.bool("new-checkout"));
}

#[test]
fn missing_errored_or_mistyped_entries_use_the_default() {
    let mut f = Flags::open(SCHEMA, None, None).unwrap();
    f.apply(
        200,
        None,
        &response(json!({ "upload-limit": 25, "checkout-copy": "Pay" })),
    )
    .unwrap();
    assert_eq!(f.int("upload-limit"), 25);
    let body = json!({ "flags": [
        { "key": "upload-limit", "errorCode": "FLAG_NOT_FOUND" },
        { "key": "checkout-copy", "value": 3 },
        { "key": "unknown", "value": true },
        { "key": "sample-rate", "value": 2 }
    ] })
    .to_string();
    f.apply(200, None, &body).unwrap();
    f.activate();
    assert_eq!(f.int("upload-limit"), 10);
    assert_eq!(f.string("checkout-copy"), "Buy now");
    assert_eq!(f.number("sample-rate"), 2.0, "an integer is a fine number");
}

#[test]
fn not_modified_keeps_values_and_errors_change_nothing() {
    let mut f = Flags::open(SCHEMA, None, None).unwrap();
    f.apply(
        200,
        Some("\"v1\""),
        &response(json!({ "upload-limit": 25 })),
    )
    .unwrap();
    assert_eq!(f.etag(), Some("\"v1\""));
    assert_eq!(f.apply(304, None, "").unwrap(), Vec::<String>::new());
    assert_eq!(f.int("upload-limit"), 25);
    assert_eq!(f.apply(503, None, ""), Err(FlagsError::Status(503)));
    assert!(matches!(
        f.apply(200, None, "<html>"),
        Err(FlagsError::BadResponse(_))
    ));
    assert_eq!(f.int("upload-limit"), 25);
    assert_eq!(f.etag(), Some("\"v1\""));
}

#[test]
fn the_cache_survives_a_relaunch() {
    let path = temp("relaunch");
    let id = {
        let mut f = Flags::open(SCHEMA, Some(path.clone()), None).unwrap();
        f.apply(
            200,
            Some("\"v1\""),
            &response(json!({ "new-checkout": true })),
        )
        .unwrap();
        f.install_id().to_owned()
    };
    let mut f = Flags::open(SCHEMA, Some(path.clone()), None).unwrap();
    assert_eq!(f.install_id(), id, "the install id is kept");
    assert!(
        f.bool("new-checkout"),
        "last known value, before any response"
    );
    assert_eq!(f.etag(), Some("\"v1\""));
    assert!(f.fetched_at().is_some());
}

#[test]
fn a_new_flags_json_drops_cached_values_it_no_longer_matches() {
    let path = temp("schema-change");
    {
        let mut f = Flags::open(SCHEMA, Some(path.clone()), None).unwrap();
        f.apply(
            200,
            None,
            &response(json!({ "upload-limit": 25, "checkout-copy": "Pay" })),
        )
        .unwrap();
    }
    let changed = r#"{"flags":{"upload-limit":{"default":"ten"},"other":{"default":true}}}"#;
    let mut f = Flags::open(changed, Some(path), None).unwrap();
    assert_eq!(f.string("upload-limit"), "ten");
    assert!(f.bool("other"));
}

#[test]
fn users_get_their_own_values() {
    let path = temp("users");
    let mut f = Flags::open(SCHEMA, Some(path.clone()), None).unwrap();
    let install = f.install_id().to_owned();
    assert_eq!(f.identity(), install);
    f.apply(200, None, &response(json!({ "upload-limit": 25 })))
        .unwrap();
    assert!(f.request_body(&Map::new()).contains(&install));

    assert_eq!(f.set_user(Some("u1".into())), vec!["upload-limit"]);
    assert_eq!(
        f.int("upload-limit"),
        10,
        "back to the default until u1's values arrive"
    );
    let mut extra = Map::new();
    extra.insert("platform".into(), json!("ios"));
    let body: serde_json::Value = serde_json::from_str(&f.request_body(&extra)).unwrap();
    assert_eq!(
        body,
        json!({ "context": { "targetingKey": "u1", "platform": "ios" } })
    );
    assert!(f.set_user(Some("u1".into())).is_empty());
    f.apply(200, None, &response(json!({ "upload-limit": 50 })))
        .unwrap();
    assert_eq!(
        f.int("upload-limit"),
        50,
        "a new user's values apply at once"
    );

    // Relaunched as someone else: u1's cached values aren't used.
    let mut other = Flags::open(SCHEMA, Some(path.clone()), Some("u2".into())).unwrap();
    assert_eq!(other.int("upload-limit"), 10);
    let mut same = Flags::open(SCHEMA, Some(path), Some("u2".into())).unwrap();
    assert_eq!(same.install_id(), install);
    assert_eq!(same.int("upload-limit"), 10);
}

#[test]
fn snapshot_reads_without_pinning() {
    let mut f = Flags::open(SCHEMA, None, None).unwrap();
    assert_eq!(f.snapshot()["upload-limit"], json!(10));
    f.apply(200, None, &response(json!({ "upload-limit": 25 })))
        .unwrap();
    assert_eq!(f.snapshot()["upload-limit"], json!(25));
    f.apply(200, None, &response(json!({ "upload-limit": 30 })))
        .unwrap();
    assert_eq!(f.int("upload-limit"), 30, "snapshot didn't pin it");
}
