#!/bin/bash
# Builds "Arena Bridge.app" — a native window app for the bridge.
# Needs the Xcode command line tools: xcode-select --install
set -euo pipefail
cd "$(dirname "$0")"

NAME="Arena Bridge"
BUNDLE="dist/$NAME.app"
ARCH="${ARCH:-$(uname -m)}"

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

echo "building for $ARCH…"
swiftc -O -swift-version 5 -parse-as-library \
  -target "$ARCH-apple-macosx13.0" \
  -o "$BUNDLE/Contents/MacOS/ArenaBridge" \
  Sources/*.swift

cp Resources/Info.plist "$BUNDLE/Contents/Info.plist"
codesign --force --sign - "$BUNDLE" >/dev/null 2>&1 || true

echo "built: $BUNDLE"
echo "install: cp -R \"$BUNDLE\" /Applications/"
