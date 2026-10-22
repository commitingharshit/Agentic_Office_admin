// The outside-in prober: probes the platform's public addresses (the console, the API gate, Keycloak's gate) and the internal
// services, from its own container, and records the readings in the same tables the API's own checks use. A service the API cannot
// see itself failing (the gateway, the tunnel's public side) is seen here.
//   AO_STATUS_PROBES   JSON [{id,label,url,expect?,timeoutMs?}]  what to probe (default: the API gateway and the sign-in service)
//   PROBER_DATABASE_URL  postgres://ao_admin:...@postgres:5432/agentic_office   (a role that can write service_status)
//   PROBER_INTERVAL_SECONDS  default 30
import pg from 'pg';
import { DEFAULT_PROBES, sweep, targetsFromEnv } from '../api/src/status/probe.ts';

const env = process.env;
const url = env.PROBER_DATABASE_URL;
if (!url) { console.error('PROBER_DATABASE_URL is required'); process.exit(2); }
const targets = targetsFromEnv(env.AO_STATUS_PROBES || DEFAULT_PROBES, (m) => console.warn(m));
if (!targets.length) { console.error('AO_STATUS_PROBES lists nothing to probe'); process.exit(2); }
const pool = new pg.Pool({ connectionString: url, max: 2, application_name: 'ao-prober' });
const every = Math.max(10, Number(env.PROBER_INTERVAL_SECONDS ?? 30)) * 1000;
let busy = false;
const tick = async () => {
  if (busy) return;
  busy = true;
  try { const r = await sweep(pool, targets); console.log(r.map((x) => `${x.id}=${x.state}`).join(' ')); }
  catch (e) { console.error('sweep failed:', (e as Error).message); }
  finally { busy = false; }
};
await tick();
const timer = setInterval(tick, every);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { clearInterval(timer); void pool.end().then(() => process.exit(0)); });
