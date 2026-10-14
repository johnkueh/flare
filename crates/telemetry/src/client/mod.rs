use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::ids::{event_id, now_ms, random_id};
use crate::queue::Queue;
use crate::transport::{Outcome, Transport};

/// A new session starts after this long without an event (GA4's default).
const SESSION_TIMEOUT_MS: i64 = 30 * 60 * 1000;
const MAX_PARAMS: usize = 50;
const MAX_STRING_CHARS: usize = 500;
const MIN_BACKOFF: Duration = Duration::from_secs(5);
const MAX_BACKOFF: Duration = Duration::from_secs(300);

/// Fixed for the life of the client: who is sending, from what, and where.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct TelemetryConfig {
    /// The ingest Worker's batch URL, e.g. `https://…/v1/events`.
    pub endpoint: String,
    /// Public per-app key the Worker checks. Not a secret: it only stops
    /// stray traffic, like a GA4 measurement id.
    pub app_key: String,
    /// Short app name, e.g. `glp3`.
    pub app_id: String,
    /// `prod` or `dev`.
    pub env: String,
    /// `ios`, `android`, `macos`, `linux`, `windows`, …
    pub platform: String,
    pub app_version: String,
    pub app_build: String,
    pub os_version: String,
    pub device_model: String,
    pub locale: String,
    /// A directory the app owns (Application Support, filesDir, …). The
    /// queue and the install id live here.
    pub storage_dir: String,
    /// Send at least this often while events are waiting.
    #[cfg_attr(feature = "uniffi", uniffi(default = 30))]
    pub flush_interval_secs: u32,
    /// Events per request; also sends early once this many are waiting.
    #[cfg_attr(feature = "uniffi", uniffi(default = 50))]
    pub max_batch_size: u32,
    /// Oldest events are dropped beyond this (offline for days).
    #[cfg_attr(feature = "uniffi", uniffi(default = 5000))]
    pub max_queue_size: u32,
}

/// A param value. Booleans are kept as booleans on the wire.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum TelemetryValue {
    Text { value: String },
    Int { value: i64 },
    Double { value: f64 },
    Bool { value: bool },
}

#[derive(Debug)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum TelemetryError {
    /// The config can't work (empty endpoint, storage dir not writable, …).
    InvalidConfig { reason: String },
}

impl std::fmt::Display for TelemetryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TelemetryError::InvalidConfig { reason } => write!(f, "invalid telemetry config: {reason}"),
        }
    }
}

impl std::error::Error for TelemetryError {}

/// What survives a restart besides the queue.
#[derive(Serialize, Deserialize, Default)]
struct Persisted {
    install_id: String,
    session_id: String,
    last_activity_ms: i64,
}

struct State {
    queue: Queue,
    persisted: Persisted,
    user_id: Option<String>,
    enabled: bool,
    flush_requested: bool,
    /// Bumped after every send round, for `flush_blocking`.
    rounds: u64,
    stopped: bool,
}

struct Shared {
    config: TelemetryConfig,
    state_path: PathBuf,
    context_json: String,
    state: Mutex<State>,
    wake: Condvar,
    round_done: Condvar,
}

