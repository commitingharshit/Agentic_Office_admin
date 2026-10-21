// A real (headless) browser against a deployed control plane: sign in, get held at MFA, enrol a TOTP, reach the console, use its forms.
// Usage: node scripts/dev/control-plane-browser-check.mjs <admin-email> <password> <screenshot-dir>
//   The account must already be an admin (promote it with POST /admin/users/<id>/role) and have no authenticator yet. Use a THROWAWAY
//   admin: the check enrols its own TOTP secret, so the account is not usable by a person afterwards. It creates a coupon and a ledger
//   grant on the account it signs in as. Env: WEB (default http://100.95.14.113:8791), PLAYWRIGHT_FROM, CHROMIUM_PATH.
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
// Playwright is resolved from PLAYWRIGHT_FROM (a directory whose node_modules has @playwright/test; default: the docx editor).
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL('../../apps/editors/docx/', import.meta.url).pathname);
const { chromium } = require('@playwright/test');

const WEB = process.env.WEB ?? 'http://100.95.14.113:8791';
const [email, password, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const stamp = Date.now().toString(36).toUpperCase();

function base32decode(s) { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function totp(secret, t = Date.now()) { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(t / 30000))); const h = createHmac('sha1', base32decode(secret)).update(c).digest(); const o = h[19] & 0xf; return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000).padStart(6, '0'); }
// The server's clock decides which code is valid, and the host's is not NTP-synced (it ran ~60 s slow): use its time.
const serverNow = async () => Date.parse((await fetch(`${WEB}/api/health`)).headers.get('date'));
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 820 }, extraHTTPHeaders: {} });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = (n) => page.screenshot({ path: `${outDir}/${n}.png`, fullPage: true });

// 1. the sign-in page, as a person sees it
await page.goto(`${WEB}/sign-in`); await page.waitForSelector('input[name=email]');
await shot('01-sign-in');
check('sign-in page renders with email and password fields', (await page.locator('h1').innerText()).includes('Sign in') && await page.locator('input[name=password]').count() === 1);

// 2. password sign-in, then the console is held at MFA
await page.fill('input[name=email]', email); await page.fill('input[name=password]', password);
await page.click('button:has-text("Sign in")');
await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 15000 });
await page.goto(`${WEB}/admin`);
check('password-only admin is sent to /mfa, not the console', new URL(page.url()).pathname === '/mfa', page.url());
await shot('02-mfa-enrol');

// 3. enrol an authenticator
await page.fill('input[name=password]', password);
await page.click('button:has-text("Set up authenticator")');
await page.waitForSelector('code');
const uri = await page.locator('code').first().innerText();
const secret = new URL(uri).searchParams.get('secret');
check('enrolment shows an authenticator link and recovery codes', !!secret && (await page.locator('pre').innerText()).trim().split('\n').length >= 4);
await shot('03-mfa-enrolled');
await page.fill('input[name=code]', 'abcdef').catch(() => undefined);
await page.fill('input[name=code]', '000000');
await page.click('button:has-text("Verify")');
await page.waitForTimeout(1500);
errors.length = 0;   // the refused wrong code is logged by the browser as a 401: expected, not a script error
check('a wrong code does not open the console', new URL(page.url()).pathname === '/mfa' && await page.locator('[role=alert]').count() > 0);
await page.fill('input[name=code]', totp(secret, await serverNow()));
await Promise.all([page.waitForURL(`${WEB}/admin`, { timeout: 15000 }), page.click('button:has-text("Verify")')]);
check('the right code opens the console', new URL(page.url()).pathname === '/admin');
await page.waitForSelector('text=Overview');
await shot('04-admin-overview');
check('overview shows account numbers', await page.locator('.stat').count() >= 4);

// 4. the console, used the way an admin would
await page.click('nav >> text=Users'); await page.waitForSelector('table');
await shot('05-users');
check('users list shows people', await page.locator('tbody tr').count() >= 1);
await page.fill('input[name=q]', email); await page.click('button:has-text("Search")');
await page.waitForSelector(`a:has-text("${email}")`);
await page.click(`a:has-text("${email}")`); await page.waitForSelector('text=Credits');
await shot('06-user-detail');
const userUrl = page.url();
check('user detail shows access, plan and credits sections', await page.locator('h2:has-text("Access")').count() === 1 && await page.locator('h2:has-text("Credits")').count() === 1);

const code = `BROWSER-${stamp}`;
await page.click('nav >> text=Coupons'); await page.waitForSelector('input[name=code]');
await page.fill('input[name=code]', code); await page.fill('input[name=amount]', '25'); await page.fill('input[name=max_redemptions]', '3'); await page.fill('input[name=note]', 'browser check');
await page.click('button:has-text("Create")');
await page.waitForTimeout(2500);
console.log('DEBUG coupon: url=', page.url(), ' msgs=', await page.locator('.msg').allInnerTexts());
await shot('07a-after-create');
await page.waitForSelector(`code:has-text("${code}")`);
await shot('07-coupons');
check('creating a coupon in the form shows it in the list', await page.locator(`tr:has(code:has-text("${code}"))`).count() === 1 && (await page.locator('.msg.ok').count()) === 1);
await page.click(`tr:has(code:has-text("${code}")) button:has-text("Disable")`);
await page.waitForSelector(`tr:has(code:has-text("${code}")) .pill`);
check('disabling it marks it off', (await page.locator(`tr:has(code:has-text("${code}")) .pill`).innerText()) === 'off');

await page.goto(userUrl); await page.waitForSelector('input[name=amount]');
await page.fill('input[name=amount]', '10'); await page.fill('input[name=reason]', `browser check grant ${stamp}`); await page.click('button:has-text("Record")');
await page.waitForSelector('.msg.ok');
await shot('08-credits-granted');
check('granting credits in the form lands in the ledger', await page.locator(`tr:has-text("browser check grant ${stamp}")`).count() === 1);

await page.click('nav >> text=Audit'); await page.waitForURL(/\/admin\/audit/); await page.waitForSelector('h1:has-text("Audit log")');
await shot('09-audit');
const audit = await page.locator('main table').first().innerText();
check('the audit log names the admin\'s user id and the actions taken', /usr_/.test(audit) && /create_coupon/.test(audit) && /adjust_credits/.test(audit));
check('no script errors in the browser console', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} checks passed; screenshots in ${outDir}`);
process.exit(failed ? 1 : 0);
