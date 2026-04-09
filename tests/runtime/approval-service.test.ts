import assert from 'node:assert/strict';
import test from 'node:test';

import { createApprovalService } from '../../src/runtime/approval-service.ts';

test('registers approval requests and resolves approve-all for command execution', async () => {
  const responses: Array<{ requestId: number; result: unknown }> = [];
  const service = createApprovalService();

  const announcement = await service.registerRequest({
    requestId: 99,
    projectInstanceId: 'project-a',
    sessionId: 'chat-a',
    threadId: 'thr_123',
    turnId: 'turn_1',
    itemId: 'item-1',
    kind: 'commandExecution',
    command: 'rm -rf /tmp/example',
    reason: 'needs approval',
    respond: async (requestId, result) => {
      responses.push({ requestId, result });
    },
  });

  assert.deepEqual(announcement.lines, [
    '[lark-agent-bridge] Approval required:',
    '  Request ID: 99',
    '  kind: command execution',
    '  projectId: project-a',
    '  chatId: chat-a',
    '  threadId: thr_123',
    '  turnId: turn_1',
    '  itemId: item-1',
    '  command: rm -rf /tmp/example',
    '  reason: needs approval',
    '  approve: //approve 99',
    '  approve all: //approve-all 99',
    '  deny: //deny 99',
  ]);
  assert.equal(announcement.card.msg_type, 'interactive');
  const card = JSON.parse(announcement.card.content) as {
    header?: { title?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(card.header?.title?.content, 'Approval required');
  assert.equal(card.body?.elements?.some((element) => element.tag === 'action' || element.tag === 'button'), false);
  assert.ok(card.body?.elements?.some((element) => String(element.content).includes('**Request ID:** 99')));
  assert.ok(card.body?.elements?.some((element) => String(element.content).includes('**Command:**')));

  const lines = await service.handleCommand({
    sessionId: 'chat-a',
    text: '//approve-all 99',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] approved request 99 for the session']);
  assert.deepEqual(responses, [
    {
      requestId: 99,
      result: {
        decision: 'acceptForSession',
      },
    },
  ]);
});

test('denies permissions requests by returning an empty grant', async () => {
  const responses: Array<{ requestId: string; result: unknown }> = [];
  const service = createApprovalService();

  const announcement = await service.registerRequest({
    requestId: 'perm-1',
    projectInstanceId: 'project-a',
    sessionId: 'chat-a',
    threadId: 'thr_123',
    turnId: 'turn_1',
    itemId: 'item-1',
    kind: 'permissions',
    reason: 'needs extra permissions',
    permissions: {
      fileSystem: {
        read: ['/tmp/input'],
        write: ['/tmp/output'],
      },
      network: {
        enabled: true,
      },
    },
    respond: async (requestId, result) => {
      responses.push({ requestId: String(requestId), result });
    },
  });

  assert.deepEqual(announcement.lines, [
    '[lark-agent-bridge] Approval required:',
    '  Request ID: perm-1',
    '  kind: permissions',
    '  projectId: project-a',
    '  chatId: chat-a',
    '  threadId: thr_123',
    '  turnId: turn_1',
    '  itemId: item-1',
    '  permissions:',
    '    fileSystem:',
    '      read: /tmp/input',
    '      write: /tmp/output',
    '    network:',
    '      enabled: yes',
    '  reason: needs extra permissions',
    '  approve: //approve perm-1',
    '  approve all: //approve-all perm-1',
    '  deny: //deny perm-1',
  ]);
  assert.equal(announcement.card.msg_type, 'interactive');
  const card = JSON.parse(announcement.card.content) as {
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };
  assert.equal(card.body?.elements?.some((element) => element.tag === 'action' || element.tag === 'button'), false);
  assert.ok(card.body?.elements?.some((element) => String(element.content).includes('**Request ID:** perm-1')));
  assert.ok(card.body?.elements?.some((element) => String(element.content).includes('**Kind:**')));

  const lines = await service.handleCommand({
    sessionId: 'chat-a',
    text: '//deny perm-1',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] denied permissions request perm-1 by withholding additional permissions']);
  assert.deepEqual(responses, [
    {
      requestId: 'perm-1',
      result: {
        permissions: {},
        scope: 'turn',
      },
    },
  ]);
});

test('approve-auto accepts current-session requests within the configured window', async () => {
  let now = 1_000_000;
  const responses: Array<{ requestId: string; result: unknown }> = [];
  const service = createApprovalService({
    now: () => now,
  });

  const pending = await service.registerRequest({
    requestId: 'pending-1',
    projectInstanceId: 'project-a',
    sessionId: 'chat-a',
    threadId: 'thr_123',
    turnId: 'turn_1',
    itemId: 'item-1',
    kind: 'commandExecution',
    command: 'git add app/pom.xml',
    respond: async (requestId, result) => {
      responses.push({ requestId: String(requestId), result });
    },
  });

  assert.notEqual(pending.card, null);

  const enableLines = await service.handleCommand({
    sessionId: 'chat-a',
    text: '//approve-auto 30',
  });

  assert.deepEqual(enableLines, [
    '[lark-agent-bridge] enabled auto-approval for this chat for 30 minutes',
    '[lark-agent-bridge] auto-approved 1 pending request(s): pending-1',
  ]);
  assert.deepEqual(responses, [
    {
      requestId: 'pending-1',
      result: {
        decision: 'acceptForSession',
      },
    },
  ]);

  const future = await service.registerRequest({
    requestId: 'future-1',
    projectInstanceId: 'project-a',
    sessionId: 'chat-a',
    threadId: 'thr_123',
    turnId: 'turn_2',
    itemId: 'item-2',
    kind: 'commandExecution',
    command: 'rm -rf /tmp/example',
    respond: async (requestId, result) => {
      responses.push({ requestId: String(requestId), result });
    },
  });

  assert.equal(future.card, null);
  assert.deepEqual(responses, [
    {
      requestId: 'pending-1',
      result: {
        decision: 'acceptForSession',
      },
    },
    {
      requestId: 'future-1',
      result: {
        decision: 'acceptForSession',
      },
    },
  ]);

  now += 31 * 60 * 1000;

  const expired = await service.registerRequest({
    requestId: 'future-2',
    projectInstanceId: 'project-a',
    sessionId: 'chat-a',
    threadId: 'thr_123',
    turnId: 'turn_3',
    itemId: 'item-3',
    kind: 'commandExecution',
    command: 'touch /tmp/after-expiry',
    respond: async (requestId, result) => {
      responses.push({ requestId: String(requestId), result });
    },
  });

  assert.notEqual(expired.card, null);
});