/// The analytics client. Create one per process; it is thread-safe and
/// every method returns immediately except `flush_blocking`.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct TelemetryClient {
    shared: Arc<Shared>,
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl TelemetryClient {
    /// Opens (or creates) the queue in `config.storage_dir` and starts the
    /// sender thread. On a fresh install this also queues `first_open`.
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(config: TelemetryConfig) -> Result<Arc<TelemetryClient>, TelemetryError> {
        if !config.endpoint.starts_with("https://") && !config.endpoint.starts_with("http://") {
            return Err(TelemetryError::InvalidConfig { reason: "endpoint must be an http(s) URL".into() });
        }
        let dir = PathBuf::from(&config.storage_dir);
        fs::create_dir_all(&dir)
            .map_err(|e| TelemetryError::InvalidConfig { reason: format!("storage_dir: {e}") })?;

        let state_path = dir.join("state.json");
        let loaded: Option<Persisted> = fs::read(&state_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Persisted>(&b).ok())
            .filter(|p| !p.install_id.is_empty());
        let fresh_install = loaded.is_none();
        let persisted = loaded.unwrap_or_else(|| Persisted { install_id: random_id(), ..Persisted::default() });

        let context_json = context_json(&config, &persisted.install_id);
        let queue = Queue::open(&dir, config.max_queue_size as usize);
        let shared = Arc::new(Shared {
            config,
            state_path,
            context_json,
            state: Mutex::new(State {
                queue,
                persisted,
                user_id: None,
                enabled: true,
                flush_requested: false,
                rounds: 0,
                stopped: false,
            }),
            wake: Condvar::new(),
            round_done: Condvar::new(),
        });
        {
            let mut state = shared.lock();
            save(&shared.state_path, &state.persisted);
            if fresh_install {
                enqueue(&shared, &mut state, "first_open", Map::new());
            }
        }
        let worker = Arc::clone(&shared);
        thread::Builder::new()
            .name("telemetry-sender".into())
            .spawn(move || run_sender(worker))
            .map_err(|e| TelemetryError::InvalidConfig { reason: format!("sender thread: {e}") })?;
        Ok(Arc::new(TelemetryClient { shared }))
    }

    /// Queue one event. Invalid names are dropped; invalid params (bad key,
    /// non-finite number) are dropped one by one; long strings are cut.
    pub fn track(&self, name: String, params: HashMap<String, TelemetryValue>) {
        if !is_valid_key(&name) {
            return;
        }
        let mut state = self.shared.lock();
        if !state.enabled {
            return;
        }
        let mut keys: Vec<&String> = params.keys().filter(|k| is_valid_key(k)).collect();
        keys.sort();
        let mut out = Map::new();
        for key in keys.into_iter().take(MAX_PARAMS) {
            if let Some(v) = to_json(&params[key]) {
                out.insert(key.clone(), v);
            }
        }
        enqueue(&self.shared, &mut state, &name, out);
    }

    /// Ties later events to an id (e.g. RevenueCat's app user id). `None` clears it.
    pub fn set_user_id(&self, user_id: Option<String>) {
        self.shared.lock().user_id = user_id.filter(|s| !s.is_empty());
    }

    /// Opt out (or back in). While disabled, `track` does nothing; already
    /// queued events are still sent.
    pub fn set_enabled(&self, enabled: bool) {
        self.shared.lock().enabled = enabled;
    }

    /// Stable per install (survives app updates, not reinstalls).
    pub fn install_id(&self) -> String {
        self.shared.lock().persisted.install_id.clone()
    }

    /// The current session, or a new one if the last event was over 30 minutes ago.
    pub fn session_id(&self) -> String {
        let mut state = self.shared.lock();
        touch_session(&self.shared, &mut state, now_ms());
        state.persisted.session_id.clone()
    }

    /// Events waiting to be sent.
    pub fn pending_count(&self) -> u32 {
        self.shared.lock().queue.len() as u32
    }

    /// Ask the sender to send now (e.g. when the app goes to the background).
    pub fn flush(&self) {
        let mut state = self.shared.lock();
        state.flush_requested = true;
        self.shared.wake.notify_all();
    }

    /// Send now and wait up to `timeout_ms` for one send round to finish.
    /// Returns true if the queue is empty afterwards. For CLIs before exit
    /// and background tasks with a deadline; never call it on a UI thread.
    pub fn flush_blocking(&self, timeout_ms: u32) -> bool {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms as u64);
        let mut state = self.shared.lock();
        let start_round = state.rounds;
        state.flush_requested = true;
        self.shared.wake.notify_all();
        while state.rounds == start_round && !state.queue_is_empty() {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            state = match self.shared.round_done.wait_timeout(state, deadline - now) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
        state.queue_is_empty()
    }
}

impl Drop for TelemetryClient {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        state.stopped = true;
        self.shared.wake.notify_all();
    }
}

