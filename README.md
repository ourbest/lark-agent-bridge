# lark-agent-bridge

Bridge service connecting Codex project instances to Feishu/Lark chat sessions. Send messages to a chat, and the bound Codex project responds.

`lark-agent-bridge` connects one Feishu/Lark chat session to one Codex project instance at a time. It supports project auto-discovery, lazy Codex connection startup, and switching between multiple providers per project.

## Prerequisites

- **Node.js 24**
- **codex CLI** (if running Codex app-server projects locally)
- **Qwen Code + `@qwen-code/sdk`** (if running Qwen-backed projects locally)
- **pm2** (optional, for production deployment with `//restart` support)
- **Feishu bot app** (if using Feishu transport)

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure projects

Copy the example config and edit:

```bash
cp projects.json.example projects.json
```

Edit `projects.json` with your project paths:

```json
{
  "projects": [
    {
      "projectInstanceId": "my-project",
      "cwd": "/path/to/your/project"
    },
    {
      "projectInstanceId": "my-qwen-project",
      "cwd": "/path/to/your/project",
      "providers": [
        { "provider": "codex", "transport": "stdio" },
        { "provider": "qwen", "transport": "stdio" }
      ]
    }
  ]
}
```

If `providers` is omitted or set to `[]`, the bridge uses the default provider list: `codex`, `cc`, and `qwen`.

### OpenCode projects

If you want to bind a Feishu chat to **OpenCode** and run one `opencode serve` per repo, configure:

```json
{
  "projects": [
    {
      "projectInstanceId": "repo-a",
      "cwd": "/path/to/repo-a",
      "opencodeHostname": "127.0.0.1",
      "opencodePort": 4101
    }
  ]
}
```

### 3. Configure Feishu (optional)

Create a `.env` file for Feishu WebSocket transport:

```bash
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
BRIDGE_FEISHU_WS_ENABLED=1
```

If `BRIDGE_FEISHU_WS_ENABLED` is not set, the bridge runs in local dev mode - messages are logged to stdout instead of sent to Feishu.

### 4. Start the bridge

```bash
npm start
```

The bridge listens on `http://127.0.0.1:3000` and stores bindings in `./data/bridge.json`.

## Project Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `projectInstanceId` | Yes | Unique identifier for the project |
| `cwd` | Yes | Working directory for the project |
| `providers` | No | Provider list; omit or set `[]` to use the default `codex` / `cc` / `qwen` list |
| `providers[].provider` | Yes | `codex`, `cc`, or `qwen` |
| `providers[].transport` | No | `stdio` or `websocket` (defaults to `stdio`; Codex defaults to `stdio`) |
| `providers[].port` | No | WebSocket port; if omitted, the bridge picks one automatically |
| `opencodeHostname` | No | OpenCode server hostname (default `127.0.0.1`) |
| `opencodePort` | No | OpenCode server port (recommended to set per repo) |
| `opencodeCommand` | No | OpenCode executable (default `opencode`) |
| `opencodeExtraArgs` | No | Extra args for `opencode serve` (array of strings) |
| `opencodeUsername` | No | HTTP basic auth username (optional) |
| `opencodePassword` | No | HTTP basic auth password (optional) |

## Provider Behavior

- The default provider order is `codex`, `cc`, then `qwen`
- `//providers` shows the providers available for the currently bound project
- `//provider <name>` switches the active provider for the current project
- Switching providers does not automatically stop inactive providers
- If an inactive provider is already running, the bridge reuses it when you switch back
- If an inactive provider has never started, the bridge does not start it proactively
- `websocket` providers can omit `port`; the bridge will choose an available port automatically

## Bridge Commands

In a bound Feishu chat, use these commands:

