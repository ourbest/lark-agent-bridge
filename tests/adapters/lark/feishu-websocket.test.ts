import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeishuWebSocketTransport } from '../../../src/adapters/lark/feishu-websocket.ts';
import type { LarkEventPayload } from '../../../src/adapters/lark/adapter.ts';

// Mock lark_ws module
const mockClient = {
  start: async () => {},
  stop: async () => {},
  on: function(event: string, handler: (...args: unknown[]) => void) {
    (this as Record<string, unknown>)[`handler_${event}`] = handler;
    return this;
  },
};

let mockSendMessage: (opts: { receiveId: string; msgType: string; content: string }) => Promise<void>;

test('implements LarkTransport interface', () => {
  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    larkClient: mockClient as never,
    sendMessageFn: mockSendMessage as never,
  });

  assert.equal(typeof transport.onEvent, 'function');
  assert.equal(typeof transport.sendMessage, 'function');
  assert.equal(typeof transport.start, 'function');
  assert.equal(typeof transport.stop, 'function');
});

test('normalizes P2ImMessageReceiveV1 event to LarkEventPayload', async () => {
  const receivedEvents: LarkEventPayload[] = [];

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    larkClient: mockClient as never,
    sendMessageFn: mockSendMessage as never,
  });

  transport.onEvent((event) => {
    receivedEvents.push(event);
  });

  await transport.start();

  // Simulate P2ImMessageReceiveV1 event from SDK
  const content = JSON.stringify({ text: 'hello world' });
  const handler = (mockClient as Record<string, { (): void }>).handler_P2ImMessageReceiveV1;
  handler({
    event: {
      message: {
        message_id: 'msg_123',
        chat_id: 'chat_abc',
        content,
      },
      sender: {
        sender_id: { open_id: 'user_xyz' },
      },
    },
  });

  assert.equal(receivedEvents.length, 1);
  assert.deepEqual(receivedEvents[0], {
    sessionId: 'chat_abc',
    messageId: 'msg_123',
    text: 'hello world',
    senderId: 'user_xyz',
    timestamp: '',
  });
});

test('sends message via sendMessageFn with chat_id as receive_id', async () => {
  let sentTo: string | null = null;
  let sentContent: string | null = null;

  const mockSend = async (opts: {
    receiveId: string;
    msgType: string;
    content: string;
  }) => {
    sentTo = opts.receiveId;
    sentContent = opts.content;
  };

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    larkClient: mockClient as never,
    sendMessageFn: mockSend as never,
    onSend: () => {},
  });

  await transport.start();
  await transport.sendMessage({ sessionId: 'chat_abc', text: 'reply text' });

  assert.equal(sentTo, 'chat_abc');
  assert.equal(sentContent, JSON.stringify({ text: 'reply text' }));
});
