// Stage 5 (required): declared permissions vs detected behaviour. An undeclared capability fails (the consent-bypass class as a
// standing check). Declared but unused capabilities are evidence only. Detection is line-based and reports file:line, never text.
import type { Evidence, StageDef } from '../../types.ts';
import { text, tooLarge, treeProblem } from './util.ts';

const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|rb|pl|js|mjs|cjs|ts|ps1|bat|cmd|php|r|jl)$/i;
const NET_CODE: RegExp[] = [
  /\b(?:import|from)\s+(?:requests|urllib\d?|httpx|aiohttp|socket|http\.client|ftplib|smtplib|telnetlib|websockets?)\b/, /\brequire\(\s*['"](?:node:)?(?:https?|net|dgram|tls|http2)['"]\s*\)/,
  /\bimport\b[^\n]*\bfrom\s+['"](?:node:)?(?:https?|net|tls)['"]/, /\bfetch\s*\(/, /\bXMLHttpRequest\b|\baxios\b/, /(?:^|[\s;&|(])(?:curl|wget|nc|ncat|ssh|scp|rsync|ftp|telnet)\s/m,
  /\bhttps?:\/\/(?!localhost\b|127\.0\.0\.1|(?:www\.)?(?:schemas\.openxmlformats\.org|schemas\.microsoft\.com|w3\.org|purl\.org|schemas\.xmlsoap\.org|ns\.adobe\.com)\/)/i,   // XML namespace URIs are identifiers, not requests
];
const SECRET_CODE: RegExp[] = [
  /\bos\.environ\b|\bos\.getenv\b|\bgetenv\s*\(|\bprocess\.env\b|\bENV\[|\bSystem\.getenv\b/, /\$\{?[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\}?/,
  /(?:^|[\s'"/])(?:\.env\b|\.netrc|\.aws\/|\.ssh\/|\.npmrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519|\.kube\/config)/, /\bkeychain\b|\bsecurity\s+find-generic-password\b/i,
];

export function permissionsStage(timeoutMs = 20_000): StageDef {
  return {
    id: 'permissions-consistency', title: 'Declared permissions match detected behaviour', required: true, timeoutMs, after: ['manifest'],
    run: async ({ pkg }) => {
      const bad = treeProblem(pkg); if (bad) return tooLarge(bad);
      const declared = new Set(pkg.manifest.permissions.map((p) => p.capability));
      const execFiles: string[] = [], net: string[] = [], sec: string[] = [], proseUrls: string[] = [];
      for (const [f, b] of pkg.files) {
        const md = /\.(md|txt)$/i.test(f) || !f.includes('.');
        const shebang = b.length > 2 && b[0] === 0x23 && b[1] === 0x21;
        const isScript = SCRIPT_EXT.test(f) || shebang || /(?:^|\/)scripts\//.test(f);
        if (isScript) execFiles.push(f);
        const lines = text(b).split('\n', 20000);
        if (md && !isScript) { if (lines.some((l) => /https?:\/\//i.test(l))) proseUrls.push(f); continue; }
        if (!isScript && !/\.(json|ya?ml|toml|cfg|ini|conf|html|xml|css)$/i.test(f)) continue;
        lines.forEach((l, i) => {
          if (l.length > 4000) l = l.slice(0, 4000);
          if (net.length < 20 && NET_CODE.some((re) => re.test(l))) net.push(`${f}:${i + 1}`);
          if (isScript && sec.length < 20 && SECRET_CODE.some((re) => re.test(l))) sec.push(`${f}:${i + 1}`);
        });
      }
      const evidence: Evidence[] = [], missing: string[] = [];
      const need = (cap: string, hits: string[], what: string) => {
        if (hits.length) evidence.push({ kind: 'check', label: `${what} detected`, detail: hits.slice(0, 10).join(', ') });
        if (hits.length && !declared.has(cap as 'network')) missing.push(`${cap} (${what}: ${hits.slice(0, 3).join(', ')})`);
        else if (!hits.length && declared.has(cap as 'network')) evidence.push({ kind: 'check', label: `${cap} declared but not detected (advisory)` });
      };
      need('exec.script', execFiles, 'scripts');
      need('network', net, 'network-capable code or URL outside prose');
      need('secrets.use', sec, 'environment or secret access');
      if (proseUrls.length) evidence.push({ kind: 'check', label: 'URLs in prose (advisory)', detail: proseUrls.slice(0, 10).join(', ') });
      if (missing.length) return { status: 'fail', reason: `undeclared capability: ${missing.join('; ')}`, evidence };
      return { status: 'pass', evidence };
    },
  };
}
