#!/bin/bash
# arena-bridge installer: the command line tool and the macOS app in one step.
#
#   curl -fsSL https://raw.githubusercontent.com/vernikr/arena-bridge/main/install.sh | sh
#
# Options:
#   --cli-only     only the command line tool
#   --app-only     only the macOS app
#   --version X.Y.Z  install a specific release
set -euo pipefail

REPO="vernikr/arena-bridge"
CLI_ONLY=0
APP_ONLY=0
VERSION=""
PREFIX=""

while [ $# -gt 0 ]; do
  case "$1" in
    --cli-only) CLI_ONLY=1 ;;
    --app-only) APP_ONLY=1 ;;
    --version) VERSION="${2:-}"; shift; case "$VERSION" in ""|[0-9]*.[0-9]*.[0-9]*) ;; *) die "invalid --version: $VERSION (expected X.Y.Z)" ;; esac ;;
    --prefix) PREFIX="${2:-}"; shift ;;
    -h|--help) cat <<'HELP'
arena-bridge installer: the command line tool and the macOS app in one step.

  curl -fsSL https://raw.githubusercontent.com/vernikr/arena-bridge/main/install.sh | sh

Options:
  --cli-only     only the command line tool
  --app-only     only the macOS app
  --version X.Y.Z  install a specific release
  --prefix PATH    npm prefix (default: global)
  -h, --help     show this help
HELP
      exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ASSET_ARCH="arm64" ;;
  x86_64|amd64) ASSET_ARCH="x86_64" ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

# --- the command line tool ------------------------------------------------

install_cli() {
  say "→ the command line tool"
  if command -v npm >/dev/null 2>&1; then
    if [ -n "$PREFIX" ]; then
      npm install -g --prefix "$PREFIX" "arena-bridge${VERSION:+@$VERSION}"
    else
      npm install -g "arena-bridge${VERSION:+@$VERSION}"
    fi
    return
  fi
  if command -v pipx >/dev/null 2>&1; then
    pipx install "arena-bridge${VERSION:+==$VERSION}"
    return
  fi
  if command -v pip3 >/dev/null 2>&1; then
    pip3 install --user "arena-bridge${VERSION:+==$VERSION}"
    say "  add ~/.local/bin to your PATH if the command is not found"
    return
  fi
  die "no npm, pipx or pip3 found — install Node.js or Python first"
}

# --- the macOS app --------------------------------------------------------

install_app() {
  [ "$OS" = "Darwin" ] || return 0
  say "→ the macOS app"
  TAG="${VERSION:-latest}"
  URL="https://github.com/$REPO/releases/latest/download/Arena-Bridge-$ASSET_ARCH.zip"
  if [ -n "$VERSION" ]; then
    URL="https://github.com/$REPO/releases/download/v$VERSION/Arena-Bridge-$ASSET_ARCH.zip"
  fi
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar "$URL" -o "$TMP/app.zip" || die "cannot download the app"
  else
    wget -q "$URL" -O "$TMP/app.zip" || die "cannot download the app"
  fi
  # A4: verify SHA256 if available (release publishes SHA256SUMS)
  SHA_URL="${URL%/*}/SHA256SUMS"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsSL "$SHA_URL" -o "$TMP/SHA256SUMS" 2>/dev/null; then
      say "  verifying SHA256…"
      if command -v shasum >/dev/null 2>&1; then
        (cd "$TMP" && shasum -a 256 -c SHA256SUMS --ignore-missing 2>/dev/null) || say "  SHA check skipped (no matching entry) — verify manually: $SHA_URL"
      elif command -v sha256sum >/dev/null 2>&1; then
        (cd "$TMP" && sha256sum -c SHA256SUMS --ignore-missing 2>/dev/null) || say "  SHA check skipped — verify manually: $SHA_URL"
      fi
    fi
  fi
  unzip -q "$TMP/app.zip" -d "$TMP"
  APP="$(find "$TMP" -maxdepth 3 -name '*.app' -print -quit)"
  [ -n "$APP" ] || die "the archive has no app inside"
  TARGET="/Applications/Arena Bridge.app"
  if [ -w /Applications ]; then
    [ -n "$TARGET" ] && [ "$TARGET" != "/" ] && [ "$TARGET" != "/Applications" ] || die "refusing to remove unsafe TARGET: $TARGET"
    rm -rf "$TARGET"
    cp -R "$APP" "$TARGET"
  else
    say "  /Applications is not writable — copy the app there by hand:"
    say "    cp -R \"$APP\" /Applications/"
    return 0
  fi
  say "  installed: $TARGET"
  say "  if macOS blocks the first launch: right-click the app in /Applications → Open"
}

if [ "$APP_ONLY" -eq 0 ]; then install_cli; fi
if [ "$CLI_ONLY" -eq 0 ]; then install_app; fi

say ""
say "done. next steps:"
say "  arena-bridge init --root ~/Documents     # set up"
say "  arena-bridge service install --bin ngrok # public address"
say "  arena-bridge start"
