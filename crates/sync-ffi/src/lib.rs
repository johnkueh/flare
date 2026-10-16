//! UniFFI bindings over `sync-core` (and `flare-flags`, below) for Swift
//! and Kotlin.
//!
//! Generic over any app's data: field values cross the boundary as JSON
//! strings, documents as JSON objects. Each app wraps this in a typed
//! layer of its own (an `Item` with `name`, `done`, `position`…).
//! `SyncStore` is safe to share between threads; calls take a lock.

use std::sync::{Arc, Mutex};
use sync_core::{Schema, Store};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum SyncError {
    #[error("database: {message}")]
    Db { message: String },
    #[error("invalid write: {message}")]
    InvalidWrite { message: String },
    #[error("wrong field type: {message}")]
    WrongKind { message: String },
    #[error("schema: {message}")]
    Schema { message: String },
    #[error("unexpected server response: {message}")]
    BadResponse { message: String },
    #[error("not JSON: {message}")]
    BadJson { message: String },
}

impl From<sync_core::SyncError> for SyncError {
    fn from(e: sync_core::SyncError) -> Self {
        use sync_core::SyncError as E;
        match e {
            E::Db(message) => SyncError::Db { message },
            E::InvalidOp(message) => SyncError::InvalidWrite { message },
            E::WrongKind(message) => SyncError::WrongKind { message },
            E::Schema(message) => SyncError::Schema { message },
            E::BadResponse(message) => SyncError::BadResponse { message },
        }
    }
}

fn json(s: &str) -> Result<serde_json::Value, SyncError> {
    serde_json::from_str(s).map_err(|e| SyncError::BadJson { message: e.to_string() })
}

#[derive(uniffi::Record)]
pub struct Change {
    pub collection: String,
    pub doc: String,
}

#[derive(uniffi::Record)]
pub struct PullOutcome {
    pub more: bool,
    pub reset: bool,
    pub changes: Vec<Change>,
}

fn changes(v: Vec<sync_core::Change>) -> Vec<Change> {
    v.into_iter().map(|c| Change { collection: c.collection, doc: c.doc }).collect()
}

#[derive(uniffi::Object)]
pub struct SyncStore {
    inner: Mutex<Store>,
}

impl SyncStore {
    fn with<T>(&self, f: impl FnOnce(&mut Store) -> Result<T, sync_core::SyncError>) -> Result<T, SyncError> {
        let mut store = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut store).map_err(SyncError::from)
    }
}

#[uniffi::export]
impl SyncStore {
    /// Opens (or creates) the store at `path`. `schema_json` declares field
    /// types: `{"groceries": {"name": "value", "position": "position"}}`.
    #[uniffi::constructor]
    pub fn open(path: String, schema_json: String) -> Result<Arc<SyncStore>, SyncError> {
        let mut store = if path == ":memory:" { Store::open_in_memory()? } else { Store::open(&path)? };
        store.set_schema(Schema::from_json(&schema_json)?);
        Ok(Arc::new(SyncStore { inner: Mutex::new(store) }))
    }

