# Remote CC Provider Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one project expose multiple CC providers, where each provider can connect either over `websocket` or over `ssh+stdio`, so Feishu users can switch between remote CC servers with `//provider <id>`.

**Architecture:** Normalize provider config into a stable `{id, kind, transport}` shape, keep provider lifecycle management inside `ProviderManager`, and add an SSH-backed client that implements the same `CodexProjectClient` surface as the existing WebSocket-backed providers. The command layer should only consume provider state and render it; it should not care whether a provider is local, WebSocket-based, or SSH-backed.

**Tech Stack:** Node.js 24, TypeScript, `node:child_process` for SSH process spawning, existing Node test runner.

---

## File Map

```
src/
├── runtime/
│   ├── project-config.ts        # MOD: normalize legacy provider configs into {id, kind, transport}
│   ├── provider-registry.ts     # MOD: store provider ids/kinds and expose provider state by id
│   ├── provider-manager.ts      # MOD: manage active provider selection and lazy client creation per provider id
│   └── project-registry.ts      # MOD: surface provider summaries and active-provider lookup by id
├── commands/
│   └── chat-command-service.ts  # MOD: render provider ids/kinds/transports and switch by provider id
├── adapters/
│   └── codex/
│       ├── app-server-client.ts  # MOD: keep existing websocket-backed behavior intact
│       ├── ssh-stdio-client.ts   # NEW: spawn ssh and bridge stdio to CodexProjectClient
│       └── index.ts              # MOD: export the new SSH client
└── app.ts                        # MOD: pass provider summaries through to //providers and //status

tests/
├── runtime/
│   ├── codex-config.test.ts      # MOD: config normalization and backward-compat tests
│   ├── provider-manager.test.ts  # MOD: provider-id switching and reuse tests
│   └── project-registry.test.ts   # MOD: provider summaries expose ids/kinds/transports
├── commands/
│   └── chat-command-service.test.ts # MOD: //providers and //provider output/behavior
└── adapters/
    └── codex/
        └── ssh-stdio-client.test.ts # NEW: SSH spawn and lifecycle tests
```

---

### Task 1: Normalize provider config into `{id, kind, transport}` and keep legacy projects loading

**Files:**
- Modify: `src/runtime/project-config.ts`
- Modify: `src/runtime/provider-registry.ts`
- Modify: `tests/runtime/codex-config.test.ts`

- [ ] **Step 1: Write the failing normalization tests**

Add tests that prove both the new shape and the legacy shape are accepted:

```ts
test('normalizes provider configs with explicit id and kind', () => {
  assert.deepEqual(
    normalizeProjectConfig({
      projectInstanceId: 'project-a',
      cwd: '/repo/a',
      providers: [
        {
          id: 'cc-east',
          kind: 'cc',
          transport: 'websocket',
          websocketUrl: 'ws://cc-east.example.com:4000',
        },
      ],
    }),
    {
      projectInstanceId: 'project-a',
      cwd: '/repo/a',
      providers: [
        {
          id: 'cc-east',
          kind: 'cc',
          transport: 'websocket',
          websocketUrl: 'ws://cc-east.example.com:4000',
        },
      ],
    },
  );
});

test('accepts legacy provider configs by treating provider as both id and kind', () => {
  assert.deepEqual(
    normalizeProjectConfig({
      projectInstanceId: 'project-a',
      cwd: '/repo/a',
      providers: [
        {
          provider: 'cc',
          transport: 'stdio',
        },
      ],
    }),
    {
      projectInstanceId: 'project-a',
      cwd: '/repo/a',
      providers: [
        {
          id: 'cc',
          kind: 'cc',
          transport: 'stdio',
        },
      ],
    },
  );
});
```

- [ ] **Step 2: Run the targeted config test and confirm the current implementation fails**

Run:
```bash
node --experimental-strip-types --test tests/runtime/codex-config.test.ts
```

Expected: the new assertions fail because the current parser still only understands the old `provider` field.

- [ ] **Step 3: Implement the normalization change**

Update `normalizeProjectProviders()` so it accepts both shapes:

