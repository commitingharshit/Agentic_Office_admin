// Runs one fork mocha-style (tdd) node test file without the fork's build: resolves the fork's `.js` import suffixes to
// their `.ts` sources, supplies suite/test/setup/teardown globals, then runs the collected tests in order.
// Usage: node --experimental-transform-types scripts/dev/marketplace-zip-differential/desktop-driver.mjs <test.ts>
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const hooks = `
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); }
  catch (e) { if (specifier.endsWith('.js')) { return nextResolve(specifier.slice(0, -3) + '.ts', context); } throw e; }
}`;
register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url);

const tests = [];
let prefix = [];
globalThis.suite = (name, fn) => { prefix.push(name); try { fn(); } finally { prefix.pop(); } };
globalThis.test = (name, fn) => tests.push({ name: [...prefix, name].join(' > '), fn });
globalThis.setup = globalThis.teardown = () => {};

await import(pathToFileURL(process.argv[2]).href);
let failed = 0;
for (const t of tests) {
  try { await t.fn.call({}); console.log(`ok   ${t.name}`); }
  catch (e) { failed++; console.log(`FAIL ${t.name}\n${e && e.stack || e}`); }
}
process.exit(failed ? 1 : 0);
