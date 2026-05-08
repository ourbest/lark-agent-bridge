import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLocalDevLarkTransport,
  resolveAgentIdleTimeoutHours,
  resolveAgentIdleTimeoutMs,
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
  const sentFiles: Array<{ sessionId: string; filePath: string; fileName: string; fallbackText?: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string } }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  const transport = createLocalDevLarkTransport({
    onSend(message) {
      sentMessages.push(message);
    },
    onSendFile(message) {
      sentFiles.push(message);
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
  await transport.sendFile({
    sessionId: 'session-a',
    filePath: '/tmp/example.txt',
    fileName: 'example.txt',
    fallbackText: 'fallback content',
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
  assert.deepEqual(sentFiles, [
    {
      sessionId: 'session-a',
      filePath: '/tmp/example.txt',
      fileName: 'example.txt',
      fallbackText: 'fallback content',
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

test('resolveAgentIdleTimeoutHours returns 48 when env var is unset', () => {
  assert.equal(resolveAgentIdleTimeoutHours({}), 48);
});

test('resolveAgentIdleTimeoutHours parses valid integer', () => {
  assert.equal(resolveAgentIdleTimeoutHours({ BRIDGE_AGENT_IDLE_TIMEOUT_HOURS: '12' }), 12);
});

test('resolveAgentIdleTimeoutHours falls back to 48 on zero', () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    assert.equal(resolveAgentIdleTimeoutHours({ BRIDGE_AGENT_IDLE_TIMEOUT_HOURS: '0' }), 48);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('resolveAgentIdleTimeoutHours falls back to 48 on negative', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(resolveAgentIdleTimeoutHours({ BRIDGE_AGENT_IDLE_TIMEOUT_HOURS: '-1' }), 48);
  } finally {
    console.warn = originalWarn;
  }
});

test('resolveAgentIdleTimeoutHours falls back to 48 on NaN', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(resolveAgentIdleTimeoutHours({ BRIDGE_AGENT_IDLE_TIMEOUT_HOURS: 'abc' }), 48);
  } finally {
    console.warn = originalWarn;
  }
});

test('resolveAgentIdleTimeoutHours falls back to 48 on Infinity', () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(resolveAgentIdleTimeoutHours({ BRIDGE_AGENT_IDLE_TIMEOUT_HOURS: 'Infinity' }), 48);
  } finally {
    console.warn = originalWarn;
  }
});

test('resolveAgentIdleTimeoutHours floors floating point', () => {
  assert.equal(resolveAgentIdleTimeoutHours({ BRIDGE_AGENT_IDLE_TIMEOUT_HOURS: '12.7' }), 12);
});

test('resolveAgentIdleTimeoutHours returns 48 on empty string', () => {
  assert.equal(resolveAgentIdleTimeoutHours({ BRIDGE_AGENT_IDLE_TIMEOUT_HOURS: '' }), 48);
  assert.equal(resolveAgentIdleTimeoutHours({ BRIDGE_AGENT_IDLE_TIMEOUT_HOURS: '   ' }), 48);
});

test('resolveAgentIdleTimeoutMs returns hours converted to ms', () => {
  assert.equal(resolveAgentIdleTimeoutMs({ BRIDGE_AGENT_IDLE_TIMEOUT_HOURS: '2' }), 2 * 60 * 60 * 1000);
});