```ts
type RawProviderConfig = {
  id?: unknown;
  kind?: unknown;
  provider?: unknown;
  transport?: unknown;
  websocketUrl?: unknown;
  sshHost?: unknown;
  sshPort?: unknown;
  sshUser?: unknown;
  sshIdentityFile?: unknown;
  sshCommand?: unknown;
  sshArgs?: unknown;
};

function normalizeProviderConfig(entry: unknown): ProjectProviderConfig {
  const raw = isRecord(entry) ? (entry as RawProviderConfig) : null;
  if (raw === null) {
    throw new Error('providers entries must be objects');
  }

  const id = typeof raw.id === 'string' && raw.id.trim() !== ''
    ? raw.id.trim()
    : typeof raw.provider === 'string' && raw.provider.trim() !== ''
      ? raw.provider.trim()
      : '';
  const kind = normalizeProviderKind(raw.kind ?? raw.provider);

  if (id === '') {
    throw new Error('provider id is required');
  }

  return {
    id,
    kind,
    transport: normalizeProviderTransport(raw.transport),
    ...(typeof raw.websocketUrl === 'string' ? { websocketUrl: raw.websocketUrl } : {}),
    ...(typeof raw.sshHost === 'string' ? { sshHost: raw.sshHost } : {}),
    ...(typeof raw.sshPort === 'number' ? { sshPort: raw.sshPort } : {}),
    ...(typeof raw.sshUser === 'string' ? { sshUser: raw.sshUser } : {}),
    ...(typeof raw.sshIdentityFile === 'string' ? { sshIdentityFile: raw.sshIdentityFile } : {}),
    ...(typeof raw.sshCommand === 'string' ? { sshCommand: raw.sshCommand } : {}),
    ...(Array.isArray(raw.sshArgs) ? { sshArgs: raw.sshArgs } : {}),
  };
}
```

Update `ProviderDescriptor` and `ProviderState` in `src/runtime/provider-registry.ts` to use `id` and `kind` instead of `provider`, and keep `transport`, `active`, `started`, and `port` unchanged.

- [ ] **Step 4: Run the config tests again**

Run:
```bash
node --experimental-strip-types --test tests/runtime/codex-config.test.ts
```

Expected: the new normalization assertions pass and existing provider-default tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/project-config.ts src/runtime/provider-registry.ts tests/runtime/codex-config.test.ts
git commit -m "feat: normalize provider ids and kinds"
```

---

### Task 2: Add an SSH-backed Codex client that bridges `ssh+stdio`

**Files:**
- Create: `src/adapters/codex/ssh-stdio-client.ts`
- Modify: `src/adapters/codex/index.ts`
- Modify: `tests/adapters/codex/ssh-stdio-client.test.ts`

- [ ] **Step 1: Write the failing SSH client tests**

Add a focused test that injects a fake `spawn` implementation and asserts the command line is correct:

```ts
test('spawns ssh with host, port, identity, and remote command', async () => {
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const client = createSshStdioCodexClient({
    spawn: (command, args) => {
      spawnCalls.push({ command, args });
      return fakeProcess();
    },
    sshHost: 'cc-west.example.com',
    sshPort: 2222,
    sshUser: 'agent',
    sshIdentityFile: '/home/me/.ssh/id_ed25519',
    sshCommand: 'cc-server --stdio',
  });

  await client.generateReply({ text: 'hello' });

  assert.deepEqual(spawnCalls[0], {
    command: 'ssh',
    args: [
      '-p', '2222',
      '-i', '/home/me/.ssh/id_ed25519',
      'agent@cc-west.example.com',
      'cc-server --stdio',
    ],
  });
});
```

- [ ] **Step 2: Run the test and confirm the client does not exist yet**

Run:
```bash
node --experimental-strip-types --test tests/adapters/codex/ssh-stdio-client.test.ts
```

Expected: fail because `createSshStdioCodexClient` is not implemented.

- [ ] **Step 3: Implement the SSH transport client**

Create a client that returns the `CodexProjectClient` surface and bridges stdin/stdout to the remote process:

```ts
export function createSshStdioCodexClient(input: {
  spawn?: typeof spawn;
  sshHost: string;
  sshPort?: number;
  sshUser?: string;
  sshIdentityFile?: string;
  sshCommand: string;
}): CodexProjectClient {
  const spawnImpl = input.spawn ?? spawn;
  const args = [
    ...(input.sshPort !== undefined ? ['-p', String(input.sshPort)] : []),
    ...(input.sshIdentityFile !== undefined ? ['-i', input.sshIdentityFile] : []),
    input.sshUser !== undefined ? `${input.sshUser}@${input.sshHost}` : input.sshHost,
    input.sshCommand,
  ];

  const child = spawnImpl('ssh', args, { stdio: 'pipe' });

  return {
    async generateReply({ text }) {
      // Write the request to child.stdin, read the response from child.stdout,
      // and translate the remote protocol back into a reply string.
      return await sendAndReadReply(child, text);
    },
    async stop() {
      child.kill();
    },
  };
}
```

The first implementation only needs to cover the `CodexProjectClient` methods required by the bridge’s current CC flow. Any extra methods should either delegate cleanly or throw a precise unsupported-method error.

- [ ] **Step 4: Run the SSH client test again**

Run:
```bash
node --experimental-strip-types --test tests/adapters/codex/ssh-stdio-client.test.ts
```

Expected: pass, including lifecycle cleanup when the child process exits or the client is stopped.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/codex/ssh-stdio-client.ts src/adapters/codex/index.ts tests/adapters/codex/ssh-stdio-client.test.ts
git commit -m "feat: add ssh stdio codex client"
```

