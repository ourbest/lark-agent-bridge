import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { loadProjectsFromFile, resolveCodexRuntimeConfig, resolveCodexRuntimeConfigs, writeProjectsFile } from '../../src/runtime/codex-config.ts';
import { createProjectConfigWatcher } from '../../src/runtime/project-config-watcher.ts';

test('returns null when codex runtime is not enabled', () => {
  assert.equal(resolveCodexRuntimeConfig({}), null);
});

test('resolves codex runtime config from environment defaults', () => {
  assert.deepEqual(
    resolveCodexRuntimeConfig({
      BRIDGE_CODEX_PROJECT_INSTANCE_ID: 'project-a',
    }),
    {
      projectInstanceId: 'project-a',
      command: 'codex',
      args: ['app-server'],
      cwd: undefined,
      serviceName: 'codex-bridge',
      transport: 'websocket',
      websocketUrl: 'ws://127.0.0.1:4000',
      adapterType: 'codex',
    },
  );
});

test('resolves websocket transport from environment override', () => {
  assert.deepEqual(
    resolveCodexRuntimeConfig({
      BRIDGE_CODEX_PROJECT_INSTANCE_ID: 'project-a',
      BRIDGE_CODEX_TRANSPORT: 'websocket',
      BRIDGE_CODEX_WEBSOCKET_URL: 'ws://127.0.0.1:4567',
      BRIDGE_CODEX_MODEL: 'gpt-5.4-mini',
    }),
    {
      projectInstanceId: 'project-a',
      command: 'codex',
      args: ['app-server'],
      cwd: undefined,
      model: 'gpt-5.4-mini',
      serviceName: 'codex-bridge',
      transport: 'websocket',
      websocketUrl: 'ws://127.0.0.1:4567',
      adapterType: 'codex',
    },
  );
});

test('resolves multiple codex runtime configs from environment json', () => {
  assert.deepEqual(
    resolveCodexRuntimeConfigs({
      BRIDGE_CODEX_PROJECTS_JSON: JSON.stringify([
        {
          projectInstanceId: 'project-a',
          cwd: '/repo/a',
        },
        {
          projectInstanceId: 'project-b',
          command: 'codex',
          args: ['app-server', '--listen', 'stdio://'],
        },
      ]),
    }),
    [
      {
        projectInstanceId: 'project-a',
        command: 'codex',
        args: ['app-server'],
        cwd: '/repo/a',
        serviceName: 'codex-bridge',
        transport: 'websocket',
        websocketUrl: 'ws://127.0.0.1:4000',
        adapterType: 'codex',
      },
      {
        projectInstanceId: 'project-b',
        command: 'codex',
        args: ['app-server', '--listen', 'stdio://'],
        cwd: undefined,
        serviceName: 'codex-bridge',
        transport: 'websocket',
        websocketUrl: 'ws://127.0.0.1:4000',
        adapterType: 'codex',
      },
    ],
  );
});

test('loads stdio project configs from projects file shape', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-bridge-projects-'));
  const filePath = join(tempDir, 'projects.json');

  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        projects: [
          {
            projectInstanceId: 'project-a',
            transport: 'stdio',
            command: 'codex',
            args: ['app-server'],
            cwd: '/repo/a',
            model: 'gpt-5.4',
            serviceName: 'codex-bridge-a',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  assert.deepEqual(resolveCodexRuntimeConfigs({
    BRIDGE_CODEX_PROJECTS_JSON: JSON.stringify([
      {
        projectInstanceId: 'project-a',
        transport: 'stdio',
        command: 'codex',
        args: ['app-server'],
        cwd: '/repo/a',
        model: 'gpt-5.4',
        serviceName: 'codex-bridge-a',
      },
    ]),
  }), [
    {
      projectInstanceId: 'project-a',
      command: 'codex',
      args: ['app-server'],
      cwd: '/repo/a',
      model: 'gpt-5.4',
      serviceName: 'codex-bridge-a',
      transport: 'stdio',
      websocketUrl: undefined,
      adapterType: 'codex',
    },
  ]);

  rmSync(tempDir, { recursive: true, force: true });
});

test('writes projects file snapshots in the same shape they are read from', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-bridge-projects-'));
  const filePath = join(tempDir, 'projects.json');

  writeProjectsFile(filePath, [
    {
      projectInstanceId: 'project-a',
      command: 'codex',
      args: ['app-server'],
      cwd: '/repo/a',
      model: 'gpt-5.4-mini',
      serviceName: 'codex-bridge-a',
      transport: 'websocket',
      websocketUrl: 'ws://127.0.0.1:4000',
    },
  ]);

  assert.deepEqual(
    JSON.parse(readFileSync(filePath, 'utf8')),
    {
      projects: [
        {
          projectInstanceId: 'project-a',
          command: 'codex',
          args: ['app-server'],
          cwd: '/repo/a',
          model: 'gpt-5.4-mini',
          serviceName: 'codex-bridge-a',
          transport: 'websocket',
          websocketUrl: 'ws://127.0.0.1:4000',
        },
      ],
    },
  );

  rmSync(tempDir, { recursive: true, force: true });
});

