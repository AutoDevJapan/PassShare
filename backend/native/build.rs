fn main() {
    println!("cargo:rerun-if-changed=src/encrypted-schema.sql");
}
