//! A command-line tool reading an app's flags from its Worker:
//!
//!   cargo run -p flare-flags --features http --example flags -- http://localhost:8787 example/flags.json
//!
//! It keeps the last values in $TMPDIR, so it answers offline with what it
//! saw last.

use flare_flags::Flags;
use serde_json::{json, Map};

fn main() {
    let mut args = std::env::args().skip(1);
    let server = args.next().unwrap_or_else(|| "http://localhost:8787".into());
    let schema_path = args.next().unwrap_or_else(|| "flags.json".into());
    let schema = std::fs::read_to_string(&schema_path).unwrap_or_else(|e| panic!("{schema_path}: {e}"));

    let cache = std::env::temp_dir().join("flare-flags-example.json");
    let mut flags = Flags::open(&schema, Some(cache), None).unwrap_or_else(|e| panic!("{e}"));
    let mut context = Map::new();
    context.insert("platform".into(), json!("cli"));
    let status = match flags.refresh(&server, &[], &context) {
        Ok(_) => format!("(from {server})"),
        Err(e) => format!("(offline: {e}; last known values)"),
    };
    for (key, value) in flags.snapshot() {
        println!("{key:<12} {value}");
    }
    println!("{status}");
}
