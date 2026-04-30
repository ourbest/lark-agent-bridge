import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectRegistry } from '../../src/runtime/project-registry.ts';
import type { CodexProjectClient } from '../../src/runtime/codex-project.ts';
import { InMemoryBindingStore } from '../../src/storage/binding-store.ts';

function createMockClient(projectId: string): CodexProjectClient {
  return {
    generateReply: async ({ text }) => `reply to ${text}`,
    stop: async () => {},
  };
}

function createProviderMockClient(provider: string, stopCalls: string[]): CodexProjectClient {
  return {
    generateReply: async ({ text }) => `${provider}:${text}`,
    startThread: async () => `${provider}-thread`,
    stop: async () => {
      stopCalls.push(provider);
    },
  };
}

test('creates connection lazily on first message, not at binding time', async () => {
  const startCalls: Array<{ cwd?: string }> = [];
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' } : null,
    createClient: () => ({
      generateReply: async ({ text }) => `reply to ${text}`,
      startThread: async ({ cwd }) => {
        startCalls.push({ cwd });
        return 'thr_bind_1';
      },
      stop: async () => {},
    }),
  });

  // Binding alone must NOT start the provider (lazy loading)
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  assert.deepEqual(startCalls, []);

  // First message handler: provider is created (lazy), but thread is not started
  // for fresh sessions - generateReply handles fresh session internally
  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
  const reply = await handler!({ projectInstanceId: 'project-a', message: { text: 'hello' } });
  assert.equal(reply?.text, 'reply to hello');
  assert.deepEqual(startCalls, []); // startThread not called for fresh sessions under lazy loading
});

test('exposes default providers and the initial active provider', async () => {
  const registry = createProjectRegistry({
    bridgeStateStore: new InMemoryBindingStore(),
    allocateWebSocketPort: async () => 45123,
    getProjectConfig: (id) =>
      id === 'project-a'
        ? {
            projectInstanceId: 'project-a',
            websocketUrl: 'ws://localhost:4000',
            cwd: '/repo/project-a',
          }
        : null,
    createClient: () => createMockClient('project-a'),
  });

  assert.deepEqual(await registry.getProjectProviders('project-a'), [
    { id: 'codex', kind: 'codex', transport: 'stdio', active: true, started: false },
    { id: 'cc', kind: 'cc', transport: 'stdio', active: false, started: false },
    { id: 'qwen', kind: 'qwen', transport: 'stdio', active: false, started: false },
    { id: 'gemini', kind: 'gemini', transport: 'stdio', active: false, started: false },
  ]);
  assert.equal(await registry.getActiveProvider('project-a'), 'codex');
});

