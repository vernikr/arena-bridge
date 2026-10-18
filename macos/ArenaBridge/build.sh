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

# the icon: one 1024px png becomes a macOS .icns
if [ -f Resources/AppIcon.png ]; then
  ICONSET="$BUNDLE/Contents/Resources/AppIcon.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512; do
    sips -z "$size" "$size" Resources/AppIcon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" Resources/AppIcon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$BUNDLE/Contents/Resources/AppIcon.icns"
  rm -rf "$ICONSET"
fi

cp Resources/Info.plist "$BUNDLE/Contents/Info.plist"
codesign --force --sign - "$BUNDLE" >/dev/null 2>&1 || true

echo "built: $BUNDLE"
echo "install: cp -R \"$BUNDLE\" /Applications/"
