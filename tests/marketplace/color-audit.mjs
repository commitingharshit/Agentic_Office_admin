#!/usr/bin/env node
// Static half of the Marketplace theme-consistency pass (Plan 4 Task 17): no raw color literal outside theme tokens.
//   node tests/marketplace/color-audit.mjs [--self-test] [file ...]     default files: the Marketplace stylesheet
// A "raw color" is a #hex, rgb()/rgba()/hsl()/hsla() or a named CSS color used as a value, anywhere that is not inside var(--vscode-*) or a
// workbench token. Fallbacks inside var(--x, #abc) count: a fallback is a hard-coded color that ignores the theme. Exit 1 when any is found.
// The live half (computed-style contrast >= 4.5:1 per theme, no horizontal scroll at the narrow width) needs the window and is in marketplace-shots.mjs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT = ['apps/desktop/src/vs/workbench/contrib/marketplace/browser/media/marketplace.css'];
const NAMED = /\b(white|black|red|green|blue|yellow|orange|purple|gray|grey|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)\b/;
export function rawColors(css) {
	const out = [];
	css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).split('\n').forEach((line, i) => {
		const decl = /^\s*(?:--[\w-]+|[a-z-]+)\s*:\s*(.+?);?\s*$/.exec(line);
		if (!decl) return;
		const v = decl[1];
		if (/#[0-9a-fA-F]{3,8}\b/.test(v) || /\b(?:rgba?|hsla?)\(/.test(v) || (/^(?:color|background(?:-color)?|border(?:-[a-z]+)?(?:-color)?|outline(?:-color)?|fill|stroke)\b/.test(line.trim()) && NAMED.test(v.replace(/var\([^)]*\)/g, '')))) out.push({ line: i + 1, text: line.trim() });
	});
	return out;
}
/** WCAG 2.x contrast ratio of two sRGB colours given as [r,g,b] 0-255. */
export function contrast(a, b) {
	const lum = ([r, g, bl]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
	const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}
if (process.argv.includes('--self-test')) {
	const assert = (await import('node:assert/strict')).default;
	assert.equal(rawColors('.a { color: var(--vscode-foreground); }\n.b {\n\tcolor: #fff;\n}').length, 1);
	assert.equal(rawColors('.a {\n\tborder: 1px solid rgba(0,0,0,.2);\n}').length, 1);
	assert.equal(rawColors('.a {\n\tcolor: var(--x, #abc);\n}').length, 1);
	assert.equal(rawColors('/* color: #fff; */\n.a {\n\tcolor: var(--mkt-ok);\n}').length, 0);
	assert.equal(rawColors('.a {\n\tbackground: white;\n}').length, 1);
	assert.equal(rawColors('.a {\n\tcontent: "white";\n}').length, 0);
	assert.ok(Math.abs(contrast([0, 0, 0], [255, 255, 255]) - 21) < 0.01);
	assert.ok(contrast([119, 119, 119], [255, 255, 255]) < 4.5 && contrast([118, 118, 118], [255, 255, 255]) >= 4.5);
	console.log('self-test ok'); process.exit(0);
}
if (import.meta.url === `file://${process.argv[1]}`) {
	const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
	let bad = 0;
	for (const f of files.length ? files : DEFAULT) {
		const hits = rawColors(readFileSync(f.startsWith('/') ? f : join(root, f), 'utf8'));
		for (const h of hits) console.log(`${f}:${h.line}: ${h.text}`);
		console.log(`${f}: ${hits.length} raw color literal(s)`); bad += hits.length;
	}
	process.exit(bad ? 1 : 0);
}
