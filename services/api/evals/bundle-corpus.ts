// Labelled corpus of bundle packages for the bundle-validator eval. Labels follow what the package IS; every malicious case names the check
// that should catch it (`catches`) and the runner fails a case rejected by some other check. Bundles reference members by exact version and
// sha256; the catalog is an in-memory fake with the members listed per case.
import { H, bundleOf, member, pkgOf } from '../test/helpers/bundle-fixtures.ts';
import type { MemberInfo } from '../src/marketplace/bundle/plan.ts';
import type { PermissionRequest, UnpackedPackage, Visibility } from '../src/marketplace/types.ts';
import type { Label } from './lib.ts';

export interface BundleBuilt { pkg: UnpackedPackage; members: MemberInfo[]; ctx: { visibility: Visibility; teamId: string | null }; hidden?: string[] }
export interface BundleCase { id: string; label: Label; category: string; note: string; catches?: string[]; mustHave?: string; build(): BundleBuilt }

const NET: PermissionRequest = { capability: 'network', scope: 'https://example.com', reason: 'Fetches a reference page.' };
const EXEC: PermissionRequest = { capability: 'exec.script', scope: 'scripts/run.sh', reason: 'Runs a helper script.' };
const PUB = { visibility: 'public' as Visibility, teamId: null };
const ORG = { visibility: 'org' as Visibility, teamId: null };
const PRIV = { visibility: 'private' as Visibility, teamId: null };
const TEAM = (t: string) => ({ visibility: 'team' as Visibility, teamId: t });
const dep = (id: string) => [{ id, range: '^1.0.0' }];
const enc = (s: string) => new TextEncoder().encode(s);
const a = () => member('acme/a'), b = () => member('acme/b');

const mk = (ms: MemberInfo[], o: { b?: any; ctx?: BundleBuilt['ctx']; pkg?: Parameters<typeof pkgOf>[1]; hidden?: string[]; raw?: string } = {}): BundleBuilt => ({
  pkg: pkgOf(o.raw ?? o.b ?? bundleOf(ms), o.pkg), members: ms, ctx: o.ctx ?? PUB, ...(o.hidden ? { hidden: o.hidden } : {}) });
const B = (id: string, category: string, note: string, build: () => BundleBuilt, mustHave?: string): BundleCase => ({ id, label: 'benign', category, note, build, ...(mustHave ? { mustHave } : {}) });
const M = (id: string, category: string, catches: string[], note: string, build: () => BundleBuilt): BundleCase => ({ id, label: 'malicious', category, note, catches, build });

const benign: BundleCase[] = [
  B('b01-single-skill', 'real', 'a bundle of one skill', () => mk([a()])),
  B('b02-template-skill-agent', 'real', 'a template, a skill and an agent with a complete dependency closure, installed skill first', () => {
    const s = member('acme/s'), t = member('acme/t', { type: 'template' }), ag = member('acme/ag', { type: 'agent', dependencies: dep('acme/s') });
    return mk([s, t, ag]);
  }),
  B('b03-dependency-chain', 'real', 'c depends on b depends on a, listed and ordered a, b, c', () => {
    const x = a(), y = member('acme/b', { dependencies: dep('acme/a') }), z = member('acme/c', { dependencies: dep('acme/b') });
    return mk([x, y, z]);
  }),
  B('b04-pinned-not-ranged', 'real', 'the same bundle built twice with exact pins (a member re-published at a newer version is not picked up)', () => mk([member('acme/a', { version: '1.4.2' }), b()])),
  B('b05-team-bundle', 'real', 'a team bundle (teamScope team t1) with a public and a t1 member', () => {
    const x = a(), y = member('acme/team-only', { visibility: 'team', teamId: 't1' });
    return mk([x, y], { b: bundleOf([x, y], { teamScope: { kind: 'team', teamId: 't1' } }), ctx: TEAM('t1') });
  }),
  B('b06-org-bundle', 'real', 'an org bundle with a public and an org member', () => mk([a(), member('acme/o', { visibility: 'org' })], { ctx: ORG })),
  B('b07-warnings-member', 'real', 'a member whose scan verdict is warnings (still installable)', () => mk([member('acme/w', { scanVerdict: 'warnings' })])),
  B('b08-elevated-member-manual-review', 'real', 'a member declares exec.script and the bundle declares the union: accepted, but routed to manual review as executable', () => {
    const x = member('acme/x', { permissions: [EXEC], riskTier: 'executable' });
    return mk([a(), x], { pkg: { permissions: [EXEC] } });
  }, 'manual-review-required'),
  B('b09-private-with-private', 'real', 'a private bundle that contains a private member of its author', () => mk([member('u-me/mine', { visibility: 'private' }), a()], { ctx: PRIV })),
  B('b10-readme-and-notes', 'real', 'a README.md and a notes field describing the bundle', () => mk([a()], { b: { ...bundleOf([a()]), notes: 'Starter pack for due diligence work.' }, pkg: { extra: { 'README.md': enc('# Starter pack\n\nTwo skills.') } } })),
  B('b11-over-declared-permission', 'real', 'the bundle declares a permission no member uses: a note, not a failure', () => mk([a()], { pkg: { permissions: [NET] } })),
];

