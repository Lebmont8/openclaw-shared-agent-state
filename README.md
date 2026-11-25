# OpenClaw Shared Agent State

An OpenClaw plugin for several trusted Telegram entry points that share one
agent workspace. It provides atomic, provenance-aware memory writes and a
TaskFlow ledger with exclusive project locks.

## Why

Multiple bot accounts can point to the same OpenClaw agent but still have
separate live sessions. Without coordination, two sessions may overwrite the
same project or record contradictory memory. This plugin gives them two narrow
tools:

- `shared_memory_remember` — confirmed memory with source, confidence, scope,
  correction links, atomic writes, and a private audit trail
- `shared_task_ledger` — task start/update/block/complete/fail plus exclusive
  `lockKey` conflict detection

## Install

```bash
openclaw plugins install git:github.com/Lebmont8/openclaw-shared-agent-state
```

```json
{
  "plugins": {
    "entries": {
      "shared-agent-state": {
        "enabled": true,
        "config": {
          "ownerTelegramId": "123456789",
          "agentId": "main",
          "allowedAccountIds": ["default", "assistant_x", "assistant_y"],
          "accountNames": {
            "default": "Assistant",
            "assistant_x": "Assistant X",
            "assistant_y": "Assistant Y"
          },
          "timeZone": "Europe/Berlin"
        }
      }
    }
  }
}
```

The plugin fails closed outside the configured owner's direct Telegram chats.
It never stores secrets intentionally and rejects common token/key shapes.

## Project-lock flow

```text
list active tasks -> start with lockKey -> update -> complete/fail
```

A second entry point trying to start work with the same active `lockKey`
receives a conflict containing the current owner and task status.

## Development

```bash
npm run verify
npm pack --dry-run
```

MIT licensed.

## Verification scope

GitHub Actions runs the existing network-free checks on Node.js 22 and 24. These tests do not log into a provider, restart a Gateway, or prove compatibility with every OpenClaw release. Verify your installed runtime API before deployment; model identifiers in configuration examples must exist in your own account.
