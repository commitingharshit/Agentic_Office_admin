// Stage 3: every file SKILL.md points at exists, is declared in the manifest, stays inside the package, and references/ is flat.
// (check-office-skills.py is bound to the repo's skills/ tree and capability map, so it cannot run on a package; its pointer
// rules 3 to 5 are re-expressed here over the unpacked files.)
import { posix } from 'node:path';
import { pathProblem } from '../../../manifest.ts';
import type { Evidence, StageDef } from '../../types.ts';
import { skillPayload, text, tooLarge, treeProblem } from './util.ts';

const LINK = /\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
const BARE = /(?:^|[\s`'"(])((?:references|scripts|assets)\/[^\s`'")\]>]+)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function referencesStage(timeoutMs = 20_000): StageDef {
  return {
    id: 'references', title: 'Reference resolution', required: true, timeoutMs, after: ['manifest'],
    run: async ({ pkg }) => {
      const bad = treeProblem(pkg); if (bad) return tooLarge(bad);
      const { entry, dir, name } = skillPayload(pkg);
      const md = pkg.files.get(entry);
      if (!md) return { status: 'fail', reason: `entry ${entry} is not in the package`, evidence: [] };
      const declared = new Set(pkg.manifest.files.map((f) => f.path));
      const body = text(md);
      const targets = new Set<string>();
      for (const m of body.matchAll(LINK)) targets.add(m[1]);
      for (const m of body.matchAll(BARE)) targets.add(m[1]);
      const problems: string[] = [], evidence: Evidence[] = []; let checked = 0;
      for (const raw of targets) {
        if (checked >= 500) { problems.push('more than 500 references'); break; }
        if (raw.startsWith('#') || SCHEME.test(raw) || raw.startsWith('//')) continue;   // anchors and URLs are not package files
        checked++;
        let t = raw.replace(/[#?].*$/, '').replace(/[.,;:]+$/, '');
        try { t = decodeURIComponent(t); } catch { /* keep raw */ }
        if (!t) continue;
        const abs = t.startsWith('/') || /^[a-z]:[\\/]/i.test(t) || t.includes('\\') || t.includes('\0');
        const resolved = abs ? t : posix.normalize(dir ? `${dir}/${t}` : t);
        if (abs || resolved === '..' || resolved.startsWith('../') || (dir && !resolved.startsWith(dir + '/')) || pathProblem(resolved)) { problems.push(`${JSON.stringify(raw.slice(0, 80))} escapes the package`); continue; }
        if (!pkg.files.has(resolved)) { problems.push(`${JSON.stringify(raw.slice(0, 80))} does not exist in the package`); continue; }
        if (!declared.has(resolved)) problems.push(`${resolved} is not declared in the manifest files`);
      }
      const refPrefix = (dir ? dir + '/' : '') + 'references/';
      const nested = [...pkg.files.keys()].filter((f) => f.startsWith(refPrefix) && f.slice(refPrefix.length).includes('/'));
      if (nested.length) problems.push(`references/ must be flat (the loader globs references/*.md): ${nested.slice(0, 5).join(', ')}`);
      const refs = [...pkg.files.keys()].filter((f) => f.startsWith(refPrefix) && f.endsWith('.md') && !f.slice(refPrefix.length).includes('/'));
      const unrouted = refs.filter((f) => !body.includes(f.slice(refPrefix.length)) && !body.includes(f));
      evidence.push({ kind: 'check', label: 'references checked', detail: `${checked} pointer(s) in ${entry} of skill ${name ?? '?'}` });
      if (unrouted.length) evidence.push({ kind: 'check', label: 'unrouted references (advisory)', detail: unrouted.slice(0, 10).join(', ') });
      if (problems.length) {
        for (const p of problems.slice(0, 30)) evidence.push({ kind: 'check', label: 'reference problem', detail: p });
        return { status: 'fail', reason: problems.slice(0, 3).join('; '), evidence };
      }
      return { status: 'pass', evidence };
    },
  };
}
