use rand::RngExt;

const LOWERCASE: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
const UPPERCASE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS: &[u8] = b"0123456789";
const SYMBOLS: &[u8] = b"!@#$%^&*()-_=+[]{}";

#[derive(Debug, Clone, Copy)]
pub struct PasswordGeneratorOptions {
    pub length: usize,
    pub lowercase: bool,
    pub uppercase: bool,
    pub digits: bool,
    pub symbols: bool,
}

impl Default for PasswordGeneratorOptions {
    fn default() -> Self {
        Self {
            length: 16,
            lowercase: true,
            uppercase: true,
            digits: true,
            symbols: true,
        }
    }
}

pub fn generate_password(options: PasswordGeneratorOptions) -> String {
    let mut charset = Vec::new();
    let mut required = Vec::new();
    let mut rng = rand::rng();

    if options.lowercase {
        charset.extend_from_slice(LOWERCASE);
        required.push(LOWERCASE[rng.random_range(0..LOWERCASE.len())] as char);
    }
    if options.uppercase {
        charset.extend_from_slice(UPPERCASE);
        required.push(UPPERCASE[rng.random_range(0..UPPERCASE.len())] as char);
    }
    if options.digits {
        charset.extend_from_slice(DIGITS);
        required.push(DIGITS[rng.random_range(0..DIGITS.len())] as char);
    }
    if options.symbols {
        charset.extend_from_slice(SYMBOLS);
        required.push(SYMBOLS[rng.random_range(0..SYMBOLS.len())] as char);
    }

    if charset.is_empty() {
        charset.extend_from_slice(LOWERCASE);
        required.push(LOWERCASE[0] as char);
    }

    let length = options.length.max(required.len());
    let mut chars: Vec<char> = (0..length - required.len())
        .map(|_| charset[rng.random_range(0..charset.len())] as char)
        .collect();
    chars.extend(required);

    // Fisher-Yates shuffle
    for i in (1..chars.len()).rev() {
        let j = rng.random_range(0..=i);
        chars.swap(i, j);
    }

    chars.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_requested_length() {
        let pwd = generate_password(PasswordGeneratorOptions {
            length: 20,
            ..Default::default()
        });
        assert_eq!(pwd.len(), 20);
    }

    #[test]
    fn includes_selected_charsets() {
        let pwd = generate_password(PasswordGeneratorOptions {
            length: 32,
            lowercase: true,
            uppercase: true,
            digits: true,
            symbols: true,
        });
        assert!(pwd.chars().any(|c| c.is_ascii_lowercase()));
        assert!(pwd.chars().any(|c| c.is_ascii_uppercase()));
        assert!(pwd.chars().any(|c| c.is_ascii_digit()));
        assert!(pwd.chars().any(|c| SYMBOLS.contains(&(c as u8))));
    }
}
