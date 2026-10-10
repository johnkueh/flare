//! The local store and sync engine.
//!
//! One SQLite database per space on the phone:
//!
//! * `entries`: the newest entry this phone knows at each path.
//! * `outbox`: paths written here that the server hasn't acknowledged. The
//!   push sends each path's current entry, so writing a path twice sends
//!   it once.
//! * `meta`: node id, pull cursor, clock offset, and whatever the app
//!   stores (`set_meta`), such as the space id.
//!
//! The engine does no networking. The app asks for a push body
//! (`take_push`), sends it, and hands back the response (`ack_push`, or
//! `fail_push` if it never arrived); it pulls with `cursor()` and hands
//! back each page (`apply_pull`). Every response's `time` corrects this
//! phone's clock.

use crate::hlc::{Clock, Hlc};
use crate::op::{Op, DELETED, KIND_PARENT, MAX_AHEAD_MS, MAX_PUSH};
use crate::schema::{FieldKind, Schema};
use crate::SyncError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

/// A document that changed, so the app knows what to re-read.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Change {
    pub collection: String,
    pub doc: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullOutcome {
    /// Another page is waiting: pull again with the new cursor.
    pub more: bool,
    /// The server rebuilt the space and this phone replaced its copy.
    pub reset: bool,
    pub changes: Vec<Change>,
}

#[derive(Deserialize)]
struct PushResponse {
    time: Option<f64>,
    #[serde(default)]
    corrections: Vec<Op>,
}

#[derive(Deserialize)]
struct PullResponse {
    ops: Vec<Op>,
    version: u64,
    #[serde(default)]
    more: bool,
    #[serde(default)]
    reset: bool,
    time: Option<f64>,
}

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS entries (
  c TEXT NOT NULL, d TEXT NOT NULL, f TEXT NOT NULL, s TEXT NOT NULL,
  v TEXT NOT NULL, t TEXT NOT NULL, k TEXT,
  PRIMARY KEY (c, d, f, s)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  c TEXT NOT NULL, d TEXT NOT NULL, f TEXT NOT NULL, s TEXT NOT NULL,
  UNIQUE (c, d, f, s)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
";

pub struct Store {
    db: Connection,
    clock: Clock,
    offset_ms: i64,
    wall_override: Option<u64>,
    in_flight: Vec<i64>,
    schema: Schema,
}

fn db_err(e: rusqlite::Error) -> SyncError {
    SyncError::Db(e.to_string())
}

impl From<rusqlite::Error> for SyncError {
    fn from(e: rusqlite::Error) -> Self {
        db_err(e)
    }
}

fn random_node() -> u64 {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).expect("random node id");
    u64::from_le_bytes(b).max(1)
}

impl Store {
    pub fn open(path: &str) -> Result<Store, SyncError> {
        Store::with_connection(Connection::open(path)?, None)
    }

    pub fn open_in_memory() -> Result<Store, SyncError> {
        Store::with_connection(Connection::open_in_memory()?, None)
    }

    /// In-memory store with a fixed node id (tests and simulations).
    pub fn open_in_memory_with_node(node: u64) -> Result<Store, SyncError> {
        Store::with_connection(Connection::open_in_memory()?, Some(node))
    }

    fn with_connection(db: Connection, node: Option<u64>) -> Result<Store, SyncError> {
        db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
        db.execute_batch(SCHEMA_SQL)?;
        let node = match read_meta(&db, "node")? {
            Some(n) => u64::from_str_radix(&n, 16).map_err(|e| SyncError::Db(e.to_string()))?,
            None => {
                let n = node.unwrap_or_else(random_node);
                write_meta(&db, "node", &format!("{n:016x}"))?;
                n
            }
        };
        let last: Option<String> = db.query_row(
            "SELECT max(t) FROM (SELECT max(t) AS t FROM entries UNION ALL SELECT value FROM meta WHERE key = 'last')",
            [], |r| r.get(0))?;
        let last = last.as_deref().and_then(Hlc::parse).unwrap_or(Hlc::ZERO);
        let offset_ms = read_meta(&db, "offset")?.and_then(|s| s.parse().ok()).unwrap_or(0);
        Ok(Store {
            db,
            clock: Clock::new(node, Hlc::ZERO).with_observed(last),
            offset_ms,
            wall_override: None,
            in_flight: Vec::new(),
            schema: Schema::default(),
        })
    }

