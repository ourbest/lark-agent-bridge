import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { createBridgeApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config/env.ts';
import type { LarkEventPayload, LarkTransport } from '../../src/adapters/lark/adapter.ts';
import { createProjectConfigWatcher } from '../../src/runtime/project-config-watcher.ts';
import { createProjectRegistry } from '../../src/runtime/project-registry.ts';

test('boots the bridge runtime and forwards a routed reply back to lark', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string } }> = [];
  const updatedCards: Array<{ messageId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendCard(message) {
      sentCards.push(message);
      return { messageId: `card-${sentCards.length}` };
    },
    async updateCard(message) {
      updatedCards.push(message);
    },
    async sendReaction(message) {
      reactions.push(message);
    },
  } as LarkTransport;

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: false,
          active: false,
          removed: false,
          sessionCount: 0,
        };
      },
    },
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

  assert.deepEqual(reactions, []);
  assert.deepEqual(sentMessages, []);
  assert.equal(sentCards.length, 2);
  assert.equal(updatedCards.length, 0);
  const processingCard = JSON.parse(sentCards[0].card.content) as {
    header?: { title?: { content?: string }; subtitle?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(processingCard.header?.title?.content, 'project-a');
  assert.equal(processingCard.header?.subtitle?.content, 'Processing');
  assert.ok(processingCard.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('hello')));

  const card = JSON.parse(sentCards[1]?.card.content ?? '{}') as {
    header?: { title?: { content?: string }; subtitle?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(card.header?.title?.content, 'project-a');
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('reply:hello')));
  const footer = card.body?.elements?.find((element) => element.tag === 'markdown' && typeof element.content === 'string' && element.content.includes('PATH'));
  assert.ok(footer);
  assert.match(JSON.stringify(footer), /PATH/);
  assert.match(JSON.stringify(footer), /Transport/);
  assert.deepEqual(sentMessages, []);

  await app.stop();
  assert.equal(app.ready, false);
});

