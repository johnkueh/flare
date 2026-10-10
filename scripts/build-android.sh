#!/usr/bin/env bash
# Build libsync_ffi.so (crate sync-ffi) for the Android app and regenerate
# its Kotlin bindings. Runs on macOS or Linux. The counterpart of
# build-xcframework.sh, and of the parser's own build-android.sh.
#
#   scripts/build-android.sh
#
# Writes the libraries to kotlin/build/rustJniLibs/<abi>/ (gitignored;
# the sync module packs them into the app) and the Kotlin bindings to
# kotlin/src/main/java/com/johnkueh/sync/ffi/sync_ffi.kt (checked in).
# The Gradle build calls this script itself when the libraries are missing
# or older than the Rust sources.
#
# Needs: rustup, cargo-ndk (`cargo install cargo-ndk`), and the Android NDK
# (ANDROID_NDK_HOME, or ANDROID_HOME/ndk/<version>).
#
# Env:
#   CARGO_TARGET_DIR  default: <workspace>/target/android
#   ANDROID_ABIS      default: "arm64-v8a x86_64" (phones + emulator).
set -euo pipefail

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the repo root
MODULE="$WORKSPACE/kotlin"
OUT="$MODULE/build/rustJniLibs"
BINDINGS="$MODULE/src/main/java"
PROFILE="android-release"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$WORKSPACE/target/android}"
read -r -a ABIS <<<"${ANDROID_ABIS:-arm64-v8a x86_64}"
# Keep in sync with minSdk in kotlin/build.gradle.kts.
PLATFORM=26

for tool in cargo rustup cargo-ndk; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found on PATH (cargo install cargo-ndk)" >&2; exit 1; }
done

if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
  sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
  if [[ -d "$sdk/ndk" ]]; then
    ANDROID_NDK_HOME="$sdk/ndk/$(ls "$sdk/ndk" | sort -V | tail -1)"
    export ANDROID_NDK_HOME
  else
    echo "error: no Android NDK. Install one (sdkmanager 'ndk;28.2.13676358') or set ANDROID_NDK_HOME." >&2
    exit 1
  fi
fi

target_for() {
  case "$1" in
    arm64-v8a) echo aarch64-linux-android ;;
    armeabi-v7a) echo armv7-linux-androideabi ;;
    x86_64) echo x86_64-linux-android ;;
    x86) echo i686-linux-android ;;
    *) echo "error: unknown ABI $1" >&2; exit 1 ;;
  esac
}

echo "==> rustup targets"
installed="$(rustup target list --installed)"
for abi in "${ABIS[@]}"; do
  t="$(target_for "$abi")"
  grep -qx "$t" <<<"$installed" || rustup target add "$t"
done

cd "$WORKSPACE"

echo "==> cargo ndk ($PROFILE) for ${ABIS[*]}"
ndk_args=()
for abi in "${ABIS[@]}"; do ndk_args+=(-t "$abi"); done
mkdir -p "$OUT"
cargo ndk "${ndk_args[@]}" --platform "$PLATFORM" -o "$OUT" build -p sync-ffi --lib --profile "$PROFILE"

echo "==> Kotlin bindings (uniffi-bindgen, library mode)"
first_lib="$OUT/${ABIS[0]}/libsync_ffi.so"
gen="$CARGO_TARGET_DIR/kotlin-bindings"
rm -rf "$gen"
cargo run -q -p sync-ffi --features bindgen --bin uniffi-bindgen -- \
  generate --library "$first_lib" --language kotlin --no-format --out-dir "$gen"
generated="$(find "$gen" -name 'sync_ffi.kt')"
dest="$BINDINGS/com/johnkueh/sync/ffi"
mkdir -p "$dest"
cp "$generated" "$dest/sync_ffi.kt"
# SyncError's variants carry a `message` field, which clashes with
# Throwable.message in Kotlin. Rename it to `detail` in the Kotlin copy.
python3 "$WORKSPACE/scripts/fix-kotlin-bindings.py" "$dest/sync_ffi.kt"

echo "==> done"
du -sh "$OUT"/*/libsync_ffi.so
if ! git -C "$WORKSPACE" diff --quiet -- "$dest"; then
  echo "    note: the generated bindings changed; commit kotlin/src/main/java/com/johnkueh/sync/ffi."
fi
