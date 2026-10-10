//! Hybrid logical clock timestamps (PROTOCOL.md "Timestamps").
//!
//! `MMMMMMMMMMMMMMM-CCCC-NNNNNNNNNNNNNNNN`: wall-clock milliseconds, a
//! counter for writes in the same millisecond, and the writer's node id.
//! Fixed width, so comparing the strings orders the timestamps.

use std::fmt;

pub const ZERO: &str = "000000000000000-0000-0000000000000000";
const MAX_MS: u64 = 999_999_999_999_999;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hlc {
    pub ms: u64,
    pub counter: u16,
    pub node: u64,
}

impl Hlc {
    pub const ZERO: Hlc = Hlc { ms: 0, counter: 0, node: 0 };

    pub fn parse(s: &str) -> Option<Hlc> {
        let b = s.as_bytes();
        if b.len() != 37 || b[15] != b'-' || b[20] != b'-' {
            return None;
        }
        let ms = &s[..15];
        let counter = &s[16..20];
        let node = &s[21..];
        if !ms.bytes().all(|c| c.is_ascii_digit()) || !is_lower_hex(counter) || !is_lower_hex(node) {
            return None;
        }
        Some(Hlc {
            ms: ms.parse().ok()?,
            counter: u16::from_str_radix(counter, 16).ok()?,
            node: u64::from_str_radix(node, 16).ok()?,
        })
    }
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl fmt::Display for Hlc {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:015}-{:04x}-{:016x}", self.ms, self.counter, self.node)
    }
}

/// Issues timestamps for one device. Never issues one at or below a
/// timestamp it has issued or seen.
#[derive(Clone, Debug)]
pub struct Clock {
    pub node: u64,
    pub last: Hlc,
}

impl Clock {
    pub fn new(node: u64, last: Hlc) -> Clock {
        Clock { node, last }
    }

    /// The next timestamp, given the (server-corrected) wall clock.
    pub fn tick(&mut self, wall_ms: u64) -> Hlc {
        let wall_ms = wall_ms.min(MAX_MS);
        let next = if wall_ms > self.last.ms {
            Hlc { ms: wall_ms, counter: 0, node: self.node }
        } else if self.last.counter < u16::MAX {
            Hlc { ms: self.last.ms, counter: self.last.counter + 1, node: self.node }
        } else {
            // 65,536 writes in one millisecond: borrow the next one.
            Hlc { ms: self.last.ms + 1, counter: 0, node: self.node }
        };
        self.last = next;
        next
    }

    /// Remember a timestamp written elsewhere so later ticks sort after it.
    pub fn observe(&mut self, seen: Hlc) {
        if seen > self.last {
            self.last = Hlc { node: self.node, ..seen };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_orders_as_strings() {
        let a = Hlc { ms: 1_760_000_000_000, counter: 0, node: 0x0123456789abcdef };
        let s = a.to_string();
        assert_eq!(s, "001760000000000-0000-0123456789abcdef");
        assert_eq!(Hlc::parse(&s), Some(a));
        assert_eq!(Hlc::ZERO.to_string(), ZERO);
        let b = Hlc { counter: 10, ..a };
        assert!(a.to_string() < b.to_string() && a < b);
        let c = Hlc { ms: a.ms + 1, counter: 0, node: 0 };
        assert!(b.to_string() < c.to_string() && b < c);
    }

    #[test]
    fn rejects_malformed() {
        for s in ["", "1760000000000-0000-0123456789abcdef", "001760000000000-000G-0123456789abcdef",
                  "001760000000000-0000-0123456789ABCDEF", "001760000000000_0000-0123456789abcdef"] {
            assert_eq!(Hlc::parse(s), None, "{s}");
        }
    }

    #[test]
    fn never_goes_backwards() {
        let mut c = Clock::new(7, Hlc::ZERO);
        let a = c.tick(1000);
        let b = c.tick(900);
        assert!(b > a);
        c.observe(Hlc { ms: 5000, counter: 3, node: 9 });
        let d = c.tick(1000);
        assert_eq!((d.ms, d.counter, d.node), (5000, 4, 7));
        let e = c.tick(6000);
        assert_eq!((e.ms, e.counter), (6000, 0));
    }
}
