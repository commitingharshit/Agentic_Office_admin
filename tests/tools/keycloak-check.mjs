// A real browser against a real Keycloak: the desktop app's sign-in (authorization code + PKCE S256 to a loopback address), a new
// account made on Keycloak's own page, the ID token's claims, and the admin-data client (service account) reading users and events.
// Usage: KC=http://127.0.0.1:8180 KC_API_SECRET=... node scripts/dev/keycloak-check.mjs   (open a tunnel to the host first)
// It creates one throwaway person and deletes them at the end.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { JwksVerifier } from '../../services/accounts-sync/src/auth/jwks.ts';
import { KeycloakAdmin } from '../../services/accounts-sync/src/api/keycloak-admin.ts';
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? new URL('../../apps/editors/docx/', import.meta.url).pathname);
const { chromium } = require('@playwright/test');
const KC = process.env.KC ?? 'http://127.0.0.1:8180', REALM = 'agentic-office', SECRET = process.env.KC_API_SECRET;
// Keycloak's administration is not public: when KC is the public address, reach the admin side through a tunnel to the host's private port (KC_ADMIN).
const KCA = process.env.KC_ADMIN ?? KC;
const results = []; const check = (n, ok, d = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', n, d); };
const b64u = (b) => Buffer.from(b).toString('base64url');
const stamp = Date.now().toString(36), email = `kc.check.${stamp}@example.test`, password = `Check-${randomBytes(6).toString('hex')}!x`;

// the app's loopback listener
let got, got2; const gotCode = new Promise((r) => { got = r; });
const srv = createServer((req, res) => { const u = new URL(req.url, 'http://127.0.0.1'); if (u.pathname === '/callback') { res.end('You can close this window.'); got(u); } else res.writeHead(404).end(); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port, redirect = `http://127.0.0.1:${port}/callback`;
const verifier = b64u(randomBytes(32)), challenge = b64u(createHash('sha256').update(verifier).digest()), state = b64u(randomBytes(16)), nonce = b64u(randomBytes(16));
const auth = new URL(`${KC}/realms/${REALM}/protocol/openid-connect/auth`);
auth.search = new URLSearchParams({ response_type: 'code', client_id: 'agentic-office-desktop', redirect_uri: redirect, scope: 'openid profile email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' });

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell` });
const page = await (await browser.newContext()).newPage();
await page.goto(auth.toString());
check('the sign-in page offers Google', (await page.locator('#social-google, a:has-text("Google")').count()) > 0);
await page.click('a:has-text("Create account"), a:has-text("Register")');
await page.fill('input[name=email]', email); await page.fill('input[name=firstName]', 'Check'); await page.fill('input[name=lastName]', 'Person');
await page.fill('input[name=password]', 'short'); await page.fill('input[name=password-confirm]', 'short'); await page.click('input[type=submit], button[type=submit]');
check('a short password is refused by the realm policy', (await page.locator('body').innerText()).toLowerCase().includes('invalid password'));
await page.fill('input[name=password]', password); await page.fill('input[name=password-confirm]', password); await page.click('input[type=submit], button[type=submit]');
const cb = await Promise.race([gotCode, new Promise((_, rej) => setTimeout(() => rej(new Error('no redirect to the loopback address')), 20000))]).catch((e) => { check('redirected back to the loopback address on a random port', false, e.message); return null; });
if (cb) {
  check('redirected back to the loopback address on a random port', true, `port ${port}`);
  check('state returned unchanged', cb.searchParams.get('state') === state);
  const tr = await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code'), redirect_uri: redirect, client_id: 'agentic-office-desktop', code_verifier: verifier }) });
  const tok = await tr.json();
  check('the code redeems with the PKCE verifier', tr.ok && !!tok.id_token, tr.ok ? '' : JSON.stringify(tok));
  if (tok.id_token) {
    const c = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
    check('ID token: issuer, audience, nonce and email are right', c.iss === `${KC}/realms/${REALM}` && (c.aud === 'agentic-office-desktop' || c.aud?.includes?.('agentic-office-desktop')) && c.nonce === nonce && c.email === email, JSON.stringify({ iss: c.iss, aud: c.aud, email_verified: c.email_verified }));
    // the live API: the same token, swapped for a device token exactly as the desktop app does it
    if (process.env.API) {
      const xr = await fetch(`${process.env.API}/v1/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: tok.id_token, nonce, device_name: 'keycloak-check', platform: 'darwin' }) });
      const xb = await xr.json().catch(() => ({}));
      check('the live API swaps the real Keycloak token for a device token', xr.status === 200 && String(xb.token).startsWith('aod_') && /^usr_/.test(xb.user?.id), `${xr.status} ${xb.error ?? ''}`);
      if (xr.status === 200) {
        const me = await fetch(`${process.env.API}/v1/credits/balance`, { headers: { authorization: `Bearer ${xb.token}` } });
        check('and that device token works', me.status === 200);
        check('the sign-in answer carries the plan and what it costs', xb.entitlements?.plan?.id === 'free' && xb.entitlements.plan.price_cents === 0, JSON.stringify(xb.entitlements?.plan));
        // the plan and role were handed to Keycloak (best effort, a moment later) and come back as claims on the NEXT token
        if (SECRET) {
          await new Promise((r) => setTimeout(r, 1500));
          const adm = await (await fetch(`${KCA}/realms/${REALM}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'ao-api', client_secret: SECRET }) })).json();
          const kcu = await (await fetch(`${KCA}/admin/realms/${REALM}/users/${c.sub}`, { headers: { authorization: `Bearer ${adm.access_token}` } })).json();
          check('Keycloak now holds the plan and role as attributes', kcu.attributes?.ao_plan?.[0] === 'free' && kcu.attributes?.ao_role?.[0] === 'user', JSON.stringify(kcu.attributes));
          // a second sign-in (the browser already has a Keycloak session, so no password) returns a token that carries them
          const v2 = randomBytes(32).toString('base64url'), ch2 = b64u(createHash('sha256').update(v2).digest()), n2 = b64u(randomBytes(16));
          const a2 = new URL(`${KC}/realms/${REALM}/protocol/openid-connect/auth`);
          a2.search = new URLSearchParams({ response_type: 'code', client_id: 'agentic-office-desktop', redirect_uri: redirect, scope: 'openid profile email', state: 's2', nonce: n2, code_challenge: ch2, code_challenge_method: 'S256' });
          got2 = new Promise((r) => { got = r; });
          await page.goto(a2.toString());
          const cb2 = await Promise.race([got2, new Promise((r) => setTimeout(() => r(null), 15000))]);
          if (cb2) {
            const t2 = await (await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: cb2.searchParams.get('code'), redirect_uri: redirect, client_id: 'agentic-office-desktop', code_verifier: v2 }) })).json();
            const c2 = JSON.parse(Buffer.from(t2.id_token.split('.')[1], 'base64url').toString());
            check('the next token carries the plan and role as claims', c2.ao_plan === 'free' && c2.ao_role === 'user', JSON.stringify({ ao_plan: c2.ao_plan, ao_role: c2.ao_role }));
          } else check('the next token carries the plan and role as claims', false, 'no second code');
        }
                await fetch(`${process.env.API}/v1/auth/signout`, { method: 'POST', headers: { authorization: `Bearer ${xb.token}` } });
        check('signed out: the device token stops working', (await fetch(`${process.env.API}/v1/credits/balance`, { headers: { authorization: `Bearer ${xb.token}` } })).status === 401);
        if (process.env.ADMIN_TOKEN) {
          const d = await fetch(`${process.env.API}/admin/users/${xb.user.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'content-type': 'application/json', 'x-ao-acting-admin': process.env.ACTING_ADMIN ?? '' }, body: JSON.stringify({ confirm: xb.user.email }) });
          check('the throwaway account is removed from our database', d.ok, String(d.status));
        }
      }
    }
    // our own verifier (the one the API runs) against the REAL token and key set
    const ver = (aud) => new JwksVerifier({ issuer: `${KC}/realms/${REALM}`, audience: aud, jwksUrl: `${KC}/realms/${REALM}/protocol/openid-connect/certs`, algs: ['RS256'] });
    check('our verifier accepts the real token (signature, issuer, audience)', (await ver(['agentic-office-desktop']).verify(tok.id_token).then((x) => x.sub === c.sub, () => false)));
    check('and refuses it for another audience', await ver(['ao-admin-console']).verify(tok.id_token).then(() => false, () => true));
    check('ID token has a stable subject', typeof c.sub === 'string' && c.sub.length > 10);
    // a second redemption of the same code is refused
    const again = await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code'), redirect_uri: redirect, client_id: 'agentic-office-desktop', code_verifier: verifier }) });
    check('a used code cannot be redeemed twice', !again.ok);
    // without the verifier, nothing
    check('the public client has no password grant', !(await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'agentic-office-desktop', username: email, password }) })).ok);
    // the admin-data client
    if (SECRET) {
      const st = await (await fetch(`${KCA}/realms/${REALM}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'ao-api', client_secret: SECRET }) })).json();
      check('the admin-data client gets a token', !!st.access_token);
      const H = { authorization: `Bearer ${st.access_token}` };
      const users = await (await fetch(`${KCA}/admin/realms/${REALM}/users?email=${encodeURIComponent(email)}&exact=true`, { headers: H })).json();
      check('it can find the new person by email', users.length === 1 && users[0].id === c.sub);
      const ev = await (await fetch(`${KCA}/admin/realms/${REALM}/events?user=${c.sub}&max=20`, { headers: H })).json();
      check('it can read that person\'s login events', Array.isArray(ev) && ev.some((e) => /LOGIN|REGISTER/.test(e.type)), ev.map((e) => e.type).join(','));
      const sess = await fetch(`${KCA}/admin/realms/${REALM}/users/${c.sub}/sessions`, { headers: H });
      check('it can list their sessions', sess.ok);
      check('it cannot touch the master realm', (await fetch(`${KCA}/admin/realms/master/users`, { headers: H })).status === 403);
      // our own admin client against the real Keycloak
      const kca = new KeycloakAdmin({ baseUrl: KCA, realm: REALM, clientId: 'ao-api', clientSecret: SECRET });
      const info = await kca.user(c.sub);
      check('KeycloakAdmin reads the person', info.enabled === true && info.emailVerified === false && info.totp === false, JSON.stringify(info));
      const ss = await kca.sessions(c.sub);
      check('KeycloakAdmin lists their live session', ss.length >= 1 && ss.every((x) => typeof x.id === 'string'));
      check('KeycloakAdmin reads their login events', (await kca.events(c.sub)).some((e) => e.type === 'LOGIN'));
      await kca.setEnabled(c.sub, false);
      check('KeycloakAdmin can disable them', (await kca.user(c.sub)).enabled === false);
      check('a disabled person cannot get a new token', !(await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'agentic-office-desktop', refresh_token: tok.refresh_token ?? 'none' }) })).ok);
      await kca.setEnabled(c.sub, true);
      await kca.logout(c.sub);
      check('KeycloakAdmin can end their sessions', (await kca.sessions(c.sub)).length === 0);
      const del = await fetch(`${KCA}/admin/realms/${REALM}/users/${c.sub}`, { method: 'DELETE', headers: H });
      check('the throwaway person is deleted', del.status === 204);
    }
  }
}
srv.close(); await browser.close();
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED'); process.exit(results.every(Boolean) ? 0 : 1);
