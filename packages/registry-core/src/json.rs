use serde_json::Value;

/// Parses portable registry JSON with ECMAScript `JSON.parse` number semantics.
///
/// `serde_json` retains integer tokens as exact `i64`/`u64` values, while
/// JavaScript converts every JSON number to an IEEE-754 binary64 value. The
/// registry's canonical wire format is defined by the JavaScript tooling, so
/// normalize numbers at the input boundary before validation or comparison.
pub fn parse_json(bytes: &[u8]) -> serde_json::Result<Value> {
    // Validate the untouched document before replacing overflowed numeric
    // tokens. RawValue performs full JSON syntax/depth validation without
    // attempting to represent numbers in serde_json::Number.
    let raw: Box<serde_json::value::RawValue> = serde_json::from_slice(bytes)?;
    let normalized = replace_non_finite_numbers(raw.get());
    let mut value = serde_json::from_str(normalized.as_ref())?;
    normalize_numbers(&mut value);
    Ok(value)
}

fn replace_non_finite_numbers(source: &str) -> std::borrow::Cow<'_, str> {
    let bytes = source.as_bytes();
    let mut output = String::new();
    let mut copied = 0;
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;

    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            index += 1;
            continue;
        }
        if byte == b'-' || byte.is_ascii_digit() {
            let start = index;
            index += 1;
            while index < bytes.len()
                && matches!(bytes[index], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
            {
                index += 1;
            }
            let token = &source[start..index];
            if token.parse::<f64>().is_ok_and(|number| !number.is_finite()) {
                output.push_str(&source[copied..start]);
                output.push_str("null");
                copied = index;
            }
            continue;
        }
        index += 1;
    }

    if copied == 0 {
        std::borrow::Cow::Borrowed(source)
    } else {
        output.push_str(&source[copied..]);
        std::borrow::Cow::Owned(output)
    }
}

pub fn canonical_json(value: &Value) -> String {
    let mut output = String::new();
    write_canonical(value, &mut output);
    output
}

/// Encodes a parsed JSON value with the registry's JavaScript-compatible
/// canonicalization contract and without a trailing newline.
pub fn canonical_json_bytes(value: &Value) -> Vec<u8> {
    canonical_json(value).into_bytes()
}

fn write_canonical(value: &Value, output: &mut String) {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => {
            output.push_str(&value.to_string());
        }
        Value::Number(number) => {
            // JSON numbers parsed by JavaScript are binary64 even when their
            // source token looks like an integer. `ryu-js` implements the
            // exact ECMAScript Number-to-string thresholds and spelling used
            // by JSON.stringify (including `0` for negative zero).
            let number = number
                .as_f64()
                .expect("serde_json numbers are finite and representable as f64");
            output.push_str(ryu_js::Buffer::new().format(number));
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical(value, output);
            }
            output.push(']');
        }
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
            output.push('{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&Value::String(key.clone()).to_string());
                output.push(':');
                write_canonical(value, output);
            }
            output.push('}');
        }
    }
}

fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            let value = number
                .as_f64()
                .expect("serde_json numbers are finite and representable as f64");
            *number = normalized_number(value);
        }
        Value::Array(values) => values.iter_mut().for_each(normalize_numbers),
        Value::Object(object) => object.values_mut().for_each(normalize_numbers),
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
}

