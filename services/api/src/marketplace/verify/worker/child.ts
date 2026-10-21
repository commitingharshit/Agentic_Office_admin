// The sandboxed half of the verifier worker: reads ./package.zip from its throwaway cwd, unpacks it, runs the registered
// pipeline and prints ONE JSON document on stdout: { result, blobs: [{ mime, b64 }] }. It holds no credentials (its
// environment is scrubbed by sandbox.ts), talks to nobody, and is expected to be killed at any moment.
// Env (explicit allowlist from the worker): VERIFY_JOB_SHA, VERIFY_JOB_TYPE, VERIFY_MODULES (comma-separated absolute paths of
// modules that register pipelines, e.g. the template and skill pipelines), VERIFY_TOOLS_MODULE (default export (env) => PipelineTools).
import { readFileSync } from 'node:fs';
import { sha256Hex, unpack } from '../../artifacts.ts';
import type { ListingType } from '../../types.ts';
import { limitedSink } from '../evidence.ts';
import { runPipeline } from '../runner.ts';
import { defaultTools } from '../tools.ts';
import type { BlobMime, PipelineTools } from '../types.ts';

const sha = process.env.VERIFY_JOB_SHA ?? '', type = process.env.VERIFY_JOB_TYPE as ListingType;
const bytes = new Uint8Array(readFileSync('package.zip'));
if (sha256Hex(bytes) !== sha) { process.stderr.write('package.zip does not match VERIFY_JOB_SHA\n'); process.exit(3); }

for (const m of (process.env.VERIFY_MODULES ?? '').split(',').map((x) => x.trim()).filter(Boolean)) await import(m);
let tools: PipelineTools = defaultTools(process.env);
if (process.env.VERIFY_TOOLS_MODULE) tools = { ...tools, ...(await (await import(process.env.VERIFY_TOOLS_MODULE)).default(process.env)) };

const blobs: { mime: BlobMime; b64: string }[] = [];
const sink = limitedSink(async (b, mime) => { blobs.push({ mime, b64: Buffer.from(b).toString('base64') }); return { sha256: sha256Hex(b), size: b.byteLength }; });
const pkg = unpack(bytes);
const result = await runPipeline(type, pkg, tools, { subjectSha256: sha, evidence: sink, env: { worker: 'sandboxed-child' } });
process.stdout.write(JSON.stringify({ result, blobs }));
