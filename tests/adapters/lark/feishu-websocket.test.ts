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
let mockSendReaction: (opts: { messageId: string; emojiType: string }) => Promise<void>;

test('implements LarkTransport interface', () => {
  registeredHandlers = {};
  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSendMessage as never,
    sendReactionFn: mockSendReaction as never,
  });

  assert.equal(typeof transport.onEvent, 'function');
  assert.equal(typeof transport.sendMessage, 'function');
  assert.equal(typeof transport.sendCard, 'function');
  assert.equal(typeof transport.sendReaction, 'function');
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
    sendReactionFn: mockSendReaction as never,
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

test('normalizes image message event to LarkEventPayload with attachment', async () => {
  registeredHandlers = {};
  const receivedEvents: LarkEventPayload[] = [];

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSendMessage as never,
    sendReactionFn: mockSendReaction as never,
  });

  transport.onEvent((event) => {
    receivedEvents.push(event);
  });

  await transport.start();

  // Simulate image message event
  const content = JSON.stringify({ image_key: 'img_abc123' });
  await registeredHandlers['im.message.receive_v1']({
    sender: {
      sender_id: { open_id: 'user_xyz' },
    },
    message: {
      message_id: 'msg_image_1',
      chat_id: 'chat_abc',
      content,
      create_time: '2026-04-10T00:00:00.000Z',
      message_type: 'image',
    },
  });

  assert.equal(receivedEvents.length, 1);
  assert.equal(receivedEvents[0].sessionId, 'chat_abc');
  assert.equal(receivedEvents[0].messageId, 'msg_image_1');
  assert.equal(receivedEvents[0].text, '');
  assert.equal(receivedEvents[0].senderId, 'user_xyz');
  assert.equal(receivedEvents[0].timestamp, '2026-04-10T00:00:00.000Z');
  assert.equal(receivedEvents[0].attachments?.length, 1);
  assert.equal(receivedEvents[0].attachments?.[0].fileKey, 'img_abc123');
  assert.equal(receivedEvents[0].attachments?.[0].attachmentType, 'image');
});

test('sends message via sendMessageFn with chat_id as receive_id', async () => {
  registeredHandlers = {};
  let sentTo: string | null = null;
  let sentMsgType: string | null = null;
  let sentContent: string | null = null;

  const mockSend = async (opts: {
    receiveId: string;
    msgType: string;
    content: string;
  }) => {
    sentTo = opts.receiveId;
    sentMsgType = opts.msgType;
    sentContent = opts.content;
  };

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSend as never,
    sendReactionFn: mockSendReaction as never,
    onSend: () => {},
  });

  await transport.start();
  await transport.sendMessage({ sessionId: 'chat_abc', text: 'reply text' });

  assert.equal(sentTo, 'chat_abc');
  assert.equal(sentMsgType, 'text');
  assert.equal(sentContent, JSON.stringify({ text: 'reply text' }));
});

test('sends markdown messages as feishu post content', async () => {
  registeredHandlers = {};
  let sentMsgType: string | null = null;
  let sentContent: string | null = null;

  const mockSend = async (opts: {
    receiveId: string;
    msgType: string;
    content: string;
  }) => {
    assert.equal(opts.receiveId, 'chat_abc');
    sentMsgType = opts.msgType;
    sentContent = opts.content;
  };

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSend as never,
    sendReactionFn: mockSendReaction as never,
    onSend: () => {},
  });

  await transport.start();
  await transport.sendMessage({ sessionId: 'chat_abc', text: '**title**' });

  assert.equal(sentMsgType, 'post');
  assert.equal(
    sentContent,
    JSON.stringify({
      zh_cn: {
        title: '',
        content: [
          [{ tag: 'md', text: '**title**' }],
        ],
      },
    }),
  );
});

test('sends interactive cards through sendMessageFn', async () => {
  registeredHandlers = {};
  let sentMsgType: string | null = null;
  let sentContent: string | null = null;
  let returnedMessageId: string | null = null;

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: async (opts) => {
      sentMsgType = opts.msgType;
      sentContent = String(opts.content);
      return { messageId: 'msg_card_1' };
    },
    sendReactionFn: mockSendReaction as never,
    onSendCard: () => {},
  });

  const result = await transport.sendCard({
    sessionId: 'chat_abc',
    card: {
      msg_type: 'interactive',
      content: JSON.stringify({
        header: {
          template: 'blue',
          title: { tag: 'plain_text', content: 'project-a' },
        },
      }),
    },
  });
  returnedMessageId = result?.messageId ?? null;

  assert.equal(sentMsgType, 'interactive');
  assert.equal(returnedMessageId, 'msg_card_1');
  assert.deepEqual(JSON.parse(sentContent ?? '{}'), {
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'project-a' },
    },
  });
});

test('swallows sendMessageFn failures while sending interactive cards', async () => {
  registeredHandlers = {};
  let called = false;

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: async () => {
      called = true;
      throw new Error('Request failed with status code 400');
    },
    sendReactionFn: mockSendReaction as never,
  });

  const result = await transport.sendCard({
    sessionId: 'chat_abc',
    card: {
      msg_type: 'interactive',
      content: JSON.stringify({
        header: {
          template: 'blue',
          title: { tag: 'plain_text', content: 'project-a' },
        },
      }),
    },
  });

  assert.equal(called, true);
  assert.equal(result, undefined);
});

