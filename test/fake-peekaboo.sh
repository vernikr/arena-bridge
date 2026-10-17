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
    echo '{"success":true,"data":{"snapshot_id":"ps1_0123456789abcdef0123456789abcdef","element_count":2,"ui_elements":[{"id":"B1","role":"button","ax_role":"AXButton","title":"Save","label":"Save","value":null,"description":null,"identifier":null,"bounds":{"x":1,"y":2},"is_actionable":true,"is_enabled":true,"is_value_settable":false},{"id":"B2","role":"textField","ax_role":"AXTextField","title":"Search","label":"Search","value":"","description":"Search field","identifier":"search","bounds":{"x":4,"y":6},"is_actionable":true,"is_enabled":true,"is_value_settable":true}]}}'
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
  click | type | press | scroll | move | drag | set-value)
    echo "done $1"
    ;;
  menu)
    if [ "$2" = "list" ]; then
      echo '{"menus":[{"title":"File","items":[{"title":"Save","id":"M1"}]}]}'
    else
      echo "done menu $2"
    fi
    ;;
  space)
    if [ "$2" = "list" ]; then
      echo '{"spaces":[{"id":1,"name":"Desktop 1","active":true},{"id":2,"name":"Desktop 2","active":false}]}'
    else
      echo "done space $2"
    fi
    ;;
  app)
    echo "done app $2"
    ;;
  *)
    echo "unknown command: $1" >&2
    exit 2
    ;;
esac