test('switches active providers without stopping already-started inactive providers', async () => {
  const createCalls: Array<{ provider: string; port?: number }> = [];
  const stopCalls: string[] = [];
  const registry = createProjectRegistry({
    bridgeStateStore: new InMemoryBindingStore(),
    allocateWebSocketPort: async () => 45123,
    getProjectConfig: (id) =>
      id === 'project-a'
        ? {
            projectInstanceId: 'project-a',
            websocketUrl: 'ws://localhost:4000',
            cwd: '/repo/project-a',
            providers: [
              { id: 'codex', kind: 'codex', transport: 'stdio' },
              { id: 'qwen', kind: 'qwen', transport: 'websocket' },
            ],
          }
        : null,
    createClient: (_projectId, _config, provider) => {
      createCalls.push({ provider: provider?.id ?? 'codex', port: provider?.port });
      return createProviderMockClient(provider?.id ?? 'codex', stopCalls);
    },
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  assert.deepEqual(createCalls, []); // binding alone doesn't start provider

  await registry.setActiveProvider('project-a', 'qwen');
  assert.equal(await registry.getActiveProvider('project-a'), 'qwen');
  assert.deepEqual(createCalls, []); // still nothing started

  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
  const reply = await handler!({
    projectInstanceId: 'project-a',
    message: { text: 'hello' },
  });

  assert.equal(reply?.text, 'qwen:hello');
  assert.equal(createCalls[0]?.provider, 'qwen');
  assert.equal(typeof createCalls[0]?.port, 'number');
});

test('reuses a started provider when switching back to it', async () => {
  const createCalls: Array<{ provider: string; port?: number }> = [];
  const stopCalls: string[] = [];
  const registry = createProjectRegistry({
    bridgeStateStore: new InMemoryBindingStore(),
    allocateWebSocketPort: async () => 45123,
    getProjectConfig: (id) =>
      id === 'project-a'
        ? {
            projectInstanceId: 'project-a',
            websocketUrl: 'ws://localhost:4000',
            cwd: '/repo/project-a',
            providers: [
              { id: 'codex', kind: 'codex', transport: 'stdio' },
              { id: 'qwen', kind: 'qwen', transport: 'websocket' },
            ],
          }
        : null,
    createClient: (_projectId, _config, provider) => {
      createCalls.push({ provider: provider?.id ?? 'codex', port: provider?.port });
      return createProviderMockClient(provider?.id ?? 'codex', stopCalls);
    },
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  await registry.setActiveProvider('project-a', 'qwen');
  const qwenHandler = registry.getHandler('project-a');
  assert.ok(qwenHandler !== null);
  await qwenHandler!({
    projectInstanceId: 'project-a',
    message: { text: 'hello' },
  });

  await registry.setActiveProvider('project-a', 'codex');
  await registry.setActiveProvider('project-a', 'qwen');

  const qwenHandlerAgain = registry.getHandler('project-a');
  assert.ok(qwenHandlerAgain !== null);
  const reply = await qwenHandlerAgain!({
    projectInstanceId: 'project-a',
    message: { text: 'again' },
  });

  assert.equal(reply?.text, 'qwen:again');
  assert.equal(createCalls.filter((call) => call.provider === 'qwen').length, 1);
  assert.deepEqual(stopCalls, []);
});

test('aborts the active reply even after switching active providers', async () => {
  let resolveReply: ((value: string) => void) | null = null;
  const abortCalls = new Map<string, number>();
  const registry = createProjectRegistry({
    getProjectConfig: (id) =>
      id === 'project-a'
        ? {
            projectInstanceId: 'project-a',
            websocketUrl: 'ws://localhost:4000',
            cwd: '/repo/project-a',
            providers: [
              { id: 'codex', kind: 'codex', transport: 'stdio' },
              { id: 'qwen', kind: 'qwen', transport: 'stdio' },
            ],
          }
        : null,
    createClient: (_projectId, _config, provider) => ({
      generateReply: async () =>
        await new Promise<string>((resolve) => {
          resolveReply = resolve;
        }),
      abortCurrentTask: async () => {
        const key = provider?.id ?? 'codex';
        abortCalls.set(key, (abortCalls.get(key) ?? 0) + 1);
        return key === 'codex';
      },
      stop: async () => {},
    }),
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);

  const replyPromise = handler!({
    projectInstanceId: 'project-a',
    message: { text: 'hello' },
  });

  await new Promise((resolve) => setImmediate(resolve));
  await registry.setActiveProvider('project-a', 'qwen');
  const aborted = await (registry as unknown as { abortCurrentTask(projectId: string): Promise<boolean> }).abortCurrentTask('project-a');
  assert.equal(aborted, true);
  assert.equal(abortCalls.get('codex'), 1);
  assert.equal(abortCalls.get('qwen') ?? 0, 0);

  resolveReply?.('late reply');

  await assert.doesNotReject(replyPromise);
  assert.deepEqual(await replyPromise, {
    text: '[lark-agent-bridge] task aborted',
  });
});

test('persists the active provider and preserves it across registry recreation', async () => {
  const store = new InMemoryBindingStore();
  const registry = createProjectRegistry({
    bridgeStateStore: store,
    getProjectConfig: (id) =>
      id === 'project-a'
        ? {
            projectInstanceId: 'project-a',
            websocketUrl: 'ws://localhost:4000',
            cwd: '/repo/project-a',
            providers: [
              { id: 'codex', kind: 'codex', transport: 'stdio' },
              { id: 'qwen', kind: 'qwen', transport: 'websocket' },
            ],
          }
        : null,
    createClient: () => createMockClient('project-a'),
  });

  await registry.setActiveProvider('project-a', 'qwen');

  const reloaded = createProjectRegistry({
    bridgeStateStore: store,
    getProjectConfig: (id) =>
      id === 'project-a'
        ? {
            projectInstanceId: 'project-a',
            websocketUrl: 'ws://localhost:4000',
            cwd: '/repo/project-a',
            providers: [
              { id: 'codex', kind: 'codex', transport: 'stdio' },
              { id: 'qwen', kind: 'qwen', transport: 'websocket' },
            ],
          }
        : null,
    createClient: () => createMockClient('project-a'),
  });

  assert.equal(await reloaded.getActiveProvider('project-a'), 'qwen');
});

test('maps codex notifications to project status updates', async () => {
  const statuses: Array<{ projectInstanceId: string; status: 'working' | 'waiting_approval' | 'done' | 'failed' }> = [];
  let client: CodexProjectClient & {
    onNotification?: ((message: { method: string; params?: Record<string, unknown> }) => void | Promise<void>) | null;
  } | null = null;

  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' } : null,
    createClient: () => {
      client = {
        generateReply: async ({ text }) => `reply to ${text}`,
        stop: async () => {},
      };
      return client;
    },
    onStatusChange: async (input) => {
      statuses.push(input);
    },
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });

  // Trigger lazy client creation
  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
  await handler!({ projectInstanceId: 'project-a', message: { text: 'trigger' } });

  assert.ok(client);
  await client!.onNotification?.({ method: 'turn/started' });
  await client!.onNotification?.({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await client!.onNotification?.({ method: 'turn/completed', params: { turn: { status: 'failed' } } });

  assert.deepEqual(statuses, [
    { projectInstanceId: 'project-a', status: 'working', reason: null, source: 'notification' },
    { projectInstanceId: 'project-a', status: 'done', reason: null, source: 'notification' },
    { projectInstanceId: 'project-a', status: 'failed', reason: null, source: 'notification' },
  ]);
});

test('forwards text deltas and activity summaries for active project sessions', async () => {
  const progressUpdates: Array<{ projectInstanceId: string; sessionId: string; textDelta?: string; summary?: string }> = [];
  let client: CodexProjectClient & {
    onNotification?: ((message: { method: string; params?: Record<string, unknown> }) => void | Promise<void>) | null;
    onTextDelta?: ((text: string) => void) | null;
  } | null = null;

  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' } : null,
    createClient: () => {
      client = {
        generateReply: async ({ text }) => `reply to ${text}`,
        stop: async () => {},
      };
      return client;
    },
    onProgress: async (input) => {
      progressUpdates.push(input);
    },
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });

  // Trigger lazy client creation
  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
  await handler!({ projectInstanceId: 'project-a', message: { text: 'trigger' } });

  assert.ok(client);
  client!.onTextDelta?.('partial reply');
  await client!.onNotification?.({
    method: 'item/completed',
    params: {
      item: {
        type: 'commandExecution',
        command: 'npm test',
      },
    },
  });

  assert.deepEqual(progressUpdates, [
    {
      projectInstanceId: 'project-a',
      sessionId: 'chat-1',
      textDelta: 'partial reply',
    },
    {
      projectInstanceId: 'project-a',
      sessionId: 'chat-1',
      summary: 'Completed command: npm test',
    },
  ]);
});

test('captures generateReply failures in project diagnostics', async () => {
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' } : null,
    createClient: () => ({
      generateReply: async () => {
        throw new Error('codex app-server disconnected');
      },
      stop: async () => {},
    }),
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });

  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
  const reply = await handler!({
    projectInstanceId: 'project-a',
    message: { text: 'hello' },
  });

  assert.equal(reply, null);
  const diagnostics = await registry.getProjectDiagnostics('project-a');
  assert.deepEqual(diagnostics, {
    projectInstanceId: 'project-a',
    status: 'failed',
    reason: 'codex app-server disconnected',
    source: 'generateReply',
  });
});

test('captures failure reasons from codex notifications in project diagnostics', async () => {
  let client: CodexProjectClient & {
    onNotification?: ((message: { method: string; params?: Record<string, unknown> }) => void | Promise<void>) | null;
  } | null = null;

  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' } : null,
    createClient: () => {
      client = {
        generateReply: async ({ text }) => `reply to ${text}`,
        stop: async () => {},
      };
      return client;
    },
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });

  // Trigger lazy client creation
  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
  await handler!({ projectInstanceId: 'project-a', message: { text: 'trigger' } });

  assert.ok(client);
  await client!.onNotification?.({
    method: 'error',
    params: {
      error: {
        message: 'approval transport timed out',
      },
    },
  });

  const diagnostics = await registry.getProjectDiagnostics('project-a');
  assert.deepEqual(diagnostics, {
    projectInstanceId: 'project-a',
    status: 'failed',
    reason: 'approval transport timed out',
    source: 'notification',
  });
});

