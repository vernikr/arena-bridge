#!/bin/bash
# Builds "Arena Bridge.app" — a native window app for the bridge.
# Needs the Xcode command line tools: xcode-select --install
set -euo pipefail
cd "$(dirname "$0")"

# the name and the bundle id live in Sources/AppInfo.swift
NAME=$(sed -n 's/.*static let name = "\(.*\)".*/\1/p' Sources/AppInfo.swift)
BUNDLE_ID=$(sed -n 's/.*static let bundleID = "\(.*\)".*/\1/p' Sources/AppInfo.swift)
EXECUTABLE=$(echo "$NAME" | tr -d ' ')
HELPER=arena-bridge-agent
BUNDLE="dist/$NAME.app"
ARCH="${ARCH:-$(uname -m)}"

rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources" "$BUNDLE/Contents/Helpers"

echo "building for ${ARCH}..."
swiftc -O -swift-version 5 -parse-as-library \
  -target "$ARCH-apple-macosx15.0" \
  -o "$BUNDLE/Contents/MacOS/$EXECUTABLE" \
  Sources/*.swift

# the helper starts the bridge. It lives inside the bundle, so macOS gives the screen
# and the accessibility permissions to the app and not to the node binary.
swiftc -O -swift-version 5 \
  -target "$ARCH-apple-macosx15.0" \
  -o "$BUNDLE/Contents/Helpers/$HELPER" \
  Helper/main.swift

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
# version single source: package.json → Info.plist
PKG_VER=$(node -p "require('../..'+'/package.json').version" 2>/dev/null || echo "0.0.0")
if [ -n "$PKG_VER" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $PKG_VER" "$BUNDLE/Contents/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $PKG_VER" "$BUNDLE/Contents/Info.plist"
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleName $NAME" "$BUNDLE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $NAME" "$BUNDLE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$BUNDLE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $EXECUTABLE" "$BUNDLE/Contents/Info.plist"

# signing: prefer the stable local certificate when it exists. Ad-hoc signing changes the
# code identity on every rebuild and makes macOS ask for screen and accessibility access again.
if [ -n "${ARENA_SIGN_IDENTITY:-}" ]; then
  SIGN_ID="$ARENA_SIGN_IDENTITY"
elif command -v security >/dev/null 2>&1 && security find-identity -v -p codesigning 2>/dev/null | grep -Fq '"Arena Bridge Local"'; then
  SIGN_ID="Arena Bridge Local"
else
  SIGN_ID="-"
fi
echo "signing with: $SIGN_ID"
# the nested code is signed first, the bundle covers it afterwards
codesign --force --sign "$SIGN_ID" --identifier "$BUNDLE_ID" "$BUNDLE/Contents/Helpers/$HELPER" || { echo "signing failed: is the certificate \"$SIGN_ID\" in the keychain?" >&2; exit 1; }
codesign --force --sign "$SIGN_ID" "$BUNDLE" || { echo "signing failed: is the certificate \"$SIGN_ID\" in the keychain?" >&2; exit 1; }

codesign --verify --deep --strict "$BUNDLE"
lipo "$BUNDLE/Contents/Helpers/$HELPER" -verify_arch "$ARCH"
echo "built: $BUNDLE"
echo "install: cp -R \"$BUNDLE\" /Applications/"
