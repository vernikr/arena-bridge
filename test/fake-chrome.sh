#!/bin/sh
# Stands in for the Chrome binary in tests: starts the fake CDP server on the
# port requested via --remote-debugging-port.
PORT=0
for a in "$@"; do
  case "$a" in
    --remote-debugging-port=*) PORT="${a#*=}" ;;
  esac
done
[ "$PORT" = "0" ] && PORT=9223
exec node "$(dirname "$0")/fake-cdp.mjs" --port "$PORT"
