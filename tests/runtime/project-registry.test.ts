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
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' } : null,
    createClient: createMockClient,
  });

  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });

  const handler = registry.getHandler('project-a');
  assert.ok(handler !== null);
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
