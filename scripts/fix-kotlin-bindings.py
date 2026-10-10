"""Renames SyncError's `message` field to `detail` in the generated Kotlin
bindings (see build-android.sh): UniFFI turns it into a property that clashes
with Throwable.message, and the file doesn't compile."""

import re
import sys

path = sys.argv[1]
src = open(path).read()
src, n = re.subn(
    r'val `message`: kotlin\.String(\s*\) : SyncException\(\) \{\s*override val message\s*get\(\) = )"message=\$\{ `message` \}"',
    r"val `detail`: kotlin.String\1`detail`",
    src,
)
src = src.replace("value.`message`", "value.`detail`")
if n != 6:
    sys.exit(f"fix-kotlin-bindings: expected 6 SyncException variants to rename, found {n}")
open(path, "w").write(src)
