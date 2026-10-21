// The media worker with real ffmpeg on generated input: what the app is allowed to play, and what is refused.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import { processMedia, runOnce, type Storage } from '../src/growth/media-worker.ts';

const run = promisify(execFile);
const tools = { ffmpeg: process.env.FFMPEG ?? 'ffmpeg', ffprobe: process.env.FFPROBE ?? 'ffprobe' };
let hasFfmpeg = true;
try { execFileSync(tools.ffmpeg, ['-version'], { stdio: 'ignore' }); } catch { hasFfmpeg = false; }
const skip = !hasFfmpeg && 'ffmpeg not installed';
const ownerUrl = process.env.AO_TEST_PG;
const dbSkip = skip || (!ownerUrl && 'AO_TEST_PG not set');
const tag = Date.now().toString(36);

let dir: string, clip15: Buffer, clip70: Buffer, image: Buffer;
before(async () => {
  if (skip) return;
  dir = await mkdtemp(join(tmpdir(), 'ao-media-test-'));
  const make = async (name: string, args: string[]) => { await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, join(dir, name)]); return readFile(join(dir, name)); };
  clip15 = await make('c15.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '15', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest']);
  clip70 = await make('c70.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=5', '-t', '70', '-c:v', 'libx264', '-preset', 'ultrafast']);
  image = await make('i.png', ['-f', 'lavfi', '-i', 'testsrc=size=1600x900', '-frames:v', '1']);
});
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const memory = (seed: Record<string, Buffer>): Storage & { files: Map<string, Buffer> } => {
  const files = new Map(Object.entries(seed));
  return { files, get: async (k) => { const v = files.get(k); if (!v) throw new Error('missing'); return v; }, put: async (k, d) => { files.set(k, d); } };
};
async function probeBuf(b: Buffer, ext: string) {
  const f = join(dir, `probe-${Math.random().toString(36).slice(2)}.${ext}`);
  await (await import('node:fs/promises')).writeFile(f, b);
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]);
  return JSON.parse(stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; width: number }> };
}

test('a clip becomes muted MP4s at 480 and 960 px, a WebM and a poster, trimmed to 12 s', { skip }, async () => {
  const store = memory({ src: clip15 });
  const out = await processMedia(tools, store, { creativeId: 'crv_t', sourceKey: 'src', kind: 'clip', maxBytes: 4_000_000 });
  assert.deepEqual(out.map((v) => `${v.role}:${v.width}`).sort(), ['mp4:480', 'mp4:960', 'poster:960', 'webm:480']);
  for (const v of out.filter((x) => x.role === 'mp4' || x.role === 'webm')) {
    const p = await probeBuf(store.files.get(v.key)!, v.role);
    assert.ok(Number(p.format.duration) <= 12.1, `${v.role} is ${p.format.duration}s`);
    assert.equal(p.streams.some((s) => s.codec_type === 'audio'), false, 'no sound');
    assert.ok(v.bytes <= 4_000_000 && /^[0-9a-f]{64}$/.test(v.sha256));
  }
});

test('an image becomes WebP at 960 and 320 px and is never enlarged', { skip }, async () => {
  const out = await processMedia(tools, memory({ src: image }), { creativeId: 'crv_i', sourceKey: 'src', kind: 'image', maxBytes: 1_000_000 });
  assert.deepEqual(out.map((v) => `${v.role}:${v.width}:${v.mime}`), ['image:960:image/webp', 'thumb:320:image/webp']);
  const small = await processMedia(tools, memory({ src: await readFile(join(dir, 'i.png')).then(() => image) }), { creativeId: 'crv_i2', sourceKey: 'src', kind: 'image', maxBytes: 1_000_000 });
  assert.ok(small.every((v) => v.width <= 960));
});

test('too long, not media, or too large for the placement is refused with a reason', { skip }, async () => {
  await assert.rejects(processMedia(tools, memory({ src: clip70 }), { creativeId: 'x', sourceKey: 'src', kind: 'clip', maxBytes: 4_000_000 }), /0-60 s/);
  await assert.rejects(processMedia(tools, memory({ src: Buffer.from('not a video at all') }), { creativeId: 'x', sourceKey: 'src', kind: 'clip', maxBytes: 4_000_000 }), /not a readable/);
  await assert.rejects(processMedia(tools, memory({ src: clip15 }), { creativeId: 'x', sourceKey: 'src', kind: 'clip', maxBytes: 1_000 }), /larger than the placement allows/);
});

test('a queued job is claimed once, its variants recorded, and the creative goes back to draft; a bad file marks it rejected', { skip: dbSkip }, async () => {
  const owner = new pg.Client({ connectionString: ownerUrl }); await owner.connect();
  const u = new URL(ownerUrl!); u.username = 'ao_admin'; u.password = process.env.AO_ADMIN_PASSWORD ?? '';
  const admin = new pg.Pool({ connectionString: u.toString() });
  const camp = `c_media_${tag}`;
  try {
    await owner.query(`INSERT INTO campaigns(id, name) VALUES ($1, 'media test')`, [camp]);
    await owner.query(`INSERT INTO creatives(id, campaign_id, placement_id, kind, headline, status) VALUES ($1,$2,'chat_empty','clip','x','processing'), ($3,$2,'inbox','image','y','processing')`, [`cr_ok_${tag}`, camp, `cr_bad_${tag}`]);
    await owner.query(`INSERT INTO media_jobs(creative_id, source_key, kind) VALUES ($1,'k-ok','clip'), ($2,'k-bad','image')`, [`cr_ok_${tag}`, `cr_bad_${tag}`]);
    const store = memory({ 'k-ok': clip15, 'k-bad': Buffer.from('nope') });
    // other test files' jobs never exist here (only this test queues jobs), so two runs process exactly these two
    assert.equal(await runOnce(admin, tools, store), true);
    assert.equal(await runOnce(admin, tools, store), true);
    const ok = (await owner.query(`SELECT status, error FROM creatives WHERE id = $1`, [`cr_ok_${tag}`])).rows[0];
    assert.deepEqual(ok, { status: 'draft', error: null });
    const roles = (await owner.query(`SELECT role FROM creative_media WHERE creative_id = $1 ORDER BY role, width`, [`cr_ok_${tag}`])).rows.map((r) => r.role);
    assert.deepEqual(roles, ['mp4', 'mp4', 'poster', 'webm']);
    const bad = (await owner.query(`SELECT status, error FROM creatives WHERE id = $1`, [`cr_bad_${tag}`])).rows[0];
    assert.equal(bad.status, 'rejected'); assert.match(bad.error, /^media: /);
    assert.deepEqual((await owner.query(`SELECT status FROM media_jobs WHERE creative_id = ANY($1) ORDER BY id`, [[`cr_ok_${tag}`, `cr_bad_${tag}`]])).rows.map((r) => r.status), ['done', 'failed']);
  } finally {
    await owner.query(`DELETE FROM campaigns WHERE id = $1`, [camp]);
    await admin.end(); await owner.end();
  }
});