test('updates the same status card for waiting approval and reconnecting while a reply is in flight', async () => {
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const updatedCards: Array<{ messageId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;
  let resolveReply: ((value: { text: string }) => void) | null = null;

  const transport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage() {
      return undefined;
    },
    async sendCard(message) {
      sentCards.push(message);
      return { messageId: `card-${sentCards.length}` };
    },
    async updateCard(message) {
      updatedCards.push(message);
    },
    async sendReaction() {},
  } as LarkTransport;

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
      getProjectConfig(projectInstanceId) {
        return {
          projectInstanceId,
          cwd: '/repo/project-a',
          transport: 'websocket',
          command: 'codex',
          args: ['app-server'],
        };
      },
    },
  });

  app.router.registerProjectHandler('project-a', async () => await new Promise<{ text: string }>((resolve) => {
    resolveReply = resolve;
  }));

  await app.bindingService.bindProjectToSession('project-a', 'session-a');
  await app.start();
  assert.ok(eventHandler);

  const inFlight = eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-live-status',
    text: 'hello',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  await new Promise((resolve) => setImmediate(resolve));

  await app.reportProjectStatus({
    projectId: 'project-a',
    sessionId: 'session-a',
    status: 'waiting_approval',
    reason: 'Approval required',
    source: 'notification',
  });

  await app.reportProjectStatus({
    projectId: 'project-a',
    sessionId: 'session-a',
    status: 'failed',
    reason: 'Reconnecting... 2/5',
    source: 'notification',
  });

  resolveReply?.({ text: 'reply:hello' });
  await inFlight;

  assert.equal(sentCards.length, 2);
  assert.equal(updatedCards.length, 2);

  const waitingCard = JSON.parse(updatedCards[0]?.card.content ?? '{}') as {
    header?: { subtitle?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(waitingCard.header?.subtitle?.content, 'Waiting Approval');
  assert.ok(waitingCard.body?.elements?.some((element) => String(element.content).includes('Approval required')));

  const reconnectingCard = JSON.parse(updatedCards[1]?.card.content ?? '{}') as {
    header?: { subtitle?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(reconnectingCard.header?.subtitle?.content, 'Reconnecting');
  assert.ok(reconnectingCard.body?.elements?.some((element) => String(element.content).includes('Reconnecting... 2/5')));

  const completedCard = JSON.parse(sentCards.at(-1)?.card.content ?? '{}') as {
    header?: { subtitle?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(completedCard.header?.title?.content, 'project-a');
  assert.ok(completedCard.body?.elements?.some((element) => String(element.content).includes('reply:hello')));

  await app.stop();
});

test('updates the in-flight status card with streamed reply text and activity summaries', async () => {
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const updatedCards: Array<{ messageId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;
  let resolveReply: ((value: { text: string }) => void) | null = null;

  const transport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage() {
      return undefined;
    },
    async sendCard(message) {
      sentCards.push(message);
      return { messageId: `card-${sentCards.length}` };
    },
    async updateCard(message) {
      updatedCards.push(message);
    },
    async sendReaction() {},
  } as LarkTransport;

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
      getProjectConfig(projectInstanceId) {
        return {
          projectInstanceId,
          cwd: '/repo/project-a',
          transport: 'websocket',
          command: 'codex',
          args: ['app-server'],
        };
      },
    },
  });

  app.router.registerProjectHandler('project-a', async () => await new Promise<{ text: string }>((resolve) => {
    resolveReply = resolve;
  }));

  await app.bindingService.bindProjectToSession('project-a', 'session-a');
  await app.start();
  assert.ok(eventHandler);

  const inFlight = eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-stream-status',
    text: 'hello',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  await new Promise((resolve) => setImmediate(resolve));

  await app.reportProjectProgress({
    projectId: 'project-a',
    sessionId: 'session-a',
    summary: 'Running command: npm test',
  });
  await app.reportProjectProgress({
    projectId: 'project-a',
    sessionId: 'session-a',
    textDelta: 'reply so far',
  });

  resolveReply?.({ text: 'final reply' });
  await inFlight;

  assert.equal(sentCards.length, 2);
  assert.equal(updatedCards.length, 2);

  const progressCard = JSON.parse(updatedCards[1]?.card.content ?? '{}') as {
    header?: { subtitle?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(progressCard.header?.subtitle?.content, 'Processing');
  assert.ok(progressCard.body?.elements?.some((element) => String(element.content).includes('Running command: npm test')));
  assert.ok(progressCard.body?.elements?.some((element) => String(element.content).includes('reply so far')));
  assert.match(updatedCards[1]?.fallbackText ?? '', /reply so far/);

  const completedCard = JSON.parse(sentCards.at(-1)?.card.content ?? '{}') as {
    header?: { subtitle?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(completedCard.header?.title?.content, 'project-a');
  assert.ok(completedCard.body?.elements?.some((element) => String(element.content).includes('final reply')));

  await app.stop();
});

test('keeps streamed reply text visible when a done status update finalizes the status card', async () => {
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const updatedCards: Array<{ messageId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;
  let resolveReply: ((value: { text: string }) => void) | null = null;

  const transport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage() {
      return undefined;
    },
    async sendCard(message) {
      sentCards.push(message);
      return { messageId: `card-${sentCards.length}` };
    },
    async updateCard(message) {
      updatedCards.push(message);
    },
    async sendReaction() {},
  } as LarkTransport;

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
      getProjectConfig(projectInstanceId) {
        return {
          projectInstanceId,
          cwd: '/repo/project-a',
          transport: 'websocket',
          command: 'codex',
          args: ['app-server'],
        };
      },
    },
  });

  app.router.registerProjectHandler('project-a', async () => await new Promise<{ text: string }>((resolve) => {
    resolveReply = resolve;
  }));

  await app.bindingService.bindProjectToSession('project-a', 'session-a');
  await app.start();
  assert.ok(eventHandler);

  const inFlight = eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-done-status-card',
    text: 'hello',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  await new Promise((resolve) => setImmediate(resolve));

  await app.reportProjectProgress({
    projectId: 'project-a',
    sessionId: 'session-a',
    textDelta: 'final reply',
  });

  await app.reportProjectStatus({
    projectId: 'project-a',
    sessionId: 'session-a',
    status: 'done',
    source: 'notification',
  });

  const completedCard = JSON.parse(updatedCards.at(-1)?.card.content ?? '{}') as {
    header?: { subtitle?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(completedCard.header?.subtitle?.content, 'Completed');
  assert.ok(completedCard.body?.elements?.some((element) => String(element.content).includes('final reply')));
  assert.ok(!completedCard.body?.elements?.some((element) => String(element.content).includes('Reply delivered below.')));

  resolveReply?.({ text: 'final reply' });
  await inFlight;

  await app.stop();
});

test('reuses the same status card when sendCard returns a snake_case message_id', async () => {
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const updatedCards: Array<{ messageId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;
  let resolveReply: ((value: { text: string }) => void) | null = null;

  const transport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage() {
      return undefined;
    },
    async sendCard(message) {
      sentCards.push(message);
      return { message_id: `card-${sentCards.length}` } as { messageId?: string };
    },
    async updateCard(message) {
      updatedCards.push(message);
    },
    async sendReaction() {},
  } as LarkTransport;

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
      getProjectConfig(projectInstanceId) {
        return {
          projectInstanceId,
          cwd: '/repo/project-a',
          transport: 'websocket',
          command: 'codex',
          args: ['app-server'],
        };
      },
    },
  });

  app.router.registerProjectHandler('project-a', async () => await new Promise<{ text: string }>((resolve) => {
    resolveReply = resolve;
  }));

  await app.bindingService.bindProjectToSession('project-a', 'session-a');
  await app.start();
  assert.ok(eventHandler);

  const inFlight = eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-snake-case-status',
    text: 'hello',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  await new Promise((resolve) => setImmediate(resolve));

  await app.reportProjectProgress({
    projectId: 'project-a',
    sessionId: 'session-a',
    summary: 'Running command: npm test',
  });

  resolveReply?.({ text: 'final reply' });
  await inFlight;

  assert.equal(sentCards.length, 2);
  assert.equal(updatedCards.length, 1);
  assert.equal(updatedCards[0]?.messageId, 'card-1');
  assert.match(sentCards[1]?.fallbackText ?? '', /final reply/);

  await app.stop();
});

test('handles //status using the supplied project registry', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendCard(message) {
      sentCards.push(message);
    },
    async sendReaction(message) {
      reactions.push(message);
    },
  };

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    codexStatusProvider: async () => [
      'Model: gpt-5.4-mini (reasoning medium, summaries auto)',
      'Directory: ~/git/lark-agent-bridge',
      'Permissions: Full Access',
      'Agents.md: AGENTS.md',
      'Collaboration mode: Default',
      'Session: 019d5e2f-9356-7903-9cdd-5ed89c556893',
      '5h limit: [████████████████████] 99% left (resets 11:01)',
      'Weekly limit: [█████░░░░░░░░░░░░░░░] 25% left (resets 18:26 on 8 Apr)',
    ],
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: false,
          removed: false,
          sessionCount: 0,
        };
      },
    },
  });

  await app.bindingService.bindProjectToSession('project-a', 'session-a');
  await app.start();

  assert.ok(eventHandler);

  await eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-2',
    text: '//status',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  assert.deepEqual(reactions, []);
  assert.deepEqual(sentMessages, []);
  assert.equal(sentCards.length, 1);
  assert.equal(sentCards[0]?.sessionId, 'session-a');
  assert.match(sentCards[0]?.fallbackText ?? '', /\[lark-agent-bridge\] Bridge State:/);
  const card = JSON.parse(sentCards[0]?.card.content ?? '{}') as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(card.header?.title?.content, 'Session State');
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('chatId: session-a')));

  await app.stop();
});

