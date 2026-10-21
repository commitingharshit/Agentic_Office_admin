# Fix wave: desktop + Hermes (feat/marketplace-fix-client)

## Items
- M1a: new `contrib/marketplace/browser/marketplaceReconcile.contribution.ts` (WorkbenchPhase.Eventually, imported in workbench.common.main.ts). Runs reconcile() 30 s after start, hourly, on focus after >15 min, on `online` (>=60 s gap). Skips when not configured / lockfile empty; never throws; logs via ILogService with sanitizeDetail. Pure policy: `common/marketplaceReconcileSchedule.ts` (fake-clock tests, 5).
- M1b: `install()` throws `SignInRequiredError` without a token (plan stays anonymous); controller signs in first (existing signIn command), detail view button reads "Sign in to install" when signed out. `reconcile()` with no token OR no device id calls anonymous `POST versions/status {versionIds}` (no Authorization header) and applies revoked/quarantined exactly like the signed-in path (shared `applyUpdates`; disable, Hermes uninstall, reason). Result still carries `skipped: 'signed-out' | 'no-device'`.
- M3: `common/marketplaceExecutable.ts` `executableFiles()` (scripts/ dir, exec extensions, shebang, ELF/PE/Mach-O magic). `plan.executable` = permissions OR files; `plan.executableFiles` lists them; native dialog lists them; install() re-checks the downloaded bytes (a package that gained a script since the plan is refused). Hermes: `marketplace_permissions` recorded in the bundle/lock metadata; `hermes skills update` refuses when (capability, scope) sets differ (no recorded set = none), unless `--accept-new-permissions` (CLI flag + slash flag), which prints the +/- diff.
- I1: `common/marketplaceErrors.ts` (`sanitizeDetail`, `classifyError`, `formatLastError`). Sync `lastError` is now `"<code>: <short sanitized detail>"` (code from the fixed list). Node codes: ENOENT/ENOSPC/... -> disk_error, EACCES/EPERM -> permission_denied. Local thrown message is unchanged (sanitised as before).
- CA env: `hermesEnv(..., isBuilt)` drops AGENTICOFFICE_MARKETPLACE_CA_FILE and DEV_MODE for packaged builds (`NativeMarketplaceInstallService` passes `IEnvironmentMainService.isBuilt`; `InstallerOptions.isBuilt`). Python `_tls_verify(base_url)` needs DEV_MODE=1 AND a loopback host.

## Tests (RED then GREEN)
- installService.test.ts: before the installer change 11 failed (sign-in, anonymous reconcile x3, executable files x2, error privacy x2, isBuilt CA, 2 updated expectations); after: 80 passing.
- Pure modules (marketplaceSafety 5, reconcile schedule 5): written first (RED = module missing); implementations were written before their first green run, so they were not individually seen failing on assertions.
- Hermes: new permission/TLS tests first failed (`_tls_verify() takes 0 positional arguments`); after: tests/tools/test_agentic_marketplace_source.py + tests/hermes_cli/test_skills_*.py + tests/tools/test_skills_hub.py = 342 passed.
- Typecheck `tsgo --noEmit -p src/tsconfig.json --skipLibCheck`: clean.
- Also green: marketplaceConnection 19, marketplaceModel 36, skillHermes.integration 1.

## Skipped / notes
- Discover-card install buttons keep the label "Install" (the controller prompts sign-in on click); only the detail view relabels.
- Background reconcile does not fire onDidChangeInstalled (views refresh when opened).
- valid-layers-check: see status in the handback message.

## Server-side needs
- `lastError` is sent as one string `"code: detail"`; the server should accept/parse the prefix (and may validate the code against the list).
- `versions/status` state values assumed: `revoked` / `quarantined` (anything else ignored); `reason` used as detail.
- Anonymous endpoint should not require auth and should cap/rate-limit versionIds (client sends <=200).
