import assert from 'node:assert/strict';
import test from 'node:test';

import { patchFeishuMessageCard } from '../src/main.ts';

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
  assert.equal('msg_type' in (calls[0]?.data ?? {}), false);
});
