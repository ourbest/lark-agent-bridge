import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderManager } from '../../src/runtime/provider-manager.ts';
import { InMemoryBindingStore } from '../../src/storage/binding-store.ts';

test('defaults to codex, cc, qwen, and gemini and selects the first provider', () => {
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    createClient: async () => ({
      generateReply: async () => 'reply',
      stop: async () => {},
    }),
  });

  assert.deepEqual(manager.listProviders(), [
    { provider: 'codex', transport: 'stdio', active: true, started: false },
    { provider: 'cc', transport: 'stdio', active: false, started: false },
    { provider: 'qwen', transport: 'stdio', active: false, started: false },
    { provider: 'gemini', transport: 'stdio', active: false, started: false },
  ]);
  assert.equal(manager.getActiveProviderName(), 'codex');
});

test('switches active providers without eagerly starting inactive providers', async () => {
  const createCalls: string[] = [];
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    createClient: async ({ provider }) => {
      createCalls.push(provider.provider);
      return {
        generateReply: async () => `${provider.provider}:reply`,
        stop: async () => {},
      };
    },
  });

  manager.switchActiveProvider('qwen');
  assert.deepEqual(createCalls, []);
  assert.equal(manager.getActiveProviderName(), 'qwen');

  const client = await manager.ensureActiveProviderClient();
  assert.equal(await client.generateReply({ text: 'hello' }), 'qwen:reply');
  assert.deepEqual(createCalls, ['qwen']);
});

test('reuses started provider clients when switching back', async () => {
  const createCalls: string[] = [];
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    createClient: async ({ provider }) => {
      createCalls.push(provider.provider);
      return {
        generateReply: async () => `${provider.provider}:reply`,
        stop: async () => {},
      };
    },
  });

  const codexClient = await manager.ensureProviderClient('codex');
  manager.switchActiveProvider('qwen');
  const qwenClient = await manager.ensureProviderClient('qwen');
  manager.switchActiveProvider('codex');
  const codexClientAgain = await manager.ensureActiveProviderClient();

  assert.equal(codexClientAgain, codexClient);
  assert.equal(qwenClient, await manager.ensureProviderClient('qwen'));
  assert.deepEqual(createCalls, ['codex', 'qwen']);
});

test('allocates a websocket port lazily and persists active provider state', async () => {
  const stateStore = new InMemoryBindingStore();
  let nextPort = 4311;
  const createConfigs: Array<{ provider: string; port?: number }> = [];
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    providers: [
      { provider: 'codex', transport: 'websocket' },
      { provider: 'cc', transport: 'stdio' },
    ],
    stateStore,
    allocatePort: async () => nextPort++,
    createClient: async ({ provider }) => {
      createConfigs.push({ provider: provider.provider, port: provider.port });
      return {
        generateReply: async () => `${provider.provider}:reply`,
        stop: async () => {},
      };
    },
  });

  manager.switchActiveProvider('codex');
  assert.deepEqual(stateStore.getProjectState('project-a'), {
    projectInstanceId: 'project-a',
    activeProvider: 'codex',
  });

  const client = await manager.ensureActiveProviderClient();
  assert.equal(await client.generateReply({ text: 'hello' }), 'codex:reply');
  assert.deepEqual(createConfigs, [{ provider: 'codex', port: 4311 }]);
  assert.deepEqual(stateStore.getProjectState('project-a'), {
    projectInstanceId: 'project-a',
    activeProvider: 'codex',
    websocketPorts: { codex: 4311 },
    startedProviders: ['codex'],
  });
});