    pub fn set_schema(&mut self, schema: Schema) {
        self.schema = schema;
    }

    /// This install's id: the timestamp node, and the counter sub-key.
    pub fn node_id(&self) -> String {
        format!("{:016x}", self.clock.node)
    }

    /// Fixes the wall clock (tests and simulations).
    pub fn set_wall_clock(&mut self, ms: Option<u64>) {
        self.wall_override = ms;
    }

    /// The server-corrected wall clock in milliseconds.
    pub fn now_ms(&self) -> u64 {
        let wall = self.wall_override.unwrap_or_else(|| {
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
        });
        (wall as i64 + self.offset_ms).max(0) as u64
    }

    /// Records the server's clock (`time` from any response).
    pub fn observe_server_time(&mut self, server_ms: u64) -> Result<(), SyncError> {
        let wall = self.now_ms() as i64 - self.offset_ms;
        self.offset_ms = server_ms as i64 - wall;
        write_meta(&self.db, "offset", &self.offset_ms.to_string())?;
        self.rewind_clock_if_ahead()
    }

    /// A phone whose clock ran fast has issued timestamps the server
    /// refuses. Once its clock is corrected, start again from the newest
    /// timestamp the server could have accepted, so the next write goes
    /// through instead of being refused until real time catches up.
    fn rewind_clock_if_ahead(&mut self) -> Result<(), SyncError> {
        let limit = self.now_ms() + MAX_AHEAD_MS;
        if self.clock.last.ms <= limit {
            return Ok(());
        }
        let bound = Hlc { ms: limit, counter: u16::MAX, node: u64::MAX }.to_string();
        let newest: Option<String> =
            self.db.query_row("SELECT max(t) FROM entries WHERE t <= ?1", [&bound], |r| r.get(0))?;
        let newest = newest.as_deref().and_then(Hlc::parse).unwrap_or(Hlc::ZERO);
        self.clock.last = Hlc { node: self.clock.node, ..newest };
        write_meta(&self.db, "last", &self.clock.last.to_string())
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>, SyncError> {
        read_meta(&self.db, &format!("app:{key}"))
    }

    pub fn set_meta(&self, key: &str, value: Option<&str>) -> Result<(), SyncError> {
        match value {
            Some(v) => write_meta(&self.db, &format!("app:{key}"), v),
            None => {
                self.db.execute("DELETE FROM meta WHERE key = ?1", [format!("app:{key}")])?;
                Ok(())
            }
        }
    }

    // ---- writes -------------------------------------------------------

    fn write(&mut self, c: &str, d: &str, f: &str, s: &str, v: Value, k: Option<&str>) -> Result<(), SyncError> {
        let t = self.clock.tick(self.now_ms()).to_string();
        let op = Op { c: c.into(), d: d.into(), f: f.into(), s: s.into(), v, t, k: k.map(String::from) };
        op.validate().map_err(SyncError::InvalidOp)?;
        let v = op.v.to_string();
        self.db.execute(
            "INSERT INTO entries (c, d, f, s, v, t, k) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (c, d, f, s) DO UPDATE SET v = excluded.v, t = excluded.t, k = excluded.k",
            params![c, d, f, s, v, op.t, op.k],
        )?;
        self.db.execute(
            "INSERT OR REPLACE INTO outbox (c, d, f, s) VALUES (?1, ?2, ?3, ?4)",
            params![c, d, f, s],
        )?;
        write_meta(&self.db, "last", &op.t)
    }

    fn in_tx<T>(&mut self, body: impl FnOnce(&mut Store) -> Result<T, SyncError>) -> Result<T, SyncError> {
        self.db.execute_batch("BEGIN IMMEDIATE")?;
        match body(self) {
            Ok(v) => {
                self.db.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    fn expect_kind(&self, c: &str, f: &str, allowed: &[FieldKind]) -> Result<(), SyncError> {
        match self.schema.kind(c, f) {
            Some(k) if !allowed.contains(&k) => {
                Err(SyncError::WrongKind(format!("{c}.{f} is a {k:?} field")))
            }
            _ => Ok(()),
        }
    }

    /// Writes a value, position, blob or parent field.
    pub fn put(&mut self, c: &str, d: &str, f: &str, v: Value) -> Result<(), SyncError> {
        if f == DELETED {
            return Err(SyncError::InvalidOp("use delete_doc / restore_doc".into()));
        }
        self.expect_kind(c, f, &[FieldKind::Value, FieldKind::Position, FieldKind::Blob, FieldKind::Parent])?;
        if self.schema.kind(c, f) == Some(FieldKind::Parent) {
            return self.set_parent(c, d, f, v.as_str());
        }
        self.in_tx(|s| s.write(c, d, f, "", v, None))
    }

    /// Writes several fields of one document at once. Set fields take an
    /// array of members (written with `set_members`); counter fields can't
    /// be written this way.
    pub fn put_doc(&mut self, c: &str, d: &str, fields: &Map<String, Value>) -> Result<(), SyncError> {
        self.in_tx(|s| {
            for (f, v) in fields {
                match s.schema.kind(c, f) {
                    Some(FieldKind::Counter) => {
                        return Err(SyncError::WrongKind(format!("{c}.{f} is a counter; use increment")))
                    }
                    Some(FieldKind::Set) => {
                        let members: Vec<String> = v.as_array()
                            .ok_or_else(|| SyncError::WrongKind(format!("{c}.{f} is a set; pass an array")))?
                            .iter().map(|m| m.as_str().map(String::from).unwrap_or_else(|| m.to_string()))
                            .collect();
                        s.set_members_inner(c, d, f, &members)?;
                    }
                    Some(FieldKind::Parent) => {
                        s.write(c, d, f, "", parent_value(v.as_str()), Some(KIND_PARENT))?
                    }
                    _ => s.write(c, d, f, "", v.clone(), None)?,
                }
            }
            Ok(())
        })
    }

    /// Points a document at its parent (same collection), or at none.
    pub fn set_parent(&mut self, c: &str, d: &str, f: &str, parent: Option<&str>) -> Result<(), SyncError> {
        self.expect_kind(c, f, &[FieldKind::Parent])?;
        self.in_tx(|s| s.write(c, d, f, "", parent_value(parent), Some(KIND_PARENT)))
    }

    pub fn set_add(&mut self, c: &str, d: &str, f: &str, member: &str) -> Result<(), SyncError> {
        self.expect_kind(c, f, &[FieldKind::Set])?;
        self.in_tx(|s| s.write(c, d, f, member, Value::Bool(true), None))
    }

    pub fn set_remove(&mut self, c: &str, d: &str, f: &str, member: &str) -> Result<(), SyncError> {
        self.expect_kind(c, f, &[FieldKind::Set])?;
        self.in_tx(|s| s.write(c, d, f, member, Value::Bool(false), None))
    }

    /// Makes the set exactly `members`, writing only what changes.
    pub fn set_members(&mut self, c: &str, d: &str, f: &str, members: &[String]) -> Result<(), SyncError> {
        self.expect_kind(c, f, &[FieldKind::Set])?;
        self.in_tx(|s| s.set_members_inner(c, d, f, members))
    }

    fn set_members_inner(&mut self, c: &str, d: &str, f: &str, members: &[String]) -> Result<(), SyncError> {
        let want: BTreeSet<&str> = members.iter().map(|m| m.as_str()).collect();
        let have = self.members(c, d, f)?;
        for m in &have {
            if !want.contains(m.as_str()) {
                self.write(c, d, f, m, Value::Bool(false), None)?;
            }
        }
        for m in want {
            if !have.iter().any(|h| h == m) {
                self.write(c, d, f, m, Value::Bool(true), None)?;
            }
        }
        Ok(())
    }

    /// Adds `delta` to a counter. Each device keeps its own running total;
    /// the counter reads as their sum, so no increment is ever lost.
    pub fn increment(&mut self, c: &str, d: &str, f: &str, delta: f64) -> Result<(), SyncError> {
        self.expect_kind(c, f, &[FieldKind::Counter])?;
        let me = self.node_id();
        let mine = self.entry(c, d, f, &me)?.and_then(|(v, _)| v.as_f64()).unwrap_or(0.0);
        self.in_tx(|s| s.write(c, d, f, &me, number(mine + delta), None))
    }

    /// Deletes a document. Any later edit, from anyone, brings it back.
    pub fn delete_doc(&mut self, c: &str, d: &str) -> Result<(), SyncError> {
        self.in_tx(|s| s.write(c, d, DELETED, "", Value::Bool(true), None))
    }

    pub fn restore_doc(&mut self, c: &str, d: &str) -> Result<(), SyncError> {
        self.in_tx(|s| s.write(c, d, DELETED, "", Value::Bool(false), None))
    }

    // ---- reads --------------------------------------------------------

    fn entry(&self, c: &str, d: &str, f: &str, s: &str) -> Result<Option<(Value, String)>, SyncError> {
        let row: Option<(String, String)> = self.db.query_row(
            "SELECT v, t FROM entries WHERE c = ?1 AND d = ?2 AND f = ?3 AND s = ?4",
            params![c, d, f, s], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        Ok(row.map(|(v, t)| (serde_json::from_str(&v).unwrap_or(Value::Null), t)))
    }

    /// A plain field's value (value, position, blob, parent).
    pub fn get(&self, c: &str, d: &str, f: &str) -> Result<Option<Value>, SyncError> {
        if self.is_deleted(c, d)? {
            return Ok(None);
        }
        Ok(self.entry(c, d, f, "")?.map(|(v, _)| v))
    }

    pub fn members(&self, c: &str, d: &str, f: &str) -> Result<Vec<String>, SyncError> {
        let mut st = self.db.prepare_cached(
            "SELECT s FROM entries WHERE c = ?1 AND d = ?2 AND f = ?3 AND s != '' AND v = 'true' ORDER BY s")?;
        let rows = st.query_map(params![c, d, f], |r| r.get(0))?;
        rows.collect::<Result<_, _>>().map_err(db_err)
    }

    pub fn counter(&self, c: &str, d: &str, f: &str) -> Result<f64, SyncError> {
        let mut st = self.db.prepare_cached(
            "SELECT v FROM entries WHERE c = ?1 AND d = ?2 AND f = ?3 AND s != ''")?;
        let rows = st.query_map(params![c, d, f], |r| r.get::<_, String>(0))?;
        let mut sum = 0.0;
        for v in rows {
            sum += serde_json::from_str::<Value>(&v?).ok().and_then(|v| v.as_f64()).unwrap_or(0.0);
        }
        Ok(sum)
    }

    pub fn is_deleted(&self, c: &str, d: &str) -> Result<bool, SyncError> {
        let row: Option<(String, String, Option<String>)> = self.db.query_row(
            "SELECT e.v, e.t, (SELECT max(t) FROM entries o WHERE o.c = e.c AND o.d = e.d AND o.f != ?3)
             FROM entries e WHERE e.c = ?1 AND e.d = ?2 AND e.f = ?3 AND e.s = ''",
            params![c, d, DELETED], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
        Ok(match row {
            Some((v, t, others)) => v == "true" && others.is_none_or(|o| t > o),
            None => false,
        })
    }

    /// The whole document as a JSON object with its `id`, read through the
    /// schema. `None` if it doesn't exist or is deleted.
    pub fn get_doc(&self, c: &str, d: &str) -> Result<Option<Value>, SyncError> {
        let mut st = self.db.prepare_cached(
            "SELECT f, s, v, t FROM entries WHERE c = ?1 AND d = ?2 ORDER BY f, s")?;
        let rows: Vec<(String, String, String, String)> = st
            .query_map(params![c, d], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<_, _>>()?;
        Ok(self.assemble(c, d, rows))
    }

    fn assemble(&self, c: &str, d: &str, rows: Vec<(String, String, String, String)>) -> Option<Value> {
        if rows.is_empty() {
            return None;
        }
        let mut deleted: Option<(bool, &str)> = None;
        let mut newest_other = "";
        let mut fields: BTreeMap<&str, Vec<(&str, Value)>> = BTreeMap::new();
        for (f, s, v, t) in &rows {
            if f == DELETED {
                deleted = Some((v == "true", t));
                continue;
            }
            if t.as_str() > newest_other {
                newest_other = t;
            }
            fields.entry(f).or_default().push((s, serde_json::from_str(v).unwrap_or(Value::Null)));
        }
        if let Some((true, t)) = deleted {
            if t > newest_other {
                return None;
            }
        }
        let mut doc = Map::new();
        doc.insert("id".into(), Value::String(d.into()));
        for (f, entries) in fields {
            let value = match self.schema.kind(c, f) {
                Some(FieldKind::Set) => Value::Array(
                    entries.into_iter().filter(|(_, v)| v == &Value::Bool(true))
                        .map(|(s, _)| Value::String(s.into())).collect()),
                Some(FieldKind::Counter) => {
                    number(entries.iter().filter_map(|(_, v)| v.as_f64()).sum())
                }
                _ => match entries.iter().position(|(s, _)| s.is_empty()) {
                    Some(i) if entries.len() == 1 => entries.into_iter().nth(i).unwrap().1,
                    _ if self.schema.kind(c, f).is_some() => {
                        entries.into_iter().find(|(s, _)| s.is_empty()).map(|(_, v)| v).unwrap_or(Value::Null)
                    }
                    _ => Value::Object(entries.into_iter().map(|(s, v)| (s.to_string(), v)).collect()),
                },
            };
            doc.insert(f.to_string(), value);
        }
        Some(Value::Object(doc))
    }

    /// Every live document in a collection. Sorted by `order_by`'s value
    /// (missing last) when given, then by id.
    pub fn list(&self, c: &str, order_by: Option<&str>) -> Result<Vec<Value>, SyncError> {
        let mut st = self.db.prepare_cached(
            "SELECT d, f, s, v, t FROM entries WHERE c = ?1 ORDER BY d, f, s")?;
        let rows: Vec<(String, String, String, String, String)> = st
            .query_map([c], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<Result<_, _>>()?;
        let mut docs = Vec::new();
        let mut i = 0;
        while i < rows.len() {
            let d = rows[i].0.clone();
            let mut group = Vec::new();
            while i < rows.len() && rows[i].0 == d {
                let (_, f, s, v, t) = rows[i].clone();
                group.push((f, s, v, t));
                i += 1;
            }
            if let Some(doc) = self.assemble(c, &d, group) {
                docs.push(doc);
            }
        }
        if let Some(key) = order_by {
            docs.sort_by(|a, b| compare_values(a.get(key), b.get(key))
                .then_with(|| a["id"].as_str().cmp(&b["id"].as_str())));
        }
        Ok(docs)
    }

    /// A document's parent chain, nearest first. Stops at a missing or
    /// deleted parent, and at a loop (one can exist briefly between a
    /// local write and the server's correction).
    pub fn ancestors(&self, c: &str, d: &str, f: &str) -> Result<Vec<String>, SyncError> {
        let mut seen = HashSet::from([d.to_string()]);
        let mut chain = Vec::new();
        let mut cur = d.to_string();
        while let Some(Value::String(p)) = self.get(c, &cur, f)? {
            if !seen.insert(p.clone()) || self.get_doc(c, &p)?.is_none() {
                break;
            }
            chain.push(p.clone());
            cur = p;
        }
        Ok(chain)
    }

    /// Live documents whose parent field is `parent` (`None`: top level).
    pub fn children(&self, c: &str, f: &str, parent: Option<&str>) -> Result<Vec<String>, SyncError> {
        let all = self.list(c, None)?;
        Ok(all.into_iter()
            .filter(|doc| match (doc.get(f), parent) {
                (Some(Value::String(p)), Some(want)) => p == want,
                (None | Some(Value::Null), None) => true,
                (Some(Value::String(p)), None) => self.get_doc(c, p).ok().flatten().is_none(),
                _ => false,
            })
            .filter_map(|doc| doc["id"].as_str().map(String::from))
            .collect())
    }

    // ---- sync ---------------------------------------------------------

    /// The `since` for the next pull.
    pub fn cursor(&self) -> Result<u64, SyncError> {
        Ok(read_meta(&self.db, "cursor")?.and_then(|s| s.parse().ok()).unwrap_or(0))
    }

    pub fn pending_count(&self) -> Result<u64, SyncError> {
        Ok(self.db.query_row("SELECT count(*) FROM outbox", [], |r| r.get::<_, i64>(0))? as u64)
    }

    /// The next push body (`{"ops": [...]}`, at most 500), or `None` when
    /// nothing is waiting or a push is already out.
    pub fn take_push(&mut self) -> Result<Option<String>, SyncError> {
        if !self.in_flight.is_empty() {
            return Ok(None);
        }
        let mut st = self.db.prepare_cached(
            "SELECT o.seq, e.c, e.d, e.f, e.s, e.v, e.t, e.k FROM outbox o
             LEFT JOIN entries e ON e.c = o.c AND e.d = o.d AND e.f = o.f AND e.s = o.s
             ORDER BY o.seq LIMIT ?1")?;
        let rows: Vec<(i64, Option<Op>)> = st.query_map([MAX_PUSH as i64], |r| {
            let seq: i64 = r.get(0)?;
            let c: Option<String> = r.get(1)?;
            Ok((seq, match c {
                Some(c) => Some(Op {
                    c, d: r.get(2)?, f: r.get(3)?, s: r.get(4)?,
                    v: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or(Value::Null),
                    t: r.get(6)?, k: r.get(7)?,
                }),
                None => None,
            }))
        })?.collect::<Result<_, _>>()?;
        drop(st);
        if rows.is_empty() {
            return Ok(None);
        }
        let mut ops = Vec::new();
        for (seq, op) in rows {
            self.in_flight.push(seq);
            ops.extend(op);
        }
        if ops.is_empty() {
            // Only rows whose entry is gone: drop them.
            self.ack_push(r#"{"corrections":[]}"#)?;
            return self.take_push();
        }
        Ok(Some(serde_json::json!({ "ops": ops }).to_string()))
    }

    /// The push arrived. Applies the server's corrections, except where
    /// this phone has written the path again since (that write goes next).
    pub fn ack_push(&mut self, response: &str) -> Result<Vec<Change>, SyncError> {
        let res: PushResponse = serde_json::from_str(response).map_err(|e| SyncError::BadResponse(e.to_string()))?;
        let sent = std::mem::take(&mut self.in_flight);
        let changes = self.in_tx(|s| {
            let mut changes = BTreeSet::new();
            for op in &res.corrections {
                let rewritten: Option<i64> = s.db.query_row(
                    "SELECT seq FROM outbox WHERE c = ?1 AND d = ?2 AND f = ?3 AND s = ?4",
                    params![op.c, op.d, op.f, op.s], |r| r.get(0)).optional()?;
                if rewritten.is_some_and(|seq| !sent.contains(&seq)) {
                    continue;
                }
                s.overwrite(op)?;
                changes.insert(Change { collection: op.c.clone(), doc: op.d.clone() });
            }
            let mut del = s.db.prepare_cached("DELETE FROM outbox WHERE seq = ?1")?;
            for seq in &sent {
                del.execute([seq])?;
            }
            Ok(changes.into_iter().collect())
        });
        if changes.is_err() {
            self.in_flight = sent;
        }
        let changes = changes?;
        if let Some(t) = res.time {
            self.observe_server_time(t as u64)?;
        }
        Ok(changes)
    }

    /// The push never got an answer: send the same paths again next time.
    pub fn fail_push(&mut self) {
        self.in_flight.clear();
    }

    fn overwrite(&mut self, op: &Op) -> Result<(), SyncError> {
        if op.is_absent() {
            self.db.execute("DELETE FROM entries WHERE c = ?1 AND d = ?2 AND f = ?3 AND s = ?4",
                params![op.c, op.d, op.f, op.s])?;
        } else {
            self.db.execute(
                "INSERT INTO entries (c, d, f, s, v, t, k) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (c, d, f, s) DO UPDATE SET v = excluded.v, t = excluded.t, k = excluded.k",
                params![op.c, op.d, op.f, op.s, op.v.to_string(), op.t, op.k])?;
            if let Some(h) = Hlc::parse(&op.t) {
                self.clock.observe(h);
            }
        }
        Ok(())
    }

    /// Applies one page of `GET /changes`. Keeps pulling while `more`.
    pub fn apply_pull(&mut self, response: &str) -> Result<PullOutcome, SyncError> {
        let res: PullResponse = serde_json::from_str(response).map_err(|e| SyncError::BadResponse(e.to_string()))?;
        for op in &res.ops {
            op.validate().map_err(SyncError::BadResponse)?;
        }
        let changes = self.in_tx(|s| {
            let mut changes = BTreeSet::new();
            if res.reset {
                // Replace this copy, keeping edits the server hasn't seen.
                let mut st = s.db.prepare("SELECT DISTINCT c, d FROM entries")?;
                let all: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<_, _>>()?;
                drop(st);
                changes.extend(all.into_iter().map(|(c, d)| Change { collection: c, doc: d }));
                s.db.execute(
                    "DELETE FROM entries WHERE (c, d, f, s) NOT IN (SELECT c, d, f, s FROM outbox)", [])?;
            }
            let mut newest = Hlc::ZERO;
            for op in &res.ops {
                let current: Option<String> = s.db.query_row(
                    "SELECT t FROM entries WHERE c = ?1 AND d = ?2 AND f = ?3 AND s = ?4",
                    params![op.c, op.d, op.f, op.s], |r| r.get(0)).optional()?;
                if let Some(h) = Hlc::parse(&op.t) {
                    newest = newest.max(h);
                }
                if current.is_some_and(|t| t >= op.t) {
                    continue;
                }
                s.db.execute(
                    "INSERT INTO entries (c, d, f, s, v, t, k) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT (c, d, f, s) DO UPDATE SET v = excluded.v, t = excluded.t, k = excluded.k",
                    params![op.c, op.d, op.f, op.s, op.v.to_string(), op.t, op.k])?;
                changes.insert(Change { collection: op.c.clone(), doc: op.d.clone() });
            }
            s.clock.observe(newest);
            write_meta(&s.db, "cursor", &res.version.to_string())?;
            Ok(changes.into_iter().collect())
        })?;
        if let Some(t) = res.time {
            self.observe_server_time(t as u64)?;
        }
        Ok(PullOutcome { more: res.more, reset: res.reset, changes })
    }

    /// Forgets the space (after leaving or being removed): every entry,
    /// pending write and the cursor. App meta and the node id stay.
    pub fn clear(&mut self) -> Result<(), SyncError> {
        self.in_flight.clear();
        self.in_tx(|s| {
            s.db.execute_batch("DELETE FROM entries; DELETE FROM outbox; DELETE FROM meta WHERE key = 'cursor';")?;
            Ok(())
        })
    }
}

fn parent_value(p: Option<&str>) -> Value {
    p.map(|p| Value::String(p.into())).unwrap_or(Value::Null)
}

/// Whole numbers as JSON integers, so `3` doesn't read back as `3.0`.
fn number(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9.0e15 {
        Value::from(x as i64)
    } else {
        serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
    }
}

fn compare_values(a: Option<&Value>, b: Option<&Value>) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    match (a.filter(|v| !v.is_null()), b.filter(|v| !v.is_null())) {
        (None, None) => Equal,
        (None, Some(_)) => Greater,
        (Some(_), None) => Less,
        (Some(Value::Number(x)), Some(Value::Number(y))) => {
            x.as_f64().partial_cmp(&y.as_f64()).unwrap_or(Equal)
        }
        (Some(Value::String(x)), Some(Value::String(y))) => x.cmp(y),
        (Some(x), Some(y)) => x.to_string().cmp(&y.to_string()),
    }
}

fn read_meta(db: &Connection, key: &str) -> Result<Option<String>, SyncError> {
    db.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional().map_err(db_err)
}

fn write_meta(db: &Connection, key: &str, value: &str) -> Result<(), SyncError> {
    db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)", params![key, value])?;
    Ok(())
}

impl Clock {
    fn with_observed(mut self, seen: Hlc) -> Clock {
        self.observe(seen);
        self
    }
}
