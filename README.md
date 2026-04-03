# codex-bridge

Bridge service for connecting Codex project instances to IM sessions.

## What it does

- Manages one-to-one bindings between `projectInstanceId` and `chatId`
- Routes inbound IM messages to the bound Codex project
- Sends Codex replies back to the original IM session
- Supports a thin `openclaw-lite` plugin runtime for Feishu-style channels
- Supports Codex app-server over `websocket`

## Requirements

- Node.js 24
- `codex` available locally if you want to run a real Codex app-server

## Scripts

```bash
npm test
npm run dev
npm start
```

## Start the bridge

Run the bridge with the default local dev transport:

```bash
/Users/yonghui/.nvm/versions/node/v24.0.2/bin/node --experimental-strip-types src/main.ts
```

The HTTP API listens on `http://127.0.0.1:3000` by default.

## Bind a project to a chat

```bash
curl -X POST http://127.0.0.1:3000/bindings \
  -H 'content-type: application/json' \
  -d '{"projectInstanceId":"project-a","sessionId":"chat-a"}'
```

Lookups:

```bash
curl http://127.0.0.1:3000/bindings/project/project-a
curl http://127.0.0.1:3000/bindings/session/chat-a
```

## Run Codex in background mode

By default the bridge uses Codex app-server over `ws://127.0.0.1:4000`.

Start Codex manually in another terminal:

```bash
codex app-server --listen ws://127.0.0.1:4000
```

Then start the bridge:

```bash
BRIDGE_CODEX_PROJECT_INSTANCE_ID=project-a \
BRIDGE_CODEX_WEBSOCKET_URL=ws://127.0.0.1:4000 \
/Users/yonghui/.nvm/versions/node/v24.0.2/bin/node --experimental-strip-types src/main.ts
```

## Console mode

Console mode lets you type into the terminal and see Codex replies inline:

```bash
BRIDGE_CONSOLE=1 \
BRIDGE_CODEX_PROJECT_INSTANCE_ID=project-a \
BRIDGE_CODEX_WEBSOCKET_URL=ws://127.0.0.1:4000 \
/Users/yonghui/.nvm/versions/node/v24.0.2/bin/node --experimental-strip-types src/main.ts
```

## openclaw-lite plugin runtime

`openclaw-lite` is a thin plugin launcher. It does not call an external OpenClaw gateway.

Enable the bundled plugin runtime:

```bash
BRIDGE_OPENCLAW_LITE_ENABLED=1 \
/Users/yonghui/.nvm/versions/node/v24.0.2/bin/node --experimental-strip-types src/main.ts
```

Or point it at your own plugin process:

```bash
BRIDGE_OPENCLAW_LITE_PLUGIN_COMMAND=/usr/bin/node \
BRIDGE_OPENCLAW_LITE_PLUGIN_ARGS_JSON='["--experimental-strip-types","src/channel/feishu-plugin-process.ts"]' \
/Users/yonghui/.nvm/versions/node/v24.0.2/bin/node --experimental-strip-types src/main.ts
```

Plugin runtime env variables:

- `BRIDGE_OPENCLAW_LITE_PLUGIN_COMMAND`
- `BRIDGE_OPENCLAW_LITE_PLUGIN_ARGS_JSON`
- `BRIDGE_OPENCLAW_LITE_PLUGIN_CWD`
- `BRIDGE_OPENCLAW_LITE_PLUGIN_ENV_JSON`

## Notes

- `chatId` is the routing key on the bridge side
- The plugin runtime only forwards `chatId`, `event`, and `status`
- Rebinding a project replaces the existing session binding

