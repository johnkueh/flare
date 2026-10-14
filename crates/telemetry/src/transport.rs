//! Posting a batch to the ingest Worker.

use std::time::Duration;

/// What happened to one batch.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 2xx: the events are stored; drop them from the queue.
    Delivered,
    /// The server refused the batch for good (a 4xx other than 408/429):
    /// drop it rather than resend it forever.
    Rejected,
    /// Offline, timed out, 408/429 or 5xx: keep the events and back off.
    Retry,
}

pub fn classify(status: u16) -> Outcome {
    match status {
        200..=299 => Outcome::Delivered,
        408 | 429 => Outcome::Retry,
        400..=499 => Outcome::Rejected,
        _ => Outcome::Retry,
    }
}

pub struct Transport {
    agent: ureq::Agent,
    endpoint: String,
    app_key: String,
}

impl Transport {
    pub fn new(endpoint: String, app_key: String) -> Transport {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(20)))
            .http_status_as_error(false)
            .user_agent(concat!("telemetry-sdk/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Transport { agent, endpoint, app_key }
    }

    pub fn send(&self, body: &str) -> Outcome {
        let result = self
            .agent
            .post(&self.endpoint)
            .header("content-type", "application/json")
            .header("x-app-key", &self.app_key)
            .send(body);
        match result {
            Ok(response) => classify(response.status().as_u16()),
            Err(_) => Outcome::Retry,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_outcomes() {
        assert_eq!(classify(204), Outcome::Delivered);
        assert_eq!(classify(400), Outcome::Rejected);
        assert_eq!(classify(413), Outcome::Rejected);
        assert_eq!(classify(429), Outcome::Retry);
        assert_eq!(classify(503), Outcome::Retry);
    }
}
