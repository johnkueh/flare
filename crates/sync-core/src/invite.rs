//! Invite codes (PROTOCOL.md "Invite codes"): 8 Crockford base32
//! characters, shown as `7KQ2-M9XD`, shared as a link.

pub const ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Reads a code out of what someone typed, pasted or opened: a link or the
/// code itself, with any spacing, dashes, case, and O/I/L for 0/1.
pub fn parse_invite(text: &str) -> Option<String> {
    let text = text.trim();
    let text = text.split(['?', '#']).next().unwrap_or("");
    let last = text.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let mut code = String::with_capacity(8);
    for ch in last.chars() {
        let ch = match ch.to_ascii_uppercase() {
            ' ' | '-' => continue,
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        };
        if !ALPHABET.contains(ch) {
            return None;
        }
        code.push(ch);
    }
    (code.len() == 8).then_some(code)
}

/// `7KQ2M9XD` → `7KQ2-M9XD`.
pub fn format_invite(code: &str) -> String {
    if code.len() == 8 { format!("{}-{}", &code[..4], &code[4..]) } else { code.to_string() }
}

/// The link an app shares: `base` is the app's own join page, e.g.
/// `https://example.com/j` → `https://example.com/j/7KQ2-M9XD`.
pub fn invite_link(base: &str, code: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), format_invite(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_codes_and_links() {
        for text in ["7KQ2M9XD", "7kq2-m9xd", " 7KQ2 M9XD ", "https://example.com/j/7KQ2-M9XD",
                     "https://example.com/j/7KQ2-M9XD/?utm=x", "example.com/j/7kq2m9xd#hi"] {
            assert_eq!(parse_invite(text).as_deref(), Some("7KQ2M9XD"), "{text}");
        }
        assert_eq!(parse_invite("O1L2-IOOU"), None); // U isn't in the alphabet
        assert_eq!(parse_invite("O1L2-IOOA").as_deref(), Some("0112100A"));
        assert_eq!(parse_invite("7KQ2M9X"), None);
        assert_eq!(parse_invite("7KQ2M9XDD"), None);
        assert_eq!(parse_invite(""), None);
    }

    #[test]
    fn formats() {
        assert_eq!(format_invite("7KQ2M9XD"), "7KQ2-M9XD");
        assert_eq!(invite_link("https://example.com/j", "7KQ2M9XD"), "https://example.com/j/7KQ2-M9XD");
        assert_eq!(invite_link("https://example.com/j/", "7KQ2M9XD"), "https://example.com/j/7KQ2-M9XD");
    }
}
