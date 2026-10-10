//! Fractional positions for ordered lists: a string that sorts between its
//! neighbours, so moving an item writes one field on one document.
//!
//! Keys are base-62 fractions (digits `0-9A-Za-z`, compared as plain
//! strings) that never end in `0`, so there is always room between two of
//! them. Port of the midpoint step of rocicorp's `fractional-indexing`.

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn digit(b: u8) -> usize {
    DIGITS.iter().position(|&d| d == b).expect("position digit")
}

fn is_key(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| DIGITS.contains(&b)) && !s.ends_with('0')
}

/// A position that sorts after `before` and before `after` (either may be
/// missing: the start or end of the list). Neighbours that aren't valid
/// keys are ignored, and so is `after` when it doesn't sort after
/// `before` (two concurrent inserts can leave equal positions; readers
/// break ties by document id), so this always returns a key.
pub fn position_between(before: Option<&str>, after: Option<&str>) -> String {
    let a = before.filter(|s| is_key(s)).unwrap_or("");
    let b = after.filter(|s| is_key(s) && *s > a);
    midpoint(a, b)
}

fn midpoint(a: &str, b: Option<&str>) -> String {
    if let Some(b) = b {
        // Shared prefix (reading `a` padded with zeros).
        let (ab, bb) = (a.as_bytes(), b.as_bytes());
        let mut n = 0;
        while n < bb.len() && *ab.get(n).unwrap_or(&b'0') == bb[n] {
            n += 1;
        }
        if n > 0 {
            let rest_a = if n < a.len() { &a[n..] } else { "" };
            return format!("{}{}", &b[..n], midpoint(rest_a, Some(&b[n..])));
        }
    }
    let da = a.bytes().next().map(digit).unwrap_or(0);
    let db = b.and_then(|b| b.bytes().next()).map(digit).unwrap_or(DIGITS.len());
    if db - da > 1 {
        let mid = (da + db).div_ceil(2);
        return (DIGITS[mid] as char).to_string();
    }
    match b {
        Some(b) if b.len() > 1 => b[..1].to_string(),
        _ => {
            let rest = if a.len() > 1 { &a[1..] } else { "" };
            format!("{}{}", DIGITS[da] as char, midpoint(rest, None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn basics() {
        let first = position_between(None, None);
        assert!(is_key(&first));
        let after = position_between(Some(&first), None);
        let before = position_between(None, Some(&first));
        assert!(before < first && first < after);
        let mid = position_between(Some(&first), Some(&after));
        assert!(first < mid && mid < after);
        // Equal neighbours: still a valid key after `before`.
        let tie = position_between(Some(&first), Some(&first));
        assert!(tie > first && is_key(&tie));
    }

    #[test]
    fn appending_and_prepending_many_stays_ordered() {
        let mut keys = vec![position_between(None, None)];
        for _ in 0..500 {
            let k = position_between(keys.last().map(|s| s.as_str()), None);
            keys.push(k);
        }
        for _ in 0..500 {
            let k = position_between(None, Some(&keys[0]));
            keys.insert(0, k);
        }
        assert!(keys.windows(2).all(|w| w[0] < w[1]));
        assert!(keys.iter().all(|k| is_key(k)));
    }

    proptest! {
        #[test]
        fn inserting_anywhere_stays_ordered(slots in proptest::collection::vec(0usize..1000, 1..200)) {
            let mut keys: Vec<String> = Vec::new();
            for slot in slots {
                let i = slot % (keys.len() + 1);
                let before = if i == 0 { None } else { Some(keys[i - 1].as_str()) };
                let after = keys.get(i).map(|s| s.as_str());
                let k = position_between(before, after);
                prop_assert!(is_key(&k));
                keys.insert(i, k);
            }
            prop_assert!(keys.windows(2).all(|w| w[0] < w[1]));
        }
    }
}
