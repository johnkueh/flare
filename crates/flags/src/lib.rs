//! flare-flags: feature flags for apps on Flare, served by Cloudflare Flagship.
//!
//! An app declares its flags once in `flags.json`, each with the value to
//! use until the server says otherwise:
//!
//! ```json
//! { "flags": {
//!     "new-checkout": { "default": false },
//!     "upload-limit": { "default": 10 },
//!     "kill-import":  { "default": false, "live": true }
//! } }
//! ```
//!
//! The app's Worker evaluates them through its Flagship binding
//! (`@flare/flags`) and answers `POST /ofrep/v1/evaluate/flags`. This crate
//! is the client side every platform shares: it keeps the last values on
//! disk, builds the request, applies the response, and decides when a new
//! value reaches the app. It does no networking of its own (the Swift and
//! Kotlin wrappers use URLSession and OkHttp) unless the `http` feature is
//! on, which adds a blocking [`Flags::refresh`] for command-line tools.
//!
//! Reads never wait on the network and never fail: a value comes from the
//! last response (or the cache, before one arrives), else the default in
//! `flags.json`.
//!
//! **When a new value shows.** A flag the app hasn't read yet takes a new
//! value as soon as it arrives. One it has read keeps its value until
//! [`Flags::activate`] (the wrappers call it when the app comes to the
//! foreground), so a screen never changes under the user. Flags marked
//! `"live": true`, such as kill switches, change at once.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

#[cfg(feature = "http")]
mod http;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FlagsError {
    #[error("flags.json: {0}")]
    Schema(String),
    #[error("unexpected server response: {0}")]
    BadResponse(String),
    #[error("server answered {0}")]
    Status(u16),
    #[error("network: {0}")]
    Network(String),
}

/// The type of a flag, from its default (or an explicit `"type"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Bool,
    /// A whole number (the default has no fraction, or `"type": "integer"`).
    Int,
    Number,
    String,
    /// A JSON object or array.
    Json,
}