---

### Task 3: Route provider lookup, switching, and summaries by provider id

**Files:**
- Modify: `src/runtime/provider-manager.ts`
- Modify: `src/runtime/project-registry.ts`
- Modify: `src/commands/chat-command-service.ts`
- Modify: `src/app.ts`
- Modify: `tests/runtime/provider-manager.test.ts`
- Modify: `tests/runtime/project-registry.test.ts`
- Modify: `tests/commands/chat-command-service.test.ts`
- Modify: `tests/smoke/app.test.ts`

- [ ] **Step 1: Write the failing provider-id tests**

Add tests that assert:

```ts
test('switches active providers by provider id and reuses a started remote provider', async () => {
  // project-a has cc-east (websocket) and cc-west (ssh+stdio)
  // switching to cc-west starts it once
  // switching back to cc-east does not stop cc-west
  // switching again to cc-west reuses the existing client
});

test('lists providers with id, kind, transport, and runtime state', async () => {
  // //providers output contains:
  // - cc-east | kind=cc | transport=websocket | running
  // - cc-west | kind=cc | transport=ssh+stdio | stopped
});
```

- [ ] **Step 2: Run the targeted tests and confirm the current implementation still keys by provider name**

Run:
```bash
node --experimental-strip-types --test tests/runtime/provider-manager.test.ts tests/runtime/project-registry.test.ts tests/commands/chat-command-service.test.ts
```

Expected: failures around `provider`/`providerName` assumptions and provider summaries not showing the new identity fields.

- [ ] **Step 3: Update the runtime to use provider ids as the stable lookup key**

Change `ProviderManager` to:

```ts
private readonly entries = new Map<string, ProviderEntry>();
private activeProviderId: string;

async setActiveProvider(providerId: string): Promise<void> {
  const entry = this.entries.get(providerId);
  if (entry === undefined) {
    throw new Error(`Unknown provider ${providerId}`);
  }

  this.activeProviderId = providerId;
  await this.ensureProviderClient(providerId);
}
```

Update `getProviderStates()` to return:

```ts
[
  { id: 'cc-east', kind: 'cc', transport: 'websocket', active: true, started: true },
  { id: 'cc-west', kind: 'cc', transport: 'ssh+stdio', active: false, started: false },
]
```

Update `formatProviderSummary()` in `src/commands/chat-command-service.ts` so the rendered line includes the provider id and kind:

```ts
const parts = [
  `- ${provider.id}`,
  `kind=${provider.kind}`,
  provider.transport ? `transport=${provider.transport}` : null,
  provider.port !== undefined ? `port=${provider.port}` : null,
  provider.active === true || activeProvider === provider.id ? 'active' : null,
  provider.started === true ? 'running' : 'stopped',
].filter((part): part is string => part !== null);
```

