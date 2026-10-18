"""One-off patch: fall back to the local Peekaboo runtime when the bridge host lost its permissions."""
from pathlib import Path

ROOT = Path(__file__).parent

# ---------------------------------------------------------------- Node
p = ROOT / "src" / "mac.mjs"
s = p.read_text()

old = """  const seeVariants = (args, outPath) => {
    const mode = args.mode === 'window' ? 'window' : 'screen';
    const base = ['see', '--mode', mode, ...targetFlags(args)];
    if (!outPath) {
      return [
        ['see', '--tree', '--no-screenshot', '--json', ...targetFlags(args)],
        ['see', '--tree', '--no-screenshot', '--no-remote', '--json', ...targetFlags(args)],
        ['see', '--tree', '--json', ...targetFlags(args)],
        ['see', '--json', ...targetFlags(args)],
      ];
    }
    return [
      [...base, '--json', '--path', outPath],
      [...base, '--path', outPath, '--json'],
      [...base, '--no-remote', '--json', '--path', outPath],
      ['image', '--mode', mode, ...targetFlags(args), '--json', '--path', outPath],
    ];
  };"""
new = """  const seeVariants = (args, outPath) => {
    const mode = args.mode === 'window' ? 'window' : 'screen';
    const base = ['see', '--mode', mode, ...targetFlags(args)];
    if (!outPath) {
      return [
        ['see', '--tree', '--no-screenshot', '--json', ...targetFlags(args)],
        ['see', '--tree', '--no-screenshot', '--no-remote', '--json', ...targetFlags(args)],
        ['see', '--tree', '--json', ...targetFlags(args)],
        ['see', '--no-remote', '--tree', '--json', ...targetFlags(args)],
        ['see', '--json', ...targetFlags(args)],
      ];
    }
    return [
      [...base, '--json', '--path', outPath],
      [...base, '--path', outPath, '--json'],
      [...base, '--no-remote', '--json', '--path', outPath],
      ['image', '--mode', mode, ...targetFlags(args), '--json', '--path', outPath],
    ];
  };"""
assert old in s
s = s.replace(old, new, 1)

old = """      if (res.exit_code === 0 && cand.elements.length) return cand;
      if (res.exit_code === 0 && best.res.exit_code !== 0) best = cand;
      if (res.exit_code !== 0 && !UNKNOWN.test(res.stderr || '')) break;"""
new = """      if (res.exit_code === 0 && cand.elements.length) return cand;
      if (res.exit_code === 0 && best.res.exit_code !== 0) best = cand;
      const denied = isPermissionError(json, res);
      if (res.exit_code !== 0 && !denied && !UNKNOWN.test(res.stderr || '')) break;"""
assert old in s
s = s.replace(old, new, 1)

old = """function menuFlags(args) {"""
new = """/** The Peekaboo envelope reports a host that lost its macOS permissions. */
function peekError(json) {
  if (!json || typeof json !== 'object') return null;
  const err = json.error;
  if (err && typeof err === 'object' && (err.code || err.message)) return err;
  return null;
}

function isPermissionError(json, res) {
  const err = peekError(json);
  const text = `${err?.code || ''} ${err?.message || ''} ${res?.stderr || ''}`;
  return /permission|screen recording|accessibility|event synthesizing/i.test(text);
}

const PERMISSION_HINT =
  'The Peekaboo host that captures the screen lost its macOS permissions (this happens after a Peekaboo update). ' +
  'Re-grant Screen Recording and Accessibility to "Peekaboo Bridge" in System Settings → Privacy & Security, ' +
  'or let the bridge use the local runtime (--no-remote). Run mac_permissions for the current state.';

function menuFlags(args) {"""
assert old in s
s = s.replace(old, new, 1)

# mac_see: report a failed peekaboo run instead of pretending everything is fine
old = """        const seen = await collectSee(args, outPath.abs);
        const elements = seen.elements.slice(0, 300);"""
new = """        const seen = await collectSee(args, outPath.abs);
        const failure = peekError(seen.json);
        if (failure && !seen.elements.length) {
          return {
            ok: false,
            error: 'peekaboo_failed',
            reason: failure.message || String(failure.code || 'peekaboo returned an error'),
            hint: PERMISSION_HINT,
          };
        }
        const elements = seen.elements.slice(0, 300);"""
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)
print('node mac: local fallback + permission hint')

# ---------------------------------------------------------------- Python
p = ROOT / "arena_bridge" / "mac.py"
s = p.read_text()

old = """        if not out_path:
            return [
                ["see", "--tree", "--no-screenshot", "--json", *_target_flags(args)],
                ["see", "--tree", "--no-screenshot", "--no-remote", "--json", *_target_flags(args)],
                ["see", "--tree", "--json", *_target_flags(args)],
                ["see", "--json", *_target_flags(args)],
            ]"""
