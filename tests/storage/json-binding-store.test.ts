import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { JsonBindingStore } from '../../src/storage/json-binding-store.ts';

test('persists the last thread for a chat and project pair', () => {
  const filePath = path.join('/tmp', `lark-agent-bridge-thread-store-${Date.now()}.json`);
  try {
    const store = new JsonBindingStore(filePath);
    store.setLastThreadId('project-a', 'chat-a', 'thr_123');

    const reloaded = new JsonBindingStore(filePath);
    assert.equal(reloaded.getLastThreadId('project-a', 'chat-a'), 'thr_123');
  } finally {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

test('persists bridge project state without runtime handles', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'lark-agent-bridge-state-'));
  const filePath = path.join(tempDir, 'bridge.json');

  try {
    const store = new JsonBindingStore(filePath);
    store.setProjectState({
      projectInstanceId: 'project-a',
      activeProvider: 'qwen',
      websocketPorts: { qwen: 4123 },
      startedProviders: ['codex', 'qwen'],
    });

    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(raw.projectStates, [
      {
        projectInstanceId: 'project-a',
        activeProvider: 'qwen',
        websocketPorts: { qwen: 4123 },
        startedProviders: ['codex', 'qwen'],
      },
    ]);
    assert.equal('process' in (raw.projectStates as Array<Record<string, unknown>>)[0], false);

    const reloaded = new JsonBindingStore(filePath);
    assert.deepEqual(reloaded.getProjectState('project-a'), {
      projectInstanceId: 'project-a',
      activeProvider: 'qwen',
      websocketPorts: { qwen: 4123 },
      startedProviders: ['codex', 'qwen'],
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
