import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLocalDevLarkTransport,
  resolveBridgeConfig,
  resolveProjectsFilePath,
  resolveProjectsRootPath,
  resolveStoragePath,
} from '../../src/runtime/bootstrap.ts';

test('resolves runtime config from environment overrides', () => {
  const config = resolveBridgeConfig({
    BRIDGE_HOST: '0.0.0.0',
    BRIDGE_PORT: '8088',
    BRIDGE_STORAGE_PATH: '/tmp/lark-agent-bridge.json',
  });

  assert.equal(config.server.host, '0.0.0.0');
  assert.equal(config.server.port, 8088);
  assert.equal(config.storage.path, '/tmp/lark-agent-bridge.json');
});

test('creates a local dev transport that can receive and send messages', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string } }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  const transport = createLocalDevLarkTransport({
    onSend(message) {
      sentMessages.push(message);
    },
    onSendCard(message) {
      sentCards.push(message);
    },
    onReact(message) {
      reactions.push(message);
    },
  });

  const receivedEvents: Array<{ sessionId: string; text: string }> = [];
  transport.onEvent(async (event) => {
    receivedEvents.push({
      sessionId: event.sessionId,
      text: event.text,
    });
  });

  await transport.sendMessage({
    sessionId: 'session-a',
    text: 'reply:hello',
  });
  await transport.sendCard({
    sessionId: 'session-a',
    card: {
      msg_type: 'interactive',
      content: JSON.stringify({ header: { title: { tag: 'plain_text', content: 'work' } } }),
    },
  });
  await transport.sendReaction({
    targetMessageId: 'message-1',
    emojiType: 'THUMBSUP',
  });

  transport.emit({
    sessionId: 'session-a',
    messageId: 'message-1',
    text: 'hello',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  assert.deepEqual(sentMessages, [
    {
      sessionId: 'session-a',
      text: 'reply:hello',
    },
  ]);
  assert.deepEqual(sentCards, [
    {
      sessionId: 'session-a',
      card: {
        msg_type: 'interactive',
        content: JSON.stringify({ header: { title: { tag: 'plain_text', content: 'work' } } }),
      },
      fallbackText: undefined,
    },
  ]);
  assert.deepEqual(reactions, [
    {
      targetMessageId: 'message-1',
      emojiType: 'THUMBSUP',
    },
  ]);
  assert.deepEqual(receivedEvents, [
    {
      sessionId: 'session-a',
      text: 'hello',
    },
  ]);
});

test('resolves the storage path from the environment', () => {
  const storagePath = resolveStoragePath({
    BRIDGE_STORAGE_PATH: '/tmp/bridge-store.json',
  });

  assert.equal(storagePath, '/tmp/bridge-store.json');
});

test('resolves the projects file path from the environment', () => {
  assert.equal(
    resolveProjectsFilePath({
      BRIDGE_PROJECTS_FILE: '/tmp/projects.json',
    }),
    '/tmp/projects.json',
  );

  assert.equal(resolveProjectsFilePath({}), './projects.json');
});

test('resolves the projects root path from the environment', () => {
  assert.equal(
    resolveProjectsRootPath({
      BRIDGE_PROJECTS_ROOT: '/tmp/projects-root',
    }),
    '/tmp/projects-root',
  );

  assert.equal(resolveProjectsRootPath({}), undefined);
});
