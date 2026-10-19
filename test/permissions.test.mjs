import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { permissionStatus } from '../src/mac.mjs';

function fakeBin(out) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
  const bin = path.join(dir, 'peekaboo');
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\n`, { mode: 0o755 });
  return bin;
}
const OK = 'Source: local runtime\nScreen Recording (Required): Granted\nAccessibility (Required): Granted\nEvent Synthesizing (Optional): Not Granted\n';

test('both permissions granted', async () => {
  const r = await permissionStatus({ peekaboo: undefined, peekabooPath: fakeBin(OK) });
  assert.deepEqual(r, { ok: true, screen: true, accessibility: true, source: 'local runtime' });
});

test('a missing permission is reported by name', async () => {
  const r = await permissionStatus({ peekabooPath: fakeBin(OK.replace('Screen Recording (Required): Granted', 'Screen Recording (Required): Not Granted')) });
  assert.equal(r.ok, false);
  assert.equal(r.screen, false);
  assert.equal(r.accessibility, true);
});

test('missing peekaboo is reported, not thrown', async () => {
  const r = await permissionStatus({ peekabooPath: '/nonexistent/peekaboo' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'peekaboo_not_found');
});