test('renders generic bridge command responses as interactive cards', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendCard(message) {
      sentCards.push(message);
    },
    async sendReaction() {},
  };

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
  });

  await app.start();
  assert.ok(eventHandler);

  await eventHandler!({
    sessionId: 'session-bind',
    messageId: 'message-bind',
    text: '//bind cms-fe',
    senderId: 'user-bind',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  assert.deepEqual(sentMessages, []);
  assert.equal(sentCards.length, 1);
  assert.match(sentCards[0]?.fallbackText ?? '', /bound chat session-bind to project "cms-fe"/);

  const card = JSON.parse(sentCards[0]?.card.content ?? '{}') as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(card.header?.title?.content, 'bind');
  assert.ok(card.body?.elements?.some((element) => String(element.content).includes('cms-fe')));

  await app.stop();
});

test('renders codex query command results as interactive cards', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendCard(message) {
      sentCards.push(message);
    },
    async sendReaction(message) {
      reactions.push(message);
    },
  };

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
      getProjectConfig(projectInstanceId) {
        return {
          projectInstanceId,
          cwd: '/repo/project-a',
          transport: 'stdio',
          command: 'codex',
          args: ['app-server'],
        };
      },
    },
    executeStructuredCodexCommand: async ({ method }) => {
      if (method === 'app/list') {
        return [
          '[lark-agent-bridge] app/list: 1 item(s)',
          '1. shell',
          '   title: Shell',
        ];
      }

      return [
        '[lark-agent-bridge] thread/read',
        'id: thr_123',
        'preview: hello world',
      ];
    },
  });

  await app.bindingService.bindProjectToSession('project-a', 'session-a');
  await app.start();
  assert.ok(eventHandler);

  await eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-app-list',
    text: '//app/list',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  await eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-thread-read',
    text: '//thread/read thr_123',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:01.000Z',
  });

  assert.deepEqual(sentMessages, []);
  assert.equal(sentCards.length, 2);
  assert.match(sentCards[0]?.fallbackText ?? '', /\[lark-agent-bridge\] app\/list: 1 item\(s\)/);
  assert.match(sentCards[1]?.fallbackText ?? '', /\[lark-agent-bridge\] thread\/read/);

  const firstCard = JSON.parse(sentCards[0]?.card.content ?? '{}') as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(firstCard.header?.title?.content, 'app/list');
  assert.ok(firstCard.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('1. shell')));

  const secondCard = JSON.parse(sentCards[1]?.card.content ?? '{}') as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(secondCard.header?.title?.content, 'thread/read');
  assert.ok(secondCard.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('id: thr_123')));

  await app.stop();
});

