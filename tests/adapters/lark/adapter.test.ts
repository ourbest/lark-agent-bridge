import assert from 'node:assert/strict';
import test from 'node:test';

import { LarkAdapter } from '../../../src/adapters/lark/adapter.ts';

test('normalizes a lark event into an inbound bridge message', () => {
  const adapter = new LarkAdapter({
    onEvent() {},
    async sendMessage() {},
    async sendReaction() {},
  });

  const event = adapter.normalizeInboundEvent({
    sessionId: 'session-a',
    messageId: 'message-1',
    text: 'hello',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  assert.deepEqual(event, {
    source: 'lark',
    sessionId: 'session-a',
    messageId: 'message-1',
    text: 'hello',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });
});

test('sends outbound bridge messages through the lark transport', async () => {
  const sentMessages: Array<{ sessionId: string; text: string; format?: 'auto' | 'text' }> = [];
  const adapter = new LarkAdapter({
    onEvent() {},
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendReaction() {},
  });

  await adapter.send({
    targetSessionId: 'session-a',
    text: 'reply:hello',
  });

  assert.deepEqual(sentMessages, [
    {
      sessionId: 'session-a',
      text: 'reply:hello',
    },
  ]);
});

test('sends outbound files through the lark transport when supported', async () => {
  const sentFiles: Array<{ sessionId: string; filePath: string; fileName: string; fallbackText?: string }> = [];
  const adapter = new LarkAdapter({
    onEvent() {},
    async sendMessage() {},
    async sendFile(message) {
      sentFiles.push(message);
    },
    async sendReaction() {},
  });

  await adapter.sendFile({
    targetSessionId: 'session-a',
    filePath: '/tmp/example.txt',
    fileName: 'example.txt',
    fallbackText: 'fallback text',
  });

  assert.deepEqual(sentFiles, [
    {
      sessionId: 'session-a',
      filePath: '/tmp/example.txt',
      fileName: 'example.txt',
      fallbackText: 'fallback text',
    },
  ]);
});