const items = (n: number) => Array.from({ length: n }, (_, i) => member(`acme/m${i}`));
const malicious: BundleCase[] = [
  M('m01-swapped-hash', 'supply-chain', ['items-pinned'], 'a member pinned with a sha256 that is not the published artifact (swapped content)', () => { const x = a(); const bd = bundleOf([x]); bd.items[0].sha256 = H('evil'); return mk([x], { b: bd }); }),
  M('m02-range-instead-of-pin', 'supply-chain', ['bundle-parse'], 'a version range "^1.0.0" instead of an exact pin (a later malicious release would be picked up)', () => { const x = a(); const bd = bundleOf([x]); (bd.items[0] as any).version = '^1.0.0'; return mk([x], { b: bd }); }),
  M('m03-nested-bundle', 'supply-chain', ['items-types'], 'a bundle inside a bundle (unbounded closure)', () => { const x = a(); const bd = bundleOf([x]); bd.items.push({ id: 'acme/inner', type: 'bundle', version: '1.0.0', sha256: H('i') }); bd.installOrder.push('acme/inner'); return mk([x], { b: bd }); }),
  M('m04-private-in-public', 'dependency', ['visibility-no-escalation'], 'a public bundle that contains a private skill', () => mk([a(), member('acme/priv', { visibility: 'private' })])),
  M('m05-other-team-member', 'dependency', ['visibility-no-escalation'], 'a team-t1 bundle that contains a skill of team t2', () => { const y = member('acme/other', { visibility: 'team', teamId: 't2' }); return mk([y], { b: bundleOf([y], { teamScope: { kind: 'team', teamId: 't1' } }), ctx: TEAM('t1') }); }),
  M('m06-revoked-member', 'supply-chain', ['items-pinned'], 'a member whose version is revoked', () => mk([a(), member('acme/rev', { state: 'revoked' })])),
  M('m07-not-visible-member', 'dependency', ['items-pinned'], 'a member the publisher cannot see (row-level security)', () => mk([a(), b()], { hidden: ['acme/b'] })),
  M('m08-unknown-member', 'dependency', ['items-pinned'], 'a member id that does not exist', () => { const bd = bundleOf([a(), b()]); return { pkg: pkgOf(bd), members: [a()], ctx: PUB }; }),
  M('m09-missing-transitive-dep', 'dependency', ['closure-complete'], 'a member needs acme/ghost which the bundle does not include', () => mk([member('acme/a', { dependencies: dep('acme/ghost') })])),
  M('m10-dep-at-unsatisfying-pin', 'dependency', ['closure-complete'], 'a member needs ^2.0.0 of a dependency the bundle pins at 1.0.0', () => mk([a(), member('acme/b', { dependencies: [{ id: 'acme/a', range: '^2.0.0' }] })])),
  M('m11-disjoint-compat', 'dependency', ['compat-consistent'], 'members whose app compatibility ranges cannot both be satisfied', () => mk([member('acme/a', { compatApp: '^1.0.0' }), member('acme/b', { compatApp: '^3.0.0' })])),
  M('m12-install-order-violation', 'dependency', ['install-order-valid'], 'installOrder puts a dependent before the member it needs', () => {
    const x = a(), y = member('acme/b', { dependencies: dep('acme/a') });
    return mk([x, y], { b: bundleOf([x, y], { installOrder: ['acme/b', 'acme/a'] }) });
  }),
  M('m13-under-declared-union', 'escalation', ['permissions-union'], 'a member declares network but the bundle declares no permissions', () => mk([a(), member('acme/n', { permissions: [NET] })])),
  M('m14-wildcard-scope', 'escalation', ['permissions-union'], 'the bundle declares a network permission with scope "*"', () => mk([member('acme/n', { permissions: [{ ...NET, scope: '*' }] })], { pkg: { permissions: [{ ...NET, scope: '*' }] } })),
  M('m15-env-file', 'secrets', ['bundle-files-allowlist'], 'a .env file inside the bundle', () => mk([a()], { pkg: { extra: { '.env': enc('TOKEN=abc') } } })),
  M('m16-memory-file', 'secrets', ['bundle-files-allowlist'], 'a memory.md file (a user memory) inside the bundle', () => mk([a()], { pkg: { extra: { 'memory.md': enc('# memory\nuser prefers x') } } })),
  M('m17-document-file', 'secrets', ['bundle-files-allowlist'], 'a notes.docx document inside the bundle', () => mk([a()], { pkg: { extra: { 'notes.docx': enc('PK') } } })),
  M('m18-credentials-file', 'secrets', ['bundle-files-allowlist'], 'a credentials.json inside the bundle', () => mk([a()], { pkg: { extra: { 'credentials.json': enc('{"token":"x"}') } } })),
  M('m19-secret-in-notes', 'secrets', ['no-secrets', 'bundle-parse'], 'a GitHub token in bundle.json notes', () => mk([a()], { b: { ...bundleOf([a()]), notes: 'use ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 to fetch' } })),
  M('m20-two-hundred-members', 'dos', ['bundle-parse'], 'a 200-member bundle (the cap is 50)', () => mk(items(200))),
  M('m21-confusable-ids', 'supply-chain', ['bundle-parse'], 'two members acme/pdf-tool and acme/pdftool: a look-alike pair', () => mk([member('acme/pdf-tool'), member('acme/pdftool')])),
  M('m22-contains-itself', 'cycle', ['items-types'], 'the bundle lists its own id as a member', () => { const bd = bundleOf([a()]); bd.items.push({ id: 'acme/starter-pack', type: 'skill', version: '1.0.0', sha256: H('s') }); bd.installOrder.push('acme/starter-pack'); return mk([a()], { b: bd }); }),
  M('m23-duplicate-member', 'supply-chain', ['bundle-parse'], 'the same member twice (the second pin could differ)', () => { const bd = bundleOf([a()]); bd.items.push({ ...bd.items[0] }); return mk([a()], { b: bd }); }),
  M('m24-proto-key', 'config-smuggling', ['bundle-parse'], 'a __proto__ key in bundle.json', () => mk([a()], { raw: `{"schema":"agentic.bundle/1","__proto__":{"x":1},"items":${JSON.stringify(bundleOf([a()]).items)},"installOrder":["acme/a"],"teamScope":{"kind":"none"}}` })),
  M('m25-depth-1000', 'dos', ['bundle-parse'], 'JSON nested 1000 deep', () => mk([a()], { raw: '{"a":'.repeat(1000) + '1' + '}'.repeat(1000) })),
  M('m26-credentials-key', 'secrets', ['bundle-parse'], 'a "credentials" object next to the items (a bundle carries references, never credentials)', () => mk([a()], { b: { ...bundleOf([a()]), credentials: { token: 'x' } } })),
  M('m27-memories-and-documents-keys', 'secrets', ['bundle-parse'], '"memories" and "documents" arrays in bundle.json', () => mk([a()], { b: { ...bundleOf([a()]), memories: ['likes x'], documents: ['contract.docx'] } })),
  M('m28-team-scope-mismatch', 'dependency', ['team-scope-valid'], 'teamScope names team t1 but the bundle is published to the public', () => { const x = a(); return mk([x], { b: bundleOf([x], { teamScope: { kind: 'team', teamId: 't1' } }), ctx: PUB }); }),
  M('m29-unsupported-member-type', 'supply-chain', ['members-supported'], 'a member of a type that cannot be installed yet (surface)', () => mk([a(), member('acme/s', { type: 'surface' })])),
  M('m30-manifest-deps-mismatch', 'supply-chain', ['deps-match-manifest'], 'manifest.dependencies lists an extra package that is not an item', () => mk([a()], { pkg: { deps: [{ id: 'acme/a', range: '=1.0.0' }, { id: 'evil/extra', range: '^1.0.0' }] } })),
  M('m31-member-wrong-type', 'supply-chain', ['items-pinned'], 'the bundle says acme/a is an agent but the catalog row is a skill', () => { const x = a(); const bd = bundleOf([x]); bd.items[0].type = 'agent'; return mk([x], { b: bd }); }),
  M('m32-unpublished-member', 'supply-chain', ['items-pinned'], 'a member that is only in review (not published)', () => mk([a(), member('acme/q', { state: 'in_review' as any })])),
  M('m33-dependency-cycle', 'cycle', ['closure-complete'], 'two members that depend on each other', () => mk([member('acme/a', { dependencies: dep('acme/b') }), member('acme/b', { dependencies: dep('acme/a') })])),
  M('m34-secret-in-manifest-payload', 'secrets', ['no-secrets-manifest-payload'], 'a credential in the manifest payload of the bundle', () => mk([a()], { pkg: { payload: { note: 'AKIAIOSFODNN7EXAMPLE' } } })),
  M('m35-duplicate-key', 'config-smuggling', ['bundle-parse'], 'the "items" key twice (the last one wins in JSON.parse, the first in other parsers); the manifest and catalog are consistent with the last', () => {
    const good = JSON.stringify(bundleOf([a()]).items), evil = member('acme/evil');
    return mk([evil], { raw: `{"schema":"agentic.bundle/1","items":${good},"items":${JSON.stringify(bundleOf([evil]).items)},"installOrder":["acme/evil"],"teamScope":{"kind":"none"}}`, pkg: { deps: [{ id: 'acme/evil', range: '=1.0.0' }] } });
  }),
];

export const cases: BundleCase[] = [...benign, ...malicious];
