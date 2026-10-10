//! Parse `op://vault/item/field` secret references.

#[derive(Debug, PartialEq, Eq)]
pub struct OpReference {
    pub vault: String,
    pub item: String,
    pub field: String,
}

pub fn parse_op_reference(input: &str) -> Option<OpReference> {
    let rest = input.strip_prefix("op://")?;
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() < 3 {
        return None;
    }
    let field = parts[2..].join("/");
    // Reject empty components (e.g. `op:///Gmail/password`, `op://Work//password`,
    // `op://Work/Gmail/`) so they never flow into request paths as `//`.
    if parts[0].is_empty() || parts[1].is_empty() || field.is_empty() {
        return None;
    }
    Some(OpReference {
        vault: parts[0].to_string(),
        item: parts[1].to_string(),
        field,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_reference() {
        let reference = parse_op_reference("op://Work/Gmail/password").unwrap();
        assert_eq!(reference.vault, "Work");
        assert_eq!(reference.item, "Gmail");
        assert_eq!(reference.field, "password");
    }

    #[test]
    fn rejects_malformed_references() {
        for bad in [
            "Work/Gmail/password",  // missing op:// prefix
            "op://Work/Gmail",      // too few components
            "op:///Gmail/password", // empty vault
            "op://Work//password",  // empty item
            "op://Work/Gmail/",     // empty field
        ] {
            assert!(parse_op_reference(bad).is_none(), "should reject: {bad}");
        }
    }
}