test('renders //read file content as an interactive markdown card', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lark-agent-bridge-read-'));
  const relativePath = 'src/example.ts';
  const absolutePath = join(tempDir, relativePath);
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(absolutePath, 'export const answer = 42;\n', 'utf8');

  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendCard(message) {
      sentCards.push(message);
    },
    async sendReaction(message) {
      reactions.push(message);
    },
  };

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
      getProjectConfig(projectInstanceId) {
        return {
          projectInstanceId,
          cwd: tempDir,
          transport: 'stdio',
          command: 'codex',
          args: ['app-server'],
        };
      },
    },
  });

  await app.bindingService.bindProjectToSession('project-a', 'session-a');
  await app.start();
  assert.ok(eventHandler);

  await eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-read',
    text: `//read ${relativePath}`,
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  assert.deepEqual(reactions, []);
  assert.deepEqual(sentMessages, []);
  assert.equal(sentCards.length, 1);
  assert.match(sentCards[0]?.fallbackText ?? '', /export const answer = 42;/);

  const card = JSON.parse(sentCards[0]?.card.content ?? '{}') as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(card.header?.title?.content, relativePath);
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('```ts')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('export const answer = 42;')));

  await app.stop();
  rmSync(tempDir, { recursive: true, force: true });
});

test('renders //read for a project with relative cwd configured', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lark-agent-bridge-read-relative-'));
  const repoRoot = join(tempDir, 'workspace');
  const projectDir = join(repoRoot, 'project-a');
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src/example.ts'), 'export const relative = true;\n', 'utf8');

  const previousCwd = process.cwd();
  process.chdir(repoRoot);

  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendCard(message) {
      sentCards.push(message);
    },
    async sendReaction() {},
  };

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
      getProjectConfig(projectInstanceId) {
        return {
          projectInstanceId,
          cwd: './project-a',
          transport: 'stdio',
          command: 'codex',
          args: ['app-server'],
        };
      },
    },
  });

  try {
    await app.bindingService.bindProjectToSession('project-a', 'session-a');
    await app.start();
    assert.ok(eventHandler);

    await eventHandler!({
      sessionId: 'session-a',
      messageId: 'message-read-relative',
      text: '//read src/example.ts',
      senderId: 'user-a',
      timestamp: '2026-03-29T00:00:00.000Z',
    });

    assert.deepEqual(sentMessages, []);
    assert.equal(sentCards.length, 1);
    assert.match(sentCards[0]?.fallbackText ?? '', /export const relative = true;/);
  } finally {
    await app.stop();
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rejects //read when a symlink resolves outside the project cwd', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lark-agent-bridge-read-symlink-'));
  const projectDir = join(tempDir, 'project-a');
  const outsideDir = join(tempDir, 'outside');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.txt'), 'top secret\n', 'utf8');
  symlinkSync(join(outsideDir, 'secret.txt'), join(projectDir, 'secret-link.txt'));

  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendCard(message) {
      sentCards.push(message);
    },
    async sendReaction() {},
  };

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
      getProjectConfig(projectInstanceId) {
        return {
          projectInstanceId,
          cwd: projectDir,
          transport: 'stdio',
          command: 'codex',
          args: ['app-server'],
        };
      },
    },
  });

  try {
    await app.bindingService.bindProjectToSession('project-a', 'session-a');
    await app.start();
    assert.ok(eventHandler);

    await eventHandler!({
      sessionId: 'session-a',
      messageId: 'message-read-symlink',
      text: '//read secret-link.txt',
      senderId: 'user-a',
      timestamp: '2026-03-29T00:00:00.000Z',
    });

    assert.deepEqual(sentMessages, []);
    assert.equal(sentCards.length, 1);
    assert.match(sentCards[0]?.fallbackText ?? '', /only supports files under the project cwd/);
  } finally {
    await app.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('acknowledges //restart before invoking the restart callback', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  const steps: string[] = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
      steps.push(`send:${message.text}`);
    },
    async sendCard(message) {
      sentCards.push(message);
      steps.push(`card:${message.fallbackText ?? ''}`);
    },
    async sendReaction(message) {
      reactions.push(message);
    },
  };

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    onRestartRequested: async () => {
      steps.push('restart');
    },
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: false,
          active: false,
          removed: false,
          sessionCount: 0,
        };
      },
    },
  });

  await app.start();
  assert.ok(eventHandler);

  await eventHandler!({
    sessionId: 'session-restart',
    messageId: 'message-restart',
    text: '//restart',
    senderId: 'user-restart',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  assert.deepEqual(reactions, []);
  assert.deepEqual(sentMessages, []);
  assert.equal(sentCards.length, 1);
  assert.match(sentCards[0]?.fallbackText ?? '', /restarting bridge process/);
  assert.deepEqual(steps, [
    'card:[lark-agent-bridge] restarting bridge process...',
    'restart',
  ]);

  await app.stop();
});

