# Enforcement hooks

Mechanical enforcement only; judgment stays with agents. Three hooks:

| Script | Event | Scope (self-enforced) | Effect |
|---|---|---|---|
| `deny-frozen-tests.js` | PreToolUse on Edit/Write/NotebookEdit | every agent, while the active run has a frozen suite | denies the write with the reason fed back |
| `format-on-edit.js` | PostToolUse on Edit/Write/NotebookEdit | `olympus:hephaestus` only | runs the config's format command on the edited file; failures feed back |
| `budget-backstop.js` | PostToolUse on every tool | `olympus:hephaestus` only | past the byte threshold: tells the agent to stop and records a breach marker |

## Why these install into the project, not the plugin

Verified empirically (CLI 2.1.201): hooks declared in a plugin agent's
frontmatter do **not** fire, and `${CLAUDE_PLUGIN_ROOT}` does not resolve in
that context. Project-level hooks in `.claude/settings.json` DO fire for
every subagent's tool calls, and payloads carry `agent_type` — so the
scripts scope themselves.

The init step therefore **copies this directory into the target project**
at `.olympus/hooks/` and registers the hooks in the project's
`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.olympus/hooks/deny-frozen-tests.js\"", "timeout": 10 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.olympus/hooks/format-on-edit.js\"", "timeout": 120 }
        ]
      },
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/.olympus/hooks/budget-backstop.js\"", "timeout": 10 }
        ]
      }
    ]
  }
}
```

Copies version with the project; a plugin upgrade refreshes them only when
init is re-run. Every deny/allow decision lands in
`.olympus/state/hook-trace.log` for audit.

The hooks fail open by design: they are defense in depth. The workflow's
verdict (frozen-SHA diff check, suite by command) remains the authority.
