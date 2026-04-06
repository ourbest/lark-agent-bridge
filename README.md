# codex-bridge

Bridge service connecting Codex project instances to Feishu/Lark chat sessions. Send messages to a chat, and the bound Codex project responds.

## Prerequisites

- **Node.js 24**
- **codex CLI** (if running Codex app-server projects locally)
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
      "command": "codex",
      "args": ["app-server"],
      "cwd": "/path/to/your/project",
      "serviceName": "my-project",
      "transport": "stdio"
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

If `BRIDGE_FEISHU_WS_ENABLED` is not set, the bridge runs in local dev mode — messages are logged to stdout instead of sent to Feishu.

### 4. Start the bridge

```bash
npm start
```

The bridge listens on `http://127.0.0.1:3000` and stores bindings in `./data/bridge.json`.

## Project Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `projectInstanceId` | Yes | Unique identifier for the project |
| `command` | Yes | Command to start Codex (e.g., `codex`) |
| `args` | Yes | Arguments, typically `["app-server"]` |
| `cwd` | Yes | Working directory for the project |
| `serviceName` | Yes | Display name for pm2/logs |
| `transport` | Yes | `stdio` or `websocket` |
| `websocketUrl` | No | Required for `websocket` transport |

## Chat Commands

In a bound Feishu chat, use these commands:

| Command | Description |
|---------|-------------|
| `//bind <projectId>` | Bind this chat to a project |
| `//unbind` | Unbind this chat |
| `//list` | Show current binding |
| `//sessions` | Show binding and project state |
| `//read <path>` | Read a file from the project's `cwd` |
| `//restart` | Restart the bridge (pm2 only) |
| `//reload projects` | Reload `projects.json` |
| `//resume <threadId\|last>` | Resume a Codex thread |
| `//help` | Show help |

Interactive commands (render as cards):

```
app/list
session/list
session/get <id>
thread/list
thread/start
thread/read <id>
```

## HTTP API

```
POST   /bindings                    # Create binding
GET    /bindings/project/:id        # Lookup session by project
GET    /bindings/session/:id       # Lookup project by session
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
pm2 logs codex-bridge
pm2 save
```

Lifecycle commands:

```bash
pm2 restart codex-bridge
pm2 stop codex-bridge
pm2 delete codex-bridge
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

## Notes

- Each chat can only be bound to **one** project at a time
- Each project can be bound to **multiple** chats
- Codex connections are established **lazily** when a chat first binds to a project
- Connections are released when **all** bound chats are unbound
- Internal plan documents are excluded from git (see `docs/` in `.gitignore`)