test('preserves the original cwd text when rewriting loaded projects', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-bridge-projects-'));
  const filePath = join(tempDir, 'projects.json');
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = '/Users/yonghui';
    writeFileSync(
      filePath,
      `${JSON.stringify(
        {
          projects: [
            {
              projectInstanceId: 'project-a',
              command: 'codex',
              args: ['app-server'],
              cwd: '~/workspace/codex-bridge',
              serviceName: 'codex-bridge',
              transport: 'websocket',
              websocketUrl: 'ws://127.0.0.1:4000',
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const projects = loadProjectsFromFile(filePath);

    assert.deepEqual(projects, [
      {
        projectInstanceId: 'project-a',
        command: 'codex',
        args: ['app-server'],
        cwd: '/Users/yonghui/workspace/codex-bridge',
        serviceName: 'codex-bridge',
        transport: 'websocket',
        websocketUrl: 'ws://127.0.0.1:4000',
        adapterType: 'codex',
      },
    ]);

    if (projects === null) {
      assert.fail('expected projects to load');
    }

    writeProjectsFile(filePath, projects);

    assert.deepEqual(
      JSON.parse(readFileSync(filePath, 'utf8')),
      {
        projects: [
          {
            projectInstanceId: 'project-a',
            command: 'codex',
            args: ['app-server'],
            cwd: '~/workspace/codex-bridge',
            serviceName: 'codex-bridge',
            transport: 'websocket',
            websocketUrl: 'ws://127.0.0.1:4000',
          },
        ],
      },
    );
  } finally {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('expands tilde cwd values from project config files', () => {
  assert.deepEqual(
    resolveCodexRuntimeConfigs({
      BRIDGE_CODEX_PROJECTS_JSON: JSON.stringify([
        {
          projectInstanceId: 'project-a',
          cwd: '~/xiaoan-source/deploy',
        },
      ]),
      HOME: '/Users/yonghui',
    }),
    [
      {
        projectInstanceId: 'project-a',
        command: 'codex',
        args: ['app-server'],
        cwd: '/Users/yonghui/xiaoan-source/deploy',
        serviceName: 'codex-bridge',
        transport: 'websocket',
        websocketUrl: 'ws://127.0.0.1:4000',
        adapterType: 'codex',
      },
    ],
  );
});

test('keeps the last valid projects snapshot when reload encounters invalid json', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-bridge-projects-'));
  const filePath = join(tempDir, 'projects.json');
  const firstSnapshot = [
    {
      projectInstanceId: 'project-a',
      command: 'codex',
      args: ['app-server'],
      cwd: undefined,
      serviceName: 'codex-bridge',
      transport: 'websocket' as const,
      websocketUrl: 'ws://127.0.0.1:4000',
      adapterType: 'codex' as const,
    },
  ];

  writeFileSync(filePath, `${JSON.stringify({ projects: firstSnapshot }, null, 2)}\n`, 'utf8');

  const seenSnapshots: string[][] = [];
  const watcher = createProjectConfigWatcher({
    filePath,
    onProjectsChanged(projects) {
      seenSnapshots.push(projects.map((entry) => entry.projectInstanceId));
    },
  });

  await watcher.reload();
  assert.deepEqual(watcher.getProjects(), firstSnapshot);

  writeFileSync(filePath, '{ invalid json', 'utf8');
  await watcher.reload();

  assert.deepEqual(watcher.getProjects(), firstSnapshot);
  assert.deepEqual(seenSnapshots, [['project-a']]);

  rmSync(tempDir, { recursive: true, force: true });
});

test('can start a projects watcher even when the file does not exist yet', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-bridge-projects-'));
  const filePath = join(tempDir, 'projects.json');

  const watcher = createProjectConfigWatcher({
    filePath,
  });

  await watcher.start();
  await watcher.reload();
  await watcher.stop();

  assert.deepEqual(watcher.getProjects(), []);

  rmSync(tempDir, { recursive: true, force: true });
});

test('continues when file watching is unavailable', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'codex-bridge-projects-'));
  const filePath = join(tempDir, 'projects.json');
  let errorListener: ((error: Error) => void) | null = null;

  const watcher = createProjectConfigWatcher({
    filePath,
    watchDirectory() {
      return {
        close() {
          return this;
        },
        on(event: 'error', listener: (error: Error) => void) {
          if (event === 'error') {
            errorListener = listener;
          }
          return this;
        },
      } as unknown as import('node:fs').FSWatcher;
    },
  });

  await watcher.start();
  queueMicrotask(() => {
    const error = new Error('too many open files');
    (error as { code?: string }).code = 'EMFILE';
    errorListener?.(error);
  });
  await new Promise((resolve) => setImmediate(resolve));
  await watcher.reload();
  await watcher.stop();

  assert.deepEqual(watcher.getProjects(), []);

  rmSync(tempDir, { recursive: true, force: true });
});

test('serializes watcher reload publications so stale snapshots do not win', async () => {
  const firstSnapshot = [{ projectInstanceId: 'project-a', transport: 'stdio' as const, cwd: '/one' }];
  const secondSnapshot = [{ projectInstanceId: 'project-a', transport: 'stdio' as const, cwd: '/two' }];
  const appliedSnapshots: string[][] = [];
  const blockers: Array<() => void> = [];

  let readCount = 0;
  const watcher = createProjectConfigWatcher({
    filePath: '/tmp/unused-projects.json',
    readProjects: async () => {
      readCount += 1;
      return readCount === 1 ? firstSnapshot : secondSnapshot;
    },
    onProjectsChanged: async (projects) => {
      appliedSnapshots.push(projects.map((entry) => entry.cwd ?? ''));
      if (appliedSnapshots.length === 1) {
        await new Promise<void>((resolve) => {
          blockers.push(resolve);
        });
      }
    },
  });

  const firstReload = watcher.reload();
  await Promise.resolve();
  const secondReload = watcher.reload();
  await Promise.resolve();

  assert.deepEqual(appliedSnapshots, [['/one']]);

  blockers.pop()?.();
  await firstReload;
  await secondReload;

  assert.deepEqual(appliedSnapshots, [['/one'], ['/two']]);
  assert.deepEqual(watcher.getProjects(), secondSnapshot);
});

test('stop waits for an in-flight reload to finish before returning', async () => {
  const firstSnapshot = [{ projectInstanceId: 'project-a', websocketUrl: 'ws://one' }];
  let release: (() => void) | null = null;
  let startedResolve: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });

  const watcher = createProjectConfigWatcher({
    filePath: '/tmp/unused-projects.json',
    readProjects: async () => firstSnapshot,
    onProjectsChanged: async () => {
      startedResolve?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });

  const reloadPromise = watcher.reload();
  await started;

  const stopPromise = watcher.stop();
  let stopFinished = false;
  stopPromise.then(() => {
    stopFinished = true;
  });

  assert.equal(stopFinished, false);

  release?.();
  await reloadPromise;
  await stopPromise;

  assert.equal(stopFinished, true);
});
