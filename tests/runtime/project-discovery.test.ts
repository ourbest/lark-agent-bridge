import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  discoverProjectsFromRoot,
  loadProjectConfigs,
  mergeProjectConfigs,
} from '../../src/runtime/project-discovery.ts';

test('discovers visible project directories from a root folder', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lark-agent-bridge-discovery-'));
  const root = join(tempDir, 'projects');
  mkdirSync(root);
  mkdirSync(join(root, 'alpha'));
  mkdirSync(join(root, '.hidden'));
  mkdirSync(join(root, 'beta'));

  assert.deepEqual(discoverProjectsFromRoot(root), [
    {
      projectInstanceId: 'alpha',
      cwd: join(root, 'alpha'),
      providers: [
        { provider: 'codex', transport: 'stdio' },
        { provider: 'cc', transport: 'stdio' },
        { provider: 'qwen', transport: 'stdio' },
        { provider: 'gemini', transport: 'stdio' },
      ],
    },
    {
      projectInstanceId: 'beta',
      cwd: join(root, 'beta'),
      providers: [
        { provider: 'codex', transport: 'stdio' },
        { provider: 'cc', transport: 'stdio' },
        { provider: 'qwen', transport: 'stdio' },
        { provider: 'gemini', transport: 'stdio' },
      ],
    },
  ]);

  rmSync(tempDir, { recursive: true, force: true });
});

test('merges explicit and discovered projects by projectInstanceId', () => {
  const merged = mergeProjectConfigs(
    [
      {
        projectInstanceId: 'alpha',
        cwd: '/explicit/alpha',
        providers: [{ provider: 'codex', transport: 'stdio' }],
      },
    ],
    [
      {
        projectInstanceId: 'alpha',
        cwd: '/discovered/alpha',
        providers: [
          { provider: 'codex', transport: 'stdio' },
          { provider: 'cc', transport: 'stdio' },
          { provider: 'qwen', transport: 'stdio' },
          { provider: 'gemini', transport: 'stdio' },
        ],
      },
      {
        projectInstanceId: 'beta',
        cwd: '/discovered/beta',
        providers: [
          { provider: 'codex', transport: 'stdio' },
          { provider: 'cc', transport: 'stdio' },
          { provider: 'qwen', transport: 'stdio' },
          { provider: 'gemini', transport: 'stdio' },
        ],
      },
    ],
  );

  assert.deepEqual(merged, [
    {
      projectInstanceId: 'alpha',
      cwd: '/explicit/alpha',
      providers: [{ provider: 'codex', transport: 'stdio' }],
    },
    {
      projectInstanceId: 'beta',
      cwd: '/discovered/beta',
      providers: [
        { provider: 'codex', transport: 'stdio' },
        { provider: 'cc', transport: 'stdio' },
        { provider: 'qwen', transport: 'stdio' },
        { provider: 'gemini', transport: 'stdio' },
      ],
    },
  ]);
});

test('loads merged projects from file and root discovery', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lark-agent-bridge-discovery-'));
  const root = join(tempDir, 'projects');
  const filePath = join(tempDir, 'projects.json');
  mkdirSync(root);
  mkdirSync(join(root, 'beta'));

  const projects = loadProjectConfigs({
    projectsFilePath: filePath,
    projectsRoot: root,
  });

  assert.deepEqual(projects, [
    {
      projectInstanceId: 'beta',
      cwd: join(root, 'beta'),
      providers: [
        { provider: 'codex', transport: 'stdio' },
        { provider: 'cc', transport: 'stdio' },
        { provider: 'qwen', transport: 'stdio' },
        { provider: 'gemini', transport: 'stdio' },
      ],
    },
  ]);

  rmSync(tempDir, { recursive: true, force: true });
});