test('renders //help as an interactive card for easier reading', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendCard(message) {
      sentCards.push(message);
    },
    async sendReaction(message) {
      reactions.push(message);
    },
  };

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: false,
          active: false,
          removed: false,
          sessionCount: 0,
        };
      },
    },
  });

  await app.start();
  assert.ok(eventHandler);

  await eventHandler!({
    sessionId: 'session-help',
    messageId: 'message-help',
    text: '//help',
    senderId: 'user-help',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  assert.deepEqual(reactions, []);
  assert.deepEqual(sentMessages, []);
  assert.equal(sentCards.length, 1);
  assert.equal(sentCards[0]?.sessionId, 'session-help');
  assert.equal(sentCards[0]?.card.msg_type, 'interactive');
  assert.match(sentCards[0]?.fallbackText ?? '', /\[lark-agent-bridge\] commands:/);

  const card = JSON.parse(sentCards[0]?.card.content ?? '{}') as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(card.header?.title?.content, 'lark-agent-bridge help');
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('//bind')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('//projects')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('//providers')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('//provider <name>')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('//new')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('//approve-auto <minutes>')));

  await app.stop();
});

test('renders unbound guidance as an interactive card', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendCard(message) {
      sentCards.push(message);
    },
    async sendReaction(message) {
      reactions.push(message);
    },
  };

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: false,
          active: false,
          removed: false,
          sessionCount: 0,
        };
      },
    },
  });

  await app.start();
  assert.ok(eventHandler);

  await eventHandler!({
    sessionId: 'session-unbound',
    messageId: 'message-unbound',
    text: 'hello there',
    senderId: 'user-unbound',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  assert.deepEqual(reactions, []);
  assert.deepEqual(sentMessages, []);
  assert.equal(sentCards.length, 1);
  assert.equal(sentCards[0]?.sessionId, 'session-unbound');
  assert.equal(sentCards[0]?.card.msg_type, 'interactive');
  assert.match(sentCards[0]?.fallbackText ?? '', /unbound session/);
  assert.match(sentCards[0]?.fallbackText ?? '', /\/\/bind <projectId>/);

  const card = JSON.parse(sentCards[0]?.card.content ?? '{}') as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(card.header?.title?.content, 'lark-agent-bridge');
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('not bound')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('//bind <projectId>')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('//projects')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('//providers')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('//provider <name>')));

  await app.stop();
});

