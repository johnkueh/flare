use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch (0 if the clock is before 1970).
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A random 128-bit id as 32 lowercase hex chars. Falls back to clock-derived
/// bits if the OS random source fails, so it never errors.
pub fn random_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        bytes = t.to_le_bytes();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `createAnalyticsId()` from the Expo app: base-36 epoch millis, "_", then
/// 10 random base-36 chars. Kept so event ids look the same across stacks.
pub fn event_id() -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut bytes = [0u8; 10];
    let _ = getrandom::fill(&mut bytes);
    let suffix: String = bytes.iter().map(|b| ALPHABET[(*b as usize) % 36] as char).collect();
    format!("{}_{}", base36(now_ms().max(0) as u64), suffix)
}

fn base36(mut n: u64) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(ALPHABET[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_have_the_expected_shape() {
        let id = random_id();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        let e = event_id();
        let (ms, rand) = e.split_once('_').unwrap();
        assert!(u64::from_str_radix(ms, 36).is_ok());
        assert_eq!(rand.len(), 10);
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
    }
}
