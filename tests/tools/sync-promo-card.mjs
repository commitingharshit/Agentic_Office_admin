#!/usr/bin/env node
// Copy the promo-card validator (packages/promo-card/src/card.ts, the single source) to the three places that cannot import
// packages/: the accounts-sync container (only services/api is mounted), the desktop fork (its own build), and the admin
// console. The desktop copy gets the fork's copyright header and tab indentation (its hygiene check requires both).
//   node tests/tools/sync-promo-card.mjs           write the copies
//   node tests/tools/sync-promo-card.mjs --check   exit 1 if any copy differs from what would be written
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = 'packages/promo-card/src/card.ts';
const NOTE = `// GENERATED from ${SOURCE} by tests/tools/sync-promo-card.mjs. Do not edit: change the source and re-run the script.\n`;
const MS = '/*---------------------------------------------------------------------------------------------\n' +
  ' *  Copyright (c) Microsoft Corporation. All rights reserved.\n' +
  ' *  Licensed under the MIT License. See License.txt in the project root for license information.\n' +
  ' *--------------------------------------------------------------------------------------------*/\n\n';
const tabs = (s) => s.replace(/^( {2})+/gm, (m) => '\t'.repeat(m.length / 2));
const TARGETS = [
  { path: 'services/api/src/growth/promo-card.ts', make: (s) => NOTE + s },
  { path: 'apps/console/src/lib/promo-card.ts', make: (s) => NOTE + s },
  { path: 'apps/desktop/src/vs/workbench/contrib/agenticOffice/common/promoCard.ts', make: (s) => MS + tabs(NOTE + s) },
];

const src = readFileSync(join(root, SOURCE), 'utf8');
if (/[^\x00-\x7f]/.test(src)) { console.error(`${SOURCE} must be ASCII (the fork's unicode filter refuses anything else)`); process.exit(1); }
const check = process.argv.includes('--check');
let stale = 0;
for (const t of TARGETS) {
  const want = t.make(src);
  const file = join(root, t.path);
  const have = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (have === want) continue;
  if (check) { console.error(`stale: ${t.path}`); stale++; continue; }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, want);
  console.log(`wrote ${t.path}`);
}
if (check && stale) { console.error(`${stale} copy(ies) out of date: run node tests/tools/sync-promo-card.mjs`); process.exit(1); }
if (check) console.log('promo-card copies match the source');