test('reports unavailable bound projects without claiming the binding is missing', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const updatedCards: Array<{ messageId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  const loggedErrors: string[] = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const transport = {
      onEvent(handler) {
        eventHandler = handler;
      },
      async sendMessage(message) {
        sentMessages.push(message);
      },
      async sendCard(message) {
        sentCards.push(message);
        return { messageId: `card-${sentCards.length}` };
      },
      async updateCard(message) {
        updatedCards.push(message);
      },
      async sendReaction(message) {
        reactions.push(message);
      },
    } as LarkTransport;

    const app = createBridgeApp({
      config: loadConfig({}),
      larkTransport: transport,
      projectRegistry: {
        async describeProject(projectInstanceId) {
          return {
            projectInstanceId,
            configured: true,
            active: false,
            removed: false,
            sessionCount: 1,
          };
        },
        async getProjectDiagnostics(projectInstanceId) {
          return {
            projectInstanceId,
            status: 'failed',
            reason: 'codex app-server disconnected',
            source: 'generateReply',
          };
        },
        getProjectConfig(projectInstanceId) {
          return {
            projectInstanceId,
            cwd: '/repo/project-a',
            transport: 'stdio',
            command: 'codex',
            args: ['app-server'],
          };
        },
      },
    });

    await app.bindingService.bindProjectToSession('project-a', 'session-a');
    await app.start();
    assert.ok(eventHandler);

    await eventHandler!({
      sessionId: 'session-a',
      messageId: 'message-no-handler',
      text: 'hello',
      senderId: 'user-a',
      timestamp: '2026-03-29T00:00:00.000Z',
    });

    assert.deepEqual(reactions, []);
    assert.deepEqual(sentMessages, []);
    assert.equal(sentCards.length, 1);
    assert.equal(updatedCards.length, 1);
    assert.equal(updatedCards[0]?.messageId, 'card-1');
    assert.match(updatedCards[0]?.fallbackText ?? '', /\[lark-agent-bridge\] bound project is unavailable: project-a/);
    assert.match(updatedCards[0]?.fallbackText ?? '', /reason: codex app-server disconnected/);
    assert.equal(loggedErrors.length, 1);
    assert.match(loggedErrors[0] ?? '', /bound project unavailable/);
    assert.match(loggedErrors[0] ?? '', /project-a/);
    assert.match(loggedErrors[0] ?? '', /codex app-server disconnected/);

    await app.stop();
  } finally {
    console.error = originalConsoleError;
  }
});

test('stops updating an unavailable status card after it has been finalized', async () => {
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const updatedCards: Array<{ messageId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;

  const transport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage() {
      return undefined;
    },
    async sendCard(message) {
      sentCards.push(message);
      return { messageId: `card-${sentCards.length}` };
    },
    async updateCard(message) {
      updatedCards.push(message);
    },
    async sendReaction() {},
  } as LarkTransport;

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: true,
          active: false,
          removed: false,
          sessionCount: 1,
        };
      },
      async getProjectDiagnostics(projectInstanceId) {
        return {
          projectInstanceId,
          status: 'failed',
          reason: 'codex app-server disconnected',
          source: 'generateReply',
        };
      },
      getProjectConfig(projectInstanceId) {
        return {
          projectInstanceId,
          cwd: '/repo/project-a',
          transport: 'stdio',
          command: 'codex',
          args: ['app-server'],
        };
      },
    },
  });

  await app.bindingService.bindProjectToSession('project-a', 'session-a');
  await app.start();
  assert.ok(eventHandler);

  await eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-no-handler-finalized',
    text: 'hello',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  assert.equal(sentCards.length, 1);
  assert.equal(updatedCards.length, 1);

  await app.reportProjectProgress({
    projectId: 'project-a',
    sessionId: 'session-a',
    summary: 'This should be ignored after finalization',
  });

  assert.equal(sentCards.length, 1);
  assert.equal(updatedCards.length, 1);

  await app.stop();
});

