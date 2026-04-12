# lark-agent-bridge

`lark-agent-bridge` is a bridge service that connects Codex project instances to Feishu/Lark chat sessions.

It keeps a one-to-one binding between a `projectInstanceId` and a chat session, routes inbound messages to the bound Codex project, and sends replies back to the same chat. The bridge also supports lazy project startup, multiple providers per project, and a local development mode that does not require Feishu.

## What It Does

- Bind one chat session to one project at a time
- Route messages from Feishu/Lark to the bound project
- Send project replies back to the same chat
- Start Codex provider connections lazily on first use
- Release provider connections when no chats are bound
- Support multiple providers per project, including switching the active provider
- Read project files with `//read` and send them as a file when the Feishu file upload permission is available, with text fallback if upload fails
- Expose a small HTTP API for binding management

## Requirements

- Node.js 24
- `codex` CLI for local Codex app-server projects
- `@qwen-code/sdk` and a local Qwen binary if you use Qwen-backed projects
- Feishu bot app credentials if you want to connect to Feishu
- `pm2` if you want process management and `//restart` support in production

## Install

```bash
npm install
```

## Configure Projects

Copy the example config and edit it:

```bash
cp projects.json.example projects.json
```

Example:

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

### OpenCode Projects

If you want to bind a Feishu chat to an OpenCode-backed project, configure it like this:

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

## Run

### Local development mode

If Feishu is not configured, the bridge runs in local development mode. Messages are written to stdout instead of being sent to Feishu.

```bash
npm run dev
```

### Feishu WebSocket mode

Set Feishu credentials and enable the Feishu WebSocket transport:

```bash
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
BRIDGE_FEISHU_WS_ENABLED=1
```

Then start the bridge:

```bash
npm start
```

The bridge listens on `http://127.0.0.1:3000` by default and stores bindings in `./data/bridge.json`.

### Production with pm2

```bash
pm2 start ecosystem.config.cjs
pm2 logs lark-agent-bridge
pm2 save
```

Useful lifecycle commands:

```bash
pm2 restart lark-agent-bridge
pm2 stop lark-agent-bridge
pm2 delete lark-agent-bridge
```

The `//restart` command exits with code `0`, and `pm2` can restart the process automatically.

## Chat Commands

Commands are sent in Feishu/Lark chat with the `//` prefix.

### Bridge Commands

| Command | Description |
|---------|-------------|
| `//bind <projectId>` | Bind this chat to a project |
| `//unbind` | Unbind this chat |
| `//list` | Show current binding |
| `//projects` | List all visible projects |
| `//providers` | List providers for the bound project |
| `//provider <name>` | Switch the active provider |
| `//status` | Show bridge and Codex state |
| `//sessions` | Alias for `//status` |
| `//read <path>` | Read a file from the project cwd and send it to chat |
| `//restart` | Restart the bridge process |
| `//reload projects` | Reload `projects.json` |
| `//resume <threadId\|last>` | Resume a Codex thread |
| `//new` | Start a fresh Codex thread |
| `//model <name>` | Update the bound project's model |
| `//help` | Show help |

### Approval Commands

| Command | Description |
|---------|-------------|
| `//approvals` | List pending approval requests |
| `//approve <id>` | Approve one request |
| `//approve-all <id>` | Approve one request for the session |
| `//approve-auto <minutes>` | Auto-approve approval requests in this chat for N minutes |
| `//deny <id>` | Deny one request |

### Codex Commands

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

Bare commands without `//` are rejected.

## HTTP API

The bridge exposes a small HTTP API on port `3000` by default.

```text
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

## Development

### Run tests

```bash
npm test
```

### Run one test file

Node 24 supports native test file globs:

```bash
node --experimental-strip-types --test tests/core/binding/binding-service.test.ts
```

### Run the bridge directly

```bash
node --experimental-strip-types src/main.ts
```

### Development entry points

- `npm run dev` starts the bridge in development mode
- `npm start` starts the bridge in production mode
- `src/main.ts` is the main runtime entry point
- `src/app.ts` wires the bridge runtime
- `src/runtime/bootstrap.ts` resolves runtime config and local dev transport
- `src/adapters/lark/feishu-websocket.ts` contains the Feishu WebSocket transport
- `src/runtime/project-registry.ts` manages lazy project connections

## Configuration

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
| `BRIDGE_STARTUP_NOTIFY_OPENID` | Optional open ID used for startup notifications |

### Codex project override

For single-project console mode:

| Variable | Description |
|----------|-------------|
| `BRIDGE_CONSOLE` | Set to `1` for console mode |
| `BRIDGE_CONSOLE_PROJECT_INSTANCE_ID` | Project to bind |
| `BRIDGE_CODEX_CWD` | Project working directory |
| `BRIDGE_CODEX_QWEN_EXECUTABLE` | Full path to the Qwen binary for Qwen-backed projects |

## Notes

- Each chat can only be bound to one project at a time
- Codex connections are established lazily when a chat first binds to a project
- Connections are released when all bound chats are unbound
- `//read` tries to upload a file to Feishu first, then falls back to text if file upload is unavailable

