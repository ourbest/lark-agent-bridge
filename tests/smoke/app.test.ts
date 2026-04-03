import assert from 'node:assert/strict';
import test from 'node:test';

import { createBridgeApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config/env.ts';
import type { LarkEventPayload, LarkTransport } from '../../src/adapters/lark/adapter.ts';

test('boots the bridge runtime and forwards a routed reply back to lark', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
  };

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
  });

  app.router.registerProjectHandler('project-a', async ({ message }) => ({
    text: `reply:${message.text}`,
  }));

  await app.bindingService.bindProjectToSession('project-a', 'session-a');
  await app.start();

  assert.equal(app.ready, true);
  assert.ok(app.apiServer);
  assert.ok(eventHandler);

  await eventHandler!({
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

  await app.stop();
  assert.equal(app.ready, false);
});