impl State {
    fn queue_is_empty(&self) -> bool {
        self.queue.len() == 0
    }
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // A panic while holding the lock can't leave the queue invalid
        // (every write is whole), so carry on with the data.
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn enqueue(shared: &Shared, state: &mut State, name: &str, params: Map<String, Value>) {
    let ts = now_ms();
    if touch_session(shared, state, ts) {
        push_event(shared, state, "session_start", Map::new(), ts);
    }
    push_event(shared, state, name, params, ts);
}

fn push_event(shared: &Shared, state: &mut State, name: &str, params: Map<String, Value>, ts: i64) {
    let mut event = Map::new();
    event.insert("event_id".into(), Value::String(event_id()));
    event.insert("name".into(), Value::String(name.into()));
    event.insert("ts".into(), Value::from(ts));
    event.insert("session_id".into(), Value::String(state.persisted.session_id.clone()));
    if let Some(user_id) = &state.user_id {
        event.insert("user_id".into(), Value::String(user_id.clone()));
    }
    event.insert("params".into(), Value::Object(params));
    state.queue.push(Value::Object(event).to_string());
    if state.queue.len() >= shared.config.max_batch_size.max(1) as usize {
        shared.wake.notify_all();
    }
}

/// Updates the session clock. Returns true when this starts a new session.
fn touch_session(shared: &Shared, state: &mut State, now: i64) -> bool {
    let p = &mut state.persisted;
    let expired = p.session_id.is_empty() || now - p.last_activity_ms > SESSION_TIMEOUT_MS || now < p.last_activity_ms;
    p.last_activity_ms = now;
    if expired {
        p.session_id = random_id();
        save(&shared.state_path, p);
    }
    expired
}

fn run_sender(shared: Arc<Shared>) {
    let transport = Transport::new(shared.config.endpoint.clone(), shared.config.app_key.clone());
    let interval = Duration::from_secs(shared.config.flush_interval_secs.max(1) as u64);
    let batch = shared.config.max_batch_size.max(1) as usize;
    let mut backoff: Option<Duration> = None;

    loop {
        // Sleep until it's time, a flush is asked for, or a full batch is waiting.
        {
            let mut state = shared.lock();
            let wait = backoff.unwrap_or(interval);
            let deadline = Instant::now() + wait;
            loop {
                if state.stopped {
                    return;
                }
                let full = state.queue.len() >= batch;
                if (state.flush_requested && backoff.is_none()) || (full && backoff.is_none()) {
                    break;
                }
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                state = match shared.wake.wait_timeout(state, deadline - now) {
                    Ok((guard, _)) => guard,
                    Err(poisoned) => poisoned.into_inner().0,
                };
            }
            state.flush_requested = false;
        }

        // Send batches until the queue is empty or the server says wait.
        loop {
            let lines = shared.lock().queue.peek(batch);
            if lines.is_empty() {
                backoff = None;
                break;
            }
            let body = format!(
                "{{\"context\":{},\"sent_at\":{},\"events\":[{}]}}",
                shared.context_json,
                now_ms(),
                lines.join(",")
            );
            match transport.send(&body) {
                Outcome::Delivered | Outcome::Rejected => {
                    shared.lock().queue.remove_front(lines.len());
                    backoff = None;
                }
                Outcome::Retry => {
                    backoff = Some(backoff.map_or(MIN_BACKOFF, |b| (b * 2).min(MAX_BACKOFF)));
                    break;
                }
            }
        }

        let mut state = shared.lock();
        save(&shared.state_path, &state.persisted);
        state.rounds += 1;
        shared.round_done.notify_all();
    }
}

fn save(path: &PathBuf, persisted: &Persisted) {
    if let Ok(bytes) = serde_json::to_vec(persisted) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }
}

fn context_json(config: &TelemetryConfig, install_id: &str) -> String {
    serde_json::json!({
        "sdk": concat!("telemetry-sdk/", env!("CARGO_PKG_VERSION")),
        "app_id": config.app_id,
        "env": config.env,
        "platform": config.platform,
        "app_version": config.app_version,
        "app_build": config.app_build,
        "os_version": config.os_version,
        "device_model": config.device_model,
        "locale": config.locale,
        "install_id": install_id,
    })
    .to_string()
}

/// Event names and param keys: lowercase snake case, 1–64 chars.
fn is_valid_key(s: &str) -> bool {
    let bytes = s.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

fn to_json(value: &TelemetryValue) -> Option<Value> {
    match value {
        TelemetryValue::Text { value } => Some(Value::String(value.chars().take(MAX_STRING_CHARS).collect())),
        TelemetryValue::Int { value } => Some(Value::from(*value)),
        TelemetryValue::Double { value } => serde_json::Number::from_f64(*value).map(Value::Number),
        TelemetryValue::Bool { value } => Some(Value::Bool(*value)),
    }
}

#[cfg(test)]
mod tests;
