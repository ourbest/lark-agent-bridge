# Project Agent Restart Design

## Overview

Add the ability to hot-restart a specific provider agent (Codex/Claude/Qwen/etc.) for a bound project without restarting the entire bridge process.

The existing `//restart` command — which triggers a full bridge restart via `process.exit(0)` — is **preserved unchanged**. The new capability is accessed via `//restart <provider>`, e.g. `//restart cc` or `//restart codex`.

## Motivation

- When a project's `model`, `args`, or `cwd` changes in `projects.json`, users currently must restart the entire bridge to pick up the new config.
- Provider processes occasionally get into a bad state (stuck, OOM, protocol desync). Users need a way to kill and respawn a specific provider without losing other bindings or the bridge itself.
- The bridge runs under PM2; a full restart disconnects all active sessions across all projects.

## Command Semantics

| Command | Behavior |
|---------|----------|
| `//restart` | **Unchanged.** Restarts the entire bridge process (existing `process.exit(0)` flow). |
| `//restart <provider>` | **New.** Hot-restarts the specified provider for the currently bound project. Reloads the project's configuration before respawning the provider. |

Examples:
- `//restart codex` — stop and respawn the `codex` provider for the bound project
- `//restart cc` — stop and respawn the `cc` provider for the bound project

## Architecture

### Component Changes

```
User sends //restart cc
  → chatCommandService.execute()
    → parseCommand() → { command: 'restart', args: ['cc'] }
    → bindingService.getProjectBySession() → projectId
    → projectRegistry.restartProjectProvider(projectId, 'cc')
      → activeProjects.get(projectId) → entry
      → fetch latest config via options.getProjectConfig(projectId)
      → entry.providerManager.updateConfig(latestConfig)
      → entry.providerManager.restartProvider('cc')
        → stopProvider('cc')       // kill subprocess, clear client ref
        → createStartedClient('cc') // respawn with fresh config
      → re-attach output handlers to the new client
    → return success message
  → larkAdapter sends result card
```

### 1. ProviderManager

Make `projectConfig` mutable and expose two new methods:

```ts
class ProviderManager {
  // was: private readonly projectConfig
  private projectConfig: ProviderManagerProjectConfig;

  updateProjectConfig(config: ProviderManagerProjectConfig): void {
    this.projectConfig = {
      ...config,
      providers:
        Array.isArray(config.providers) && config.providers.length > 0
          ? config.providers.map(cloneDescriptor)
          : defaultProviderDescriptors(),
    };
  }

  async restartProvider(providerId: string): Promise<void> {
    await this.stopProvider(providerId);
    // stopProvider clears entry.client to null;
    // createStartedClient will respawn the subprocess.
    await this.createStartedClient(providerId);
  }

  // Expose stopProvider for ProjectRegistry to call directly if needed
  async stopProvider(providerId: string): Promise<void> { ... }
}
```

`createStartedClient` already uses `this.projectConfig`, so after `updateProjectConfig` the new client will be spawned with the latest settings (model, args, cwd, etc.).

### 2. ProjectRegistry Interface & Implementation

Add to the `ProjectRegistry` interface:

```ts
export interface ProjectRegistry {
  // ... existing methods
  restartProjectProvider(projectInstanceId: string, provider: string): Promise<void>;
}
```

Implementation in `createProjectRegistry`:

```ts
async restartProjectProvider(projectInstanceId: string, provider: string): Promise<void> {
  const entry = activeProjects.get(projectInstanceId);
  if (!entry) {
    throw new Error(`Project ${projectInstanceId} is not active`);
  }

  // 1. Reload configuration
  const config = options.getProjectConfig(projectInstanceId);
  if (!config) {
    throw new Error(`Project ${projectInstanceId} is no longer configured`);
  }

  // 2. Update entry and ProviderManager with latest config
  entry.config = config;
  entry.providerManager.updateProjectConfig(config);

  // 3. Restart the specific provider
  await entry.providerManager.restartProvider(provider);

  // 4. Re-attach output handlers to the new client
  const restartedClient = entry.providerManager.getStartedClient(provider);
  if (restartedClient !== null) {
    attachServerRequestHandler(projectInstanceId, provider, restartedClient);
    attachStatusHandler(projectInstanceId, provider, restartedClient);
    attachTextDeltaHandler(projectInstanceId, provider, restartedClient);
    attachThreadChangedHandler(projectInstanceId, provider, restartedClient);
    attachSystemInitHandler(projectInstanceId, provider, restartedClient);
  }
}
```

### 3. Chat Command Service

Add `restartProjectProvider` to `ChatCommandServiceDependencies.projectRegistry`:

