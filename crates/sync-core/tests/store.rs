mod common;

use common::{sync, Server};
use serde_json::{json, Value};
use sync_core::{Schema, Store};

const NOW: u64 = 1_760_000_000_000;
const SCHEMA: &str = r#"{"groceries": {"name": "value", "done": "value", "position": "position",
    "tags": "set", "qty": "counter", "parent": "parent", "photo": "blob"}}"#;

fn phone(node: u64) -> Store {
    let mut s = Store::open_in_memory_with_node(node).unwrap();
    s.set_schema(Schema::from_json(SCHEMA).unwrap());
    s.set_wall_clock(Some(NOW));
    s
}

fn names(s: &Store) -> Vec<String> {
    s.list("groceries", Some("position")).unwrap().iter()
        .map(|d| d["name"].as_str().unwrap_or("").to_string()).collect()
}

#[test]
fn reads_fields_through_the_schema() {
    let mut a = phone(1);
    a.put_doc("groceries", "milk", json!({"name": "Milk", "done": false, "tags": ["dairy", "cold"],
        "position": "V"}).as_object().unwrap()).unwrap();
    a.increment("groceries", "milk", "qty", 2.0).unwrap();
    a.increment("groceries", "milk", "qty", 1.0).unwrap();
    a.set_remove("groceries", "milk", "tags", "cold").unwrap();
    assert_eq!(a.get_doc("groceries", "milk").unwrap().unwrap(),
               json!({"id": "milk", "name": "Milk", "done": false, "tags": ["dairy"], "position": "V", "qty": 3}));
    assert!(a.increment("groceries", "milk", "name", 1.0).is_err());
    assert!(a.set_add("groceries", "milk", "qty", "x").is_err());
    // Undeclared fields: a plain value, or a map of sub-keys.
    a.put("other", "x", "title", json!("Hi")).unwrap();
    assert_eq!(a.get_doc("other", "x").unwrap().unwrap(), json!({"id": "x", "title": "Hi"}));
}

#[test]
fn two_phones_converge_and_newer_write_wins() {
    let mut server = Server::new(NOW, 1000);
    let (mut a, mut b) = (phone(1), phone(2));
    a.put_doc("groceries", "milk", json!({"name": "Milk", "position": "V"}).as_object().unwrap()).unwrap();
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    assert_eq!(names(&b), ["Milk"]);

    // Both rename offline; b's edit is later.
    a.set_wall_clock(Some(NOW + 1000));
    b.set_wall_clock(Some(NOW + 2000));
    a.put("groceries", "milk", "name", json!("Oat milk")).unwrap();
    b.put("groceries", "milk", "name", json!("Whole milk")).unwrap();
    // Different fields of the same item both survive.
    a.put("groceries", "milk", "done", json!(true)).unwrap();
    for _ in 0..2 {
        sync(&mut b, &mut server);
        sync(&mut a, &mut server);
    }
    for s in [&a, &b] {
        let doc = s.get_doc("groceries", "milk").unwrap().unwrap();
        assert_eq!((doc["name"].clone(), doc["done"].clone()), (json!("Whole milk"), json!(true)));
    }
}

#[test]
fn counters_and_sets_keep_every_device_s_edits() {
    let mut server = Server::new(NOW, 1000);
    let (mut a, mut b) = (phone(1), phone(2));
    a.put("groceries", "eggs", "name", json!("Eggs")).unwrap();
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    a.increment("groceries", "eggs", "qty", 6.0).unwrap();
    b.increment("groceries", "eggs", "qty", 12.0).unwrap();
    a.set_add("groceries", "eggs", "tags", "free-range").unwrap();
    b.set_add("groceries", "eggs", "tags", "large").unwrap();
    for _ in 0..2 {
        sync(&mut a, &mut server);
        sync(&mut b, &mut server);
    }
    for s in [&a, &b] {
        assert_eq!(s.counter("groceries", "eggs", "qty").unwrap(), 18.0);
        assert_eq!(s.members("groceries", "eggs", "tags").unwrap(), ["free-range", "large"]);
    }
}

