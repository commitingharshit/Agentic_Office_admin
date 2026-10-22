---
type: Playbook
title: "Service deployment"
description: "One entry point for the server-side compose stacks: stack.sh runs a stack under its own project name, compose.yaml includes every stack for a local copy."
resource: services/deploy/
toolchain: "Docker Compose"
build: "none"
test: "docker compose -f services/deploy/compose.yaml config (with each stack's .env)"
run: "services/deploy/stack.sh <accounts-sync|collab|research-search|observability> up -d"
owns_data: "none (each stack owns its volumes)"
depends_on: [services/api/, services/collab/, services/research/, services/dag-runtime/]
status: "active"
tags: [deploy, docker]
timestamp: 2026-10-17T00:00:00Z
---

One entry point for the server-side compose stacks: stack.sh runs a stack under its own project name, compose.yaml includes every stack for a local copy.

A production host runs `stack.sh`, never `compose.yaml`: the latter's project name differs, so its volumes would be new and empty.

README: [`services/deploy/README.md`](/../services/deploy/README.md)

# Citations

- [`services/deploy/README.md`](/../services/deploy/README.md)
