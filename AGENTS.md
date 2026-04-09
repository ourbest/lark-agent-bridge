# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

`codex-bridge` is a bridge service connecting Codex project instances to IM sessions (Feishu/Lark). It manages one-to-one bindings between `projectInstanceId` and `chatId`, routes inbound IM messages to bound Codex projects, and sends replies back to the originating IM session.

**Runtime**: Node.js 24 with ES modules and `--experimental-strip-types` flag.

## Common Commands

```bash
npm test           # Run all tests
npm run dev        # Start bridge in dev mode
npm start          # Start bridge in production mode
```

**Single test file**: Node 24 native test runner supports glob patterns:
```bash
node --experimental-strip-types --test tests/core/binding/binding-service.test.ts
```

**Start the bridge directly**:
```bash
node --experimental-strip-types src/main.ts
```

## Architecture

```
src/main.ts                    # Entry point - resolves config and starts runtime
├── src/app.ts                 # BridgeRuntime factory - wires core components
│   ├── BindingService         # Manages projectInstanceId <-> sessionId bindings + observer
│   ├── BridgeRouter           # Routes inbound messages to registered project handlers
│   ├── LarkAdapter            # Normalizes Lark events into InboundMessage
│   └── createApiServer()     # HTTP API (port 3000)
├── src/storage/
│   ├── binding-store.ts       # InMemoryBindingStore (volatile)
│   └── json-binding-store.ts  # File-persisted bindings (./data/bridge.json)
├── src/adapters/
│   ├── lark/                  # Feishu/Lark transport layer
│   │   ├── adapter.ts         # LarkAdapter + LarkTransport interface
│   │   └── feishu-websocket.ts  # Official SDK WebSocket transport
│   └── codex/                 # Codex app-server client
│       └── app-server-client.ts  # WebSocket client for Codex
└── src/runtime/
    ├── bootstrap.ts           # Config resolution + local dev transport
    ├── feishu-config.ts       # Feishu credentials and WS config
    ├── codex-config.ts        # Codex project configs + loadProjectsFromFile()
    └── project-registry.ts    # Dynamic project connection manager (lazy connections)
```

### Message Flow

1. **Inbound**: Lark event → `LarkAdapter.normalizeInboundEvent()` → `InboundMessage`
2. **Route**: `BridgeRouter.routeInboundMessage()` → looks up binding → calls registered project handler
3. **Outbound**: Project handler returns `ProjectReply` → `OutboundMessage` → Lark transport

### Dynamic Project Connections

- Codex project connections are established **on-demand** when a chat is first bound to a project
- Connections are **released** when all chats bound to that project are unbound
- Configuration via `projects.json` file lists available projects
- `BRIDGE_PROJECTS_ROOT` can add implicit projects from non-hidden subdirectories
- `providers: []` means "use the default provider list" (`codex`, `cc`, `qwen`)
- Each project tracks one active provider at a time; switching providers should reuse any already-started provider instance and not stop inactive ones
- No provider connections exist at startup — they are created lazily

### Binding Storage

Bindings persist to `BRIDGE_STORAGE_PATH` (default `./data/bridge.json`). Two store implementations:
- `InMemoryBindingStore` - for testing or ephemeral runs
- `JsonBindingStore` - file-backed, survives restarts

### Transport Modes

- **Feishu WebSocket** (production): `createFeishuWebSocketTransport` — official `@larksuiteoapi/node-sdk` WebSocket client
- **Local dev**: `LocalDevLarkTransport` — in-process, console-based I/O for development without Feishu

### Console Commands (via Feishu chat)

| Command | Description |
|---------|-------------|
| `//bind <projectId>` | Bind this chat to a project |
| `//unbind` | Unbind this chat |
| `//list` | Show current binding |
| `//projects` | List all visible projects |
| `//providers` | List providers for the bound project |
| `//provider <name>` | Switch the active provider |
| `//sessions` | Show bridge binding plus Codex project state |
| `//reload projects` | Reload `projects.json` immediately |
| `//resume <threadId|last>` | Resume a Codex thread for the current chat |
| `//help` | Show help |
| `//app/list` | List supported Codex apps for the bound project |
| `//session/list` | List Codex sessions for the bound project |
| `//thread/list` | List Codex threads for the bound project |
| `//thread/read <id>` | Inspect one Codex thread |

## HTTP API (port 3000)

| Method | Path | Description |
|--------|------|-------------|
| POST | /bindings | Create binding `{projectInstanceId, sessionId}` |
| GET | /bindings/project/:id | Lookup session by project |
| GET | /bindings/session/:id | Lookup project by session |
| DELETE | /bindings/project/:id | Unbind project |
| DELETE | /bindings/session/:id | Unbind session |
| GET | /health | Health check |

## Configuration Files

### projects.json — Project definitions

```json
{
  "projects": [
    {
      "projectInstanceId": "project_a",
      "cwd": "/path/to/project_a",
      "providers": [
        { "provider": "codex", "transport": "stdio" }
      ]
    }
  ]
}
```

Loaded by `loadProjectsFromFile()` at startup.

## Environment Variables

**Bridge server**:
- `BRIDGE_HOST` - server bind host (default 127.0.0.1)
- `BRIDGE_PORT` - server port (default 3000)
- `BRIDGE_STORAGE_PATH` - binding store path (default ./data/bridge.json)

**Feishu WebSocket transport**:
- `FEISHU_APP_ID` - Feishu application App ID
- `FEISHU_APP_SECRET` - Feishu application App Secret
- `BRIDGE_FEISHU_WS_ENABLED=1` - enable Feishu WebSocket transport

**Projects configuration**:
- `BRIDGE_PROJECTS_FILE` - path to projects.json (default ./projects.json)
- `BRIDGE_PROJECTS_ROOT` - auto-discovery root for project folders