test('logs when an in-flight status card update fails and falls back to sending a new card', async () => {
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const loggedErrors: string[] = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;
  let resolveReply: ((value: { text: string }) => void) | null = null;
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const transport = {
      onEvent(handler) {
        eventHandler = handler;
      },
      async sendMessage() {
        return undefined;
      },
      async sendCard(message) {
        sentCards.push(message);
        return { messageId: `card-${sentCards.length}` };
      },
      async updateCard() {
        throw new Error('update rejected');
      },
      async sendReaction() {},
    } as LarkTransport;

    const app = createBridgeApp({
      config: loadConfig({}),
      larkTransport: transport,
      projectRegistry: {
        async describeProject(projectInstanceId) {
          return {
            projectInstanceId,
            configured: true,
            active: true,
            removed: false,
            sessionCount: 1,
          };
        },
        getProjectConfig(projectInstanceId) {
          return {
            projectInstanceId,
            cwd: '/repo/project-a',
            transport: 'websocket',
            command: 'codex',
            args: ['app-server'],
          };
        },
      },
    });

    app.router.registerProjectHandler('project-a', async () => await new Promise<{ text: string }>((resolve) => {
      resolveReply = resolve;
    }));

    await app.bindingService.bindProjectToSession('project-a', 'session-a');
    await app.start();
    assert.ok(eventHandler);

    const inFlight = eventHandler!({
      sessionId: 'session-a',
      messageId: 'message-update-failure',
      text: 'hello',
      senderId: 'user-a',
      timestamp: '2026-03-29T00:00:00.000Z',
    });

    await new Promise((resolve) => setImmediate(resolve));

    await app.reportProjectProgress({
      projectId: 'project-a',
      sessionId: 'session-a',
      summary: 'Running command: npm test',
    });

    resolveReply?.({ text: 'final reply' });
    await inFlight;

    assert.equal(sentCards.length, 3);
    assert.ok(loggedErrors.some((line) => line.includes('status card update failed')));
    assert.ok(loggedErrors.some((line) => line.includes('session=session-a')));
    assert.ok(loggedErrors.some((line) => line.includes('messageId=card-1')));
    assert.ok(loggedErrors.some((line) => line.includes('update rejected')));

    await app.stop();
  } finally {
    console.error = originalConsoleError;
  }
});

test('self-heals a missing bound project handler once before replying with failure', async () => {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  const restored: Array<{ projectInstanceId: string; sessionId: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;
  let app: ReturnType<typeof createBridgeApp> | null = null;

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendCard(message) {
      sentCards.push(message);
    },
    async sendReaction(message) {
      reactions.push(message);
    },
  };

  app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return {
          projectInstanceId,
          configured: true,
          active: false,
          removed: false,
          sessionCount: 1,
        };
      },
      getProjectConfig(projectInstanceId) {
        return {
          projectInstanceId,
          cwd: '/repo/project-a',
          transport: 'stdio',
          command: 'codex',
          args: ['app-server'],
        };
      },
      async restoreBinding(projectInstanceId, sessionId) {
        restored.push({ projectInstanceId, sessionId });
        app?.router.registerProjectHandler(projectInstanceId, async ({ message }) => ({
          text: `reply:${message.text}`,
        }));
      },
    },
  });

  await app.bindingService.bindProjectToSession('project-a', 'session-a');
  await app.start();
  assert.ok(eventHandler);

  await eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-heal-handler',
    text: 'hello',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  assert.deepEqual(reactions, []);
  assert.deepEqual(restored, [
    {
      projectInstanceId: 'project-a',
      sessionId: 'session-a',
    },
  ]);
  assert.deepEqual(sentMessages, []);
  assert.equal(sentCards.length, 2);
  assert.match(sentCards[0]?.fallbackText ?? '', /processing request/i);
  assert.match(sentCards[1]?.fallbackText ?? '', /reply:hello/);

  await app.stop();
});

