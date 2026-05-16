# E2E audit-fixture rule

When an agent needs Fulcrum to be in a **populated** state (≥1 project, ≥2 mixed-status apps,
≥1 successful deployment, ≥3 tasks across statuses) — for example to capture populated-state
gold-path screenshots in
[`mattermost-plugin-fulcrum#33` / `#41`](https://github.com/Mouriya-Emma/mattermost-plugin-fulcrum/issues/41)
audits — drive the seed from the dedicated fixture repo, not from inline DB writes scattered
across PR scratch.

## Canonical fixture repo

**[`Mouriya-Emma/fulcrum-audit-fixture`](https://github.com/Mouriya-Emma/fulcrum-audit-fixture)**
(private). Same role as `claude-code-pr-bridge-e2e`: dedicated repo whose only deliverable is
the populated-state E2E backing data.

Contents:

- `compose.yaml` — 2-service compose (`traefik/whoami` + `ealen/echo-server`). Public images,
  no build step. Fulcrum's `compose-parser` reads service names from this.
- `seed.py` — idempotent host-side Python (stdlib only) that:
  1. `POST /api/repositories` → creates the `repositories` row + auto-creates the linked
     `projects` row + `project_repositories` join entry.
  2. Direct SQLite insert for `apps` ×2 (one `status=running`, one `status=stopped`),
     `app_services` ×2, `deployments` ×1 (`status=running` with realistic compose-up
     `buildLogs` so `apps logs` returns non-empty content).
  3. Direct SQLite insert for `tasks` ×3 (TO_DO / IN_PROGRESS / DONE), linked to the seeded
     project.
- `cleanup.py` — idempotent counterpart that removes the seeded rows by fixture-prefixed
  name. Safe to re-run.

## Why direct SQLite for apps + deployments

Fulcrum's `POST /api/apps` runs `checkDockerInstalled()` + `checkDockerRunning()` precondition
checks, and `deployApp()` shells out to `docker compose up`. The prod Fulcrum container on
`vctcn-app1` (homelab Komodo stack) **does not bind the host docker socket** — that's
deliberate, prod Fulcrum is a renderer for the homelab control plane, not a Docker host. So
the HTTP-driven create path cannot succeed against prod.

For the audit goal — populated-state UI / CLI screenshots — only the DB rows need to exist,
not actual running containers. Direct SQLite insert is honest: this is fixture data, never
claims real deployment. The rule it follows is the same shape Fulcrum's own migrations write,
and respects WAL mode + the `nanoid`-format primary keys.

For local-dev (or any host where Fulcrum has docker access) the HTTP `POST /api/apps` +
`POST /api/apps/:id/deploy` path **is** available and should be preferred — `seed.py` can be
extended with a `--http-deploy` flag if/when that's needed. Today's prod constraint drives the
default path.

## When to run seed vs cleanup

- **Run seed when**: an audit-comment-v2 leaf reports `gold-path needs populated state` and
  prod data is 0-row; or before a manual demo where empty-state visuals would mislead.
- **Run cleanup when**: an upcoming audit needs to verify empty-state branches; or a Fulcrum
  schema change made the seed rows internally inconsistent (re-seed afterwards).

The seed is **idempotent**: re-running with the same target is a no-op for apps/tasks
(SELECT-then-skip) and HTTP 409 on the repo. So leaving the fixture in place across audit
runs is the default; explicit cleanup is the exception.

## Operator-side procedure

```sh
# On the box hosting target Fulcrum (e.g. moat-app1.mouriya.lan for prod):
git clone https://github.com/Mouriya-Emma/fulcrum-audit-fixture.git \
    /var/lib/fulcrum/repos/audit-fixture
chown -R 1000:1000 /var/lib/fulcrum/repos/audit-fixture

# Seed. --container-repo-path is what Fulcrum sees after host bind
# (/var/lib/fulcrum -> /data):
python3 /var/lib/fulcrum/repos/audit-fixture/seed.py \
    --fulcrum-url http://localhost:7777 \
    --db /var/lib/fulcrum/.fulcrum/fulcrum.db \
    --container-repo-path /data/repos/audit-fixture

# Verify:
docker exec fulcrum fulcrum projects 2>&1 | jq '.data.total'   # ≥1
docker exec fulcrum fulcrum apps list 2>&1 | jq '.data.total'  # ≥2
docker exec fulcrum fulcrum tasks list 2>&1 | jq '.data.total' # ≥3
```

## Acceptance criteria covered

The seeded state satisfies these
[`mattermost-plugin-fulcrum#41`](https://github.com/Mouriya-Emma/mattermost-plugin-fulcrum/issues/41)
ACs end-to-end:

| AC | Check | Source row |
|---|---|---|
| 1 | `/f tasks list` ≥3 incl. ≥1 done | tasks ×3 |
| 2 | `/f apps list` ≥2 mixed-status | apps ×2 (running/stopped) |
| 3 | `/f projects` ≥1 | auto-created by POST /api/repositories |
| 4 | `/f apps logs <id>` non-empty | `deployments.buildLogs` (~8 lines) |
| 5 | `/f dashboard` reflects fixture | counters derive from above rows |

AC#6 (retrigger `#33` audit) is supervisor work — flip plugin q41 `blocked → queued` after
seed verified, then restart the plugin coder-loop daemon with `--require-browser-evidence`.

## Not in scope for the fixture repo

- Live workloads (the compose images never actually run on the target host).
- Production secrets — the fixture repo holds zero credentials.
- Tracking real audit progress — that lives in
  [`fulcrum#221`](https://github.com/Mouriya-Emma/fulcrum/issues/221) supervisor state and the
  audit-comment-v2 series.

## Related rules

- `.claude/rules/e2e-mattermost.md` in
  [`mattermost-plugin-fulcrum`](https://github.com/Mouriya-Emma/mattermost-plugin-fulcrum/blob/main/.claude/rules/e2e-mattermost.md)
  — Mattermost SSO test identity (`fulcrum-e2e`) and sops-encrypted password used by
  `agent-browser` when navigating the populated UI for screenshots. The audit-fixture rule
  here covers the **data**; the e2e-mattermost rule covers the **identity**.