fn normalized_number(value: f64) -> serde_json::Number {
    // Preserve an integral representation when possible. `serde_json::Number`
    // compares its internal integer and float variants distinctly, whereas
    // JavaScript has one Number type (`1 === 1.0`). Keeping ordinary schema
    // integers integral therefore preserves existing Value-based validation
    // without giving up binary64 rounding for unsafe integer source tokens.
    const U64_EXCLUSIVE_MAX: f64 = 18_446_744_073_709_551_616.0;
    if value >= 0.0 && value < U64_EXCLUSIVE_MAX && value.fract() == 0.0 {
        return serde_json::Number::from(value as u64);
    } else if value >= i64::MIN as f64 && value < 0.0 && value.fract() == 0.0 {
        return serde_json::Number::from(value as i64);
    }
    serde_json::Number::from_f64(value).expect("a parsed JSON number cannot be NaN or infinite")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;
    use std::process::{Command, Stdio};

    #[test]
    fn deeply_nested_json_uses_one_output_buffer() {
        let mut value = json!("leaf");
        for _ in 0..128 {
            value = Value::Array(vec![value]);
        }
        let encoded = canonical_json(&value);
        assert_eq!(encoded.len(), 6 + 128 * 2);
        assert!(encoded.starts_with("[[[["));
        assert!(encoded.ends_with("]]]]"));
    }

    #[test]
    fn numbers_match_json_stringify_spelling() {
        let vectors = [
            ("-0", "0"),
            ("0.000001", "0.000001"),
            ("0.0000001", "1e-7"),
            ("100000000000000000000", "100000000000000000000"),
            ("1e21", "1e+21"),
            ("1.23e30", "1.23e+30"),
            ("9007199254740993", "9007199254740992"),
            ("18446744073709551615", "18446744073709552000"),
        ];

        for (source, expected) in vectors {
            let value = parse_json(source.as_bytes()).expect(source);
            assert_eq!(canonical_json(&value), expected, "source: {source}");
        }
    }

    #[test]
    fn parser_applies_binary64_semantics_before_comparison() {
        let rounded_down = parse_json(b"9007199254740992").unwrap();
        let rounded_input = parse_json(b"9007199254740993").unwrap();
        assert_eq!(rounded_down, rounded_input);
        assert_eq!(parse_json(b"1.0").unwrap(), Value::from(1));
    }

    #[test]
    fn strings_and_utf8_key_order_match_registry_javascript() {
        let value = parse_json("{\"𐀀\":2,\"\":1,\"escaped\":\"line\\n\\\"quote\\\"\"}".as_bytes())
            .unwrap();
        assert_eq!(
            canonical_json(&value),
            "{\"escaped\":\"line\\n\\\"quote\\\"\",\"\u{e000}\":1,\"\u{10000}\":2}"
        );
    }

    #[test]
    fn rejects_lone_surrogates_instead_of_claiming_lossless_parity() {
        assert!(parse_json(br#""\ud800""#).is_err());
    }

    #[test]
    fn overflow_underflow_and_number_looking_strings_match_javascript() {
        let value = parse_json(
            br#"{"positive":1e400,"negative":-1e400,"tiny":1e-4000,"text":"1e400","escaped":"number: \"-1e400\""}"#,
        )
        .unwrap();
        assert_eq!(
            canonical_json(&value),
            r#"{"escaped":"number: \"-1e400\"","negative":null,"positive":null,"text":"1e400","tiny":0}"#
        );
        for invalid in [
            b"01".as_slice(),
            b"1.".as_slice(),
            b"+1".as_slice(),
            b"1e".as_slice(),
        ] {
            assert!(parse_json(invalid).is_err(), "accepted invalid JSON number");
        }
    }

    #[test]
    fn number_parser_and_writer_match_node_oracle() {
        let mut sources = vec![
            "-0".into(),
            "1.0".into(),
            "5e-324".into(),
            "2.2250738585072014e-308".into(),
            "9007199254740993".into(),
            "-9223372036854775808".into(),
            "18446744073709551615".into(),
            "1e400".into(),
            "-1e400".into(),
            "1e-4000".into(),
        ];
        let mut state = 0x6a09_e667_f3bc_c909_u64;
        while sources.len() < 263 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let value = f64::from_bits(state);
            if value.is_finite() {
                sources.push(format!("{value:e}"));
            }
            let integer = (u128::from(state) << 64) | u128::from(state.rotate_left(29));
            sources.push(integer.to_string());
        }
        sources.truncate(263);

        let mut child = Command::new("node")
            .args([
                "-e",
                "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s.trimEnd().split('\\n').map(v=>JSON.stringify(JSON.parse(v))).join('\\n')))",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("Node is required for the JavaScript canonicalization oracle");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(sources.join("\n").as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        let expected = String::from_utf8(output.stdout).unwrap();

        for (source, expected) in sources.iter().zip(expected.lines()) {
            let parsed = parse_json(source.as_bytes()).expect(source);
            assert_eq!(canonical_json(&parsed), expected, "source: {source}");
        }
    }
}
