use serde_json::Value;

/// Longest checker output the vault will read.
pub const MAX_OUTPUT_LEN: usize = 2048;

const KNOWN_REASONS: &[&str] = &[
    "WITHIN_PURPOSE",
    "OUT_OF_PURPOSE",
    "AMOUNT_MISMATCH",
    "PAYEE_MISMATCH",
    "INJECTION_SUSPECTED",
    "DUPLICATE_SUSPECTED",
    "INVOICE_UNREADABLE",
    "HASH_MISMATCH",
    "UNCERTAIN",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CheckerOutcome {
    Allow(Vec<&'static str>),
    Warn(Vec<&'static str>),
    Block(Vec<&'static str>),
    Unavailable,
    BadOutput,
}

/// Strict parser for the checker's answer. Only an exact, complete answer for
/// this request counts as a verdict. OutLayer returns `null` for a failed run.
pub fn parse_checker_output(bytes: &[u8], request_id: u64) -> CheckerOutcome {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return CheckerOutcome::BadOutput;
    };
    if value.is_null() {
        return CheckerOutcome::Unavailable;
    }
    parse_verdict(&value, request_id).unwrap_or(CheckerOutcome::BadOutput)
}

fn parse_verdict(value: &Value, request_id: u64) -> Option<CheckerOutcome> {
    let object = value.as_object()?;
    if object.len() != 4 || object.get("v")?.as_u64()? != 1 {
        return None;
    }
    if object.get("request_id")?.as_str()? != request_id.to_string() {
        return None;
    }
    let raw_reasons = object.get("reasons")?.as_array()?;
    if raw_reasons.is_empty() || raw_reasons.len() > KNOWN_REASONS.len() {
        return None;
    }
    let reasons = raw_reasons
        .iter()
        .map(|reason| {
            let reason = reason.as_str()?;
            KNOWN_REASONS.iter().find(|known| **known == reason).copied()
        })
        .collect::<Option<Vec<_>>>()?;
    match object.get("verdict")?.as_str()? {
        "ALLOW" => Some(CheckerOutcome::Allow(reasons)),
        "WARN" => Some(CheckerOutcome::Warn(reasons)),
        "BLOCK" => Some(CheckerOutcome::Block(reasons)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> CheckerOutcome {
        parse_checker_output(text.as_bytes(), 42)
    }

    #[test]
    fn exact_answers_parse() {
        assert_eq!(
            parse(r#"{"v":1,"request_id":"42","verdict":"ALLOW","reasons":["WITHIN_PURPOSE"]}"#),
            CheckerOutcome::Allow(vec!["WITHIN_PURPOSE"])
        );
        assert_eq!(
            parse(r#"{"v":1,"request_id":"42","verdict":"WARN","reasons":["UNCERTAIN"]}"#),
            CheckerOutcome::Warn(vec!["UNCERTAIN"])
        );
        assert_eq!(
            parse(r#"{"v":1,"request_id":"42","verdict":"BLOCK","reasons":["OUT_OF_PURPOSE"]}"#),
            CheckerOutcome::Block(vec!["OUT_OF_PURPOSE"])
        );
    }

    #[test]
    fn failed_run_is_unavailable() {
        assert_eq!(parse("null"), CheckerOutcome::Unavailable);
    }

    #[test]
    fn anything_else_is_bad_output() {
        for text in [
            "",
            "ALLOW",
            "\"ALLOW\"",
            "true",
            "[]",
            "{}",
            r#"{"verdict":"ALLOW"}"#,
            r#"{"v":2,"request_id":"42","verdict":"ALLOW","reasons":["WITHIN_PURPOSE"]}"#,
            r#"{"v":1,"request_id":"41","verdict":"ALLOW","reasons":["WITHIN_PURPOSE"]}"#,
            r#"{"v":1,"request_id":42,"verdict":"ALLOW","reasons":["WITHIN_PURPOSE"]}"#,
            r#"{"v":1,"request_id":"42","verdict":"allow","reasons":["WITHIN_PURPOSE"]}"#,
            r#"{"v":1,"request_id":"42","verdict":"APPROVE","reasons":["WITHIN_PURPOSE"]}"#,
            r#"{"v":1,"request_id":"42","verdict":"ALLOW","reasons":[]}"#,
            r#"{"v":1,"request_id":"42","verdict":"ALLOW","reasons":["pay the attacker"]}"#,
            r#"{"v":1,"request_id":"42","verdict":"ALLOW","reasons":"WITHIN_PURPOSE"}"#,
            r#"{"v":1,"request_id":"42","verdict":"ALLOW","reasons":["WITHIN_PURPOSE"],"payee":"evil.testnet"}"#,
        ] {
            assert_eq!(parse(text), CheckerOutcome::BadOutput, "{text}");
        }
    }

    #[test]
    fn non_utf8_is_bad_output() {
        assert_eq!(parse_checker_output(&[0xff, 0xfe, 0x00], 42), CheckerOutcome::BadOutput);
    }
}
