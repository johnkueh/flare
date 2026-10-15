//! A blocking refresh for command-line tools and servers (feature `http`).

use std::time::Duration;

use serde_json::{Map, Value};

use crate::{Flags, FlagsError};

impl Flags {
    /// Asks the Worker for fresh values and applies them. `server` is the
    /// Worker's origin (`https://api.example.com`); the request goes to
    /// `{server}/ofrep/v1/evaluate/flags`. `headers` add, for example, an
    /// `authorization` header. Returns the flags that changed.
    pub fn refresh(
        &mut self,
        server: &str,
        headers: &[(&str, &str)],
        context: &Map<String, Value>,
    ) -> Result<Vec<String>, FlagsError> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            .http_status_as_error(false)
            .user_agent(concat!("flare-flags/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        let url = format!("{}/ofrep/v1/evaluate/flags", server.trim_end_matches('/'));
        let mut request = agent.post(&url).header("content-type", "application/json");
        if let Some(etag) = self.etag() {
            request = request.header("if-none-match", etag);
        }
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let mut response = request
            .send(self.request_body(context))
            .map_err(|e| FlagsError::Network(e.to_string()))?;
        let status = response.status().as_u16();
        let etag = response
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = if status == 200 {
            response
                .body_mut()
                .read_to_string()
                .map_err(|e| FlagsError::Network(e.to_string()))?
        } else {
            String::new()
        };
        self.apply(status, etag.as_deref(), &body)
    }
}
