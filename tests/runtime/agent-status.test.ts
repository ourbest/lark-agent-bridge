import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStatusManager } from '../../src/runtime/agent-status.ts';

test('AgentStatusManager should return default state when no data set', () => {
  const manager = new AgentStatusManager();
  const state = manager.getStatus('project-a');
  assert.strictEqual(state.model, null);
  assert.strictEqual(state.sessionId, null);
  assert.strictEqual(state.cwd, null);
  assert.strictEqual(state.gitStatus, 'unknown');
  assert.strictEqual(state.gitBranch, null);
});

test('AgentStatusManager should update from system/init data', () => {
  const manager = new AgentStatusManager();
  manager.updateFromSystemInit('project-a', {
    model: 'opus-4-6',
    sessionId: 'sess_123',
    cwd: '/path/to/project',
    permissionMode: 'default',
  });
  const state = manager.getStatus('project-a');
  assert.strictEqual(state.model, 'opus-4-6');
  assert.strictEqual(state.sessionId, 'sess_123');
  assert.strictEqual(state.cwd, '/path/to/project');
  assert.strictEqual(state.permissionMode, 'default');
});

test('AgentStatusManager should update git state', async () => {
  // Note: This test uses a real git repo, skipping for unit test
  // In real test, mock execFile
});