    pub fn node_id(&self) -> String {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).node_id()
    }

    // writes

    pub fn put(&self, collection: String, doc: String, field: String, value_json: String) -> Result<(), SyncError> {
        let v = json(&value_json)?;
        self.with(|s| s.put(&collection, &doc, &field, v))
    }

    /// Writes several fields of one document: a JSON object of field → value.
    pub fn put_doc(&self, collection: String, doc: String, fields_json: String) -> Result<(), SyncError> {
        let fields = match json(&fields_json)? {
            serde_json::Value::Object(m) => m,
            _ => return Err(SyncError::BadJson { message: "fields must be a JSON object".into() }),
        };
        self.with(|s| s.put_doc(&collection, &doc, &fields))
    }

    pub fn set_parent(&self, collection: String, doc: String, field: String, parent: Option<String>) -> Result<(), SyncError> {
        self.with(|s| s.set_parent(&collection, &doc, &field, parent.as_deref()))
    }

    pub fn set_add(&self, collection: String, doc: String, field: String, member: String) -> Result<(), SyncError> {
        self.with(|s| s.set_add(&collection, &doc, &field, &member))
    }

    pub fn set_remove(&self, collection: String, doc: String, field: String, member: String) -> Result<(), SyncError> {
        self.with(|s| s.set_remove(&collection, &doc, &field, &member))
    }

    pub fn set_members(&self, collection: String, doc: String, field: String, members: Vec<String>) -> Result<(), SyncError> {
        self.with(|s| s.set_members(&collection, &doc, &field, &members))
    }

    pub fn increment(&self, collection: String, doc: String, field: String, delta: f64) -> Result<(), SyncError> {
        self.with(|s| s.increment(&collection, &doc, &field, delta))
    }

    pub fn delete_doc(&self, collection: String, doc: String) -> Result<(), SyncError> {
        self.with(|s| s.delete_doc(&collection, &doc))
    }

    pub fn restore_doc(&self, collection: String, doc: String) -> Result<(), SyncError> {
        self.with(|s| s.restore_doc(&collection, &doc))
    }

    // reads

    /// A plain field's value as JSON, or nil.
    pub fn get(&self, collection: String, doc: String, field: String) -> Result<Option<String>, SyncError> {
        self.with(|s| Ok(s.get(&collection, &doc, &field)?.map(|v| v.to_string())))
    }

    /// The document as a JSON object (with `id`), or nil if missing or deleted.
    pub fn get_doc(&self, collection: String, doc: String) -> Result<Option<String>, SyncError> {
        self.with(|s| Ok(s.get_doc(&collection, &doc)?.map(|v| v.to_string())))
    }

    /// Every live document as a JSON array, sorted by `order_by` then id.
    pub fn list(&self, collection: String, order_by: Option<String>) -> Result<String, SyncError> {
        self.with(|s| Ok(serde_json::Value::Array(s.list(&collection, order_by.as_deref())?).to_string()))
    }

    pub fn members(&self, collection: String, doc: String, field: String) -> Result<Vec<String>, SyncError> {
        self.with(|s| s.members(&collection, &doc, &field))
    }

    pub fn counter(&self, collection: String, doc: String, field: String) -> Result<f64, SyncError> {
        self.with(|s| s.counter(&collection, &doc, &field))
    }

    pub fn ancestors(&self, collection: String, doc: String, field: String) -> Result<Vec<String>, SyncError> {
        self.with(|s| s.ancestors(&collection, &doc, &field))
    }

    pub fn children(&self, collection: String, field: String, parent: Option<String>) -> Result<Vec<String>, SyncError> {
        self.with(|s| s.children(&collection, &field, parent.as_deref()))
    }

    // sync

    pub fn cursor(&self) -> Result<u64, SyncError> {
        self.with(|s| s.cursor())
    }

    pub fn pending_count(&self) -> Result<u64, SyncError> {
        self.with(|s| s.pending_count())
    }

    /// The body for `POST /push`, or nil when there's nothing to send.
    pub fn take_push(&self) -> Result<Option<String>, SyncError> {
        self.with(|s| s.take_push())
    }

    pub fn ack_push(&self, response_json: String) -> Result<Vec<Change>, SyncError> {
        self.with(|s| s.ack_push(&response_json)).map(changes)
    }

    pub fn fail_push(&self) {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).fail_push()
    }

    /// Applies a `GET /changes` page; pull again while `more`.
    pub fn apply_pull(&self, response_json: String) -> Result<PullOutcome, SyncError> {
        self.with(|s| s.apply_pull(&response_json))
            .map(|o| PullOutcome { more: o.more, reset: o.reset, changes: changes(o.changes) })
    }

    pub fn observe_server_time(&self, server_ms: u64) -> Result<(), SyncError> {
        self.with(|s| s.observe_server_time(server_ms))
    }

    /// Forgets the space's data (after leaving or being removed).
    pub fn clear(&self) -> Result<(), SyncError> {
        self.with(|s| s.clear())
    }

    pub fn meta(&self, key: String) -> Result<Option<String>, SyncError> {
        self.with(|s| s.meta(&key))
    }

    pub fn set_meta(&self, key: String, value: Option<String>) -> Result<(), SyncError> {
        self.with(|s| s.set_meta(&key, value.as_deref()))
    }
}

/// A position between two neighbours (either may be nil: list start/end).
#[uniffi::export]
pub fn position_between(before: Option<String>, after: Option<String>) -> String {
    sync_core::position_between(before.as_deref(), after.as_deref())
}

/// The 8-character code in a typed or pasted code or link, or nil.
#[uniffi::export]
pub fn parse_invite(text: String) -> Option<String> {
    sync_core::parse_invite(&text)
}

/// `7KQ2M9XD` → `7KQ2-M9XD`.
#[uniffi::export]
pub fn format_invite(code: String) -> String {
    sync_core::format_invite(&code)
}

