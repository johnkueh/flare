use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

use super::*;

/// A one-route HTTP server that records request bodies and answers each
/// request with the next status in `statuses` (then 204 forever).
fn server(statuses: Vec<u16>) -> (String, mpsc::Receiver<serde_json::Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/v1/events", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut statuses = statuses.into_iter();
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; len];
            reader.read_exact(&mut body).unwrap();
            let status = statuses.next().unwrap_or(204);
            if status == 204 {
                tx.send(serde_json::from_slice(&body).unwrap()).unwrap();
            }
            write!(stream, "HTTP/1.1 {status} X\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").unwrap();
        }
    });
    (url, rx)
}

fn config(endpoint: &str, dir: &str) -> TelemetryConfig {
    TelemetryConfig {
        endpoint: endpoint.into(),
        app_key: "test-key".into(),
        app_id: "glp3".into(),
        env: "dev".into(),
        platform: "linux".into(),
        app_version: "1.0".into(),
        app_build: "1".into(),
        os_version: "6".into(),
        device_model: "test".into(),
        locale: "en-AU".into(),
        storage_dir: dir.into(),
        flush_interval_secs: 3600,
        max_batch_size: 50,
        max_queue_size: 100,
    }
}

fn temp_dir() -> String {
    std::env::temp_dir().join(format!("telemetry-client-{}", random_id())).to_string_lossy().into_owned()
}

