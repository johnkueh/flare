#!/usr/bin/env bash
# Build SyncFFI.xcframework (crate sync-ffi) into swift/ and
# regenerate its Swift bindings. macOS only (needs Xcode).
#
#   scripts/build-xcframework.sh
#
# Slices: iOS device (arm64), iOS simulator (arm64 + x86_64, lipo'd), and
# macOS (arm64 + x86_64, lipo'd) so `swift test` works in the package.
# Uses the size-optimised `ios-release` Cargo profile (see the workspace
# Cargo.toml). Re-run after any change to sync-core or sync-ffi.
#
# Env:
#   CARGO_TARGET_DIR   default: <workspace>/target/ios
#   SKIP_MACOS=1       skip the macOS slice (faster; no `swift test`)
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: build-xcframework.sh needs macOS + Xcode (xcodebuild, lipo)." >&2
  exit 1
fi

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the repo root
KIT="$WORKSPACE/swift"
FRAMEWORK_NAME="SyncFFI"
LIB="libsync_ffi.a"
PROFILE="ios-release"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$WORKSPACE/target/ios}"
# Match Package.swift's platforms so the linker doesn't warn about objects
# built for newer OS versions than the package declares. The bundled
# SQLite is C, so the C compiler needs them too.
export IPHONEOS_DEPLOYMENT_TARGET="17.0"
export MACOSX_DEPLOYMENT_TARGET="14.0"

IOS_DEVICE="aarch64-apple-ios"
IOS_SIM=("aarch64-apple-ios-sim" "x86_64-apple-ios")
MACOS=("aarch64-apple-darwin" "x86_64-apple-darwin")
TARGETS=("$IOS_DEVICE" "${IOS_SIM[@]}")
if [[ "${SKIP_MACOS:-0}" != "1" ]]; then
  TARGETS+=("${MACOS[@]}")
fi

for tool in cargo rustup xcodebuild lipo; do
  command -v "$tool" >/dev/null || { echo "error: $tool not found on PATH" >&2; exit 1; }
done

echo "==> rustup targets"
installed="$(rustup target list --installed)"
for t in "${TARGETS[@]}"; do
  if ! grep -qx "$t" <<<"$installed"; then
    rustup target add "$t"
  fi
done

cd "$WORKSPACE"

echo "==> cargo build ($PROFILE) for ${TARGETS[*]}"
for t in "${TARGETS[@]}"; do
  # `cargo rustc --crate-type staticlib` builds only the static library
  # (skips linking the cdylib, which would double the LTO time).
  cargo rustc -p sync-ffi --lib --profile "$PROFILE" --target "$t" --crate-type staticlib \
    -- --print native-static-libs
done

lib_for() { echo "$CARGO_TARGET_DIR/$1/$PROFILE/$LIB"; }

BUILD="$CARGO_TARGET_DIR/xcframework"
rm -rf "$BUILD"
mkdir -p "$BUILD/headers/$FRAMEWORK_NAME" "$BUILD/bindings" "$BUILD/ios-sim" "$BUILD/macos"

echo "==> Swift bindings (uniffi-bindgen, library mode)"
# Library mode reads the UniFFI metadata embedded in the static library and
# picks up crates/sync-ffi/uniffi.toml (module names) via cargo metadata.
# --no-format keeps the output identical to what Linux generates (no
# swift-format there), so the checked-in file only changes with the API.
cargo run -q -p sync-ffi --features bindgen --bin uniffi-bindgen -- \
  generate --library "$(lib_for "$IOS_DEVICE")" --language swift --no-format --out-dir "$BUILD/bindings"

# In a folder of their own: Xcode copies every XCFramework's Headers into
# one include directory, and another framework's module.modulemap may already
# be at its top. Clang finds `SyncFFI/module.modulemap` by the module's name.
cp "$BUILD/bindings/$FRAMEWORK_NAME.h" "$BUILD/headers/$FRAMEWORK_NAME/"
cp "$BUILD/bindings/$FRAMEWORK_NAME.modulemap" "$BUILD/headers/$FRAMEWORK_NAME/module.modulemap"

echo "==> lipo"
lipo -create "$(lib_for "${IOS_SIM[0]}")" "$(lib_for "${IOS_SIM[1]}")" -output "$BUILD/ios-sim/$LIB"
args=(
  -library "$(lib_for "$IOS_DEVICE")" -headers "$BUILD/headers"
  -library "$BUILD/ios-sim/$LIB" -headers "$BUILD/headers"
)
if [[ "${SKIP_MACOS:-0}" != "1" ]]; then
  lipo -create "$(lib_for "${MACOS[0]}")" "$(lib_for "${MACOS[1]}")" -output "$BUILD/macos/$LIB"
  args+=(-library "$BUILD/macos/$LIB" -headers "$BUILD/headers")
fi

echo "==> xcodebuild -create-xcframework"
rm -rf "$KIT/$FRAMEWORK_NAME.xcframework"
xcodebuild -create-xcframework "${args[@]}" -output "$KIT/$FRAMEWORK_NAME.xcframework"

mkdir -p "$KIT/Sources/SyncKit/Generated"
cp "$BUILD/bindings/SyncKit.swift" "$KIT/Sources/SyncKit/Generated/SyncKit.swift"

echo "==> done"
echo "    $KIT/$FRAMEWORK_NAME.xcframework"
du -sh "$KIT/$FRAMEWORK_NAME.xcframework"/* 2>/dev/null || true
if ! git -C "$WORKSPACE" diff --quiet -- "$KIT/Sources/SyncKit/Generated"; then
  echo "    note: the generated bindings changed; commit swift/Sources/SyncKit/Generated."
fi
