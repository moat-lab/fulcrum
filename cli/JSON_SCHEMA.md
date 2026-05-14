# Fulcrum CLI — Mattermost-plugin JSON contract

This document is the **stable contract** between the `fulcrum` CLI and the
`mattermost-plugin-fulcrum` Go plugin (see umbrella issue
[Mouriya-Emma/fulcrum#221](https://github.com/Mouriya-Emma/fulcrum/issues/221)
§5.4). The plugin runs CLI verbs over `rexec-go` and parses the `--json`
stdout. Any change to a verb's output shape that is not backwards-compatible
must bump `schema_version`.

## Envelope

Every verb in this surface emits a single line of JSON to stdout:

```json
{
  "success": true,
  "data": {
    "schema_version": 1,
    "verb": "<verb-id>",
    "...": "verb-specific payload"
  }
}
```

The outer `{ "success", "data" }` envelope is the existing fulcrum CLI
convention. Plugin consumers read `data` and key off `data.verb` and
`data.schema_version`.

On error the envelope is:

```json
{
  "success": true,
  "data": {
    "schema_version": 1,
    "verb": "<verb-id>",
    "error": { "code": "<machine-readable code>", "message": "<text>" }
  }
}
```

`success: true` only signals that the CLI process produced structured output;
the plugin must check `data.error` for the business outcome. The process exit
code is non-zero when an error is emitted, so transport (rexec-go) sees the
failure independently.

`schema_version` is currently `1`.

## Verb catalogue

### `fulcrum dashboard --json`

Aggregate summary shown by `/f` with no subcommand.

```json
{
  "schema_version": 1,
  "verb": "dashboard",
  "tasks_by_status": { "TO_DO": 3, "IN_PROGRESS": 2, "IN_REVIEW": 1, "DONE": 12, "CANCELED": 1 },
  "active_tasks": 6,
  "apps_by_status": { "running": 4, "failed": 1 },
  "total_apps": 5,
  "due_today": [TaskSummary, ...]
}
```

### `fulcrum tasks list [--status] [--priority] [--project] [--tag] [--page]`

```json
{
  "schema_version": 1,
  "verb": "tasks.list",
  "filter": {
    "status": "active" | "TO_DO" | "IN_PROGRESS" | ...,
    "priority": "high" | "medium" | "low" | null,
    "project_id": "<id>" | null,
    "tag": "<tag>" | null,
    "page": 1,
    "page_size": 20,
    "total_pages": 3
  },
  "total": 47,
  "tasks": [TaskSummary, ...]
}
```

`status` defaults to `active` (everything except DONE/CANCELED). Aliases
accepted on input: `todo`, `doing`/`progress`/`wip`, `review`, `done`,
`canceled`/`cancelled`.

### `fulcrum tasks get <id>`

```json
{
  "schema_version": 1,
  "verb": "tasks.get",
  "task": TaskSummary,
  "actions": [{ "id": "set_status_in_progress", "label": "Start", "destructive": false }, ...]
}
```

Actions are state-dependent (see `taskActions()`). The plugin uses these to
populate Mattermost interactive buttons.

### `fulcrum tasks create --title=... [...]`

Mirrors `POST /api/tasks` with optional `--description`, `--priority`,
`--type`, `--project`, `--repo`, `--due`, `--tags` (comma-separated).

```json
{ "schema_version": 1, "verb": "tasks.create", "task": TaskSummary }
```

### `fulcrum tasks set-status <id> <status>`

```json
{ "schema_version": 1, "verb": "tasks.set-status", "task": TaskSummary }
```

### `fulcrum tasks set-priority <id> <priority>`

```json
{ "schema_version": 1, "verb": "tasks.set-priority", "task": TaskSummary }
```

### `fulcrum tasks diff <id>`

```json
{
  "schema_version": 1,
  "verb": "tasks.diff",
  "task_id": "<id>",
  "branch": "<branch>" | null,
  "base_branch": "<branch>" | null,
  "diff": "<unified-diff string>" | null,
  "summary": {
    "fileCount": 4,
    "insertions": 123,
    "deletions": 12,
    "files": [{ "path": "...", "insertions": 10, "deletions": 1 }, ...]
  }
}
```

`diff` is `null` when the task has no worktree/scratch directory.

### `fulcrum tasks start-agent <id>`

```json
{
  "schema_version": 1,
  "verb": "tasks.start-agent",
  "task_id": "<id>",
  "terminal_id": "<id>",
  "agent": "claude" | "opencode"
}
```

Side effects: creates a fulcrum-managed terminal in the task's worktree and
writes the agent's launch command. Also transitions the task to
`IN_PROGRESS` if it was not already.

### `fulcrum tasks kill-agent <id>`

```json
{
  "schema_version": 1,
  "verb": "tasks.kill-agent",
  "task_id": "<id>",
  "terminals_affected": 2
}
```

### `fulcrum apps list`

```json
{ "schema_version": 1, "verb": "apps.list", "total": 5, "apps": [AppSummary, ...] }
```

### `fulcrum apps get <id>`

```json
{ "schema_version": 1, "verb": "apps.get", "app": AppSummary, "services": [...] }
```

### `fulcrum apps deploy <id>`

```json
{
  "schema_version": 1,
  "verb": "apps.deploy",
  "success": true,
  "deployment_id": "<id>" | null,
  "error": "<text>" | null
}
```

### `fulcrum apps stop <id>`

```json
{ "schema_version": 1, "verb": "apps.stop", "success": true, "error": null }
```

### `fulcrum apps rollback <id> <deployment-id>`

```json
{
  "schema_version": 1,
  "verb": "apps.rollback",
  "success": true,
  "deployment_id": "<id>" | null,
  "error": null
}
```

### `fulcrum apps logs <id> [--service] [--tail]`

```json
{
  "schema_version": 1,
  "verb": "apps.logs",
  "app_id": "<id>",
  "service": "<name>" | null,
  "logs": "<raw log text>"
}
```

### `fulcrum search <query> [--limit]`

```json
{
  "schema_version": 1,
  "verb": "search",
  "query": "<query>",
  "total": 17,
  "results": [
    {
      "entityType": "task" | "project" | "message" | "event" | "memory" | "conversation",
      "id": "<id>",
      "title": "<title>",
      "snippet": "<context>",
      "score": 0.83,
      "metadata": { ... }
    },
    ...
  ]
}
```

### `fulcrum monitor`

```json
{
  "schema_version": 1,
  "verb": "monitor",
  "host_id": "local",
  "window": "1h",
  "cpu_percent": 12.5,
  "memory_percent": 40.2,
  "disk_percent": null
}
```

### `fulcrum jobs [--scope=all|user|system]`

```json
{
  "schema_version": 1,
  "verb": "jobs",
  "scope": "all",
  "total": 4,
  "jobs": [JobSummary, ...]
}
```

### `fulcrum projects`

```json
{
  "schema_version": 1,
  "verb": "projects",
  "total": 3,
  "projects": [
    {
      "id": "<id>",
      "name": "<name>",
      "description": "<text>" | null,
      "status": "active" | "archived",
      "defaultAgent": "claude" | "opencode" | null,
      "taskCounts": { "total": 12, "active": 4 }
    }
  ]
}
```

### `fulcrum help`

Plugin entry for `/f help` — returns every top-level fulcrum CLI verb so the
plugin can render a bot post (not an ephemeral) listing the command surface.

```json
{
  "schema_version": 1,
  "verb": "help",
  "verbs": [
    { "name": "tasks", "description": "Task verbs for Mattermost plugin contract" },
    { "name": "apps", "description": "App verbs for Mattermost plugin contract" },
    { "name": "projects", "description": "List projects" },
    { "name": "status", "description": "Show server status" },
    { "name": "doctor", "description": "Check dependencies and system status" }
  ]
}
```

`verbs` lists every entry registered in `cli/src/index.ts`'s top-level
`subCommands`, including non-plugin operator verbs (`up`, `down`, `expose`,
`doctor`, ...) so `/f help` doubles as a CLI surface inventory. The list is
defined in `cli/src/commands/help.ts:HELP_VERBS`; see the unit test for the
required-presence contract.

`fulcrum help --json=false` prints the same list in padded plain text for
operator debugging.

## Shared shapes

### `TaskSummary`

```json
{
  "id": "<id>",
  "title": "<text>",
  "status": "TO_DO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "CANCELED",
  "priority": "high" | "medium" | "low" | null,
  "type": "worktree" | "scratch" | "draft" | null,
  "projectId": "<id>" | null,
  "tags": ["<tag>", ...],
  "dueDate": "YYYY-MM-DD" | null,
  "agent": "claude" | "opencode",
  "worktreePath": "<path>" | null,
  "prUrl": "<url>" | null,
  "startedAt": "<ISO-8601>" | null,
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>"
}
```

### `AppSummary`

```json
{
  "id": "<id>",
  "name": "<name>",
  "status": "running" | "building" | "failed" | "stopped" | "pending",
  "branch": "<branch>",
  "repository": "<displayName>" | null,
  "lastDeployedAt": "<ISO-8601>" | null,
  "lastDeployCommit": "<sha>" | null,
  "autoDeployEnabled": true
}
```

### `JobSummary`

```json
{
  "name": "<unit-name>",
  "scope": "user" | "system",
  "state": "active" | "inactive" | "failed" | "waiting",
  "enabled": true,
  "nextRun": "<ISO-8601>" | null,
  "lastRun": "<ISO-8601>" | null,
  "lastResult": "success" | "failed" | "unknown" | null,
  "schedule": "<systemd OnCalendar / cron>" | null
}
```

## Version policy

- Additive, backwards-compatible changes (new optional fields, new verbs)
  keep `schema_version = 1`.
- Renames, removed fields, or changed field semantics bump `schema_version`
  to `2` and require a coordinated `mattermost-plugin-fulcrum` release.
- The plugin reads `schema_version` from every response and refuses to
  render unsupported versions.

## See also

- Pure payload builders + filter logic:
  [`cli/src/commands/mattermost-verbs.ts`](src/commands/mattermost-verbs.ts)
- Unit tests:
  [`cli/src/__tests__/commands/mattermost-verbs.test.ts`](src/__tests__/commands/mattermost-verbs.test.ts)
- Umbrella issue:
  [#221](https://github.com/Mouriya-Emma/fulcrum/issues/221)
