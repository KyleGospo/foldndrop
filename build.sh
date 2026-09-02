#!/usr/bin/env bash
set -euo pipefail
UUID="foldndrop@kylegospodneti.ch"
glib-compile-schemas schemas/

# Parse every module before packaging. A module that does not parse leaves the
# extension silently inert on the next login, and the GLSL lives inside
# template literals where a stray backtick in a shader comment ends the string
# early — which looks nothing like a syntax error when you are reading GLSL.
for f in extension.js prefs.js src/core/*.js src/shell/*.js; do
    # Captured rather than piped: gjs exits non-zero on the shell imports it
    # cannot resolve outside the compositor, and under `set -o pipefail` that
    # status would mask a grep that did match.
    out=$(gjs -m "$f" 2>&1 || true)
    if printf '%s\n' "$out" | grep -q SyntaxError; then
        echo "syntax error in $f:" >&2
        printf '%s\n' "$out" | grep SyntaxError >&2
        exit 1
    fi
done

rm -f "$UUID.shell-extension.zip"
zip -r "$UUID.shell-extension.zip" \
    metadata.json extension.js prefs.js LICENSE src schemas \
    -x 'schemas/*.xml'
echo "built $UUID.shell-extension.zip"
