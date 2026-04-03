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
