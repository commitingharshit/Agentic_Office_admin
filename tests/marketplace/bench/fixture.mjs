// Synthetic installed set for the marketplace benchmark. Writes a lockfile with N entries and a store directory per entry
// (a small agentic.marketplace.json and, for skills, a SKILL.md) into a throwaway MARKETPLACE_HOME. Nothing here touches the
// user's real ~/.agentic-office/marketplace. Items are marked test: ids are `bench-test/item-<n>`.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeHome(prefix = 'mkt-bench-') { return mkdtempSync(join(tmpdir(), prefix)); }

/** 3 in 4 items are skills with a SKILL.md, the rest templates (150 + 50 for n = 200). */
export function generateInstalled(home, n = 200, { withStore = true } = {}) {
  const store = join(home, 'store');
  mkdirSync(store, { recursive: true });
  const items = [];
  for (let i = 0; i < n; i++) {
    const isSkill = i % 4 !== 3;
    const id = `bench-test/item-${i}`;
    const sha256 = createHash('sha256').update(`bench:${i}`).digest('hex');
    const dir = join(store, sha256);
    if (withStore) mkdirSync(dir, { recursive: true });
    const manifest = { schema: 'agentic.marketplace/1', id, type: isSkill ? 'skill' : 'template', version: '1.0.0', title: `Bench item ${i}`, license: 'MIT', summary: 'synthetic benchmark item (test)', permissions: [], files: [] };
    if (withStore) writeFileSync(join(dir, 'agentic.marketplace.json'), JSON.stringify(manifest));
    if (withStore && isSkill) writeFileSync(join(dir, 'SKILL.md'), `---\nname: bench-item-${i}\ndescription: synthetic benchmark skill ${i} (test)\n---\n\n# Bench item ${i}\n\nUse this only in the benchmark.\n`);
    else if (withStore) writeFileSync(join(dir, `template-${i}.docx`), Buffer.alloc(512, i % 251));
    items.push({
      id, type: manifest.type, version: '1.0.0', versionId: `ver_bench-test_item-${i}_1`, sha256, source: 'marketplace', enabled: i % 7 !== 0,
      scanVerdict: 'clean', installedAt: '2026-10-21T00:00:00.000Z', modifiedLocally: false, installPath: dir,
    });
  }
  const bytes = JSON.stringify({ version: 1, items }, null, 2) + '\n';
  writeFileSync(join(home, 'installed.lock.json'), bytes);
  return { count: n, lockfileBytes: Buffer.byteLength(bytes) };
}
