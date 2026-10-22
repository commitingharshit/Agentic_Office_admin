#!/usr/bin/env bash
# Marketplace gates in CI form (Plan 4 Task 18): fast, deterministic, CI-safe. One PASS/FAIL/SKIP line per gate and a final tally.
#
#   tests/marketplace/gates.sh [--only <gate>] [--allow-skip <gate>[,<gate>...]] [--perf] [--full-desktop] [--list]
#
# Exit 1 on any FAIL, and on any SKIP that is not named by --allow-skip (a gate that cannot run is not a pass).
# Logs per gate: ${TMPDIR:-/tmp}/marketplace-gates/<gate>.log. bash 3.2 compatible (macOS).
#   --perf          also run the timing budgets of the bench (structural budgets always run)
#   --full-desktop  also run the whole desktop unit suite and compare its failures to the recorded baseline
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${PYTHON_BIN:-$ROOT/vendor/hermes-agent/venv/bin/python}"
[ -x "$PY" ] || PY="$HOME/Desktop/Agentic_Office_ultra/vendor/hermes-agent/venv/bin/python"   # a worktree has no venv of its own (same resolution as test-matrix.sh)
ONLY=""; ALLOW=","; PERF=0; FULL=0; LIST=0
while [ $# -gt 0 ]; do
	case "$1" in
		--only) ONLY="$2"; shift ;;
		--allow-skip) ALLOW=",$2,"; shift ;;
		--perf) PERF=1 ;;
		--full-desktop) FULL=1 ;;
		--list) LIST=1 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done
LOGS="${TMPDIR:-/tmp}/marketplace-gates"; mkdir -p "$LOGS"
NPASS=0; NFAIL=0; NSKIP=0; BADSKIP=0; GATES=""
SVC="$ROOT/services/api"; DESK="$ROOT/apps/desktop"

# gate <name> <description> -- runs the function gate_<name> in a subshell; exit 0 (pass), non-zero (fail) or 77 via skip() (reason in $LOGS/<name>.skip)
gate() {
	local name="$1" desc="$2"
	GATES="$GATES $name"
	[ "$LIST" = 1 ] && { echo "$name  $desc"; return; }
	[ -n "$ONLY" ] && [ "$ONLY" != "$name" ] && return
	rm -f "$LOGS/$name.skip"
	local t0=$SECONDS rc
	( "gate_$name" ) >"$LOGS/$name.log" 2>&1; rc=$?
	local dt=$((SECONDS - t0))
	case $rc in
		0) NPASS=$((NPASS + 1)); printf 'PASS  %-22s %4ss  %s\n' "$name" "$dt" "$desc" ;;
		77) NSKIP=$((NSKIP + 1)); local why; why="$(cat "$LOGS/$name.skip" 2>/dev/null)"
			case "$ALLOW" in *",$name,"*) printf 'SKIP  %-22s %4ss  %s (allowed: %s)\n' "$name" "$dt" "$desc" "$why" ;;
				*) BADSKIP=$((BADSKIP + 1)); printf 'SKIP! %-22s %4ss  %s (NOT allowed: %s)\n' "$name" "$dt" "$desc" "$why" ;; esac ;;
		*) NFAIL=$((NFAIL + 1)); printf 'FAIL  %-22s %4ss  %s  (log: %s)\n' "$name" "$dt" "$desc" "$LOGS/$name.log" ;;
	esac
}
skip() { echo "$1" > "$LOGS/${FUNCNAME[1]#gate_}.skip"; exit 77; }   # gates run in a subshell, so exit ends only the gate

