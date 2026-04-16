import assert from 'node:assert/strict';
import test from 'node:test';

import { restoreBoundProjects } from '../../src/runtime/binding-restoration.ts';

test('skips failed restores and continues with later bindings', async () => {
  const calls: Array<{ projectInstanceId: string; sessionId: string }> = [];
  const warnings: Array<{ projectInstanceId: string; sessionId: string; reason: string }> = [];

  await restoreBoundProjects({
    bindingService: {
      async getAllBindings() {
        return [
          { projectInstanceId: 'project-a', sessionId: 'chat-a' },
          { projectInstanceId: 'project-b', sessionId: 'chat-b' },
        ];
      },
    },
    projectRegistry: {
      async restoreBinding(projectInstanceId: string, sessionId: string) {
        calls.push({ projectInstanceId, sessionId });
        if (projectInstanceId === 'project-a') {
          throw new Error('Failed to connect to Codex websocket at ws://10.8.0.19:4010');
        }
      },
    },
    onError: ({ projectInstanceId, sessionId, error }) => {
      warnings.push({
        projectInstanceId,
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    },
  });

  assert.deepEqual(calls, [
    { projectInstanceId: 'project-a', sessionId: 'chat-a' },
    { projectInstanceId: 'project-b', sessionId: 'chat-b' },
  ]);
  assert.deepEqual(warnings, [
    {
      projectInstanceId: 'project-a',
      sessionId: 'chat-a',
      reason: 'Failed to connect to Codex websocket at ws://10.8.0.19:4010',
    },
  ]);
});
