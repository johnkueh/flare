//! `cargo run -p sync-ffi --features bindgen --bin uniffi-bindgen -- generate
//! --library <path to libsync_ffi.{so,dylib,a}> --language swift --out-dir <dir>`
//! (see README.md).
fn main() {
    uniffi::uniffi_bindgen_main()
}
