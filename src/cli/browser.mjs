import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { findChrome, listProfiles, resolveProfile, sanitizeProfile } from '../browser.mjs';

export function cmdBrowser(args) {
  const what = args._[1] || 'list';
  if (what === 'list') {
    const profiles = listProfiles();
    if (args.flags.json) { console.log(JSON.stringify(profiles, null, 2)); return; }
    if (!profiles.length) {
      console.log('no agent browser profiles yet — create one: arena-bridge browser login <name>');
      return;
    }
    for (const p of profiles) {
      console.log(`${p.name.padEnd(20)} ${String(p.files).padStart(3)} files   ${new Date(p.mtime).toLocaleString()}`);
      console.log(`  ${p.path}`);
    }
    console.log('\nThe agent opens a profile with: chrome_launch {"profile":"<name>"}');
    return;
  }
  if (what === 'open' || what === 'login') {
    if (what === 'open') {
      console.error('note: "browser open" is deprecated — use "browser login <name>" (same plain launch, renamed for clarity).');
    }
    const name = args._[2];
    if (!name) {
      console.error('usage: arena-bridge browser login <name>');
      process.exit(1);
    }
    const bin = findChrome();
    if (!bin) {
      console.error('✗ Chrome not found in /Applications');
      process.exit(1);
    }
    const profile = resolveProfile(name);
    fs.mkdirSync(profile, { recursive: true });
    const chromeArgs = [
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
    ];
    const width = Number(args.flags.width || 0);
    const height = Number(args.flags.height || 0);
    if (width && height) chromeArgs.push(`--window-size=${width},${height}`);
    if (args.flags.x != null && args.flags.y != null) {
      chromeArgs.push(`--window-position=${Number(args.flags.x)},${Number(args.flags.y)}`);
    }
    const proc = spawn(bin, chromeArgs, { detached: true, stdio: 'ignore' });
    proc.unref();
    console.log(`✓ Chrome opened with the profile "${sanitizeProfile(name)}"`);
    console.log(`  profile: ${profile}`);
    console.log('  log in to the sites the agent needs and close this window — the logins stay.');
    console.log(`  the agent opens the same profile with: chrome_launch {"profile":"${sanitizeProfile(name)}"}`);
    return;
  }
  if (what === 'clean' || what === 'prune') {
    const days = Number(args.flags.days || args._[2] || 30);
    const d = Number.isFinite(days) && days>0 ? days : 30;
    const profiles = listProfiles();
    let removed=0;
    for (const prof of profiles) {
      const ageDays = (Date.now() - prof.mtime) / 86400000;
      if (ageDays > d) {
        try { fs.rmSync(prof.path, { recursive: true, force: true }); removed++; console.log(`removed ${prof.name} (${Math.round(ageDays)} days old)`); } catch {}
      }
    }
    if (!removed) console.log(`no profiles older than ${d} days`);
    else console.log(`cleaned ${removed} profile(s)`);
    return;
  }
  if (what === 'close') {
    const name = args._[2];
    if (!name) {
      console.error('usage: arena-bridge browser close <name>');
      process.exit(1);
    }
    const profile = resolveProfile(name);
    let out = '';
    try { out = execSync('ps -Ao pid,command', { encoding: 'utf8' }); } catch {}
    let killed=0;
    for (const line of out.split('\n')) {
      if (line.includes(`--user-data-dir=${profile}`)) {
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (pid) { try { process.kill(pid, 'SIGTERM'); killed++; } catch {} }
      }
    }
    if (killed) console.log(`killed ${killed} Chrome(s) for ${sanitizeProfile(name)}`);
    else console.log(`no running Chrome for ${sanitizeProfile(name)}`);
    return;
  }
  console.error(`unknown browser subcommand: ${what} — use: list, login, clean, close`);
  process.exit(1);
}
