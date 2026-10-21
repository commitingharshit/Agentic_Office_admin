import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateArtifact } from '../src/marketplace/validate/index.ts';
import { parseFieldPattern } from '../src/marketplace/validate/connector.ts';
import { BENIGN_PAYLOAD, BENIGN_PERMISSIONS, HOSTILE, ZONE, connectorPackage } from '../evals/corpora/connector.ts';

const failedNames = (r: { checks: { name: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('connector validator', () => {
  test('a benign api_key connector passes every check and reports an elevated tier', async () => {
    const r = await validateArtifact('connector', connectorPackage());
    assert.deepEqual(failedNames(r), []);
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    assert.equal(r.riskTier, 'executable'); // policy floor for connectors
  });

  test('bearer and none connectors with a fixed host pass', async () => {
    const bearer = BENIGN_PAYLOAD(); bearer.auth = { kind: 'bearer' }; bearer.fields = [bearer.fields[1]];
    bearer.bridge.url_template = `https://api.${ZONE}/mcp`; bearer.network_allowlist = [`api.${ZONE}`];
    const perms = [{ capability: 'network' as const, scope: `api.${ZONE}`, reason: 'x' }, BENIGN_PERMISSIONS()[1]];
    assert.deepEqual(failedNames(await validateArtifact('connector', connectorPackage({ payload: bearer, permissions: perms }))), []);
    const none = BENIGN_PAYLOAD(); none.auth = { kind: 'none' }; none.fields = []; delete none.health;
    none.bridge.url_template = `https://api.${ZONE}/mcp`; none.network_allowlist = [`api.${ZONE}`];
    assert.deepEqual(failedNames(await validateArtifact('connector', connectorPackage({ payload: none, permissions: [perms[0]] }))), []);
  });

  test('a template with the placeholder inside a label (prefix + suffix text) passes', async () => {
    const p = BENIGN_PAYLOAD();
    p.fields[0].pattern = '^[a-z0-9]{3,20}$'; delete p.fields[0].example;
    p.bridge.url_template = `https://{workspace_host}.${ZONE}/mcp`;
    assert.deepEqual(failedNames(await validateArtifact('connector', connectorPackage({ payload: p }))), []);
  });

  test('a write tool needs tool.invoke scoped to it', async () => {
    const p = BENIGN_PAYLOAD(); p.bridge.tools.push({ name: 'create_issue', capability: 'write' });
    assert.equal((await validateArtifact('connector', connectorPackage({ payload: p }))).ok, false);
    const r = await validateArtifact('connector', connectorPackage({ payload: p, permissions: [...BENIGN_PERMISSIONS(), { capability: 'tool.invoke', scope: 'create_issue', reason: 'creates issues' }] }));
    assert.deepEqual(failedNames(r), []);
  });

  for (const c of HOSTILE) {
    test(`rejects: ${c.name}`, async () => {
      const r = await validateArtifact('connector', c.build());
      assert.equal(r.ok, false, `${c.name} was accepted`);
      assert.equal(r.verified, false);
      assert.ok(failedNames(r).includes(c.fails), `${c.name}: expected ${c.fails} to fail, failed: ${failedNames(r).join(',')}`);
    });
  }

  test('oauth2 rejection names the reason and the path', async () => {
    const p = BENIGN_PAYLOAD(); p.auth = { kind: 'oauth2' };
    const r = await validateArtifact('connector', connectorPackage({ payload: p }));
    const c = r.checks.find((k) => k.name === 'auth-kind-supported');
    assert.equal(c?.ok, false);
    assert.match(c?.detail ?? '', /no third-party token broker/);
    assert.match(c?.detail ?? '', /Path:/);
  });

  test('a failing report never echoes a secret value', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const p = BENIGN_PAYLOAD(); p.fields[0].default = secret; p.fields[0].pattern = undefined; delete p.fields[0].pattern;
    const r = await validateArtifact('connector', connectorPackage({ payload: p }));
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes(secret));
    const q = BENIGN_PAYLOAD(); q.extra_key_with_secret = secret;
    assert.ok(!JSON.stringify(await validateArtifact('connector', connectorPackage({ payload: q }))).includes(secret));
  });

  describe('the pattern grammar is linear-time safe', () => {
    test('accepts the documented shapes', () => {
      for (const ok of ['^[a-z0-9-]+\\.example\\.com$', '^[a-z0-9]{3,20}$', '^acme-[a-z0-9]{1,10}$', '^[A-Za-z0-9_.-]{1,40}$', '^v[0-9]+$']) assert.equal(parseFieldPattern(ok).ok, true, ok);
    });
    test('rejects groups, alternation, lookarounds, backreferences, dots and nested quantifiers', () => {
      for (const bad of ['^(a|b)$', '^(a+)+$', '^(?:a)$', '^a(?=b)$', '^(a)\\1$', '^.*$', '^.+\\.com$', '^[^a]+$', '^a{1,2}{3}$', '^a++$', '^a+?$', '^\\d+$', '^[a-z]+[a-z]+[a-z]+[a-z]+$', 'abc', '^$', '^a$b']) {
        assert.equal(parseFieldPattern(bad).ok, false, bad);
      }
    });
    test('worst-case matching of every accepted shape on a hostile 100-char value is fast', () => {
      const re = new RegExp('^[a-z]+[a-z]+[a-z]+x$');
      assert.equal(parseFieldPattern('^[a-z]+[a-z]+[a-z]+x$').ok, true);
      const t = Date.now();
      re.test('a'.repeat(100) + '!');
      assert.ok(Date.now() - t < 500, 'three adjacent quantified parts stay cheap on a value capped at 100 characters');
    });
  });

  describe('loopback is a dev-only flag, never a production path', () => {
    const dev = () => {
      const p = BENIGN_PAYLOAD();
      p.bridge.url_template = 'https://127.0.0.1:8443/mcp'; p.fields = [p.fields[1]]; p.network_allowlist = ['127.0.0.1'];
      return connectorPackage({ payload: p, permissions: [{ capability: 'network', scope: '127.0.0.1', reason: 'dev' }, BENIGN_PERMISSIONS()[1]] });
    };
    test('rejected without the flag, accepted with it, rejected under NODE_ENV=production', async () => {
      const saved = { d: process.env.AGENTICOFFICE_DEV_MODE, n: process.env.NODE_ENV };
      try {
        delete process.env.AGENTICOFFICE_DEV_MODE; delete process.env.NODE_ENV;
        const off = failedNames(await validateArtifact('connector', dev()));
        assert.ok(off.includes('url-template-bounded') || off.includes('allowlist-specific'), off.join(','));
        process.env.AGENTICOFFICE_DEV_MODE = '1';
        assert.deepEqual(failedNames(await validateArtifact('connector', dev())), []);
        process.env.NODE_ENV = 'production';
        assert.ok(failedNames(await validateArtifact('connector', dev())).length > 0);
      } finally {
        if (saved.d === undefined) delete process.env.AGENTICOFFICE_DEV_MODE; else process.env.AGENTICOFFICE_DEV_MODE = saved.d;
        if (saved.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.n;
      }
    });
    test('dev mode still rejects private non-loopback hosts', async () => {
      const saved = process.env.AGENTICOFFICE_DEV_MODE; process.env.AGENTICOFFICE_DEV_MODE = '1';
      try {
        const p = BENIGN_PAYLOAD(); p.bridge.url_template = 'https://10.0.0.5:8443/mcp'; p.fields = [p.fields[1]]; p.network_allowlist = ['10.0.0.5'];
        const r = await validateArtifact('connector', connectorPackage({ payload: p, permissions: [{ capability: 'network', scope: '10.0.0.5', reason: 'x' }, BENIGN_PERMISSIONS()[1]] }));
        assert.equal(r.ok, false);
      } finally { if (saved === undefined) delete process.env.AGENTICOFFICE_DEV_MODE; else process.env.AGENTICOFFICE_DEV_MODE = saved; }
    });
  });
});
