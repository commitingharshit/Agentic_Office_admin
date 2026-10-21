"""Regenerates src/marketplace/validate/memory-provider-schemas.json from the bundled Hermes memory providers.

Run from vendor/hermes-agent with its python:
    HERMES_HOME=$(mktemp -d) venv/bin/python ../../services/accounts-sync/scripts/refresh-memory-schemas.py

The snapshot is what the publish-time validator checks config keys and secret env names against. It lists, per
bundled provider, only: config keys (non-secret), secret fields (key + env_var) and whether the provider has a
save_config. It never contains values. A Hermes test (tests/hermes_cli/marketplace_ext/test_memory.py) fails when
this file drifts from the live providers, so a provider change forces a refresh.
"""
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src" / "marketplace" / "validate" / "memory-provider-schemas.json"
LOCAL = {"holographic", "agentic"}


def main() -> int:
    from plugins.memory import _MEMORY_PLUGINS_DIR, load_memory_provider

    names = sorted(p.name for p in Path(_MEMORY_PLUGINS_DIR).iterdir() if p.is_dir() and (p / "__init__.py").exists() and not p.name.startswith("_"))
    out = {}
    for name in names:
        prov = load_memory_provider(name)
        schema = []
        if prov is not None and hasattr(prov, "get_config_schema"):
            try:
                schema = prov.get_config_schema() or []
            except Exception:
                schema = []
        keys, secrets, seen = [], [], set()
        for f in schema:
            if not isinstance(f, dict) or not isinstance(f.get("key"), str) or f["key"] in seen:
                continue
            seen.add(f["key"])
            if f.get("secret") is True:
                secrets.append({"key": f["key"], "env_var": f.get("env_var")})
            else:
                keys.append({"key": f["key"], **({"choices": f["choices"]} if f.get("choices") else {})})
        out[name] = {"local": name in LOCAL, "keys": keys, "secrets": secrets, "hasSaveConfig": bool(prov is not None and hasattr(prov, "save_config"))}
    OUT.write_text(json.dumps({"schema": "agentic.marketplace.memory-schemas/1", "providers": out}, indent=2, sort_keys=True) + "\n")
    print(f"wrote {OUT} ({len(out)} providers)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
