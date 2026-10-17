//! The last few events, kept on disk after they are sent, so a crash found
//! on the next launch can say what the user was doing. One JSON object per
//! line in `breadcrumbs.jsonl`; appends go straight to the file and it is
//! cut back to the newest `KEEP` lines once it doubles.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Crumbs attached to a report.
pub const KEEP: usize = 30;

pub struct Breadcrumbs {
    path: PathBuf,
    items: VecDeque<Value>,
    lines_on_disk: usize,
    /// What the file held when this process started: the previous run's
    /// last moments, for crashes the OS reports on this launch.
    previous_run: Vec<Value>,
}

impl Breadcrumbs {
    pub fn open(dir: &Path) -> Breadcrumbs {
        let path = dir.join("breadcrumbs.jsonl");
        let mut items = VecDeque::new();
        let mut lines_on_disk = 0;
        if let Ok(file) = File::open(&path) {
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                lines_on_disk += 1;
                if let Ok(v @ Value::Object(_)) = serde_json::from_str::<Value>(line.trim()) {
                    items.push_back(v);
                    if items.len() > KEEP {
                        items.pop_front();
                    }
                }
            }
        }
        let previous_run = items.iter().cloned().collect();
        Breadcrumbs { path, items, lines_on_disk, previous_run }
    }

    /// Record one event: `{name, ts, session_id}`.
    pub fn push(&mut self, crumb: Value) {
        let appended = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut f| f.write_all(format!("{crumb}\n").as_bytes()));
        self.items.push_back(crumb);
        if self.items.len() > KEEP {
            self.items.pop_front();
        }
        self.lines_on_disk += 1;
        if appended.is_err() || self.lines_on_disk >= KEEP * 2 {
            self.rewrite();
        }
    }

    /// This run's crumbs, oldest first.
    pub fn current(&self) -> Vec<Value> {
        self.items.iter().cloned().collect()
    }

    /// The previous run's crumbs, keeping only those at or before
    /// `until_ms` when the OS says when the problem happened.
    pub fn previous_run(&self, until_ms: Option<i64>) -> Vec<Value> {
        self.previous_run
            .iter()
            .filter(|c| match (until_ms, c.get("ts").and_then(Value::as_i64)) {
                (Some(until), Some(ts)) => ts <= until,
                _ => true,
            })
            .cloned()
            .collect()
    }

    fn rewrite(&mut self) {
        let tmp = self.path.with_extension("jsonl.tmp");
        let mut body = String::new();
        for crumb in &self.items {
            body.push_str(&crumb.to_string());
            body.push('\n');
        }
        if fs::write(&tmp, body).is_ok() && fs::rename(&tmp, &self.path).is_ok() {
            self.lines_on_disk = self.items.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_the_newest_and_remembers_the_previous_run() {
        let dir = std::env::temp_dir().join(format!("telemetry-crumbs-{}", crate::ids::random_id()));
        fs::create_dir_all(&dir).unwrap();
        let mut crumbs = Breadcrumbs::open(&dir);
        for i in 0..(KEEP as i64 * 3) {
            crumbs.push(json!({ "name": "tap", "ts": i }));
        }
        assert_eq!(crumbs.current().len(), KEEP);
        assert!(crumbs.previous_run(None).is_empty());

        let next = Breadcrumbs::open(&dir);
        let previous = next.previous_run(None);
        assert_eq!(previous.len(), KEEP);
        assert_eq!(previous.last().unwrap()["ts"], json!(KEEP as i64 * 3 - 1));
        assert_eq!(next.previous_run(Some(KEEP as i64 * 2)).len(), 1);
    }
}