test('restores a persisted binding by resuming the last thread', async () => {
  const startCalls: Array<{ cwd?: string; force?: boolean }> = [];
  const resumeCalls: Array<{ threadId: string; cwd?: string }> = [];
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' } : null,
    createClient: () => ({
      generateReply: async ({ text }) => `reply to ${text}`,
      startThread: async ({ cwd, force }) => {
        startCalls.push({ cwd, force });
        return 'thr_new';
      },
      resumeThread: async ({ threadId, cwd }) => {
        resumeCalls.push({ threadId, cwd });
        return threadId;
      },
      stop: async () => {},
    }),
    getLastThread: (projectId, sessionId) => projectId === 'project-a' && sessionId === 'chat-1' ? 'thr_previous' : null,
  });

  await (registry as unknown as { restoreBinding(projectInstanceId: string, sessionId: string): Promise<void> }).restoreBinding(
    'project-a',
    'chat-1',
  );

  assert.deepEqual(resumeCalls, [{ threadId: 'thr_previous', cwd: '/repo/project-a' }]);
  assert.deepEqual(startCalls, []);
});

test('does not fall back to fresh thread when saved thread is missing - lazy loading instead', async () => {
  // When resume fails with "no rollout found", we no longer fall back to startThread.
  // Instead we return early and let the provider be started lazily on first message.
  const startCalls: Array<{ cwd?: string; force?: boolean }> = [];
  const resumeCalls: Array<{ threadId: string; cwd?: string }> = [];
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' } : null,
    createClient: () => ({
      generateReply: async ({ text }) => `reply to ${text}`,
      startThread: async ({ cwd, force }) => {
        startCalls.push({ cwd, force });
        return 'thr_fresh';
      },
      resumeThread: async ({ threadId, cwd }) => {
        resumeCalls.push({ threadId, cwd });
        throw new Error(`no rollout found for thread id ${threadId}`);
      },
      stop: async () => {},
    }),
    getLastThread: (projectId, sessionId) => projectId === 'project-a' && sessionId === 'chat-1' ? 'thr_missing' : null,
  });

  await registry.restoreBinding('project-a', 'chat-1');

  assert.deepEqual(resumeCalls, [{ threadId: 'thr_missing', cwd: '/repo/project-a' }]);
  assert.deepEqual(startCalls, []); // no startThread call - lazy loading handles fresh session on first message
});

