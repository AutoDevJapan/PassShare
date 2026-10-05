use serde_json::json;
use std::io::{self, Read};

fn main() {
    const LIMIT: u64 = 2 * 1024 * 1024;
    let mut bytes = Vec::new();
    let result = match io::stdin().take(LIMIT + 1).read_to_end(&mut bytes) {
        Ok(_) if bytes.len() as u64 <= LIMIT => serde_json::from_slice(&bytes)
            .map(|input| passshare_mutations::dispatch(&input))
            .unwrap_or_else(|_| json!({"status":400,"message":"PS018: Invalid mutation request"})),
        _ => json!({"status":400,"message":"PS018: Mutation input too large"}),
    };
    println!("{result}");
}
