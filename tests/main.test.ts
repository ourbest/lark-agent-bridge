import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCodexCommandResultWithFallback,
  patchFeishuMessageCard,
  resolveStartupNotificationTitle,
} from '../src/main.ts';

test('patchFeishuMessageCard sends a PATCH request without msg_type', async () => {
  const calls: Array<{
    method?: string;
    url?: string;
    data?: Record<string, unknown>;
  }> = [];

  await patchFeishuMessageCard(
    {
      async request(payload) {
        calls.push(payload);
        return {};
      },
    },
    {
      messageId: 'om_card_123',
      content: JSON.stringify({
        header: {
          template: 'green',
          title: { tag: 'plain_text', content: 'Done' },
        },
      }),
    },
  );

  assert.deepEqual(calls, [
    {
      method: 'PATCH',
      url: '/open-apis/im/v1/messages/om_card_123',
      params: {
        msg_type: 'interactive',
      },
      data: {
        content: JSON.stringify({
          header: {
            template: 'green',
            title: { tag: 'plain_text', content: 'Done' },
          },
        }),
      },
    },
  ]);
});

test('formatCodexCommandResultWithFallback enriches sparse thread/read results from thread/list', async () => {
  const calls: Array<{ projectInstanceId: string; method: string; params: Record<string, unknown> }> = [];

  const lines = await formatCodexCommandResultWithFallback({
    projectInstanceId: 'project-a',
    method: 'thread/read',
    result: { id: 'thr_123' },
    executeCommand: async (projectInstanceId, input) => {
      calls.push({
        projectInstanceId,
        method: input.method,
        params: input.params,
      });

      assert.equal(projectInstanceId, 'project-a');
      assert.deepEqual(input, {
        method: 'thread/list',
        params: {},
      });

      return {
        threads: [
          {
            id: 'thr_123',
            preview: 'hello world',
            status: { type: 'loaded' },
            cwd: '/tmp/project',
            source: 'vscode',
          },
        ],
      };
    },
  });

  assert.deepEqual(calls, [
    {
      projectInstanceId: 'project-a',
      method: 'thread/list',
      params: {},
    },
  ]);
  assert.deepEqual(lines, [
    '## [lark-agent-bridge] thread/read',
    '- id: thr_123',
    '- preview: hello world',
    '- status: loaded',
    '- cwd: /tmp/project',
    '- source: vscode',
  ]);
});

test('resolveStartupNotificationTitle defaults to lark-agent-bridge and honors BRIDGE_APP_NAME', () => {
  assert.equal(resolveStartupNotificationTitle({}), 'lark-agent-bridge');
  assert.equal(resolveStartupNotificationTitle({ BRIDGE_APP_NAME: '  lark-agent-bridge  ' }), 'lark-agent-bridge');
  assert.equal(resolveStartupNotificationTitle({ BRIDGE_APP_NAME: '   ' }), 'lark-agent-bridge');
});