fn names(batch: &serde_json::Value) -> Vec<String> {
    batch["events"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect()
}

#[test]
fn sends_a_batch_with_context_and_auto_events() {
    let (url, rx) = server(vec![]);
    let dir = temp_dir();
    let client = TelemetryClient::new(config(&url, &dir)).unwrap();
    client.set_user_id(Some("rc_123".into()));
    client.track(
        "dose_logged".into(),
        HashMap::from([
            ("compound".into(), TelemetryValue::Text { value: "tirzepatide".into() }),
            ("mg".into(), TelemetryValue::Double { value: 2.5 }),
            ("bad".into(), TelemetryValue::Double { value: f64::NAN }),
            ("Bad Key".into(), TelemetryValue::Int { value: 1 }),
            ("first".into(), TelemetryValue::Bool { value: true }),
        ]),
    );
    client.track("Not Valid".into(), HashMap::new());
    assert!(client.flush_blocking(5000));

    let batch = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(batch["context"]["app_id"], "glp3");
    assert_eq!(batch["context"]["install_id"], client.install_id().as_str());
    assert_eq!(names(&batch), ["session_start", "first_open", "dose_logged"]);
    let dose = &batch["events"][2];
    assert_eq!(dose["user_id"], "rc_123");
    assert_eq!(dose["session_id"], client.session_id().as_str());
    assert_eq!(dose["params"], serde_json::json!({"compound": "tirzepatide", "first": true, "mg": 2.5}));
}

#[test]
fn keeps_events_through_failures_and_restarts() {
    // Two 503s: the first send fails, so the event must survive a restart
    // and go out (once) from the second client.
    let (url, rx) = server(vec![503, 503]);
    let dir = temp_dir();
    let install_id;
    {
        let client = TelemetryClient::new(config(&url, &dir)).unwrap();
        install_id = client.install_id();
        client.track("app_opened".into(), HashMap::new());
        assert!(!client.flush_blocking(5000));
        assert_eq!(client.pending_count(), 3);
    }
    let client = TelemetryClient::new(config(&url, &dir)).unwrap();
    assert_eq!(client.install_id(), install_id, "install id survives a restart");
    // Still backing off from the first client's failure? No: a new client starts fresh.
    assert!(!client.flush_blocking(5000)); // second 503
    thread::sleep(MIN_BACKOFF + Duration::from_millis(500));
    assert!(client.flush_blocking(5000));
    let batch = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(names(&batch), ["session_start", "first_open", "app_opened"], "no second first_open");
}

#[test]
fn drops_a_rejected_batch() {
    let (url, _rx) = server(vec![400]);
    let client = TelemetryClient::new(config(&url, &temp_dir())).unwrap();
    client.track("x".into(), HashMap::new());
    assert!(client.flush_blocking(5000));
    assert_eq!(client.pending_count(), 0);
}

#[test]
fn rejects_a_bad_endpoint() {
    assert!(TelemetryClient::new(config("ftp://nope", &temp_dir())).is_err());
}

fn frame(module: &str, function: &str) -> crate::StackFrame {
    crate::StackFrame { module: module.into(), function: Some(function.into()), in_app: true, ..Default::default() }
}

#[test]
fn reports_a_handled_error_with_this_runs_breadcrumbs() {
    let (url, rx) = server(vec![]);
    let client = TelemetryClient::new(config(&url, &temp_dir())).unwrap();
    client.track("dose_logged".into(), HashMap::new());
    client.report(crate::ProblemReport {
        kind: crate::ProblemKind::Error,
        type_name: "SyncError".into(),
        message: "x".repeat(5000),
        frames: vec![frame("GLP3", "DoseStore.save")],
        from_previous_run: false,
        occurred_at_ms: None,
        app_version: None,
        app_build: None,
    });
    assert!(client.flush_blocking(5000));
    let batch = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(names(&batch), ["session_start", "first_open", "dose_logged", "error"]);
    let p = &batch["events"][3]["params"];
    assert_eq!(p["type"], "SyncError");
    assert_eq!(p["message"].as_str().unwrap().len(), 1000);
    assert_eq!(p["frames"][0], serde_json::json!({"module": "GLP3", "function": "DoseStore.save", "in_app": true}));
    let crumbs: Vec<&str> = p["breadcrumbs"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(crumbs, ["session_start", "first_open", "dose_logged"]);
}

#[test]
fn a_crash_from_the_last_run_gets_that_runs_session_and_breadcrumbs() {
    let (url, rx) = server(vec![]);
    let dir = temp_dir();
    let last_session;
    {
        let client = TelemetryClient::new(config(&url, &dir)).unwrap();
        client.track("checkout_tapped".into(), HashMap::new());
        last_session = client.session_id();
        assert!(client.flush_blocking(5000));
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
    }
    let crashed_at = now_ms();
    let client = TelemetryClient::new(config(&url, &dir)).unwrap();
    client.track("app_opened".into(), HashMap::new());
    client.report(crate::ProblemReport {
        kind: crate::ProblemKind::Crash,
        type_name: "EXC_BAD_ACCESS SIGSEGV".into(),
        message: String::new(),
        frames: vec![],
        from_previous_run: true,
        occurred_at_ms: Some(crashed_at),
        app_version: Some("1.9".into()),
        app_build: None,
    });
    assert!(client.flush_blocking(5000));
    let batch = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let crash = batch["events"].as_array().unwrap().iter().find(|e| e["name"] == "crash").unwrap();
    assert_eq!(crash["session_id"], last_session.as_str());
    assert_eq!(crash["params"]["crashed_version"], "1.9");
    let crumbs: Vec<&str> =
        crash["params"]["breadcrumbs"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(crumbs, ["session_start", "first_open", "checkout_tapped"], "not this run's app_opened");
}

#[test]
fn reports_a_rust_panic() {
    let (url, rx) = server(vec![]);
    let client = TelemetryClient::new(config(&url, &temp_dir())).unwrap();
    client.install_panic_hook();
    let _ = thread::spawn(|| panic!("boom")).join();
    assert!(client.flush_blocking(5000));
    let batch = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let event = batch["events"].as_array().unwrap().iter().find(|e| e["name"] == "error").unwrap();
    assert_eq!(event["params"]["type"], "rust_panic");
    assert_eq!(event["params"]["message"], "boom");
    assert!(event["params"]["frames"][0]["file_line"].as_str().unwrap().contains("tests.rs"));
}