test('starts a fresh thread on demand for an active project', async () => {
  const startCalls: Array<{ cwd?: string; force?: boolean }> = [];
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' } : null,
    createClient: () => ({
      generateReply: async ({ text }) => `reply to ${text}`,
      startThread: async ({ cwd, force }) => {
        startCalls.push({ cwd, force });
        return `thr_${startCalls.length}`;
      },
      stop: async () => {},
    }),
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  // Binding doesn't start thread (lazy loading) - thread is only started when explicitly requested
  assert.deepEqual(startCalls, []);

  const threadId = await registry.startThread('project-a', { cwd: '/repo/project-a', force: true });

  assert.equal(threadId, 'thr_1'); // first and only startThread call
  assert.deepEqual(startCalls, [
    { cwd: '/repo/project-a', force: true },
  ]);
});

test('does not reconnect if project already connected', async () => {
  const createCount = { count: 0 };
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' } : null,
    createClient: (id) => { createCount.count++; return createMockClient(id); },
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-2' });

  // binding doesn't create connection; lazy loading means 0 until handler is called
  assert.equal(createCount.count, 0);

  // first message triggers provider creation
  const handler1 = registry.getHandler('project-a');
  await handler1!({ projectInstanceId: 'project-a', message: { text: 'hello' } });
  assert.equal(createCount.count, 1);

  // second binding doesn't reconnect
  const handler2 = registry.getHandler('project-a');
  await handler2!({ projectInstanceId: 'project-a', message: { text: 'hi' } });
  assert.equal(createCount.count, 1); // still 1, no reconnection
});

test('disconnects when last binding is removed', async () => {
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' } : null,
    createClient: createMockClient,
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  await registry.onBindingChanged({ type: 'session-unbound', sessionId: 'chat-1' });

  const handler = registry.getHandler('project-a');
  assert.equal(handler, null);
});

