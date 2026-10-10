#!/usr/bin/env bash
# Build the Rust store for iOS and Android once, upload it, and point the
# Swift and Kotlin packages at the upload, so apps build without cargo.
# macOS only (needs Xcode, cargo-ndk and the Android NDK). Run it after a
# change to sync-core or sync-ffi, then commit what it changes:
#
#   scripts/publish-binaries.sh
#
# Uploads to the R2 bucket sync-releases (wrangler, logged in), served on its
# public r2.dev URL:
#
#   SyncFFI-<version>.xcframework.zip                       SwiftPM binaryTarget
#   maven/com/johnkueh/sync/sync-ffi-native/<version>/...   an AAR of the .so files
#   maven/com/johnkueh/sync/sync-ffi-host/<version>/...     a jar of this Mac's
#                                                           library, for an app's
#                                                           JVM unit tests
#
# <version> is a hash of the Rust sources, so the same sources publish the
# same version and a changed crate can't reuse an old upload. Rewrites the
# version, URL and checksum in Package.swift and kotlin/build.gradle.kts
# and regenerates the checked-in bindings. When those already name this
# version, only the host jar is (re)uploaded, so a published zip's checksum
# never changes under a tag that uses it.
#
# Env:
#   BUCKET   default: sync-releases
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: publish-binaries.sh needs macOS + Xcode." >&2
  exit 1
fi

WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the repo root
BUCKET="${BUCKET:-sync-releases}"
WRANGLER=(npx --yes wrangler@4)
GROUP_PATH="com/johnkueh/sync"

cd "$WORKSPACE"
VERSION="$(find crates -type f \( -name '*.rs' -o -name '*.toml' -o -name '*.udl' \) -print0 | sort -z |
  xargs -0 cat Cargo.toml Cargo.lock | shasum -a 256 | cut -c1-12)"
echo "==> version $VERSION"

echo "==> bucket $BUCKET"
"${WRANGLER[@]}" r2 bucket info "$BUCKET" >/dev/null 2>&1 || "${WRANGLER[@]}" r2 bucket create "$BUCKET"
public_url() { "${WRANGLER[@]}" r2 bucket dev-url get "$BUCKET" 2>/dev/null | grep -o 'https://[^ '\''"]*r2\.dev' | head -1; }
BASE="$(public_url || true)"
if [[ -z "$BASE" ]]; then
  "${WRANGLER[@]}" r2 bucket dev-url enable "$BUCKET" -y
  BASE="$(public_url)"
fi
echo "    $BASE"

OUT="$WORKSPACE/target/publish/$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT"

put() { "${WRANGLER[@]}" r2 object put "$BUCKET/$1" --file "$2" --remote --content-type "$3" >/dev/null; echo "    $1"; }
# An artifact and its POM (plus .sha1s) into the Maven layout.
put_maven() { # artifact file packaging
  local artifact="$1" file="$2" packaging="$3" ext="${2##*.}"
  local name="$artifact-$VERSION"
  cp "$file" "$OUT/$name.$ext"
  cat > "$OUT/$name.pom" <<POM
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.johnkueh.sync</groupId>
  <artifactId>$artifact</artifactId>
  <version>$VERSION</version>
  <packaging>$packaging</packaging>
</project>
POM
  for f in "$name.$ext" "$name.pom"; do
    shasum -a 1 "$OUT/$f" | cut -d' ' -f1 > "$OUT/$f.sha1"
    put "maven/$GROUP_PATH/$artifact/$VERSION/$f" "$OUT/$f" application/octet-stream
    put "maven/$GROUP_PATH/$artifact/$VERSION/$f.sha1" "$OUT/$f.sha1" text/plain
  done
}

if grep -q "SyncFFI-$VERSION.xcframework.zip" Package.swift && grep -q "^val ffiVersion = \"$VERSION\"" kotlin/build.gradle.kts; then
  echo "==> iOS and Android: $VERSION is already published, skipping"
else
  echo "==> iOS"
  SKIP_MACOS="${SKIP_MACOS:-0}" scripts/build-xcframework.sh
  ZIP="SyncFFI-$VERSION.xcframework.zip"
  (cd swift && ditto -c -k --sequesterRsrc --keepParent SyncFFI.xcframework "$OUT/$ZIP")
  CHECKSUM="$(swift package compute-checksum "$OUT/$ZIP")"

  echo "==> Android"
  ANDROID_ABIS="${ANDROID_ABIS:-arm64-v8a x86_64}" scripts/build-android.sh
  aar="$OUT/aar"
  mkdir -p "$aar/jni"
  cp -R kotlin/build/rustJniLibs/. "$aar/jni/"
  cat > "$aar/AndroidManifest.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.johnkueh.sync.ffi.jni" />
XML
  (cd "$OUT" && mkdir -p empty && jar cf "$aar/classes.jar" -C empty .)
  : > "$aar/R.txt"
  (cd "$aar" && zip -qr -X "$OUT/native.aar" AndroidManifest.xml classes.jar R.txt jni)

  echo "==> upload"
  put "$ZIP" "$OUT/$ZIP" application/zip
  put_maven sync-ffi-native "$OUT/native.aar" aar

  echo "==> point the packages at $VERSION"
  sed -i '' -E \
    -e "s#^let ffiURL = \".*\"#let ffiURL = \"$BASE/$ZIP\"#" \
    -e "s#^let ffiChecksum = \".*\"#let ffiChecksum = \"$CHECKSUM\"#" \
    Package.swift
  sed -i '' -E \
    -e "s#^val ffiVersion = \".*\"#val ffiVersion = \"$VERSION\"#" \
    kotlin/build.gradle.kts
  sed -i '' -E "s#^val syncBinaries = \".*\"#val syncBinaries = \"$BASE/maven\"#" \
    settings.gradle.kts

  # The packages now use the upload; drop the local builds so they do too.
  rm -rf swift/SyncFFI.xcframework kotlin/build/rustJniLibs
fi

# JNA finds a library on the classpath under its platform folder, so an
# app's JVM tests just add this jar (testRuntimeOnly).
echo "==> host jar (darwin-aarch64)"
CARGO_TARGET_DIR="$WORKSPACE/target/host" cargo build -p sync-ffi --lib --profile android-release
host="$OUT/host/darwin-aarch64"
mkdir -p "$host"
cp "$WORKSPACE/target/host/android-release/libsync_ffi.dylib" "$host/"
(cd "$OUT/host" && jar cf "$OUT/host.jar" darwin-aarch64)
put_maven sync-ffi-host "$OUT/host.jar" jar

echo "==> done: commit what changed, tag, and bump the apps to the new tag"
git -C "$WORKSPACE" status --short