impl Kind {
    fn accepts(self, v: &Value) -> bool {
        match self {
            Kind::Bool => v.is_boolean(),
            Kind::Int => {
                v.is_i64()
                    || v.is_u64()
                    || v.as_f64()
                        .is_some_and(|f| f.fract() == 0.0 && f.abs() < 9.0e15)
            }
            Kind::Number => v.is_number(),
            Kind::String => v.is_string(),
            Kind::Json => v.is_object() || v.is_array(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Flag {
    pub key: String,
    pub kind: Kind,
    pub default: Value,
    pub live: bool,
    pub description: Option<String>,
}

/// The parsed `flags.json`.
#[derive(Debug, Clone)]
pub struct Schema {
    flags: BTreeMap<String, Flag>,
}

/// Flagship's own limit on keys, and what the generated accessors can name.
pub fn valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    key.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Schema {
    pub fn from_json(json: &str) -> Result<Schema, FlagsError> {
        let root: Value =
            serde_json::from_str(json).map_err(|e| FlagsError::Schema(e.to_string()))?;
        let flags = root
            .get("flags")
            .and_then(Value::as_object)
            .ok_or_else(|| FlagsError::Schema("expected {\"flags\": {...}}".into()))?;
        let mut out = BTreeMap::new();
        for (key, def) in flags {
            if !valid_key(key) {
                return Err(FlagsError::Schema(format!(
                    "{key:?}: keys start with a letter and use letters, digits, - and _ (64 at most)"
                )));
            }
            let default = def
                .get("default")
                .cloned()
                .ok_or_else(|| FlagsError::Schema(format!("{key}: needs a \"default\"")))?;
            let kind = match def.get("type").and_then(Value::as_str) {
                Some("boolean") => Kind::Bool,
                Some("integer") => Kind::Int,
                Some("number") => Kind::Number,
                Some("string") => Kind::String,
                Some("object") => Kind::Json,
                Some(other) => {
                    return Err(FlagsError::Schema(format!("{key}: unknown type {other:?}")))
                }
                None => match &default {
                    Value::Bool(_) => Kind::Bool,
                    Value::Number(n) if n.is_i64() || n.is_u64() => Kind::Int,
                    Value::Number(_) => Kind::Number,
                    Value::String(_) => Kind::String,
                    Value::Object(_) | Value::Array(_) => Kind::Json,
                    Value::Null => {
                        return Err(FlagsError::Schema(format!(
                            "{key}: the default can't be null"
                        )))
                    }
                },
            };
            if !kind.accepts(&default) {
                return Err(FlagsError::Schema(format!(
                    "{key}: the default doesn't match its type"
                )));
            }
            let live = def.get("live").and_then(Value::as_bool).unwrap_or(false);
            let description = def
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned);
            out.insert(
                key.clone(),
                Flag {
                    key: key.clone(),
                    kind,
                    default,
                    live,
                    description,
                },
            );
        }
        Ok(Schema { flags: out })
    }

    pub fn get(&self, key: &str) -> Option<&Flag> {
        self.flags.get(key)
    }

    pub fn flags(&self) -> impl Iterator<Item = &Flag> {
        self.flags.values()
    }
}

/// What's on disk between launches.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Cache {
    install_id: String,
    /// Who the values below were evaluated for.
    identity: Option<String>,
    etag: Option<String>,
    fetched_at: Option<u64>,
    values: BTreeMap<String, Value>,
}

/// One app's flags. Not thread-safe on its own; the FFI wraps it in a lock.
pub struct Flags {
    schema: Schema,
    cache_path: Option<PathBuf>,
    install_id: String,
    /// A signed-in user, or None for this install.
    user: Option<String>,
    /// The last values the server sent (or the cache held).
    server: BTreeMap<String, Value>,
    /// What reads return. Differs from `server` only for flags read since
    /// the last [`Flags::activate`] (which wait for it).
    active: BTreeMap<String, Value>,
    read: BTreeSet<String>,
    /// The user changed and no response has come for them yet: the next
    /// one applies to every flag.
    switched: bool,
    etag: Option<String>,
    fetched_at: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn random_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        return format!("t{:x}", now_ms());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Flags {
    /// `schema_json` is the app's flags.json. `cache_path` is a file the
    /// app owns (None keeps nothing between launches). `user` is the
    /// signed-in user's id; without one, flags are evaluated for this
    /// install (a random id kept in the cache file).
    pub fn open(
        schema_json: &str,
        cache_path: Option<PathBuf>,
        user: Option<String>,
    ) -> Result<Flags, FlagsError> {
        let schema = Schema::from_json(schema_json)?;
        let cache: Cache = cache_path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let install_id = if cache.install_id.is_empty() {
            random_id()
        } else {
            cache.install_id.clone()
        };
        let mut flags = Flags {
            schema,
            cache_path,
            install_id,
            user,
            server: BTreeMap::new(),
            active: BTreeMap::new(),
            read: BTreeSet::new(),
            switched: false,
            etag: None,
            fetched_at: None,
        };
        if cache.identity.as_deref() == Some(flags.identity()) {
            flags.server = cache
                .values
                .into_iter()
                .filter(|(k, v)| flags.valid(k, v))
                .collect();
            flags.active = flags.server.clone();
            flags.etag = cache.etag;
            flags.fetched_at = cache.fetched_at;
        }
        flags.save();
        Ok(flags)
    }

    fn valid(&self, key: &str, v: &Value) -> bool {
        self.schema.get(key).is_some_and(|f| f.kind.accepts(v))
    }

    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    /// The id flags are evaluated for: the user, else this install.
    pub fn identity(&self) -> &str {
        self.user.as_deref().unwrap_or(&self.install_id)
    }

    pub fn install_id(&self) -> &str {
        &self.install_id
    }

    /// When the server last answered (ms since 1970), or None.
    pub fn fetched_at(&self) -> Option<u64> {
        self.fetched_at
    }

    // reads

    /// A flag's current value, or None for a key not in flags.json. Marks
    /// the flag read, so it holds its value until [`Flags::activate`].
    pub fn value(&mut self, key: &str) -> Option<Value> {
        let flag = self.schema.get(key)?;
        let v = self
            .active
            .get(key)
            .cloned()
            .unwrap_or_else(|| flag.default.clone());
        self.read.insert(key.to_owned());
        Some(v)
    }

    pub fn bool(&mut self, key: &str) -> bool {
        self.value(key).and_then(|v| v.as_bool()).unwrap_or(false)
    }

    pub fn int(&mut self, key: &str) -> i64 {
        self.value(key)
            .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
            .unwrap_or(0)
    }

    pub fn number(&mut self, key: &str) -> f64 {
        self.value(key).and_then(|v| v.as_f64()).unwrap_or(0.0)
    }

    pub fn string(&mut self, key: &str) -> String {
        self.value(key)
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default()
    }

    /// Every flag's current value, without marking any read (for a debug
    /// screen).
    pub fn snapshot(&self) -> Map<String, Value> {
        self.schema
            .flags()
            .map(|f| {
                (
                    f.key.clone(),
                    self.active
                        .get(&f.key)
                        .cloned()
                        .unwrap_or_else(|| f.default.clone()),
                )
            })
            .collect()
    }

    // the request

    /// The body for `POST /ofrep/v1/evaluate/flags`: `{"context": {...}}`
    /// with `targetingKey` set to [`Flags::identity`]. `extra` adds
    /// attributes such as `platform` and `appVersion`; the Worker decides
    /// which it trusts.
    pub fn request_body(&self, extra: &Map<String, Value>) -> String {
        let mut context = extra.clone();
        context.insert(
            "targetingKey".into(),
            Value::String(self.identity().to_owned()),
        );
        serde_json::json!({ "context": context }).to_string()
    }

    /// The `If-None-Match` header to send, if any.
    pub fn etag(&self) -> Option<&str> {
        self.etag.as_deref()
    }

    /// Applies the server's answer. Returns the flags whose value changed
    /// for readers now.
    pub fn apply(
        &mut self,
        status: u16,
        etag: Option<&str>,
        body: &str,
    ) -> Result<Vec<String>, FlagsError> {
        match status {
            304 => {
                self.fetched_at = Some(now_ms());
                self.save();
                Ok(Vec::new())
            }
            200 => {
                let values = self.parse(body)?;
                self.server = values;
                self.etag = etag.map(str::to_owned);
                self.fetched_at = Some(now_ms());
                self.save();
                let all = std::mem::take(&mut self.switched);
                Ok(self.settle(all))
            }
            other => Err(FlagsError::Status(other)),
        }
    }

    fn parse(&self, body: &str) -> Result<BTreeMap<String, Value>, FlagsError> {
        let root: Value =
            serde_json::from_str(body).map_err(|e| FlagsError::BadResponse(e.to_string()))?;
        let list = root
            .get("flags")
            .and_then(Value::as_array)
            .ok_or_else(|| FlagsError::BadResponse("expected {\"flags\": [...]}".into()))?;
        // An entry without a value (an error, or a flag gone from Flagship)
        // or of the wrong type falls back to the default.
        Ok(list
            .iter()
            .filter_map(|e| Some((e.get("key")?.as_str()?.to_owned(), e.get("value")?.clone())))
            .filter(|(k, v)| self.valid(k, v))
            .collect())
    }

    /// Moves values from `server` to `active`: all of them when `all`,
    /// else only flags that are live or haven't been read.
    fn settle(&mut self, all: bool) -> Vec<String> {
        let mut changed = Vec::new();
        for flag in self.schema.flags.values() {
            if !(all || flag.live || !self.read.contains(&flag.key)) {
                continue;
            }
            let next = self.server.get(&flag.key);
            if self.active.get(&flag.key) != next {
                match next {
                    Some(v) => self.active.insert(flag.key.clone(), v.clone()),
                    None => self.active.remove(&flag.key),
                };
                changed.push(flag.key.clone());
            }
        }
        changed
    }

    /// Lets read flags take the latest values: call it where a change
    /// won't surprise anyone, such as the app coming to the foreground.
    /// Returns the flags that changed.
    pub fn activate(&mut self) -> Vec<String> {
        let changed = self.settle(true);
        self.read.clear();
        changed
    }

    /// Evaluates flags for a signed-in user from now on (None: this
    /// install again, after signing out). Values go back to their defaults
    /// until the next response, which applies to every flag at once.
    /// Returns the flags that changed, or nothing when the user is the same.
    pub fn set_user(&mut self, user: Option<String>) -> Vec<String> {
        if self.user == user {
            return Vec::new();
        }
        self.user = user;
        self.server.clear();
        self.etag = None;
        self.fetched_at = None;
        self.save();
        self.switched = true;
        self.settle(true)
    }

    fn save(&self) {
        let Some(path) = &self.cache_path else { return };
        let cache = Cache {
            install_id: self.install_id.clone(),
            identity: Some(self.identity().to_owned()),
            etag: self.etag.clone(),
            fetched_at: self.fetched_at,
            values: self.server.clone(),
        };
        let Ok(bytes) = serde_json::to_vec(&cache) else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Write then rename, so a crash mid-write leaves the old file.
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}
