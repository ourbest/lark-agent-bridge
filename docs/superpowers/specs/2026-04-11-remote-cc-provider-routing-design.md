# Remote CC Provider Routing Design

> **Goal:** Allow one project to expose multiple CC providers, where each provider can connect either over `websocket` or over `ssh + stdio`, so a Feishu chat can switch between remote CC servers with `//provider <id>`.

## Overview

The bridge already models one `projectInstanceId` with multiple providers and an active-provider switch. This design extends that model so a provider can represent a remote CC server instead of only a local process.

The important constraint is that the bridge should keep its current shape:

- one chat binds to one project
- one project can have multiple providers
- only one provider is active at a time
- switching providers should reuse already-started providers when possible

The new work is about transport selection, not about changing the binding model.

## Supported Transports

### `websocket`

The provider connects directly to a remote CC service over WebSocket.

Typical use case:

- the CC server already exposes a WebSocket endpoint
- the bridge only needs to connect and speak the existing provider protocol

### `ssh+stdio`

The provider starts an `ssh` process locally, connects to a remote machine, and uses the remote process stdin/stdout stream as the provider transport.

Typical use case:

- the CC runtime exists only on the remote machine
- the bridge should not require the remote server to expose an inbound WebSocket port
- SSH is already the operational boundary for the target machine

## Configuration Shape

`projects.json` should keep the existing project shape, but each provider entry needs a stable instance id plus transport-specific fields.

Example:

```json
{
  "projects": [
    {
      "projectInstanceId": "project-a",
      "cwd": "/repo/project-a",
      "providers": [
        {
          "id": "cc-east",
          "kind": "cc",
          "transport": "websocket",
          "websocketUrl": "ws://cc-east.example.com:4000"
        },
        {
          "id": "cc-west",
          "kind": "cc",
          "transport": "ssh+stdio",
          "sshHost": "cc-west.example.com",
          "sshUser": "agent",
          "sshCommand": "cc-server --stdio"
        }
      ]
    }
  ]
}
```

Notes:

- the bridge should keep accepting the existing project format
- provider ids remain the user-facing switch target for `//provider <id>`
- transport-specific fields are only validated when that transport is selected

## Runtime Model

### Provider Lifecycle

1. The bridge loads project config and registers providers.
2. No remote provider is started at boot just because it is listed.
3. The first time a provider is selected or used, the bridge creates its client.
4. Switching away from a provider does not stop the provider immediately.
5. Switching back to a started provider reuses the existing client when possible.

### Transport Boundary

The transport layer should own connection mechanics:

- `websocket` transport owns WebSocket dialing and reconnection behavior
- `ssh+stdio` transport owns SSH process startup, process lifetime, and stream wiring

The provider manager should remain transport-agnostic. It should only know:

- which providers exist
- which provider is active
- which provider client is already started
- how to call the client

## Suggested Interfaces

### Provider Config

```typescript
interface ProviderConfig {
  id: string;
  kind: 'codex' | 'cc' | 'qwen' | 'gemini';
  transport: 'websocket' | 'ssh+stdio';
  websocketUrl?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshIdentityFile?: string;
  sshCommand?: string;
  sshArgs?: string[];
}
```

### Transport Factory

```typescript
interface ProviderTransportFactory {
  create(config: ProviderConfig): Promise<CodexProjectClient>;
}
```

The factory chooses the correct implementation based on `transport`.

### SSH Transport Process

The `ssh+stdio` transport should execute a command similar to:

```bash
ssh -p <port> -i <identity> <user>@<host> <remote-command>
```

The bridge should stream the remote process stdin/stdout and treat it like the existing stdio-based provider transport.

The `kind` field identifies the agent family. The `id` field identifies the specific remote instance. That separation is required so one project can contain multiple CC servers without ambiguity.

## Commands and UX

Existing commands should continue to work:

| Command | Behavior |
|---------|----------|
| `//providers` | List all configured providers for the bound project, including transport and started/active state |
| `//provider <id>` | Switch the active provider to the named remote or local provider |
| `//status` | Show the active provider and the per-provider runtime state |

The user should be able to tell whether a provider is:

- configured
- active
- started
- failed to connect

## Error Handling

### Configuration Errors

Reject invalid provider configs early:

- missing `websocketUrl` for `websocket`
- missing `sshHost` or `sshCommand` for `ssh+stdio`
- invalid transport value
- duplicate provider ids in one project

### Connection Errors

Keep provider failures isolated:

- one provider failing to connect should not remove the rest of the project’s providers
- `//providers` should still show healthy providers if one provider is down
- `//provider <id>` should report a clear error when the selected provider cannot start

### SSH-Specific Errors

Separate the common failure modes so operators can diagnose them quickly:

- SSH host unreachable
- authentication failure
- remote command missing
- remote process exits immediately
- transport closes unexpectedly after startup

## Architecture

```text
src/
├── runtime/
│   ├── project-config.ts        -> normalize transport-aware provider config
│   ├── provider-registry.ts     -> represent providers and their transport state
│   └── provider-manager.ts      -> manage active provider selection and reuse
├── adapters/
│   ├── lark/
│   └── codex/
│       ├── websocket-client.ts  -> existing direct remote transport
│       └── ssh-stdio-client.ts  -> new SSH-backed transport
└── commands/
    └── chat-command-service.ts  -> render providers and handle //provider
```

The registry and command layer should not care whether a provider is local, WebSocket-based, or SSH-backed. They only consume the provider state returned by the runtime.

## Testing Strategy

### Config Normalization

- parse `websocket` provider configs
- parse `ssh+stdio` provider configs
- reject invalid or incomplete provider entries
- preserve existing default-provider behavior when `providers` is omitted or empty

### Provider Lifecycle

- switching to a provider starts it lazily
- switching back reuses an already-started provider
- one provider failing does not affect another provider in the same project

### Command Output

- `//providers` lists all configured providers for a project
- provider summaries include transport and active state
- failure messages are specific enough to tell whether the issue is config or connectivity

### SSH Transport

- spawning the SSH-backed client passes the expected host, user, port, and command
- SSH startup failure is surfaced as a provider error
- process exit tears down the provider client cleanly

## Key Design Decisions

1. **Keep the current project model**: one project, many providers, one active provider.
2. **Treat transport as a provider detail**: the runtime chooses between `websocket` and `ssh+stdio` without changing command behavior.
3. **Use lazy startup**: remote providers are only connected when they are selected or first used.
4. **Keep failures local**: one broken remote server should not make the whole project unavailable.