test('does not disconnect if project still has bindings', async () => {
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' } : null,
    createClient: createMockClient,
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-2' });
  await registry.onBindingChanged({ type: 'session-unbound', sessionId: 'chat-1' });

  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
});

test('returns null for unbound project', async () => {
  const registry = createProjectRegistry({
    getProjectConfig: () => null,
    createClient: createMockClient,
  });

  const handler = registry.getHandler('project-b');
  assert.equal(handler, null);
});

test('marks a previously configured project as removed after reload while keeping active sessions', async () => {
  const projectConfigs = [
    { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' },
  ];

  const registry = createProjectRegistry({
    getProjectConfig: (id) => projectConfigs.find((entry) => entry.projectInstanceId === id) ?? null,
    createClient: createMockClient,
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });

  projectConfigs.length = 0;

  const state = await registry.describeProject('project-a');
  assert.deepEqual(state, {
    projectInstanceId: 'project-a',
    configured: false,
    active: true,
    removed: true,
    sessionCount: 1,
  });

  await registry.onBindingChanged({ type: 'session-unbound', sessionId: 'chat-1' });

  const afterUnbind = await registry.describeProject('project-a');
  assert.deepEqual(afterUnbind, {
    projectInstanceId: 'project-a',
    configured: false,
    active: false,
    removed: true,
    sessionCount: 0,
  });
});

test('accepts project clients that also support structured codex commands', async () => {
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' } : null,
    createClient: () => ({
      generateReply: async ({ text }) => `reply to ${text}`,
      executeCommand: async () => ({ ok: true }),
      stop: async () => {},
    }),
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });

  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
});

test('executes a structured command on an active project client', async () => {
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' } : null,
    createClient: () => ({
      generateReply: async ({ text }) => `reply to ${text}`,
      executeCommand: async ({ method, params }) => ({ method, params, ok: true }),
      stop: async () => {},
    }),
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });

  const result = await registry.executeCommand('project-a', {
    method: 'session/get',
    params: { id: 'chat-1' },
  });

  assert.deepEqual(result, {
    method: 'session/get',
    params: { id: 'chat-1' },
    ok: true,
  });
});

test('recreates an active project client when its config changes', async () => {
  const configs = [{ projectInstanceId: 'project-a', transport: 'stdio' as const, cwd: '/repo/one' }];
  const stopCalls: string[] = [];
  const createdConfigs: string[] = [];

  const registry = createProjectRegistry({
    getProjectConfig: (id) => configs.find((entry) => entry.projectInstanceId === id) ?? null,
    createClient: (_id, config) => {
      createdConfigs.push(`${config.transport}:${config.cwd ?? ''}`);
      return {
        generateReply: async ({ text }) => `reply:${config.transport}:${config.cwd}:${text}`,
        stop: async () => {
          stopCalls.push(`${config.transport}:${config.cwd ?? ''}`);
        },
      };
    },
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });

  configs[0] = { projectInstanceId: 'project-a', transport: 'stdio' as const, cwd: '/repo/two' };

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });

  // First message triggers provider creation (lazy) - client is created with current config
  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
  const reply = await handler!({
    projectInstanceId: 'project-a',
    message: { text: 'hello' },
  });

  assert.deepEqual(createdConfigs, ['stdio:/repo/two']); // only one client created lazily
  assert.deepEqual(stopCalls, []); // no old client was running to stop
  assert.equal(reply?.text, 'reply:stdio:/repo/two:hello');
});

test('marks a project as removed after it disappears from a previous config snapshot', async () => {
  const configs = [
    { projectInstanceId: 'project-a', websocketUrl: 'ws://one' },
    { projectInstanceId: 'project-b', websocketUrl: 'ws://two' },
  ];

  const registry = createProjectRegistry({
    getProjectConfig: (id) => configs.find((entry) => entry.projectInstanceId === id) ?? null,
    createClient: createMockClient,
  });

  await registry.reconcileProjectConfigs(configs);

  configs.shift();
  await registry.reconcileProjectConfigs(configs);

  const state = await registry.describeProject('project-a');
  assert.deepEqual(state, {
    projectInstanceId: 'project-a',
    configured: false,
    active: false,
    removed: true,
    sessionCount: 0,
  });
});
