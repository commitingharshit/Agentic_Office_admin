// The media worker: turns an uploaded promotion image or clip into what the app is allowed to play.
//   clip  -> checked by ffprobe (a video stream, at most 60 s, at most 50 MB), trimmed to 12 s, sound removed, H.264 MP4 at 480 and
//            960 px wide (faststart), VP9 WebM at 480, a JPEG poster; a variant larger than the placement allows is dropped, and the
//            job fails if the smallest one still is
//   image -> WebP at 960 and 320 px wide (never enlarged)
// Jobs are claimed with FOR UPDATE SKIP LOCKED, so several workers never take the same one; a failed job says why on the creative.
// A processed creative goes back to 'draft': an admin still publishes it (src/growth/admin.ts publishCreative).
//   node src/growth/media-worker.ts        (env: PG_HOST/DATABASE_URL as the API, AO_ADMIN_PASSWORD, MINIO_*; FFMPEG, FFPROBE)
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type pg from 'pg';
import { MEDIA_BUCKET } from './engine.ts';

const run = promisify(execFile);
export const LIMITS = { sourceSeconds: 60, sourceBytes: 50_000_000, clipSeconds: 12 };

export interface Storage { get(key: string): Promise<Buffer>; put(key: string, data: Buffer): Promise<void> }
export interface Variant { role: 'mp4' | 'webm' | 'poster' | 'image' | 'thumb'; width: number; height: number; mime: string; durationMs: number; bytes: number; sha256: string; key: string }
export interface Tools { ffmpeg: string; ffprobe: string }

async function probe(tools: Tools, file: string) {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 4_000_000 });
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type: string; width?: number; height?: number; duration?: string }> };
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  return { video: v, audio: (j.streams ?? []).some((s) => s.codec_type === 'audio'), seconds: Number(j.format?.duration ?? v?.duration ?? 0) };
}