#[test]
fn delete_then_later_edit_brings_it_back() {
    let mut server = Server::new(NOW, 1000);
    let (mut a, mut b) = (phone(1), phone(2));
    a.put("groceries", "x", "name", json!("Basil")).unwrap();
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    server.now = NOW + 10;
    a.set_wall_clock(Some(NOW + 10));
    b.set_wall_clock(Some(NOW + 10));
    a.delete_doc("groceries", "x").unwrap();
    assert!(a.get_doc("groceries", "x").unwrap().is_none());
    assert!(a.list("groceries", None).unwrap().is_empty());
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    assert!(b.get_doc("groceries", "x").unwrap().is_none());
    // An edit after the delete restores it everywhere.
    server.now = NOW + 20;
    b.set_wall_clock(Some(NOW + 20));
    a.set_wall_clock(Some(NOW + 20));
    b.put("groceries", "x", "done", json!(true)).unwrap();
    sync(&mut b, &mut server);
    sync(&mut a, &mut server);
    assert_eq!(a.get_doc("groceries", "x").unwrap().unwrap()["name"], json!("Basil"));
    // An edit made before the delete (offline) does not.
    server.now = NOW + 30;
    a.set_wall_clock(Some(NOW + 30));
    a.delete_doc("groceries", "x").unwrap();
    sync(&mut a, &mut server);
    b.set_wall_clock(Some(NOW + 25));
    b.put("groceries", "x", "name", json!("Thai basil")).unwrap();
    sync(&mut b, &mut server);
    // b hadn't seen the delete; its edit is older, so the item stays deleted.
    assert!(b.get_doc("groceries", "x").unwrap().is_none());
    assert_eq!(b.get("groceries", "x", "name").unwrap(), None);
}

#[test]
fn server_refuses_parent_loops_and_phone_takes_the_correction() {
    let mut server = Server::new(NOW, 1000);
    let (mut a, mut b) = (phone(1), phone(2));
    for d in ["x", "y"] {
        a.put("groceries", d, "name", json!(d)).unwrap();
    }
    sync(&mut a, &mut server);
    sync(&mut b, &mut server);
    a.set_parent("groceries", "x", "parent", Some("y")).unwrap();
    b.set_parent("groceries", "y", "parent", Some("x")).unwrap();
    sync(&mut a, &mut server);
    // b's local state briefly has a loop; reads still terminate.
    assert_eq!(b.ancestors("groceries", "y", "parent").unwrap(), ["x"]);
    sync(&mut b, &mut server);
    assert!(!server.has_parent_loop("groceries", "parent"));
    for s in [&a, &b] {
        assert_eq!(s.get("groceries", "x", "parent").unwrap(), Some(json!("y")));
        assert_eq!(s.get("groceries", "y", "parent").unwrap(), None);
        assert_eq!(s.ancestors("groceries", "x", "parent").unwrap(), ["y"]);
        assert_eq!(s.children("groceries", "parent", Some("y")).unwrap(), ["x"]);
        assert_eq!(s.children("groceries", "parent", None).unwrap(), ["y"]);
    }
}

#[test]
fn a_phone_with_a_fast_clock_is_corrected_then_writes_normally() {
    let mut server = Server::new(NOW, 1000);
    let mut a = phone(1);
    a.set_wall_clock(Some(NOW + 3_600_000)); // an hour ahead
    a.put("groceries", "x", "name", json!("Salt")).unwrap();
    sync(&mut a, &mut server);
    // Refused: too far ahead. The correction removes it locally.
    assert!(a.get_doc("groceries", "x").unwrap().is_none());
    // The clock now follows the server's, so the next write goes through.
    a.put("groceries", "x", "name", json!("Salt")).unwrap();
    sync(&mut a, &mut server);
    assert_eq!(a.get_doc("groceries", "x").unwrap().unwrap()["name"], json!("Salt"));
}