/// The link to share: `base` is the app's join page, so
/// (`https://example.com/j`, `7KQ2M9XD`) → `https://example.com/j/7KQ2-M9XD`.
#[uniffi::export]
pub fn invite_link(base: String, code: String) -> String {
    sync_core::invite_link(&base, &code)
}

// Feature flags (crate flare-flags). The Swift and Kotlin `Flags` classes
// in SyncClient do the HTTP and the app lifecycle around this.

impl From<flare_flags::FlagsError> for SyncError {
    fn from(e: flare_flags::FlagsError) -> Self {
        use flare_flags::FlagsError as E;
        match e {
            E::Schema(message) => SyncError::Schema { message },
            other => SyncError::BadResponse {
                message: other.to_string(),
            },
        }
    }
}

#[derive(uniffi::Object)]
pub struct FlagStore {
    inner: Mutex<flare_flags::Flags>,
}

impl FlagStore {
    fn with<T>(&self, f: impl FnOnce(&mut flare_flags::Flags) -> T) -> T {
        f(&mut self.inner.lock().unwrap_or_else(|p| p.into_inner()))
    }
}

#[uniffi::export]
impl FlagStore {
    /// `schema_json` is the app's flags.json; `cache_path` a file the app
    /// owns (nil keeps nothing between launches); `user` the signed-in
    /// user's id, or nil to evaluate for this install.
    #[uniffi::constructor]
    pub fn open(
        schema_json: String,
        cache_path: Option<String>,
        user: Option<String>,
    ) -> Result<Arc<FlagStore>, SyncError> {
        let flags = flare_flags::Flags::open(&schema_json, cache_path.map(Into::into), user)?;
        Ok(Arc::new(FlagStore {
            inner: Mutex::new(flags),
        }))
    }

    /// A flag's value as JSON, or nil for a key not in flags.json. Reading
    /// a flag holds its value until `activate`.
    pub fn value_json(&self, key: String) -> Option<String> {
        self.with(|f| f.value(&key).map(|v| v.to_string()))
    }

    pub fn bool_value(&self, key: String) -> bool {
        self.with(|f| f.bool(&key))
    }

    pub fn int_value(&self, key: String) -> i64 {
        self.with(|f| f.int(&key))
    }

    pub fn number_value(&self, key: String) -> f64 {
        self.with(|f| f.number(&key))
    }

    pub fn string_value(&self, key: String) -> String {
        self.with(|f| f.string(&key))
    }

    /// Every flag's value as a JSON object, without holding any.
    pub fn snapshot_json(&self) -> String {
        self.with(|f| serde_json::Value::Object(f.snapshot()).to_string())
    }

    /// The body for `POST /ofrep/v1/evaluate/flags`. `context_json` is a
    /// JSON object of extra attributes (platform, appVersion…).
    pub fn request_body(&self, context_json: String) -> Result<String, SyncError> {
        let extra = match json(&context_json)? {
            serde_json::Value::Object(m) => m,
            _ => {
                return Err(SyncError::BadJson {
                    message: "context must be a JSON object".into(),
                })
            }
        };
        Ok(self.with(|f| f.request_body(&extra)))
    }

    /// The `If-None-Match` header to send, if any.
    pub fn etag(&self) -> Option<String> {
        self.with(|f| f.etag().map(str::to_owned))
    }

    /// Applies the server's answer; returns the flags that changed.
    pub fn apply_response(
        &self,
        status: u16,
        etag: Option<String>,
        body: String,
    ) -> Result<Vec<String>, SyncError> {
        self.with(|f| f.apply(status, etag.as_deref(), &body))
            .map_err(SyncError::from)
    }

    /// Lets flags that were read take their latest values (call it when
    /// the app comes to the foreground). Returns the flags that changed.
    pub fn activate(&self) -> Vec<String> {
        self.with(|f| f.activate())
    }

    /// Evaluates for a signed-in user (nil: this install). Values go back
    /// to their defaults until the next response; returns what changed.
    pub fn set_user(&self, user: Option<String>) -> Vec<String> {
        self.with(|f| f.set_user(user))
    }

    pub fn identity(&self) -> String {
        self.with(|f| f.identity().to_owned())
    }

    /// When the server last answered (ms since 1970), or nil.
    pub fn fetched_at(&self) -> Option<u64> {
        self.with(|f| f.fetched_at())
    }
}