/** Make the variants for one source. Pure apart from the files it writes in a private temp folder and the storage it is given. */
export async function processMedia(tools: Tools, store: Storage, o: { creativeId: string; sourceKey: string; kind: 'image' | 'clip'; maxBytes: number }): Promise<Variant[]> {
  const dir = await mkdtemp(join(tmpdir(), 'ao-media-'));
  try {
    const src = join(dir, 'source');
    const bytes = await store.get(o.sourceKey);
    if (bytes.length > LIMITS.sourceBytes) throw new Error(`the source is larger than ${LIMITS.sourceBytes / 1e6} MB`);
    await writeFile(src, bytes);
    const info = await probe(tools, src).catch(() => { throw new Error('the file is not a readable image or video'); });
    if (!info.video) throw new Error('the file has no picture');
    const out: Variant[] = [];
    const keep = async (role: Variant['role'], file: string, mime: string, width: number) => {
      const p = await probe(tools, file);
      const data = await readFile(file);
      const sha256 = createHash('sha256').update(data).digest('hex');
      const key = `media/${o.creativeId}/${role}-${width}-${sha256.slice(0, 16)}`;
      await store.put(key, data);
      out.push({ role, width: p.video?.width ?? width, height: p.video?.height ?? 0, mime, durationMs: Math.round(p.seconds * 1000), bytes: data.length, sha256, key });
    };
    const ff = (args: string[]) => run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 4_000_000, timeout: 180_000 });
    // never enlarge; keep the height even (H.264 needs it)
    const scale = (w: number) => `scale='min(${w},iw)':-2`;
    if (o.kind === 'clip') {
      if (!(info.seconds > 0) || info.seconds > LIMITS.sourceSeconds) throw new Error(`a clip must be 0-${LIMITS.sourceSeconds} s long (this one is ${info.seconds.toFixed(1)} s)`);
      for (const w of [480, 960]) {
        const f = join(dir, `clip-${w}.mp4`);
        await ff(['-i', src, '-t', String(LIMITS.clipSeconds), '-an', '-vf', scale(w), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', f]);
        if ((await stat(f)).size <= o.maxBytes) await keep('mp4', f, 'video/mp4', w);
      }
      const webm = join(dir, 'clip-480.webm');
      await ff(['-i', src, '-t', String(LIMITS.clipSeconds), '-an', '-vf', scale(480), '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', webm]);
      if ((await stat(webm)).size <= o.maxBytes) await keep('webm', webm, 'video/webm', 480);
      if (!out.some((v) => v.role === 'mp4' || v.role === 'webm')) throw new Error(`even the smallest version of the clip is larger than the placement allows (${o.maxBytes / 1e6} MB)`);
      const poster = join(dir, 'poster.jpg');
      await ff(['-ss', info.seconds > 1 ? '1' : '0', '-i', src, '-frames:v', '1', '-vf', scale(960), '-q:v', '4', poster]);
      await keep('poster', poster, 'image/jpeg', 960);
    } else {
      for (const [role, w] of [['image', 960], ['thumb', 320]] as const) {
        const f = join(dir, `${role}.webp`);
        await ff(['-i', src, '-frames:v', '1', '-vf', scale(w), '-c:v', 'libwebp', '-quality', '82', f]);
        if ((await stat(f)).size > o.maxBytes) { if (role === 'image') throw new Error(`the image is larger than the placement allows (${o.maxBytes / 1e6} MB) even at 960 px`); continue; }
        await keep(role, f, 'image/webp', w);
      }
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Claim one queued job and process it. Returns false when there is nothing to do. */
export async function runOnce(admin: pg.Pool, tools: Tools, store: Storage): Promise<boolean> {
  const c = await admin.connect();
  let job: { id: number; creative_id: string; source_key: string; kind: 'image' | 'clip' } | undefined;
  try {
    await c.query('BEGIN');
    job = (await c.query(`SELECT id, creative_id, source_key, kind FROM media_jobs WHERE status = 'queued' OR (status = 'running' AND locked_at < now() - interval '15 minutes')
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if (job) await c.query(`UPDATE media_jobs SET status = 'running', attempts = attempts + 1, locked_at = now() WHERE id = $1`, [job.id]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  if (!job) return false;
  const [lim] = (await admin.query(`SELECT p.max_media_bytes FROM creatives c JOIN placements p ON p.id = c.placement_id WHERE c.id = $1`, [job.creative_id])).rows;
  try {
    const variants = await processMedia(tools, store, { creativeId: job.creative_id, sourceKey: job.source_key, kind: job.kind, maxBytes: lim?.max_media_bytes ?? 4_000_000 });
    const t = await admin.connect();
    try {
      await t.query('BEGIN');
      await t.query(`DELETE FROM creative_media WHERE creative_id = $1 AND role <> 'source'`, [job.creative_id]);
      for (const v of variants) {
        await t.query(`INSERT INTO creative_media(creative_id, role, width, height, s3_key, mime, duration_ms, bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [job.creative_id, v.role, v.width, v.height, v.key, v.mime, v.durationMs, v.bytes, v.sha256]);
      }
      await t.query(`UPDATE media_jobs SET status = 'done', error = NULL, finished_at = now() WHERE id = $1`, [job.id]);
      await t.query(`UPDATE creatives SET status = 'draft', error = NULL, updated_at = now() WHERE id = $1 AND status = 'processing'`, [job.creative_id]);
      await t.query('COMMIT');
    } catch (e) { await t.query('ROLLBACK'); throw e; } finally { t.release(); }
  } catch (e) {
    const why = String((e as Error).message ?? e).slice(0, 300);
    await admin.query(`UPDATE media_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [job.id, why]);
    await admin.query(`UPDATE creatives SET status = 'rejected', error = $2, updated_at = now() WHERE id = $1`, [job.creative_id, `media: ${why}`]);
  }
  return true;
}

// ── the process ─────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: pgmod } = await import('pg');
  const { S3 } = await import('../api/s3.ts');
  const env = process.env;
  const need = (k: string) => { const v = env[k]; if (!v) { console.error(`${k} is required`); process.exit(2); } return v; };
  const admin = new pgmod.Pool({ host: env.PG_HOST ?? 'postgres', port: Number(env.PG_PORT ?? 5432), database: env.PG_DATABASE ?? 'agentic_office', user: 'ao_admin', password: need('AO_ADMIN_PASSWORD') });
  const s3 = new S3({ endpoint: need('MINIO_ENDPOINT'), accessKey: need('MINIO_ROOT_USER'), secretKey: need('MINIO_ROOT_PASSWORD') });
  const store: Storage = {
    get: async (k) => { const r = await s3.request('GET', MEDIA_BUCKET, k); if (!r.ok) throw new Error(`source missing (${r.status})`); return Buffer.from(await r.arrayBuffer()); },
    put: (k, d) => s3.put(MEDIA_BUCKET, k, d),
  };
  const tools = { ffmpeg: env.FFMPEG ?? 'ffmpeg', ffprobe: env.FFPROBE ?? 'ffprobe' };
  console.log('media worker: waiting for jobs');
  for (;;) {
    const did = await runOnce(admin, tools, store).catch((e) => { console.error('media worker:', (e as Error).message); return false; });
    if (!did) await new Promise((r) => setTimeout(r, 3000));
  }
}
