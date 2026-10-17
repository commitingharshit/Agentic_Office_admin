# deploy

One entry point for the server-side compose stacks. Each stack keeps its own compose file,
`.env` and volumes next to its service; this folder only points at them.

- `stack.sh <stack> <compose args>` — run one stack the way production does (its own project
  name, so volume names do not change). Stacks: `accounts-sync`, `collab`, `research-search`,
  `observability`.
- `compose.yaml` — includes every stack, for a local copy of all of them:
  `docker compose -f services/deploy/compose.yaml up -d <service…>`. Needs each stack's `.env`.
  Do not point a production host at it: its project name differs, so its volumes would be new.

The desktop build environment (`Dockerfile.build`, root `docker-compose.yml`) is not a service
and stays at the repo root.
