use serde_json::{json, Value};

pub fn validate(input: &Value) -> Value {
    let r = &input["request"];
    let fields = ["requestId", "kind", "version", "platform", "errorCode"];
    let text = |key: &str| r[key].as_str().unwrap_or("");
    let id = text("requestId");
    let valid_id = id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        });
    let version = text("version");
    if !crate::encrypted::exact_fields(r, &fields)
        || fields.iter().any(|field| !r[field].is_string())
        || !valid_id
        || !["technical", "export", "cancellation", "refund"].contains(&text("kind"))
        || !["web", "windows", "android", "ios", "extension"].contains(&text("platform"))
        || version.is_empty()
        || version.len() > 32
        || !version
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'.' || b == b'-')
        || !(text("errorCode").is_empty()
            || (text("errorCode").len() == 5
                && text("errorCode").starts_with("PS")
                && text("errorCode")[2..].bytes().all(|b| b.is_ascii_digit())))
    {
        return json!({"status":400,"code":"PS018","message":"Invalid support receipt request"});
    }
    json!({"status":200,"body":{"requestId":id.to_ascii_lowercase(),"kind":text("kind"),"version":text("version"),"platform":text("platform"),"errorCode":text("errorCode")}})
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"request":{"requestId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","kind":"technical","version":"0.1.0","platform":"windows","errorCode":"PS019"}})
    }
    #[test]
    fn fixed_metadata_is_accepted() {
        assert_eq!(validate(&fixture())["status"], 200);
    }
    #[test]
    fn rejects_non_string_metadata() {
        for value in [
            Value::Null,
            json!(123),
            json!({"secret":"never-store"}),
            json!(["secret"]),
            json!(false),
        ] {
            let mut x = fixture();
            x["request"]["errorCode"] = value;
            assert_eq!(validate(&x)["status"], 400);
        }
    }
    #[test]
    fn bodies_secrets_and_arbitrary_metadata_are_rejected() {
        for (key, value) in [
            ("body", "secret"),
            ("version", "password-value"),
            ("errorCode", "token-value"),
            ("requestId", "../other"),
        ] {
            let mut x = fixture();
            x["request"][key] = json!(value);
            assert_eq!(validate(&x)["status"], 400);
        }
    }
}
