// Cross-origin rules for the sync API: exact origins only, /v1 only, no wildcard, no credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { cors, parseOrigins } from '../src/api/cors.ts';

const start = async (raw?: string) => {
  const allow = cors(parseOrigins(raw));
  const s = createServer((req, res) => { if (allow(req, res)) return; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
};

test('by default any origin may call /v1 with a bearer token, never with credentials, and never the admin API', async () => {
  const { s, base } = await start();
  try {
    const pre = await fetch(`${base}/v1/me`, { method: 'OPTIONS', headers: { origin: 'https://anything.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), '*'); assert.equal(pre.headers.get('access-control-allow-credentials'), null);
    assert.equal((await fetch(`${base}/v1/me`, { headers: { origin: 'null' } })).headers.get('access-control-allow-origin'), '*');
    assert.equal((await fetch(`${base}/admin/users`, { headers: { origin: 'https://anything.example' } })).headers.get('access-control-allow-origin'), null);
  } finally { s.close(); }
});

test('a listed origin is the only one answered when the list is set', async () => {
  const { s, base } = await start('https://app.example.com/, https://evil.example.com/path , not-an-origin, https://*.example.org');
  try {
    const pre = await fetch(`${base}/v1/me`, { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' } });
    assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), 'https://app.example.com');
    assert.match(pre.headers.get('access-control-allow-headers')!, /authorization/); assert.equal(pre.headers.get('access-control-allow-credentials'), null);
    assert.equal((await fetch(`${base}/v1/me`, { headers: { origin: 'https://app.example.com' } })).headers.get('access-control-allow-origin'), 'https://app.example.com');
    assert.equal((await fetch(`${base}/v1/me`, { headers: { origin: 'vscode-file://vscode-app' } })).headers.get('access-control-allow-origin'), 'vscode-file://vscode-app', 'the desktop app is always allowed');
    for (const o of ['https://evil.example.com', 'https://app.example.com.evil.test', 'null']) {
      assert.equal((await fetch(`${base}/v1/me`, { headers: { origin: o } })).headers.get('access-control-allow-origin'), null, o);
      assert.equal((await fetch(`${base}/v1/me`, { method: 'OPTIONS', headers: { origin: o } })).status, 403, o);
    }
    assert.equal((await fetch(`${base}/admin/users`, { headers: { origin: 'https://app.example.com' } })).headers.get('access-control-allow-origin'), null, 'the admin API is not opened to browsers');
    assert.equal((await fetch(`${base}/v1/me`)).headers.get('access-control-allow-origin'), null, 'no Origin header, no CORS headers');
  } finally { s.close(); }
});
