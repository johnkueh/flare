//! The on-disk queue: one JSON event per line in `queue.jsonl`, mirrored in
//! memory. Appends go straight to the file, so a crash loses nothing that
//! `track` returned from; a sent batch is removed by rewriting the file
//! through a temp file and rename, so the file is never half-written.

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

pub struct Queue {
    path: PathBuf,
    items: VecDeque<String>,
    max_len: usize,
}

impl Queue {
    /// Load the queue from `dir`, keeping only lines that are valid JSON
    /// objects and only the newest `max_len` of them.
    pub fn open(dir: &Path, max_len: usize) -> Queue {
        let path = dir.join("queue.jsonl");
        let mut items = VecDeque::new();
        if let Ok(file) = File::open(&path) {
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                let line = line.trim();
                if line.starts_with('{') && serde_json::from_str::<serde_json::Value>(line).is_ok() {
                    items.push_back(line.to_string());
                }
            }
        }
        let mut queue = Queue { path, items, max_len: max_len.max(1) };
        if queue.items.len() > queue.max_len {
            let excess = queue.items.len() - queue.max_len;
            queue.items.drain(..excess);
            queue.rewrite();
        }
        queue
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// Append one serialised event. When full, the oldest event is dropped.
    pub fn push(&mut self, line: String) {
        if self.items.len() >= self.max_len {
            self.items.pop_front();
            self.items.push_back(line);
            self.rewrite();
            return;
        }
        let appended = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut f| f.write_all(format!("{line}\n").as_bytes()));
        self.items.push_back(line);
        if appended.is_err() {
            self.rewrite();
        }
    }

    /// The oldest `n` events, without removing them.
    pub fn peek(&self, n: usize) -> Vec<String> {
        self.items.iter().take(n).cloned().collect()
    }

    /// Remove the oldest `n` events (after they were delivered or rejected).
    pub fn remove_front(&mut self, n: usize) {
        let n = n.min(self.items.len());
        if n == 0 {
            return;
        }
        self.items.drain(..n);
        self.rewrite();
    }

    fn rewrite(&self) {
        let tmp = self.path.with_extension("jsonl.tmp");
        let mut body = String::new();
        for line in &self.items {
            body.push_str(line);
            body.push('\n');
        }
        if fs::write(&tmp, body).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("telemetry-queue-{name}-{}", crate::ids::random_id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn survives_a_restart_and_removes_sent_events() {
        let dir = temp_dir("restart");
        let mut q = Queue::open(&dir, 10);
        q.push(r#"{"n":1}"#.into());
        q.push(r#"{"n":2}"#.into());
        q.push(r#"{"n":3}"#.into());
        q.remove_front(2);
        let q = Queue::open(&dir, 10);
        assert_eq!(q.peek(10), vec![r#"{"n":3}"#.to_string()]);
    }

    #[test]
    fn drops_the_oldest_when_full_and_skips_corrupt_lines() {
        let dir = temp_dir("full");
        fs::write(dir.join("queue.jsonl"), "{\"n\":1}\nnot json\n{\"n\":2\n{\"n\":3}\n").unwrap();
        let mut q = Queue::open(&dir, 2);
        assert_eq!(q.len(), 2);
        q.push(r#"{"n":4}"#.into());
        assert_eq!(q.peek(10), vec![r#"{"n":3}"#.to_string(), r#"{"n":4}"#.to_string()]);
        assert_eq!(Queue::open(&dir, 2).peek(10), q.peek(10));
    }
}
