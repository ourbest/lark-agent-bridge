import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCodexCommandResult } from '../../src/runtime/codex-command-formatting.ts';

test('formats thread/list data into readable summary lines', () => {
  const lines = formatCodexCommandResult('thread/list', {
    data: [
      {
        id: '019d5675-621f-73f1-b481-9f44d77a8c1f',
        preview: '/sessions',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1775272026,
        updatedAt: 1775295943,
        status: { type: 'notLoaded' },
        cwd: '/Users/yonghui/git/codex-bridge',
        source: 'vscode',
        gitInfo: { branch: 'master' },
      },
      {
        id: '019d564f-25f1-7b03-b7e1-4adf31021509',
        preview: 'git status',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1775269520,
        updatedAt: 1775269597,
        status: { type: 'notLoaded' },
        cwd: '/Users/yonghui/git/codex-bridge',
        source: 'vscode',
        gitInfo: { branch: 'master' },
      },
    ],
  });

  assert.deepEqual(lines, [
    '[codex-bridge] thread/list: 2 item(s)',
    '1. 019d5675-621f-73f1-b481-9f44d77a8c1f',
    '   preview: /sessions',
    '   status: notLoaded',
    '   updated: 2026-04-04 17:45:43',
    '   cwd: /Users/yonghui/git/codex-bridge',
    '   source: vscode',
    '   branch: master',
    '2. 019d564f-25f1-7b03-b7e1-4adf31021509',
    '   preview: git status',
    '   status: notLoaded',
    '   updated: 2026-04-04 10:26:37',
    '   cwd: /Users/yonghui/git/codex-bridge',
    '   source: vscode',
    '   branch: master',
  ]);
});

test('formats thread/list without truncating additional items', () => {
  const lines = formatCodexCommandResult('thread/list', {
    threads: Array.from({ length: 11 }, (_, index) => ({
      id: `thr_${index + 1}`,
      preview: `thread ${index + 1}`,
      status: { type: 'loaded' },
    })),
  });

  assert.equal(lines.some((line) => line.startsWith('... ')), false);
  assert.deepEqual(lines[0], '[codex-bridge] thread/list: 11 item(s)');
  assert.ok(lines.includes('10. thr_10'));
  assert.ok(lines.includes('11. thr_11'));
});

test('falls back to compact key fields for single-object responses', () => {
  const lines = formatCodexCommandResult('thread/read', {
    id: 'thr_123',
    preview: 'hello world',
    status: { type: 'loaded' },
    cwd: '/tmp/project',
    createdAt: 1775269520,
    updatedAt: 1775269597,
    path: '/tmp/project/thread.jsonl',
    turns: [],
  });

  assert.deepEqual(lines, [
    '[codex-bridge] thread/read',
    'id: thr_123',
    'preview: hello world',
    'status: loaded',
    'cwd: /tmp/project',
    'createdAt: 2026-04-04 10:25:20',
    'updatedAt: 2026-04-04 10:26:37',
    'path: /tmp/project/thread.jsonl',
    'turns: 0 item(s)',
  ]);
});

test('truncates oversized scalar values instead of returning raw payloads', () => {
  const lines = formatCodexCommandResult('thread/read', {
    error: 'x'.repeat(220),
  });

  assert.deepEqual(lines, [
    '[codex-bridge] thread/read',
    `error: ${'x'.repeat(117)}...`,
  ]);
});

test('formats app/list into readable app summaries', () => {
  const lines = formatCodexCommandResult('app/list', {
    apps: [
      {
        name: 'shell',
        title: 'Shell',
        description: 'Run commands in the workspace',
      },
      {
        name: 'github',
        title: 'GitHub',
        description: 'Inspect pull requests and issues',
      },
    ],
  });

  assert.deepEqual(lines, [
    '[codex-bridge] app/list: 2 item(s)',
    '1. shell',
    '   title: Shell',
    '   description: Run commands in the workspace',
    '2. github',
    '   title: GitHub',
    '   description: Inspect pull requests and issues',
  ]);
});

test('formats empty lists explicitly', () => {
  const lines = formatCodexCommandResult('app/list', {
    apps: [],
  });

  assert.deepEqual(lines, [
    '[codex-bridge] app/list: 0 item(s)',
    'no items',
  ]);
});
