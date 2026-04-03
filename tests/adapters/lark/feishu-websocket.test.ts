import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeishuWebSocketTransport } from '../../../src/adapters/lark/feishu-websocket.ts';
import type { LarkEventPayload } from '../../../src/adapters/lark/adapter.ts';

let registeredHandlers: Record<string, Function> = {};

const mockWsClient = {
  start: async () => {},
  close: () => {},
};

const mockEventDispatcher = {
  register(handler: Record<string, Function>) {
    registeredHandlers = { ...handler };
    return {
      invoke: async () => {},
    };
  },
};

let mockSendMessage: (opts: { receiveId: string; msgType: string; content: string }) => Promise<void>;

test('implements LarkTransport interface', () => {
  registeredHandlers = {};
  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSendMessage as never,
  });

  assert.equal(typeof transport.onEvent, 'function');
  assert.equal(typeof transport.sendMessage, 'function');
  assert.equal(typeof transport.start, 'function');
  assert.equal(typeof transport.stop, 'function');
});

test('normalizes P2ImMessageReceiveV1 event to LarkEventPayload', async () => {
  registeredHandlers = {};
  const receivedEvents: LarkEventPayload[] = [];

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSendMessage as never,
  });

  transport.onEvent((event) => {
    receivedEvents.push(event);
  });

  await transport.start();

  // Simulate im.message.receive_v1 event from SDK
  const content = JSON.stringify({ text: 'hello world' });
  await registeredHandlers['im.message.receive_v1']({
    sender: {
      sender_id: { open_id: 'user_xyz' },
    },
    message: {
      message_id: 'msg_123',
      chat_id: 'chat_abc',
      content,
      create_time: '2026-04-03T00:00:00.000Z',
    },
  });

  assert.equal(receivedEvents.length, 1);
  assert.deepEqual(receivedEvents[0], {
    sessionId: 'chat_abc',
    messageId: 'msg_123',
    text: 'hello world',
    senderId: 'user_xyz',
    timestamp: '2026-04-03T00:00:00.000Z',
  });
});

test('sends message via sendMessageFn with chat_id as receive_id', async () => {
  registeredHandlers = {};
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
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSend as never,
    onSend: () => {},
  });

  await transport.start();
  await transport.sendMessage({ sessionId: 'chat_abc', text: 'reply text' });

  assert.equal(sentTo, 'chat_abc');
  assert.equal(sentContent, JSON.stringify({ text: 'reply text' }));
});

test('stop closes the websocket connection', () => {
  registeredHandlers = {};
  let closed = false;
  const wsClient = {
    start: async () => {},
    close: () => { closed = true; },
  };

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: wsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSendMessage as never,
  });

  transport.stop();
  assert.equal(closed, true);
});
