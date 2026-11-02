const MIN_LEN: usize = 2;
const MAX_LEN: usize = 64;

/// NEAR account ID rules: lowercase ASCII parts split by dots, with single
/// `-` or `_` separators inside a part.
pub fn is_valid_account_id(id: &str) -> bool {
    if id.len() < MIN_LEN || id.len() > MAX_LEN {
        return false;
    }
    let mut last_was_separator = true;
    for byte in id.bytes() {
        match byte {
            b'a'..=b'z' | b'0'..=b'9' => last_was_separator = false,
            b'-' | b'_' | b'.' => {
                if last_was_separator {
                    return false;
                }
                last_was_separator = true;
            }
            _ => return false,
        }
    }
    !last_was_separator
}

#[cfg(test)]
mod tests {
    use super::is_valid_account_id as valid;

    #[test]
    fn accepts_normal_ids() {
        for id in ["acme.testnet", "a1", "pay.acme.near", "a-b_c.near", &"f".repeat(64)] {
            assert!(valid(id), "{id}");
        }
    }

    #[test]
    fn rejects_lookalikes_and_malformed_ids() {
        for id in [
            "",
            "a",
            "ACME.testnet",
            "аcme.testnet", // Cyrillic a
            "acme.testnеt", // Cyrillic e
            "acme\u{200b}.testnet",
            "acme .testnet",
            ".acme",
            "acme.",
            "ac..me",
            "ac--me",
            "-acme",
            "acme-",
            "ac-.me",
            &"f".repeat(65),
        ] {
            assert!(!valid(id), "{id:?}");
        }
    }
}