test('updates interactive cards through updateMessageFn', async () => {
  registeredHandlers = {};
  let updatedMessageId: string | null = null;
  let updatedMsgType: string | null = null;
  let updatedContent: string | null = null;

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSendMessage as never,
    updateMessageFn: async ({ sessionId, messageId, msgType, content }) => {
      void sessionId;
      updatedMessageId = messageId;
      updatedMsgType = msgType;
      updatedContent = String(content);
    },
    sendReactionFn: mockSendReaction as never,
  });

  await transport.updateCard?.({
    messageId: 'msg_card_2',
    card: {
      msg_type: 'interactive',
      content: JSON.stringify({
        header: {
          template: 'green',
          title: { tag: 'plain_text', content: 'Done' },
        },
      }),
    },
    fallbackText: 'Done',
  });

  assert.equal(updatedMessageId, 'msg_card_2');
  assert.equal(updatedMsgType, 'interactive');
  assert.deepEqual(JSON.parse(updatedContent ?? '{}'), {
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: 'Done' },
    },
  });
});

test('serializes interactive card updates for the same session', async () => {
  registeredHandlers = {};
  const callOrder: string[] = [];
  let releaseFirstUpdate: (() => void) | null = null;

  const firstUpdate = new Promise<void>((resolve) => {
    releaseFirstUpdate = resolve;
  });

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSendMessage as never,
    updateMessageFn: async ({ messageId, content }) => {
      callOrder.push(messageId);
      if (messageId === 'msg_card_1') {
        await firstUpdate;
      }

      callOrder.push(String(content));
    },
    sendReactionFn: mockSendReaction as never,
  });

  const first = transport.updateCard?.({
    messageId: 'msg_card_1',
    card: {
      msg_type: 'interactive',
      content: JSON.stringify({ header: { title: { tag: 'plain_text', content: 'One' } } }),
    },
    fallbackText: 'One',
  });

  const second = transport.updateCard?.({
    messageId: 'msg_card_2',
    card: {
      msg_type: 'interactive',
      content: JSON.stringify({ header: { title: { tag: 'plain_text', content: 'Two' } } }),
    },
    fallbackText: 'Two',
  });

  assert.equal(callOrder[0], 'msg_card_1');
  assert.equal(callOrder.includes('msg_card_2'), false);

  releaseFirstUpdate?.();
  await first;
  await second;

  assert.deepEqual(callOrder, [
    'msg_card_1',
    JSON.stringify({ header: { title: { tag: 'plain_text', content: 'One' } } }),
    'msg_card_2',
    JSON.stringify({ header: { title: { tag: 'plain_text', content: 'Two' } } }),
  ]);
});

test('routes card action triggers as inbound messages with command text', async () => {
  registeredHandlers = {};
  const receivedEvents: LarkEventPayload[] = [];

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSendMessage as never,
    sendReactionFn: mockSendReaction as never,
  });

  transport.onEvent((event) => {
    receivedEvents.push(event);
  });

  await transport.start();
  await registeredHandlers['card.action.trigger']({
    chat_id: 'chat_abc',
    message_id: 'msg_approval',
    sender: {
      sender_id: {
        open_id: 'user_xyz',
      },
    },
    action: {
      value: {
        action: 'approve',
        requestId: '42',
      },
    },
  });

  assert.deepEqual(receivedEvents, [
    {
      sessionId: 'chat_abc',
      messageId: 'msg_approval',
      text: '',
      senderId: 'user_xyz',
      timestamp: receivedEvents[0]?.timestamp ?? '',
      cardAction: {
        action: 'approve',
        requestId: '42',
      },
    },
  ]);
});

test('sends reactions via sendReactionFn with message id and emoji type', async () => {
  registeredHandlers = {};
  let reactedTo: string | null = null;
  let reactedWith: string | null = null;

  const mockReact = async (opts: {
    messageId: string;
    emojiType: string;
  }) => {
    reactedTo = opts.messageId;
    reactedWith = opts.emojiType;
  };

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSendMessage as never,
    sendReactionFn: mockReact as never,
  });

  await transport.sendReaction({
    targetMessageId: 'msg_123',
    emojiType: 'THUMBSUP',
  });

  assert.equal(reactedTo, 'msg_123');
  assert.equal(reactedWith, 'THUMBSUP');
});

test('passes the target message id through to the SDK reaction call', async () => {
  registeredHandlers = {};
  let sdkMessageId: string | null = null;

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    wsClient: mockWsClient as never,
    eventDispatcher: mockEventDispatcher as never,
    sendMessageFn: mockSendMessage as never,
    sendReactionFn: async (opts) => {
      sdkMessageId = opts.messageId;
    },
  });

  await transport.sendReaction({
    targetMessageId: 'msg_456',
    emojiType: 'THUMBSUP',
  });

  assert.equal(sdkMessageId, 'msg_456');
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
    sendReactionFn: mockSendReaction as never,
  });

  transport.stop();
  assert.equal(closed, true);
});
