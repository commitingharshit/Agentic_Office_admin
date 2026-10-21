// Template-validator eval: the corpus in template-corpus.ts through unpack() + the REAL template validator (static checks
// only: no officecli binary; the OfficeCLI cross-check is run-template-differential.ts).
// Run: node evals/run-template-validator.ts   (npm run eval:templates)
import { runEval } from './lib.ts';
import { cases } from './template-corpus.ts';

process.exit(await runEval('template-validator', 'Template validator eval', cases, 'template', [
  `Static checks over a fixed corpus of ${cases.length} packages (${cases.filter((c) => c.label === 'benign').length} real, ${cases.filter((c) => c.label === 'malicious').length} hostile or malformed): a regression gate, not a proof that every hostile Office file is caught.`,
  'The renderer check (officecli-open) is not run: it needs the OfficeCLI binary and is injected in production. Passing here means the static structure and active-content scan passed.',
  'The PDF check is a heuristic byte scan for /JavaScript, /Launch and similar names (with name-escape handling); it is not a PDF parser.',
  'Hostile Office files that rely on application behavior (DDE, remote template injection through unusual relationship types, formula injection) are only caught where the scanner has a rule for them; see known gaps.',
  'Mutations are built from the repo\'s own templates, so exotic real-world malware families are not represented.',
]));