new = """        if not out_path:
            return [
                ["see", "--tree", "--no-screenshot", "--json", *_target_flags(args)],
                ["see", "--tree", "--no-screenshot", "--no-remote", "--json", *_target_flags(args)],
                ["see", "--tree", "--json", *_target_flags(args)],
                ["see", "--no-remote", "--tree", "--json", *_target_flags(args)],
                ["see", "--json", *_target_flags(args)],
            ]"""
assert old in s
s = s.replace(old, new, 1)

old = """            if res["exit_code"] == 0 and cand["elements"]:
                return cand
            if res["exit_code"] == 0 and best["exit_code"] != 0:
                best = cand
            if res["exit_code"] != 0 and not any(m in (res["stderr"] or "").lower() for m in UNKNOWN):
                break"""
new = """            if res["exit_code"] == 0 and cand["elements"]:
                return cand
            if res["exit_code"] == 0 and best["exit_code"] != 0:
                best = cand
            if res["exit_code"] != 0 and not _is_permission_error(cand) and not any(
                m in (res["stderr"] or "").lower() for m in UNKNOWN
            ):
                break"""
assert old in s
s = s.replace(old, new, 1)

old = """def _menu_flags(args):"""
new = '''PERMISSION_HINT = (
    "The Peekaboo host that captures the screen lost its macOS permissions (this happens after a Peekaboo update). "
    'Re-grant Screen Recording and Accessibility to "Peekaboo Bridge" in System Settings → Privacy & Security, '
    "or let the bridge use the local runtime (--no-remote). Run mac_permissions for the current state."
)


def _peek_error(data):
    if not isinstance(data, dict):
        return None
    err = data.get("error")
    if isinstance(err, dict) and (err.get("code") or err.get("message")):
        return err
    return None


def _is_permission_error(cand):
    err = _peek_error(cand.get("data"))
    text = " ".join(
        str(x or "")
        for x in (err.get("code") if err else None, err.get("message") if err else None, cand.get("stderr"))
    )
    return any(k in text.lower() for k in ("permission", "screen recording", "accessibility", "event synthesizing"))


def _menu_flags(args):'''
assert old in s
s = s.replace(old, new, 1)

old = """        seen = collect_see(args, out_path)
        res = seen
        data = seen["data"]
        elements = seen["elements"][:300]"""
new = """        seen = collect_see(args, out_path)
        res = seen
        data = seen["data"]
        elements = seen["elements"][:300]
        failure = _peek_error(data)
        if failure and not elements:
            return {
                "ok": False,
                "error": "peekaboo_failed",
                "reason": failure.get("message") or str(failure.get("code") or "peekaboo returned an error"),
                "hint": PERMISSION_HINT,
            }"""
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)
print('python mac: local fallback + permission hint')

# ---------------------------------------------------------------- fake
p = ROOT / "test" / "fake-peekaboo.sh"
s = p.read_text()
old = """  see | image)
    echo '{"success":true,"data":{"snapshot_id":"ps1_0123456789abcdef0123456789abcdef","element_count":2,"ui_elements":[{"id":"B1","role":"button","ax_role":"AXButton","title":"Save","label":"Save","value":null,"description":null,"identifier":null,"bounds":{"x":1,"y":2},"is_actionable":true,"is_enabled":true,"is_value_settable":false},{"id":"B2","role":"textField","ax_role":"AXTextField","title":"Search","label":"Search","value":"","description":"Search field","identifier":"search","bounds":{"x":4,"y":6},"is_actionable":true,"is_enabled":true,"is_value_settable":true}]}}'
    ;;"""
new = """  see | image)
    case " $* " in
      *--no-remote*)
        echo '{"success":true,"data":{"snapshot_id":"ps1_0123456789abcdef0123456789abcdef","element_count":2,"ui_elements":[{"id":"B1","role":"button","ax_role":"AXButton","title":"Save","label":"Save","value":null,"description":null,"identifier":null,"bounds":{"x":1,"y":2},"is_actionable":true,"is_enabled":true,"is_value_settable":false},{"id":"B2","role":"textField","ax_role":"AXTextField","title":"Search","label":"Search","value":"","description":"Search field","identifier":"search","bounds":{"x":4,"y":6},"is_actionable":true,"is_enabled":true,"is_value_settable":true}]}}'
        ;;
      *)
        echo '{"success":false,"data":null,"error":{"code":"PERMISSION_ERROR_SCREEN_RECORDING","message":"Screen Recording permission is required"}}'
        ;;
    esac
    ;;"""
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)
print('fake: the remote host has no permissions, the local one works')
