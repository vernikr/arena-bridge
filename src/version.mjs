// Single source of truth for version — read from package.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = "0.11.0";

export function getVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, '..', 'package.json');
    const data = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return data.version || VERSION;
  } catch {
    return VERSION;
  }
}
