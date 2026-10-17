//! Crashes, hangs and handled errors, sent as ordinary events named
//! `crash`, `hang` and `error`. The platform layer (MetricKit on iOS,
//! ApplicationExitInfo and the uncaught-exception handler on Android, the
//! panic hook here) turns what it finds into a [`ProblemReport`]; the
//! Worker adds a `fingerprint` and `title` so `GROUP BY fingerprint` gives
//! one row per distinct problem.

use serde_json::{Map, Value};

const MAX_FRAMES: usize = 50;
const MAX_MESSAGE_CHARS: usize = 1000;
const MAX_FIELD_CHARS: usize = 300;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
pub enum ProblemKind {
    /// The process died.
    Crash,
    /// The main thread was stuck (iOS hang, Android ANR).
    Hang,
    /// Caught and handled, but worth counting.
    Error,
}

impl ProblemKind {
    pub fn event_name(self) -> &'static str {
        match self {
            ProblemKind::Crash => "crash",
            ProblemKind::Hang => "hang",
            ProblemKind::Error => "error",
        }
    }
}

/// One stack frame, innermost first. Fill what the platform gives you:
/// MetricKit has `module` + `offset` + `image_id` but no function names;
/// a JVM stack has `function` and `file:line`.
#[derive(Clone, Debug, Default, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct StackFrame {
    /// Binary or package, e.g. `GLP3`, `libglp3_core.so`, `com.glp3.app`.
    pub module: String,
    /// Symbol, e.g. `DoseStore.save(_:)` or `com.glp3.Dose.save`.
    #[cfg_attr(feature = "uniffi", uniffi(default = None))]
    pub function: Option<String>,
    /// `File.kt:42`, when known.
    #[cfg_attr(feature = "uniffi", uniffi(default = None))]
    pub file_line: Option<String>,
    /// Offset into the binary's text segment (for symbolicating later).
    #[cfg_attr(feature = "uniffi", uniffi(default = None))]
    pub offset: Option<u64>,
    /// The binary's UUID / build id, matching its dSYM or symbols file.
    #[cfg_attr(feature = "uniffi", uniffi(default = None))]
    pub image_id: Option<String>,
    /// The app's own code (not the OS or a system library). Grouping uses
    /// the top in-app frames.
    pub in_app: bool,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
pub struct ProblemReport {
    pub kind: ProblemKind,
    /// e.g. `EXC_BAD_ACCESS SIGSEGV`, `java.lang.IllegalStateException`,
    /// `ANR`, `rust_panic`, or an app error domain.
    pub type_name: String,
    pub message: String,
    pub frames: Vec<StackFrame>,
    /// True when the OS reported this on a later launch (MetricKit,
    /// ApplicationExitInfo, a crash file written by the dying process):
    /// breadcrumbs then come from the previous run, not this one.
    #[cfg_attr(feature = "uniffi", uniffi(default = false))]
    pub from_previous_run: bool,
    /// When it happened (ms since epoch), if the OS says; else now.
    #[cfg_attr(feature = "uniffi", uniffi(default = None))]
    pub occurred_at_ms: Option<i64>,
    /// The version and build that crashed, if not the running one
    /// (MetricKit and ApplicationExitInfo can report a crash after an update).
    #[cfg_attr(feature = "uniffi", uniffi(default = None))]
    pub app_version: Option<String>,
    #[cfg_attr(feature = "uniffi", uniffi(default = None))]
    pub app_build: Option<String>,
}

fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn frame_json(f: &StackFrame) -> Value {
    let mut o = Map::new();
    o.insert("module".into(), Value::String(cut(&f.module, MAX_FIELD_CHARS)));
    if let Some(v) = f.function.as_deref().filter(|s| !s.is_empty()) {
        o.insert("function".into(), Value::String(cut(v, MAX_FIELD_CHARS)));
    }
    if let Some(v) = f.file_line.as_deref().filter(|s| !s.is_empty()) {
        o.insert("file_line".into(), Value::String(cut(v, MAX_FIELD_CHARS)));
    }
    if let Some(v) = f.offset {
        o.insert("offset".into(), Value::from(v));
    }
    if let Some(v) = f.image_id.as_deref().filter(|s| !s.is_empty()) {
        o.insert("image_id".into(), Value::String(cut(v, 64)));
    }
    o.insert("in_app".into(), Value::Bool(f.in_app));
    Value::Object(o)
}

/// The event params for a report, without breadcrumbs (the client adds them).
pub fn params(report: &ProblemReport) -> Map<String, Value> {
    let mut p = Map::new();
    p.insert("type".into(), Value::String(cut(&report.type_name, MAX_FIELD_CHARS)));
    p.insert("message".into(), Value::String(cut(&report.message, MAX_MESSAGE_CHARS)));
    p.insert("frames".into(), Value::Array(report.frames.iter().take(MAX_FRAMES).map(frame_json).collect()));
    p.insert("from_previous_run".into(), Value::Bool(report.from_previous_run));
    if let Some(ts) = report.occurred_at_ms {
        p.insert("occurred_at".into(), Value::from(ts));
    }
    if let Some(v) = report.app_version.as_deref().filter(|s| !s.is_empty()) {
        p.insert("crashed_version".into(), Value::String(cut(v, 32)));
    }
    if let Some(v) = report.app_build.as_deref().filter(|s| !s.is_empty()) {
        p.insert("crashed_build".into(), Value::String(cut(v, 32)));
    }
    p
}

/// A Rust panic as a report: the panic site is the one frame we always have.
pub fn from_panic(info: &std::panic::PanicHookInfo<'_>) -> ProblemReport {
    let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "panic".to_string()
    };
    let frames = info
        .location()
        .map(|l| {
            vec![StackFrame {
                module: "rust".into(),
                file_line: Some(format!("{}:{}", l.file(), l.line())),
                in_app: true,
                ..StackFrame::default()
            }]
        })
        .unwrap_or_default();
    ProblemReport {
        // With panic = "abort" the process dies; otherwise UniFFI turns the
        // panic into an exception the app can survive.
        kind: if cfg!(panic = "abort") { ProblemKind::Crash } else { ProblemKind::Error },
        type_name: "rust_panic".into(),
        message,
        frames,
        from_previous_run: false,
        occurred_at_ms: None,
        app_version: None,
        app_build: None,
    }
}
