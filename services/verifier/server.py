#!/usr/bin/env python3
"""The verifier: the Hermes skill scanner and the agent blueprint compiler behind a small HTTP API, so the platform API
never needs a Hermes checkout or a Python interpreter.

    POST /scan     {"name": "my-skill", "files": {"SKILL.md": "<base64>", ...}}   -> run result
    POST /compile  {"op": "check" | "dryrun", "stdin": "<the compiler request JSON>"} -> run result
    GET  /healthz  200 {"ok": true, ...} once Hermes is present and importable

A "run result" is {"code", "stdout", "stderr", "timedOut", "overflow"}: exactly what a local child process would have
given the API, so the API parses it with the code it already had. Both commands run as child processes with an argument
array (never a shell), a minimal environment, a throwaway HOME, their own process group (killed as a group on timeout),
and capped output. Internal network only: this service has no authentication and must not be published.
"""
import base64, json, os, re, shutil, signal, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERMES_DIR = os.path.abspath(os.environ.get("HERMES_DIR", "/opt/hermes"))
PYTHON = os.environ.get("VERIFIER_PYTHON", sys.executable)
PORT = int(os.environ.get("VERIFIER_PORT", "8089"))
BIND = os.environ.get("VERIFIER_BIND", "0.0.0.0")
MAX_BODY = 16 * 1024 * 1024
MAX_STDOUT = 1024 * 1024
SCAN_TIMEOUT, COMPILE_TIMEOUT = 60, 30
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SLOTS = threading.BoundedSemaphore(int(os.environ.get("VERIFIER_CONCURRENCY", "4")))
SCAN_CLI = os.path.join(HERMES_DIR, "tools", "skills_scan_cli.py")


def hermes_ref() -> str:
    try:
        return open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "HERMES_REF")).read().strip()[:80]
    except OSError:
        return "unknown"


def run(argv, stdin, cwd, env, timeout):
    """Run one child to completion; never raises."""
    try:
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd, env=env, start_new_session=True)
    except OSError as e:
        return {"code": None, "stdout": "", "stderr": str(e)[:2000], "timedOut": False, "overflow": False}
    timed_out = [False]

    def kill():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            pass

    timer = threading.Timer(timeout, lambda: (timed_out.__setitem__(0, True), kill()))
    timer.start()
    try:
        out, err = child.communicate(stdin.encode("utf-8") if stdin is not None else None)
    finally:
        timer.cancel()
        kill()
    overflow = len(out) > MAX_STDOUT
    return {
        "code": None if (timed_out[0] or overflow) else child.returncode,
        "stdout": "" if overflow else out.decode("utf-8", "replace"),
        "stderr": err.decode("utf-8", "replace")[:2000],
        "timedOut": timed_out[0], "overflow": overflow,
    }


def child_env(home):
    return {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": home, "HERMES_HOME": os.path.join(home, "hermes-home"),
        "PYTHONPATH": HERMES_DIR, "PYTHONDONTWRITEBYTECODE": "1", "LANG": "C.UTF-8",
    }


def path_problem(rel):
    if not isinstance(rel, str) or not rel or len(rel) > 200 or "\x00" in rel or "\\" in rel or rel.startswith("/"):
        return "bad path"
    if any(p in ("", ".", "..") for p in rel.split("/")):
        return "bad path"
    return None


def scan(body):
    name, files = body.get("name"), body.get("files")
    if not isinstance(name, str) or not NAME_RE.match(name) or len(name) > 64:
        return 400, {"error": "bad skill name"}
    if not isinstance(files, dict) or not files or len(files) > 500:
        return 400, {"error": "bad files"}
    base = tempfile.mkdtemp(prefix="verifier-scan-")
    try:
        skill = os.path.join(base, "skill", name)
        os.makedirs(skill)
        os.makedirs(os.path.join(base, "hermes-home"))
        total = 0
        for rel, b64 in files.items():
            if path_problem(rel) or not isinstance(b64, str):
                return 400, {"error": "bad file path"}
            try:
                data = base64.b64decode(b64, validate=True)
            except Exception:
                return 400, {"error": "bad file encoding"}
            total += len(data)
            if total > 8 * 1024 * 1024:
                return 400, {"error": "files too large"}
            dest = os.path.realpath(os.path.join(skill, rel))
            if not dest.startswith(os.path.realpath(skill) + os.sep):
                return 400, {"error": "bad file path"}
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            # LICENSE/NOTICE/README have no extension, which the scanner would skip: scan them as .txt.
            if "." not in rel.rsplit("/", 1)[-1]:
                dest += ".txt"
            with open(dest, "wb") as fh:
                fh.write(data)
        return 200, run([PYTHON, "-B", SCAN_CLI, "--source", "community", "--json", skill], None, base, child_env(base), SCAN_TIMEOUT)
    finally:
        shutil.rmtree(base, ignore_errors=True)


def compile_(body):
    op, stdin = body.get("op"), body.get("stdin")
    if op not in ("check", "dryrun") or not isinstance(stdin, str):
        return 400, {"error": "bad request"}
    base = tempfile.mkdtemp(prefix="verifier-bp-")
    try:
        return 200, run([PYTHON, "-B", "-m", "agent.office.blueprint.cli", op], stdin, base, child_env(base), COMPILE_TIMEOUT)
    finally:
        shutil.rmtree(base, ignore_errors=True)


def healthy():
    if not os.path.isfile(SCAN_CLI) or not os.path.isdir(os.path.join(HERMES_DIR, "agent", "office", "blueprint")):
        return False, "hermes files missing"
    r = run([PYTHON, "-B", "-c", "import tools.skills_guard, agent.office.blueprint.cli"], None, tempfile.gettempdir(), child_env(tempfile.gettempdir()), 20)
    return (r["code"] == 0), ("" if r["code"] == 0 else "hermes does not import")


class Handler(BaseHTTPRequestHandler):
    server_version = "verifier"
    sys_version = ""

    def log_message(self, *a):  # request lines would carry nothing useful and no skill content may reach a log
        pass

    def send(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path != "/healthz":
            return self.send(404, {"error": "not found"})
        ok, why = healthy()
        self.send(200 if ok else 503, {"ok": ok, "hermes": hermes_ref(), **({"reason": why} if why else {})})

    def do_POST(self):
        if self.path not in ("/scan", "/compile"):
            return self.send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("content-length", "-1"))
        except ValueError:
            n = -1
        if n < 0 or n > MAX_BODY:
            return self.send(413, {"error": "bad length"})
        try:
            body = json.loads(self.rfile.read(n))
            assert isinstance(body, dict)
        except Exception:
            return self.send(400, {"error": "bad json"})
        if not SLOTS.acquire(blocking=False):
            return self.send(429, {"error": "busy"})
        try:
            code, obj = scan(body) if self.path == "/scan" else compile_(body)
        finally:
            SLOTS.release()
        self.send(code, obj)


if __name__ == "__main__":
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
