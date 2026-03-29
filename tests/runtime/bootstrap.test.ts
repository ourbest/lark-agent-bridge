import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLocalDevLarkTransport,
  resolveBridgeConfig,
} from '../../src/runtime/bootstrap.ts';

test('resolves runtime config from environment overrides', () => {
  const config = resolveBridgeConfig({
    BRIDGE_HOST: '0.0.0.0',
    BRIDGE_PORT: '8088',
    BRIDGE_STORAGE_PATH: '/tmp/codex-bridge.json',
  });

  assert.equal(config.server.host, '0.0.0.0');
  assert.equal(config.server.port, 8088);
  assert.equal(config.storage.path, '/tmp/codex-bridge.json');
});

test('creates a local dev transport that can receive and send messages', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const transport = createLocalDevLarkTransport({
    onSend(message) {
      sentMessages.push(message);
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
  assert.deepEqual(receivedEvents, [
    {
      sessionId: 'session-a',
      text: 'hello',
    },
  ]);
});