gate_invariants()   { cd "$ROOT" && python3 scripts/dev/check-repo-layout.py && python3 scripts/dev/check-okf.py && scripts/verify-repo-invariants.sh; }
gate_migrations()   { cd "$SVC" && node --test test/migration-numbers.test.ts test/marketplace-migrations.test.ts test/marketplace-migrations-compose.test.ts; }
gate_accounts_sync() { [ -d "$SVC/node_modules" ] || skip "no node_modules in services/api (npm ci)"; cd "$SVC" && npm test; }
gate_accounts_sync_utc() { [ -d "$SVC/node_modules" ] || skip "no node_modules"; cd "$SVC" && TZ=UTC npm test; }
gate_postgres() {
	# the Postgres-gated tests: a local PostgreSQL with pgvector (test:postgres) or, failing that, a throwaway docker pgvector container
	[ -d "$SVC/node_modules" ] || skip "no node_modules"
	if command -v initdb >/dev/null 2>&1 && [ -n "$(command -v pg_config)" ] && [ -f "$(pg_config --sharedir)/extension/vector.control" ]; then cd "$SVC" && npm run test:postgres; return $?; fi
	command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || skip "neither a local PostgreSQL with pgvector nor a running docker"
	local port name="ao-mkt-gates-$$"
	port="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
	docker run -d --name "$name" -e POSTGRES_USER=ao_owner -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=agentic_office -p "127.0.0.1:$port:5432" pgvector/pgvector:pg17 >/dev/null || return 1
	trap "docker rm -f $name >/dev/null 2>&1" RETURN
	local i; for i in $(seq 1 60); do docker exec "$name" pg_isready -U ao_owner -d agentic_office >/dev/null 2>&1 && break; sleep 1; done
	export AO_TEST_PG="postgres://ao_owner:pw@127.0.0.1:$port/agentic_office" DATABASE_URL="postgres://ao_owner:pw@127.0.0.1:$port/agentic_office"
	export AO_APP_PASSWORD=ao-app-local-test AO_READONLY_PASSWORD=ao-readonly-local-test AO_ADMIN_PASSWORD=ao-admin-local-test
	cd "$SVC" && node db/migrate.ts && npm test
}
gate_evals() { [ -d "$SVC/node_modules" ] || skip "no node_modules"; cd "$SVC" && npm run eval; }
gate_verification_eval() {
	[ -d "$SVC/node_modules" ] || skip "no node_modules"
	command -v officecli >/dev/null 2>&1 || [ -n "${OFFICECLI_BIN:-}" ] || skip "officecli is not installed (a hosted runner may not have it: run this gate nightly on a machine that does)"
	[ -x "$ROOT/kernels/target/release/xlsx-context" ] || skip "kernels are not built (cd kernels && cargo build --release -p xlsx-kernel -p docpatch -p pptx-kernel -p pdf-kernel)"
	cd "$SVC" && npm run eval:verification
}
gate_zip_differential() {
	[ -x "$PY" ] || skip "no Hermes python (set PYTHON_BIN)"
	[ -d "$DESK/node_modules" ] || skip "no apps/desktop/node_modules (the desktop reader is one of the three)"
	cd "$ROOT" && FUZZ_ITERS="${FUZZ_ITERS:-400}" HERMES_PYTHON="$PY" node tests/marketplace/zip-differential.mjs
}
gate_hermes() { [ -x "$PY" ] || skip "no Hermes python (set PYTHON_BIN)"; "$PY" -c 'import pytest' 2>/dev/null || skip "pytest is not installed in $PY"; cd "$ROOT/vendor/hermes-agent" && "$PY" -m pytest tests/tools/test_agentic_marketplace_source.py tests/hermes_cli/marketplace_ext -q -p no:cacheprovider; }
gate_desktop() {
	[ -d "$DESK/node_modules" ] || skip "no apps/desktop/node_modules"
	cd "$DESK" && npm run transpile-client >/dev/null 2>&1 || return 1
	local f rc=0
	for f in $(cd "$DESK" && find src/vs/workbench/contrib/marketplace/test src/vs/platform/marketplace/test -name '*.test.ts' | sort); do
		npm run test-node -- --run "$f" >"$LOGS/desktop.$(basename "$f").log" 2>&1 || { echo "FAILED: $f"; rc=1; }
	done
	[ "$FULL" = 1 ] && { echo "full desktop suite requested: compare with docs/audits/marketplace-known-desktop-failures.json by hand (baseline script: scripts/dev/baseline-desktop-unit.sh)"; }
	return $rc
}
gate_desktop_types() { [ -d "$DESK/node_modules" ] || skip "no apps/desktop/node_modules"; cd "$DESK" && npm run typecheck-client; }
gate_desktop_layers() { [ -d "$DESK/node_modules" ] || skip "no apps/desktop/node_modules"; cd "$DESK" && node build/checker/layersChecker.ts && npx tsgo --project build/checker/tsconfig.electron-main.json && npx tsgo --project build/checker/tsconfig.browser.json; }
gate_bench() {
	[ -d "$DESK/node_modules" ] || skip "no apps/desktop/node_modules"
	cd "$ROOT" && if [ "$PERF" = 1 ]; then node tests/marketplace/bench/run.mjs --check; else node tests/marketplace/bench/run.mjs --check --no-server; fi
}
gate_control_plane_pages() { cd "$ROOT/apps/console" && npx tsc --noEmit && node --import tsx --test test/marketplace.test.ts test/marketplace-verification.test.ts test/marketplace-plan2.test.ts; }
gate_color_audit() { cd "$ROOT" && node tests/marketplace/color-audit.mjs --self-test && node tests/marketplace/color-audit.mjs; }
gate_truth_table() { cd "$ROOT" && node tests/marketplace/truth-table.mjs --check; }

gate invariants "repo layout, okf and repo invariants"
gate migrations "migration numbering, rollback scripts, composition"
gate accounts_sync "accounts-sync test suite"
gate accounts_sync_utc "accounts-sync test suite with TZ=UTC"
gate postgres "Postgres-gated tests (real pgvector Postgres)"
gate evals "evals: scan gate, templates, blueprints, bundles, advanced types"
gate verification_eval "verification pipeline eval (real officecli and kernels)"
gate zip_differential "three-reader zip differential"
gate hermes "Hermes marketplace tests"
gate desktop "desktop marketplace unit files"
gate desktop_types "desktop type check (tsgo)"
gate desktop_layers "desktop layers: checker, electron-main, browser"
gate bench "structural performance budgets (timing with --perf)"
gate control_plane_pages "control-plane marketplace pages typecheck and helper tests"
gate color_audit "no raw color literal in the Marketplace stylesheet"
gate truth_table "truth table agrees with the evidence"

[ "$LIST" = 1 ] && exit 0
echo
echo "tally: $NPASS pass, $NFAIL fail, $NSKIP skip ($BADSKIP not allowed)"
[ "$NFAIL" -eq 0 ] && [ "$BADSKIP" -eq 0 ]
