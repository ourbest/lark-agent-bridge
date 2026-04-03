# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`codex-bridge` is a bridge service connecting Codex project instances to IM sessions (primarily Feishu/Lark). It manages one-to-one bindings between `projectInstanceId` and `chatId`, routes inbound IM messages to bound Codex projects, and sends replies back to the originating IM session.

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
│   ├── BindingService         # Manages projectInstanceId <-> sessionId bindings
│   ├── BridgeRouter           # Routes inbound messages to registered project handlers
│   ├── LarkAdapter            # Normalizes Lark events into InboundMessage
│   └── createApiServer()     # HTTP API (port 3000)
├── src/storage/
│   ├── binding-store.ts       # InMemoryBindingStore (volatile)
│   └── json-binding-store.ts  # File-persisted bindings (./data/bridge.json)
├── src/adapters/
│   ├── lark/                  # Feishu/Lark transport layer
│   │   ├── adapter.ts         # LarkAdapter + LarkTransport interface
│   │   └── openclaw-lite-transport.ts  # Plugin process transport
│   └── codex/                 # Codex app-server client
│       └── app-server-client.ts  # WebSocket client for Codex
└── src/runtime/
    ├── bootstrap.ts           # Config resolution + local dev transport
    ├── codex-config.ts        # Codex project runtime configs (env-driven)
    ├── codex-project-registry.ts  # Manages multiple Codex project sessions
    └── openclaw-lite-config.ts   # Plugin runtime configuration
```

### Message Flow

1. **Inbound**: Lark event → `LarkAdapter.normalizeInboundEvent()` → `InboundMessage`
2. **Route**: `BridgeRouter.routeInboundMessage()` → looks up binding → calls registered project handler
3. **Outbound**: Project handler returns `ProjectReply` → `OutboundMessage` → Lark transport

### Binding Storage

Bindings persist to `BRIDGE_STORAGE_PATH` (default `./data/bridge.json`). Two store implementations:
- `InMemoryBindingStore` - for testing or ephemeral runs
- `JsonBindingStore` - file-backed, survives restarts

### Transport Modes

- **Default (local dev)**: `LocalDevLarkTransport` - in-process, console-based I/O
- **Plugin runtime**: `OpenClawLiteTransport` - spawns a plugin subprocess for Feishu channel integration
- **Codex connection**: `CodexAppServerClient` connects to Codex app-server via WebSocket (or console mode for stdin/stdout)

## HTTP API (port 3000)

| Method | Path | Description |
|--------|------|-------------|
| POST | /bindings | Create binding `{projectInstanceId, sessionId}` |
| GET | /bindings/project/:id | Lookup session by project |
| GET | /bindings/session/:id | Lookup project by session |
| DELETE | /bindings/project/:id | Unbind project |
| GET | /health | Health check |

## Environment Variables

**Bridge server**:
- `BRIDGE_HOST` - server bind host (default 127.0.0.1)
- `BRIDGE_PORT` - server port (default 3000)
- `BRIDGE_STORAGE_PATH` - binding store path (default ./data/bridge.json)

**Transport mode**:
- `BRIDGE_OPENCLAW_LITE_ENABLED=1` - enable plugin runtime (instead of local dev transport)
- `BRIDGE_OPENCLAW_LITE_PLUGIN_COMMAND` - plugin executable path
- `BRIDGE_OPENCLAW_LITE_PLUGIN_ARGS_JSON` - plugin args as JSON array
- `BRIDGE_OPENCLAW_LITE_PLUGIN_CWD` - plugin working directory
- `BRIDGE_OPENCLAW_LITE_PLUGIN_ENV_JSON` - plugin env vars as JSON

**Codex runtime**:
- `BRIDGE_CONSOLE=1` - terminal console mode (stdin/stdout)
- `BRIDGE_CODEX_PROJECT_INSTANCE_ID` - project instance ID for console mode
- `BRIDGE_CODEX_WEBSOCKET_URL` - Codex app-server WebSocket URL (default ws://127.0.0.1:4000)

**Multiple Codex projects** (via `BRIDGE_CODEX_RUNTIMES_JSON`):
```json
[{"projectInstanceId":"project-a","command":"codex","args":["app-server"],"cwd":".","serviceName":"my-service","transport":"websocket","websocketUrl":"ws://127.0.0.1:4000"}]
```
