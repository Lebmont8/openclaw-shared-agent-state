# OpenClaw Shared Agent State

When several Telegram bots use one OpenClaw agent, each chat still has its own
session. This plugin lets those sessions share memory with source records and use
project locks so two sessions do not edit the same project at once.

## Tools

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