#[test]
fn rewriting_a_path_while_its_push_is_out_keeps_the_new_write() {
    let mut server = Server::new(NOW, 1000);
    let mut a = phone(1);
    a.put("groceries", "x", "name", json!("A")).unwrap();
    let body = a.take_push().unwrap().unwrap();
    assert!(a.take_push().unwrap().is_none(), "one push at a time");
    a.put("groceries", "x", "name", json!("B")).unwrap();
    let res = server.push(&body);
    a.ack_push(&res).unwrap();
    assert_eq!(a.pending_count().unwrap(), 1);
    sync(&mut a, &mut server);
    assert_eq!(a.pending_count().unwrap(), 0);
    let mut b = phone(2);
    sync(&mut b, &mut server);
    assert_eq!(b.get("groceries", "x", "name").unwrap(), Some(json!("B")));
}

#[test]
fn lost_push_is_resent() {
    let mut server = Server::new(NOW, 1000);
    let mut a = phone(1);
    a.put("groceries", "x", "name", json!("A")).unwrap();
    let body = a.take_push().unwrap().unwrap();
    server.push(&body); // arrived, but the answer was lost
    a.fail_push();
    let again = a.take_push().unwrap().unwrap();
    assert_eq!(body, again);
    let v = server.version;
    a.ack_push(&server.push(&again)).unwrap();
    assert_eq!(server.version, v, "same op twice changes nothing");
}

#[test]
fn paged_pull_and_reset() {
    let mut server = Server::new(NOW, 3);
    let (mut a, mut b) = (phone(1), phone(2));
    for i in 0..10 {
        a.put("groceries", &format!("i{i}"), "name", json!(format!("Item {i}"))).unwrap();
    }
    sync(&mut a, &mut server);
    for i in 0..10 {
        a.put("groceries", "i0", "name", json!(format!("Item 0 v{i}"))).unwrap();
        sync(&mut a, &mut server);
    }
    sync(&mut b, &mut server);
    assert_eq!(b.list("groceries", None).unwrap().len(), 10);
    assert_eq!(b.cursor().unwrap(), server.version);

    // b has an unpushed edit when the server is rebuilt: 10 entries, so
    // 10 versions, behind b's cursor of 20.
    b.put("groceries", "local", "name", json!("Mine")).unwrap();
    server.rebuild();
    assert!(b.cursor().unwrap() > server.version);
    let res = server.changes(b.cursor().unwrap());
    let out = b.apply_pull(&res).unwrap();
    assert!(out.reset);
    sync(&mut b, &mut server);
    let docs = b.list("groceries", None).unwrap();
    assert!(docs.iter().any(|d| d["id"] == json!("local")), "pending edit survives a reset");
}

#[test]
fn reopening_keeps_node_and_clock() {
    let dir = std::env::temp_dir().join(format!("sync-core-test-{}", std::process::id()));
    let path = dir.with_extension("db");
    let _ = std::fs::remove_file(&path);
    let (node, t) = {
        let mut s = Store::open(path.to_str().unwrap()).unwrap();
        s.set_wall_clock(Some(NOW));
        s.put("c", "d", "f", json!(1)).unwrap();
        let body: Value = serde_json::from_str(&s.take_push().unwrap().unwrap()).unwrap();
        (s.node_id(), body["ops"][0]["t"].as_str().unwrap().to_string())
    };
    let mut s = Store::open(path.to_str().unwrap()).unwrap();
    assert_eq!(s.node_id(), node);
    s.set_wall_clock(Some(NOW - 5000)); // clock went backwards
    s.put("c", "d", "f", json!(2)).unwrap();
    let body: Value = serde_json::from_str(&s.take_push().unwrap().unwrap()).unwrap();
    assert!(body["ops"][0]["t"].as_str().unwrap() > t.as_str());
    drop(s);
    let _ = std::fs::remove_file(&path);
}
