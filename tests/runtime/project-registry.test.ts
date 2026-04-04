import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectRegistry } from '../../src/runtime/project-registry.ts';
import type { CodexProjectClient } from '../../src/runtime/codex-project-registry.ts';

function createMockClient(projectId: string): CodexProjectClient {
  return {
    generateReply: async ({ text }) => `reply to ${text}`,
    stop: async () => {},
  };
}

test('creates connection when first binding is created', async () => {
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

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });

  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
  assert.deepEqual(startCalls, [{ cwd: '/repo/project-a' }]);
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

  assert.ok(client);
  await client!.onNotification?.({ method: 'turn/started' });
  await client!.onNotification?.({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  await client!.onNotification?.({ method: 'turn/completed', params: { turn: { status: 'failed' } } });

  assert.deepEqual(statuses, [
    { projectInstanceId: 'project-a', status: 'working' },
    { projectInstanceId: 'project-a', status: 'done' },
    { projectInstanceId: 'project-a', status: 'failed' },
  ]);
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

test('falls back to a fresh thread when the saved thread no longer exists', async () => {
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
  assert.deepEqual(startCalls, [{ cwd: '/repo/project-a', force: true }]);
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
  const threadId = await registry.startThread('project-a', { cwd: '/repo/project-a', force: true });

  assert.equal(threadId, 'thr_2');
  assert.deepEqual(startCalls, [
    { cwd: '/repo/project-a', force: true },
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

  assert.equal(createCount.count, 1);
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

  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
  const reply = await handler!({
    projectInstanceId: 'project-a',
    message: { text: 'hello' },
  });

  assert.deepEqual(createdConfigs, ['stdio:/repo/one', 'stdio:/repo/two']);
  assert.deepEqual(stopCalls, ['stdio:/repo/one']);
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
