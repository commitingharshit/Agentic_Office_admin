import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateArtifact } from '../src/marketplace/validate/index.ts';
import { devLoopbackAllowed } from '../src/marketplace/validate/bridge.ts';
import { BENIGN_PAYLOAD, HOSTILE, bridgePackage, withDevUrl } from '../evals/corpora/bridge.ts';

const failedNames = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('bridge validator', () => {
  test('a benign read-only bridge passes every check and reports a high risk tier', async () => {
    const r = await validateArtifact('bridge', bridgePackage());
    assert.deepEqual(failedNames(r), []);
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    assert.equal(r.riskTier, 'executable'); // the policy floor for bridges; the payload claims declarative
    assert.ok(r.checks.find((c) => c.name === 'host-in-network-scope')?.ok);
  });

  test('a benign bridge without auth needs no secrets.use, and with write tools needs tool.invoke', async () => {
    const p = BENIGN_PAYLOAD(); delete p.auth;
    const net = bridgePackage().manifest.permissions[0];
    assert.equal((await validateArtifact('bridge', bridgePackage({ payload: p, permissions: [net] }))).ok, true);
    const p2 = BENIGN_PAYLOAD(); delete p2.auth; (p2.tools as any[]).push({ name: 'create_issue', capability: 'write' });
    assert.equal((await validateArtifact('bridge', bridgePackage({ payload: p2, permissions: [net] }))).ok, false);
    const r = await validateArtifact('bridge', bridgePackage({ payload: p2, permissions: [net, { capability: 'tool.invoke', scope: 'create_issue', reason: 'creates issues' }] }));
    assert.deepEqual(failedNames(r), []);
    assert.match(r.checks.find((c) => c.name === 'excessive-scope')?.detail ?? '', /high risk/);
  });

  for (const c of HOSTILE) {
    test(`rejects: ${c.name}`, async () => {
      const r = await validateArtifact('bridge', c.build());
      assert.equal(r.ok, false, `${c.name} was accepted`);
      assert.equal(r.verified, false);
      assert.ok(failedNames(r).includes(c.fails), `${c.name}: expected ${c.fails} to fail, failed: ${failedNames(r).join(',')}`);
    });
  }

  test('a failing report never echoes a secret value', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const r = await validateArtifact('bridge', bridgePackage({ payload: { ...BENIGN_PAYLOAD(), extra: secret } }));
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes(secret));
  });

  describe('loopback is a dev-only flag, never a production path', () => {
    const url = 'https://127.0.0.1:8443/mcp';
    const pkg = () => withDevUrl(url);
    test('rejected without the flag', async () => {
      const saved = process.env.AGENTICOFFICE_DEV_MODE; delete process.env.AGENTICOFFICE_DEV_MODE;
      try { assert.ok(failedNames(await validateArtifact('bridge', pkg())).includes('url-public-https')); } finally { if (saved !== undefined) process.env.AGENTICOFFICE_DEV_MODE = saved; }
    });
    test('accepted with AGENTICOFFICE_DEV_MODE=1, but not with NODE_ENV=production', async () => {
      const saved = { d: process.env.AGENTICOFFICE_DEV_MODE, n: process.env.NODE_ENV };
      try {
        process.env.AGENTICOFFICE_DEV_MODE = '1'; delete process.env.NODE_ENV;
        assert.equal(devLoopbackAllowed(), true);
        const r = await validateArtifact('bridge', pkg());
        assert.deepEqual(failedNames(r), []);
        process.env.NODE_ENV = 'production';
        assert.equal(devLoopbackAllowed(), false);
        assert.ok(failedNames(await validateArtifact('bridge', pkg())).includes('url-public-https'));
      } finally {
        if (saved.d === undefined) delete process.env.AGENTICOFFICE_DEV_MODE; else process.env.AGENTICOFFICE_DEV_MODE = saved.d;
        if (saved.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.n;
      }
    });
    test('dev mode still rejects private non-loopback hosts and userinfo', async () => {
      const saved = process.env.AGENTICOFFICE_DEV_MODE; process.env.AGENTICOFFICE_DEV_MODE = '1';
      try {
        for (const u of ['https://10.0.0.5:8443/mcp', 'https://127.0.0.1.evil.com:8443/mcp', 'https://user@127.0.0.1:8443/mcp', 'https://localhost:80/mcp', 'https://169.254.169.254/x']) {
          assert.ok(failedNames(await validateArtifact('bridge', withDevUrl(u))).includes('url-public-https'), u);
        }
      } finally { if (saved === undefined) delete process.env.AGENTICOFFICE_DEV_MODE; else process.env.AGENTICOFFICE_DEV_MODE = saved; }
    });
  });
});
