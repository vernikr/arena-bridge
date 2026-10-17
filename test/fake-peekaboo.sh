#!/bin/sh
# Fake Peekaboo CLI for tests: answers like the real one for the commands the bridge uses.
log="${FAKE_PEEKABOO_LOG:-/dev/null}"
printf '%s\n' "$*" >>"$log"

# create the file given by --path so the bridge sees a saved screenshot
prev=""
for arg in "$@"; do
  if [ "$prev" = "--path" ]; then
    mkdir -p "$(dirname "$arg")" 2>/dev/null
    printf 'PNG' >"$arg"
  fi
  prev="$arg"
done

case "$1" in
  see | image)
    echo '{"elements":[{"id":"B1","role":"button","title":"Save","bounds":{"x":1,"y":2}},{"id":"B2","role":"textField","title":"Search"}]}'
    ;;
  list)
    if [ "$2" = "windows" ]; then
      echo '{"windows":[{"id":42,"title":"Documents"}]}'
    else
      echo '{"apps":[{"name":"Safari","pid":10,"focused":true},{"name":"Finder","pid":11,"focused":false}]}'
    fi
    ;;
  permissions)
    echo 'Screen Recording: granted'
    ;;
  click | type | press | scroll | move | drag)
    echo "done $1"
    ;;
  app)
    echo "done app $2"
    ;;
  *)
    echo "unknown command: $1" >&2
    exit 2
    ;;
esac