Update the `//provider` command path to switch by id and keep the `//providers` output stable for both active and inactive providers.

- [ ] **Step 4: Run the runtime and command tests again**

Run:
```bash
node --experimental-strip-types --test tests/runtime/provider-manager.test.ts tests/runtime/project-registry.test.ts tests/commands/chat-command-service.test.ts tests/smoke/app.test.ts
```

Expected: pass, with Feishu command output showing provider ids and transport kinds.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/provider-manager.ts src/runtime/project-registry.ts src/commands/chat-command-service.ts src/app.ts tests/runtime/provider-manager.test.ts tests/runtime/project-registry.test.ts tests/commands/chat-command-service.test.ts tests/smoke/app.test.ts
git commit -m "feat: route providers by id"
```

---

### Task 4: Wire transport selection through project creation and verify the full flow

**Files:**
- Modify: `src/runtime/project-registry.ts`
- Modify: `src/runtime/project-management-service.ts`
- Modify: `src/runtime/codex-project-registry.ts`
- Modify: `src/runtime/bootstrap.ts`
- Modify: `tests/runtime/project-discovery.test.ts`
- Modify: `tests/runtime/codex-config.test.ts`

- [ ] **Step 1: Write the final end-to-end config test**

Add a test that loads a project file with one local provider and two remote CC providers:

```ts
test('loads mixed websocket and ssh+stdio providers from a projects file', () => {
  const projects = loadProjectsFromFile(filePath);
  assert.deepEqual(projects?.[0].providers, [
    { id: 'codex-local', kind: 'codex', transport: 'stdio' },
    { id: 'cc-east', kind: 'cc', transport: 'websocket', websocketUrl: 'ws://cc-east.example.com:4000' },
    { id: 'cc-west', kind: 'cc', transport: 'ssh+stdio', sshHost: 'cc-west.example.com', sshUser: 'agent', sshCommand: 'cc-server --stdio' },
  ]);
});
```

- [ ] **Step 2: Run the end-to-end config test and confirm the current loader does not yet preserve the new fields**

Run:
```bash
node --experimental-strip-types --test tests/runtime/codex-config.test.ts tests/runtime/project-discovery.test.ts
```

Expected: failure or partial mismatch until the normalized provider shape is threaded through project discovery and runtime project creation.

- [ ] **Step 3: Thread the new provider config through project creation**

Ensure the project discovery, project management, and registry code all preserve:

```ts
{
  id: string;
  kind: 'codex' | 'cc' | 'qwen' | 'gemini';
  transport: 'stdio' | 'websocket';
}
```

The project registry should pass the full provider config into `ProviderManager`, and the provider manager should select the correct client implementation:

```ts
const client = provider.transport === 'ssh+stdio'
  ? createSshStdioCodexClient(providerConfig)
  : new CodexAppServerClient({
      command: provider.command ?? 'codex',
      args: provider.args ?? ['app-server'],
      clientInfo: { name: 'lark-agent-bridge', title: 'lark-agent-bridge', version: 'dev' },
      cwd: provider.cwd,
      transport: 'websocket',
      websocketUrl: provider.websocketUrl,
    });
```

- [ ] **Step 4: Run the full suite**

Run:
```bash
npm test
```

Expected: all tests pass, including smoke coverage for `//providers`, `//provider <id>`, and the mixed provider state display.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/project-registry.ts src/runtime/project-management-service.ts src/runtime/codex-project-registry.ts src/runtime/bootstrap.ts tests/runtime/project-discovery.test.ts tests/runtime/codex-config.test.ts
git commit -m "feat: wire remote cc providers through runtime"
```

## Self-Review Checklist

- The plan covers config compatibility, SSH transport, provider routing, command rendering, and full-suite verification.
- Every task has a concrete file set, a failing test step, an implementation step, a verification step, and a commit step.
- The plan keeps the runtime model intact and does not introduce a second binding system.
- The provider identity split is explicit: `id` is the switch target, `kind` is the agent family.
