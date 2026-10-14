//! telemetry-sdk: product analytics for every app we ship (iOS, Android,
//! macOS, Linux, Windows), in one place.
//!
//! The app calls [`TelemetryClient::track`] with an event name and flat
//! params. The client stamps ids and context, appends the event to a queue
//! file (so nothing is lost on a crash or offline), and a background thread
//! posts batches to the ingest Worker, which writes them to Cloudflare Basin.
//!
//! Nothing here blocks the caller on the network or panics on bad input:
//! analytics must never break a user flow. Event names and the params each
//! accepts are the app's contract (generated per platform); this crate only
//! enforces the wire limits.

mod client;
mod ids;
mod queue;
mod transport;

pub use client::{TelemetryClient, TelemetryConfig, TelemetryError, TelemetryValue};

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!();
