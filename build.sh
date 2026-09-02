#!/usr/bin/env bash
set -euo pipefail
UUID="foldndrop@kylegospodneti.ch"
glib-compile-schemas schemas/
rm -f "$UUID.shell-extension.zip"
zip -r "$UUID.shell-extension.zip" \
    metadata.json extension.js prefs.js LICENSE src schemas \
    -x 'schemas/*.xml'
echo "built $UUID.shell-extension.zip"
