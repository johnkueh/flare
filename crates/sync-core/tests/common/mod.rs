//! An in-memory model of the space server's push and changes, written
//! from PROTOCOL.md. The real server (`server/`) has its own
//! tests against the same rules.

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use sync_core::hlc::{Hlc, ZERO};
use sync_core::Op;

type Path = (String, String, String, String);

#[derive(Default)]
pub struct Server {
    entries: BTreeMap<Path, (Op, u64)>,
    pub version: u64,
    pub now: u64,
    pub page: usize,
}

const MAX_AHEAD_MS: u64 = 10 * 60 * 1000;

#[allow(dead_code)]
impl Server {
    pub fn new(now: u64, page: usize) -> Server {
        Server { now, page, ..Default::default() }
    }

    fn path(op: &Op) -> Path {
        (op.c.clone(), op.d.clone(), op.f.clone(), op.s.clone())
    }

    fn makes_loop(&self, op: &Op) -> bool {
        let Some(mut cur) = op.v.as_str().map(String::from) else { return false };
        let mut seen = HashSet::new();
        loop {
            if cur == op.d {
                return true;
            }
            if !seen.insert(cur.clone()) {
                return false;
            }
            match self.entries.get(&(op.c.clone(), cur.clone(), op.f.clone(), String::new())) {
                Some((e, _)) => match e.v.as_str() {
                    Some(next) => cur = next.to_string(),
                    None => return false,
                },
                None => return false,
            }
        }
    }

    pub fn push(&mut self, body: &str) -> String {
        let body: Value = serde_json::from_str(body).unwrap();
        let ops: Vec<Op> = serde_json::from_value(body["ops"].clone()).unwrap();
        assert!(ops.len() <= 500);
        for op in &ops {
            op.validate().unwrap();
        }
        let mut corrections = Vec::new();
        for op in ops {
            let ahead = Hlc::parse(&op.t).unwrap().ms > self.now + MAX_AHEAD_MS;
            if ahead || (op.k.as_deref() == Some("parent") && self.makes_loop(&op)) {
                corrections.push(match self.entries.get(&Self::path(&op)) {
                    Some((e, _)) => e.clone(),
                    None => Op { v: Value::Null, t: ZERO.into(), k: None, ..op },
                });
                continue;
            }
            let path = Self::path(&op);
            if self.entries.get(&path).is_some_and(|(e, _)| e.t >= op.t) {
                continue;
            }
            self.version += 1;
            self.entries.insert(path, (op, self.version));
        }
        json!({ "version": self.version, "time": self.now, "corrections": corrections }).to_string()
    }

    pub fn changes(&self, since: u64) -> String {
        let (since, reset) = if since > self.version { (0, true) } else { (since, false) };
        let mut newer: Vec<&(Op, u64)> = self.entries.values().filter(|(_, v)| *v > since).collect();
        newer.sort_by_key(|(_, v)| *v);
        let more = newer.len() > self.page;
        newer.truncate(self.page);
        let version = newer.last().map(|(_, v)| *v).unwrap_or(self.version);
        let ops: Vec<&Op> = newer.iter().map(|(o, _)| o).collect();
        json!({ "ops": ops, "version": version, "more": more, "reset": reset, "time": self.now }).to_string()
    }

    /// The space was rebuilt from scratch (e.g. restored from a backup):
    /// same entries, versions starting over.
    pub fn rebuild(&mut self) {
        let mut ops: Vec<Op> = self.entries.values().map(|(o, _)| o.clone()).collect();
        ops.sort_by(|a, b| a.t.cmp(&b.t));
        self.entries.clear();
        self.version = 0;
        for op in ops {
            self.version += 1;
            self.entries.insert(Self::path(&op), (op, self.version));
        }
    }

    pub fn has_parent_loop(&self, c: &str, f: &str) -> bool {
        self.entries.keys().filter(|(ec, _, ef, s)| ec == c && ef == f && s.is_empty()).any(|(_, d, _, _)| {
            let probe = Op { c: c.into(), d: d.clone(), f: f.into(), s: String::new(),
                             v: self.entries[&(c.into(), d.clone(), f.into(), String::new())].0.v.clone(),
                             t: ZERO.into(), k: None };
            self.makes_loop(&probe)
        })
    }
}

/// Pushes everything pending, then pulls until caught up.
pub fn sync(store: &mut sync_core::Store, server: &mut Server) {
    while let Some(body) = store.take_push().unwrap() {
        let res = server.push(&body);
        store.ack_push(&res).unwrap();
    }
    loop {
        let res = server.changes(store.cursor().unwrap());
        if !store.apply_pull(&res).unwrap().more {
            break;
        }
    }
}