```ts
projectRegistry: {
  // ... existing methods
  restartProjectProvider?(projectInstanceId: string, provider: string): Promise<void>;
}
```

Update the `//restart` branch:

```ts
case 'restart': {
  if (parsed.args.length === 0) {
    // Existing behavior — bridge-wide restart
    return ['[lark-agent-bridge] restarting bridge process...'];
  }

  const provider = parsed.args[0];
  const projectId = await dependencies.bindingService.getProjectBySession(input.sessionId);
  if (!projectId) {
    return ['[lark-agent-bridge] no project bound to this chat'];
  }

  if (!dependencies.projectRegistry?.restartProjectProvider) {
    return ['[lark-agent-bridge] provider restart is not configured'];
  }

  // Validate provider exists for this project
  const providers = await dependencies.projectRegistry.listProjectProviders?.(projectId) ?? [];
  const providerExists = providers.some(p => p.id === provider);
  if (!providerExists) {
    const available = providers.map(p => p.id).join(', ') || 'none';
    return [`[lark-agent-bridge] provider '${provider}' not found. Available: ${available}`];
  }

  try {
    await dependencies.projectRegistry.restartProjectProvider(projectId, provider);
    return [`[lark-agent-bridge] restarted ${provider} for ${projectId}`];
  } catch (error) {
    return [`[lark-agent-bridge] failed to restart ${provider}: ${error instanceof Error ? error.message : String(error)}`];
  }
}
```

Update `HELP_CARD_BRIDGE_COMMANDS`:

```ts
{ command: '//restart', description: 'Restart the bridge process.' },
{ command: '//restart <provider>', description: 'Restart a provider for the bound project.' },
```

### 4. App Layer

No changes required. `isRestartCommand` already does an exact match on `//restart`:

```ts
function isRestartCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '//restart';  // '//restart cc' does NOT match
}
```

The post-command `isRestartCommand` check in `app.ts` continues to work exactly as before — it only fires for bare `//restart`.

### 5. Main Layer

Add `restartProjectProvider` to the `projectRegistry` proxy passed into `createBridgeApp`:

```ts
async restartProjectProvider(projectInstanceId: string, provider: string) {
  if (projectRegistryImpl === null) {
    throw new Error('project registry is not initialized');
  }
  await projectRegistryImpl.restartProjectProvider(projectInstanceId, provider);
}
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| No project bound | Return `"no project bound to this chat"` |
| Provider not found for project | Return `"provider 'X' not found. Available: ..."` |
| Project not active | Throw `"Project X is not active"` |
| Project config removed | Throw `"Project X is no longer configured"` |
| Provider stop fails | `stopProvider` catches errors in a `finally` block; client ref is still cleared. Next `createStartedClient` will spawn a fresh process. |
| Provider restart fails (create fails) | Error bubbles up to chat command service and is returned as a friendly message. |

## Edge Cases

- **Active task during restart**: `stopProvider` kills the provider subprocess. Any in-flight `generateReply` will receive an error (connection closed), caught by existing `runProjectReply` error handling.
- **Restarting an idle provider**: If the provider was already stopped by the idle-timeout scanner, `stopProvider` is a no-op. `createStartedClient` respawns it with the latest config.
- **Restarting the active provider while another provider is running**: Only the target provider is affected. Other started providers continue running.
- **Config changes**: Because `updateProjectConfig` is called before `restartProvider`, the new subprocess always uses the latest configuration.

## Testing Strategy

- `provider-manager.test.ts`: Test `updateProjectConfig` and `restartProvider`:
  - `restartProvider` stops and respawns the client.
  - `updateProjectConfig` updates the config used by `createStartedClient`.
- `project-registry.test.ts`: Test `restartProjectProvider`:
  - Reloads config and updates the ProviderManager.
  - Re-attaches output handlers.
  - Throws when project is not active.
- `chat-command-service.test.ts`: Test `//restart` and `//restart cc`:
  - Bare `//restart` returns the existing bridge-restart message.
  - `//restart <provider>` validates provider, calls registry, returns success/failure.

## Files to Modify

| File | Change |
|------|--------|
| `src/runtime/provider-manager.ts` | Make `projectConfig` mutable; add `updateProjectConfig()`; expose `restartProvider()`; make `stopProvider` callable |
| `src/runtime/project-registry.ts` | Add `restartProjectProvider` to interface and implementation |
| `src/commands/chat-command-service.ts` | Add `restartProjectProvider` to deps; update `//restart` branch; update help text |
| `src/main.ts` | Add `restartProjectProvider` to projectRegistry proxy |
