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
    { id: 'codex', kind: 'codex', transport: 'stdio', active: true, started: false },
    { id: 'cc', kind: 'cc', transport: 'stdio', active: false, started: false },
    { id: 'qwen', kind: 'qwen', transport: 'stdio', active: false, started: false },
    { id: 'gemini', kind: 'gemini', transport: 'stdio', active: false, started: false },
  ]);
  assert.equal(manager.getActiveProviderName(), 'codex');
});

test('switches active providers without eagerly starting inactive providers', async () => {
  const createCalls: string[] = [];
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    createClient: async ({ provider }) => {
      createCalls.push(provider.id);
      return {
        generateReply: async () => `${provider.id}:reply`,
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
      createCalls.push(provider.id);
      return {
        generateReply: async () => `${provider.id}:reply`,
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
      { id: 'codex-web', kind: 'codex', transport: 'websocket' },
      { id: 'cc-stdio', kind: 'cc', transport: 'stdio' },
    ],
    stateStore,
    allocatePort: async () => nextPort++,
    createClient: async ({ provider }) => {
      createConfigs.push({ provider: provider.id, port: provider.port });
      return {
        generateReply: async () => `${provider.id}:reply`,
        stop: async () => {},
      };
    },
  });

  manager.switchActiveProvider('codex-web');
  assert.deepEqual(stateStore.getProjectState('project-a'), {
    projectInstanceId: 'project-a',
    activeProvider: 'codex-web',
  });

  const client = await manager.ensureActiveProviderClient();
  assert.equal(await client.generateReply({ text: 'hello' }), 'codex-web:reply');
  assert.deepEqual(createConfigs, [{ provider: 'codex-web', port: 4311 }]);
  assert.deepEqual(stateStore.getProjectState('project-a'), {
    projectInstanceId: 'project-a',
    activeProvider: 'codex-web',
    websocketPorts: { 'codex-web': 4311 },
    startedProviders: ['codex-web'],
  });
});

test('markActivity updates lastActivityAt for the provider entry', async () => {
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    createClient: () => ({
      generateReply: async () => 'ok',
      stop: async () => {},
    }),
  });

  await manager.ensureProviderClient('codex');
  const entries = (manager as any).entries as Map<string, { lastActivityAt: number }>;
  const before = entries.get('codex')!.lastActivityAt;

  await new Promise((r) => setTimeout(r, 5));
  manager.markActivity('codex');

  const after = entries.get('codex')!.lastActivityAt;
  assert.ok(after > before, `expected ${after} > ${before}`);
});

test('markActivity is a no-op for unknown provider', () => {
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    createClient: () => ({ generateReply: async () => 'ok', stop: async () => {} }),
  });
  manager.markActivity('nonexistent');
});

test('stopProvider stops only the specified provider client', async () => {
  const stops: string[] = [];
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    createClient: ({ provider }) => ({
      generateReply: async () => 'ok',
      stop: async () => {
        stops.push(provider.id);
      },
    }),
  });

  await manager.ensureProviderClient('codex');
  await manager.ensureProviderClient('qwen');

  await (manager as any).stopProvider('codex');

  assert.equal(manager.getStartedClient('codex'), null);
  assert.notEqual(manager.getStartedClient('qwen'), null);
  assert.deepEqual(stops, ['codex']);
});

test('stopProvider on already-stopped provider is a no-op', async () => {
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    createClient: () => ({ generateReply: async () => 'ok', stop: async () => {} }),
  });

  await (manager as any).stopProvider('codex');
  assert.equal(manager.getStartedClient('codex'), null);
});

test('scanIdle stops clients whose lastActivityAt exceeds idleTimeoutMs', async () => {
  const stops: string[] = [];
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    idleTimeoutMs: 50,
    createClient: ({ provider }) => ({
      generateReply: async () => 'ok',
      stop: async () => { stops.push(provider.id); },
    }),
  });

  await manager.ensureProviderClient('codex');
  await new Promise((r) => setTimeout(r, 80));
  await (manager as any).scanIdle();

  assert.equal(manager.getStartedClient('codex'), null);
  assert.deepEqual(stops, ['codex']);

  await manager.stop();
});

test('markActivity refreshes timer so scanIdle does not stop the client', async () => {
  const stops: string[] = [];
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    idleTimeoutMs: 80,
    createClient: ({ provider }) => ({
      generateReply: async () => 'ok',
      stop: async () => { stops.push(provider.id); },
    }),
  });

  await manager.ensureProviderClient('codex');
  await new Promise((r) => setTimeout(r, 50));
  manager.markActivity('codex');
  await new Promise((r) => setTimeout(r, 50));
  await (manager as any).scanIdle();

  assert.notEqual(manager.getStartedClient('codex'), null);
  assert.deepEqual(stops, []);

  await manager.stop();
});

test('scanIdle skips entries with no client', async () => {
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    idleTimeoutMs: 50,
    createClient: () => ({ generateReply: async () => 'ok', stop: async () => {} }),
  });

  await new Promise((r) => setTimeout(r, 80));
  await (manager as any).scanIdle();

  assert.equal(manager.getStartedClient('codex'), null);
  await manager.stop();
});

test('stop() clears the idle scan timer', async () => {
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    idleTimeoutMs: 50,
    createClient: () => ({ generateReply: async () => 'ok', stop: async () => {} }),
  });

  await manager.stop();
  assert.equal((manager as any).scanTimer, null);
});

test('stopProvider is idempotent under concurrent calls', async () => {
  const stops: string[] = [];
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    createClient: ({ provider }) => ({
      generateReply: async () => 'ok',
      stop: async () => {
        stops.push(provider.id);
        await new Promise((r) => setTimeout(r, 10));
      },
    }),
  });

  await manager.ensureProviderClient('codex');

  // Fire two concurrent stopProvider calls
  await Promise.all([
    (manager as any).stopProvider('codex'),
    (manager as any).stopProvider('codex'),
  ]);

  assert.equal(manager.getStartedClient('codex'), null);
  assert.equal(stops.length, 1, 'stop should only be called once');
});

test('does not start scan timer when idleTimeoutMs is 0', () => {
  const manager = new ProviderManager({
    projectInstanceId: 'project-a',
    cwd: '/repo/project-a',
    idleTimeoutMs: 0,
    createClient: () => ({ generateReply: async () => 'ok', stop: async () => {} }),
  });
  assert.equal((manager as any).scanTimer, null);
});
