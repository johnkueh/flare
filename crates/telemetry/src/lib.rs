//! telemetry-sdk: product analytics for every app we ship (iOS, Android,
//! macOS, Linux, Windows), in one place.
//!
//! The app calls [`TelemetryClient::track`] with an event name and flat
//! params. The client stamps ids and context, appends the event to a queue
//! file (so nothing is lost on a crash or offline), and a background thread
//! posts batches to the ingest Worker, which writes them to Cloudflare Basin.
//!
//! Crashes, hangs and handled errors go through the same queue as events
//! named `crash`, `hang` and `error` ([`TelemetryClient::report`]), each
//! with its stack and the last breadcrumbs; the platform layer finds them
//! (MetricKit, ApplicationExitInfo) and [`TelemetryClient::install_panic_hook`]
//! covers Rust panics.
//!
//! Nothing here blocks the caller on the network or panics on bad input:
//! analytics must never break a user flow. Event names and the params each
//! accepts are the app's contract (generated per platform); this crate only
//! enforces the wire limits.

mod breadcrumbs;
mod client;
mod ids;
mod problems;
mod queue;
mod transport;

pub use client::{TelemetryClient, TelemetryConfig, TelemetryError, TelemetryValue};
pub use problems::{ProblemKind, ProblemReport, StackFrame};

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!();
