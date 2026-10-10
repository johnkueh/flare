//! Property test: any interleaving of edits, pushes, pulls, lost answers
//! and clock skew across three phones ends with every phone reading the
//! same data as the server, no lost counter increments, and no parent
//! loops.

mod common;

use common::{sync, Server};
use proptest::prelude::*;
use serde_json::json;
use sync_core::{Schema, Store};

const NOW: u64 = 1_760_000_000_000;
const SCHEMA: &str = r#"{"items": {"a": "value", "b": "value", "tags": "set", "n": "counter", "p": "parent"}}"#;
const PHONES: usize = 3;
const DOCS: usize = 4;

#[derive(Clone, Debug)]
enum Action {
    Put { phone: usize, doc: usize, field: bool, value: u8 },
    Tag { phone: usize, doc: usize, member: u8, add: bool },
    Inc { phone: usize, doc: usize, delta: i8 },
    Parent { phone: usize, doc: usize, parent: Option<usize> },
    Delete { phone: usize, doc: usize },
    Restore { phone: usize, doc: usize },
    Push { phone: usize },
    PushLost { phone: usize },
    Pull { phone: usize },
    Time { ms: u16 },
}

fn action() -> impl Strategy<Value = Action> {
    let p = 0..PHONES;
    let d = 0..DOCS;
    prop_oneof![
        1 => (p.clone(), d.clone(), any::<bool>(), 0u8..4).prop_map(|(phone, doc, field, value)| Action::Put { phone, doc, field, value }),
        1 => (p.clone(), d.clone(), 0u8..3, any::<bool>()).prop_map(|(phone, doc, member, add)| Action::Tag { phone, doc, member, add }),
        1 => (p.clone(), d.clone(), -3i8..4).prop_map(|(phone, doc, delta)| Action::Inc { phone, doc, delta }),
        1 => (p.clone(), d.clone(), proptest::option::of(0..DOCS)).prop_map(|(phone, doc, parent)| Action::Parent { phone, doc, parent }),
        1 => (p.clone(), d.clone()).prop_map(|(phone, doc)| Action::Delete { phone, doc }),
        1 => (p.clone(), d.clone()).prop_map(|(phone, doc)| Action::Restore { phone, doc }),
        3 => p.clone().prop_map(|phone| Action::Push { phone }),
        1 => p.clone().prop_map(|phone| Action::PushLost { phone }),
        3 => p.clone().prop_map(|phone| Action::Pull { phone }),
        1 => (0u16..2000).prop_map(|ms| Action::Time { ms }),
    ]
}

fn doc(i: usize) -> String {
    format!("d{i}")
}

fn pull(store: &mut Store, server: &Server) {
    let res = server.changes(store.cursor().unwrap());
    store.apply_pull(&res).unwrap();
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 400, ..ProptestConfig::default() })]

    #[test]
    fn phones_converge(
        actions in proptest::collection::vec(action(), 1..120),
        skews in proptest::collection::vec(-300_000i64..300_000, PHONES),
        page in 1usize..6,
    ) {
        let mut server = Server::new(NOW, page);
        let schema = Schema::from_json(SCHEMA).unwrap();
        let mut phones: Vec<Store> = (0..PHONES).map(|i| {
            let mut s = Store::open_in_memory_with_node(i as u64 + 1).unwrap();
            s.set_schema(schema.clone());
            s
        }).collect();
        let mut elapsed = 0u64;
        let set_walls = |phones: &mut Vec<Store>, elapsed: u64| {
            for (s, skew) in phones.iter_mut().zip(&skews) {
                s.set_wall_clock(Some((NOW as i64 + elapsed as i64 + skew) as u64));
            }
        };
        set_walls(&mut phones, elapsed);
        // Increments the server accepted, per doc (no skew here exceeds
        // the server's 10-minute limit, so none is refused).
        let mut increments = [0i64; DOCS];

        for a in actions {
            match a {
                Action::Put { phone, doc: d, field, value } => {
                    phones[phone].put("items", &doc(d), if field { "a" } else { "b" }, json!(value)).unwrap();
                }
                Action::Tag { phone, doc: d, member, add } => {
                    let m = format!("t{member}");
                    if add { phones[phone].set_add("items", &doc(d), "tags", &m).unwrap() }
                    else { phones[phone].set_remove("items", &doc(d), "tags", &m).unwrap() }
                }
                Action::Inc { phone, doc: d, delta } => {
                    phones[phone].increment("items", &doc(d), "n", delta as f64).unwrap();
                    increments[d] += delta as i64;
                }
                Action::Parent { phone, doc: d, parent } => {
                    phones[phone].set_parent("items", &doc(d), "p", parent.map(doc).as_deref()).unwrap();
                }
                Action::Delete { phone, doc: d } => phones[phone].delete_doc("items", &doc(d)).unwrap(),
                Action::Restore { phone, doc: d } => phones[phone].restore_doc("items", &doc(d)).unwrap(),
                Action::Push { phone } => {
                    if let Some(body) = phones[phone].take_push().unwrap() {
                        let res = server.push(&body);
                        phones[phone].ack_push(&res).unwrap();
                    }
                }
                Action::PushLost { phone } => {
                    if let Some(body) = phones[phone].take_push().unwrap() {
                        server.push(&body);
                        phones[phone].fail_push();
                    }
                }
                Action::Pull { phone } => pull(&mut phones[phone], &server),
                Action::Time { ms } => {
                    elapsed += ms as u64;
                    server.now = NOW + elapsed;
                    set_walls(&mut phones, elapsed);
                }
            }
        }

        // Everyone comes online and syncs until nothing moves.
        for _ in 0..2 {
            for p in phones.iter_mut() {
                sync(p, &mut server);
            }
        }
        let mut fresh = Store::open_in_memory_with_node(99).unwrap();
        fresh.set_schema(schema.clone());
        fresh.set_wall_clock(Some(server.now));
        sync(&mut fresh, &mut server);
        let expected = fresh.list("items", None).unwrap();
        for p in &phones {
            prop_assert_eq!(p.pending_count().unwrap(), 0);
            prop_assert_eq!(&p.list("items", None).unwrap(), &expected);
        }
        for (d, total) in increments.iter().enumerate() {
            prop_assert_eq!(fresh.counter("items", &doc(d), "n").unwrap(), *total as f64);
        }
        prop_assert!(!server.has_parent_loop("items", "p"));
    }
}
