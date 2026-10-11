fn main() {
    println!("cargo:rerun-if-changed=src/encrypted-schema.sql");
    println!("cargo:rerun-if-changed=src/encrypted-migration-schema.sql");
}