test('handles //reload projects by reloading a real projects file and reconciling state', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lark-agent-bridge-projects-'));
  const filePath = join(tempDir, 'projects.json');
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        projects: [
          {
            projectInstanceId: 'project-a',
            cwd: '/repo/project-a',
            websocketUrl: 'ws://127.0.0.1:4000',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const sentCards: Array<{ sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }> = [];
  const reactions: Array<{ targetMessageId: string; emojiType: string }> = [];
  let eventHandler: ((event: LarkEventPayload) => Promise<void> | void) | null = null;
  const projectConfigs: Array<{ projectInstanceId: string; websocketUrl: string; cwd: string }> = [];

  const registry = createProjectRegistry({
    getProjectConfig(projectInstanceId) {
      return projectConfigs.find((entry) => entry.projectInstanceId === projectInstanceId) ?? null;
    },
    createClient: () => ({
      async generateReply({ text }) {
        return `reply:${text}`;
      },
      async stop() {},
    }),
  });

  const watcher = createProjectConfigWatcher({
    filePath,
  });

  const transport: LarkTransport = {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      sentMessages.push(message);
    },
    async sendCard(message) {
      sentCards.push(message);
    },
    async sendReaction(message) {
      reactions.push(message);
    },
  };

  const app = createBridgeApp({
    config: loadConfig({}),
    larkTransport: transport,
    codexStatusProvider: async () => [
      'Model: gpt-5.4-mini (reasoning medium, summaries auto)',
      'Directory: ~/git/lark-agent-bridge',
      'Permissions: Full Access',
      'Agents.md: AGENTS.md',
      'Collaboration mode: Default',
      'Session: 019d5e2f-9356-7903-9cdd-5ed89c556893',
      '5h limit: [████████████████████] 99% left (resets 11:01)',
      'Weekly limit: [█████░░░░░░░░░░░░░░░] 25% left (resets 18:26 on 8 Apr)',
    ],
    projectRegistry: {
      async describeProject(projectInstanceId) {
        return registry.describeProject(projectInstanceId);
      },
    },
    reloadProjects: async () => {
      const projects = await watcher.reload();
      projectConfigs.splice(0, projectConfigs.length, ...projects.map((entry) => ({
        projectInstanceId: entry.projectInstanceId,
        websocketUrl: entry.websocketUrl ?? 'ws://127.0.0.1:4000',
        cwd: entry.cwd ?? '/repo/project-a',
      })));
      await registry.reconcileProjectConfigs(projectConfigs);
      return [`[lark-agent-bridge] reloaded projects: ${projects.length}`];
    },
  });

  await registry.reconcileProjectConfigs([]);
  await app.start();
  await app.bindingService.bindProjectToSession('project-a', 'session-a');
  assert.ok(eventHandler);

  await eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-3',
    text: '//reload projects',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:00.000Z',
  });

  assert.deepEqual(reactions, []);
  assert.deepEqual(sentMessages, []);
  assert.equal(sentCards.length, 1);
  assert.match(sentCards[0]?.fallbackText ?? '', /reloaded projects: 1/);

  const stateAfterReload = await registry.describeProject('project-a');
  assert.deepEqual(stateAfterReload, {
    projectInstanceId: 'project-a',
    configured: true,
    active: false,
    removed: false,
    sessionCount: 0,
  });

  await eventHandler!({
    sessionId: 'session-a',
    messageId: 'message-4',
    text: '//status',
    senderId: 'user-a',
    timestamp: '2026-03-29T00:00:01.000Z',
  });

  assert.equal(sentMessages[0]?.text, undefined);
  assert.equal(sentCards.length, 2);
  assert.match(sentCards[1]?.fallbackText ?? '', /\[lark-agent-bridge\] Bridge State:/);
  assert.match(sentCards[1]?.fallbackText ?? '', /Model: gpt-5.4-mini \(reasoning medium, summaries auto\)/);

  await app.stop();
  rmSync(tempDir, { recursive: true, force: true });
});

test('rejects app construction without a real project registry', async () => {
  const transport: LarkTransport = {
    onEvent() {},
    async sendMessage() {},
    async sendReaction() {},
  };

  await assert.rejects(
    async () =>
      createBridgeApp({
        config: loadConfig({}),
        larkTransport: transport,
      }),
    /projectRegistry is required/,
  );
});
