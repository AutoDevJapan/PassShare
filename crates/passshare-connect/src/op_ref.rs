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
    Some(OpReference {
        vault: parts[0].to_string(),
        item: parts[1].to_string(),
        field: parts[2..].join("/"),
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
}