| Command | Description |
|---------|-------------|
| `//bind <projectId>` | Bind this chat to a project |
| `//unbind` | Unbind this chat |
| `//list` | Show current binding |
| `//projects` | List all visible projects |
| `//providers` | List providers for the bound project |
| `//provider <name>` | Switch the active provider for the bound project |
| `//status` | Show bridge and Codex state |
| `//sessions` | Alias for `//status` |
| `//read <path>` | Read a file from the project's `cwd` |
| `//restart` | Restart the bridge (pm2 only) |
| `//reload projects` | Reload `projects.json` |
| `//resume <threadId\|last>` | Resume a Codex thread |
| `//new` | Start a fresh Codex thread for this chat |
| `//model <name>` | Update the bound project's model |
| `//help` | Show help |

## Approval Commands

Use these commands while the bridge is waiting for approval:

| Command | Description |
|---------|-------------|
| `//approvals` | List pending approval requests for this chat |
| `//approve <id>` | Approve one request |
| `//approve-all <id>` | Approve one request and remember it for this session |
| `//approve-auto <minutes>` | Auto-approve approval requests in this chat for N minutes |
| `//deny <id>` | Deny one request |

## Codex Commands

These commands are forwarded to the bound Codex project:

| Command | Description |
|---------|-------------|
| `//session/list` | List Codex sessions |
| `//session/get <id>` | Inspect one Codex session |
| `//thread/list` | List Codex threads |
| `//thread/get <id>` | Inspect one Codex thread |
| `//thread/read <id>` | Read a thread with richer summary output |
| `//review` | Review the current working tree |
| `//review --base <branch>` | Review against a branch |
| `//review --commit <sha>` | Review a specific commit |
| `//review <instructions>` | Review with custom instructions |

These commands render as cards when sent with the `//` prefix. Bare commands without `//` are rejected.

```
//app/list
//session/list
//thread/list
//thread/read <id>
//review
```

## HTTP API

```
POST   /bindings                    # Create binding
GET    /bindings/project/:id        # Lookup session by project
GET    /bindings/session/:id        # Lookup project by session
DELETE /bindings/project/:id        # Unbind project
DELETE /bindings/session/:id        # Unbind session
GET    /health                     # Health check
```

Example:

```bash
curl -X POST http://127.0.0.1:3000/bindings \
  -H 'content-type: application/json' \
  -d '{"projectInstanceId":"my-project","sessionId":"chat-id-from-feishu"}'
```

## Production Deployment with pm2

```bash
pm2 start ecosystem.config.cjs
pm2 logs lark-agent-bridge
pm2 save
```

Lifecycle commands:

```bash
pm2 restart lark-agent-bridge
pm2 stop lark-agent-bridge
pm2 delete lark-agent-bridge
```

The `//restart` command exits with code 0, and pm2 automatically starts a fresh process.

## Environment Variables

### Bridge server

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_HOST` | `127.0.0.1` | Server bind host |
| `BRIDGE_PORT` | `3000` | Server port |
| `BRIDGE_STORAGE_PATH` | `./data/bridge.json` | Binding store path |
| `BRIDGE_PROJECTS_FILE` | `./projects.json` | Projects config path |
| `BRIDGE_PROJECTS_ROOT` | not set | Auto-discover projects from non-hidden subdirectories |
| `BRIDGE_APP_NAME` | `lark-agent-bridge` | Display name used in startup notifications |

### Feishu

| Variable | Description |
|----------|-------------|
| `FEISHU_APP_ID` | Feishu application App ID |
| `FEISHU_APP_SECRET` | Feishu application App Secret |
| `BRIDGE_FEISHU_WS_ENABLED` | Set to `1` to enable Feishu WebSocket transport |

### Codex project override

For single-project console mode:

| Variable | Description |
|----------|-------------|
| `BRIDGE_CONSOLE` | Set to `1` for console mode |
| `BRIDGE_CONSOLE_PROJECT_INSTANCE_ID` | Project to bind |
| `BRIDGE_CODEX_CWD` | Project working directory |
| `BRIDGE_CODEX_QWEN_EXECUTABLE` | Full path to the Qwen binary for Qwen-backed projects |

## Notes

- Each chat can only be bound to **one** project at a time
- Codex connections are established **lazily** when a chat first binds to a project
- Connections are released when **all** bound chats are unbound
- Internal plan documents are excluded from git (see `docs/` in `.gitignore`)
