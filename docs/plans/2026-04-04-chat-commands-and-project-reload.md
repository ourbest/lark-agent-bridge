# Chat Commands And Project Reload Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add bridge-native and Codex pass-through chat commands, including `//sessions`, while supporting dynamic reload of the projects configuration file without dropping healthy active project connections.

**Architecture:** Introduce a command service between the Lark message handler and the existing router so chat commands are parsed once and dispatched either to local bridge state readers or to structured Codex client requests. Extend the runtime project registry to expose active-project status and to reconcile live project definitions against `projects.json` reloads with last-known-good rollback behavior.

**Tech Stack:** Node.js 24, native `node:test`, ES modules, JSON file storage, WebSocket Codex app-server client.

### Task 1: Define command parsing and execution surface

**Files:**
- Create: `src/commands/chat-command-service.ts`
- Create: `tests/commands/chat-command-service.test.ts`
- Modify: `src/app.ts`
- Modify: `src/runtime/project-registry.ts`

**Step 1: Write the failing test**

```ts
test('returns bridge and codex sections for //sessions on a bound chat', async () => {
  const service = createChatCommandService({
    bindingService,
    projectRegistry,
    codexCommandExecutor,
    projectConfigProvider,
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//sessions',
  });

  assert.deepEqual(lines, [
    '[codex-bridge] Bridge State:',
    '  projectId: project-a',
    '  sessionId: chat-a',
    '[codex-bridge] Codex State:',
    '  sessions: 1',
    '  sessionId: thread-1',
  ]);
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/commands/chat-command-service.test.ts`
Expected: FAIL with module or symbol not found for `createChatCommandService`

**Step 3: Write minimal implementation**

Create a command service with:
- `isCommand(text)` to recognize `//...` bridge commands and bare Codex commands such as `app/list` and `session/list`
- `execute(input)` to return help, bindings, sessions, and Codex pass-through results
- formatters that clearly separate `Bridge State` and `Codex State`

Modify `src/app.ts` so the Lark handler delegates all command handling to the new service instead of the current inline switch.

Expose enough project-registry state to answer:
- whether a project is configured
- whether a project is active
- whether a project is marked removed after reload

**Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/commands/chat-command-service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/chat-command-service.ts tests/commands/chat-command-service.test.ts src/app.ts src/runtime/project-registry.ts
git commit -m "feat: add chat command service"
```

### Task 2: Add structured Codex command requests with a whitelist

**Files:**
- Modify: `src/adapters/codex/app-server-client.ts`
- Modify: `src/runtime/codex-project.ts`
- Modify: `src/runtime/project-registry.ts`
- Modify: `tests/adapters/codex/app-server-client.test.ts`
- Modify: `tests/runtime/project-registry.test.ts`
- Modify: `tests/commands/chat-command-service.test.ts`

**Step 1: Write the failing test**

```ts
test('executes whitelisted codex command through the project client', async () => {
  const client = new CodexAppServerClient({
    command: 'codex',
    clientInfo: { name: 'test', title: 'test', version: '1.0.0' },
    transport: 'websocket',
    connectWebSocket: async () => fakeSocket,
    websocketUrl: 'ws://127.0.0.1:4000',
  });

  await client.executeCommand({
    method: 'session/list',
    params: {},
  });

  assert.deepEqual(sentMessages.at(-1), {
    id: 2,
    method: 'session/list',
    params: {},
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/adapters/codex/app-server-client.test.ts tests/runtime/project-registry.test.ts tests/commands/chat-command-service.test.ts`
Expected: FAIL because `executeCommand` does not exist and the registry cannot dispatch Codex commands

**Step 3: Write minimal implementation**

Add:
- `executeCommand({ method, params })` to `CodexAppServerClient`
- a shared `sendRequest` path so command requests and text turns both reuse the same transport lifecycle
- whitelist validation in the command service for the first allowed methods:
  - `app/list`
  - `session/list`
  - `session/get`
  - `thread/get`

Update project-registry-facing client types so a bound project can execute structured Codex commands in addition to `generateReply()`.

**Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/adapters/codex/app-server-client.test.ts tests/runtime/project-registry.test.ts tests/commands/chat-command-service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/codex/app-server-client.ts src/runtime/codex-project.ts src/runtime/project-registry.ts tests/adapters/codex/app-server-client.test.ts tests/runtime/project-registry.test.ts tests/commands/chat-command-service.test.ts
git commit -m "feat: add codex command passthrough"
```

### Task 3: Support dynamic `projects.json` reload with reconciliation

**Files:**
- Create: `src/runtime/project-config-watcher.ts`
- Modify: `src/runtime/codex-config.ts`
- Modify: `src/runtime/bootstrap.ts`
- Modify: `src/runtime/project-registry.ts`
- Modify: `tests/runtime/codex-config.test.ts`
- Modify: `tests/runtime/bootstrap.test.ts`
- Modify: `tests/runtime/project-registry.test.ts`

**Step 1: Write the failing test**

```ts
test('keeps the last good config when projects.json reload is invalid', async () => {
  const watcher = createProjectConfigWatcher({
    filePath,
    onProjectsChanged(projects) {
      received = projects;
    },
  });

  writeFileSync(filePath, '{ invalid json');
  await watcher.reload();

  assert.deepEqual(received, [
    { projectInstanceId: 'project-a', websocketUrl: 'ws://127.0.0.1:4000' },
  ]);
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/runtime/codex-config.test.ts tests/runtime/bootstrap.test.ts tests/runtime/project-registry.test.ts`
Expected: FAIL because there is no watcher/reload path and invalid reloads are not preserved safely

**Step 3: Write minimal implementation**

Add a small watcher/reloader abstraction that:
- loads `projects.json`
- validates entries include `projectInstanceId`
- remembers the last valid snapshot
- notifies the runtime when a new valid snapshot arrives

Update the project registry to reconcile active projects:
- unchanged configured projects stay active
- new projects become available for future binding
- removed projects are marked unavailable for new binding
- active removed projects are only disconnected once their last binding is gone

Wire reload support into bootstrap and expose a command hook so the chat layer can trigger `//reload projects`.

**Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/runtime/codex-config.test.ts tests/runtime/bootstrap.test.ts tests/runtime/project-registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/runtime/project-config-watcher.ts src/runtime/codex-config.ts src/runtime/bootstrap.ts src/runtime/project-registry.ts tests/runtime/codex-config.test.ts tests/runtime/bootstrap.test.ts tests/runtime/project-registry.test.ts
git commit -m "feat: reload project config at runtime"
```

### Task 4: Add end-to-end command coverage

**Files:**
- Modify: `tests/smoke/app.test.ts`
- Modify: `tests/runtime/bootstrap.test.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Step 1: Write the failing test**

```ts
test('routes //sessions through the command service and returns bridge plus codex details', async () => {
  await eventHandler!({
    sessionId: 'chat-a',
    messageId: 'message-1',
    text: '//sessions',
    senderId: 'user-a',
    timestamp: '2026-04-04T00:00:00.000Z',
  });

  assert.match(sentMessages[0]!.text, /Bridge State:/);
  assert.match(sentMessages[0]!.text, /Codex State:/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/smoke/app.test.ts tests/runtime/bootstrap.test.ts`
Expected: FAIL because the app does not yet expose the new command behavior and reload hook

**Step 3: Write minimal implementation**

Finish wiring:
- command service into app creation
- project reload handler into runtime bootstrap
- help text updates for:
  - `//sessions`
  - `//reload projects`
  - Codex pass-through examples like `app/list`

Document the new commands and reload behavior.

**Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/smoke/app.test.ts tests/runtime/bootstrap.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/smoke/app.test.ts tests/runtime/bootstrap.test.ts README.md AGENTS.md src/app.ts src/runtime/bootstrap.ts
git commit -m "docs: document bridge chat commands"
```

### Task 5: Final verification

**Files:**
- Modify: none

**Step 1: Run focused test suites**

Run: `node --experimental-strip-types --test tests/commands/chat-command-service.test.ts tests/adapters/codex/app-server-client.test.ts tests/runtime/project-registry.test.ts tests/runtime/codex-config.test.ts tests/runtime/bootstrap.test.ts tests/smoke/app.test.ts`
Expected: PASS

**Step 2: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 3: Review git diff**

Run: `git status --short && git diff --stat`
Expected: only intended files changed for this feature branch

**Step 4: Commit**

```bash
git add .
git commit -m "feat: add bridge commands and project reload"
```
