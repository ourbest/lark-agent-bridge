import assert from 'node:assert/strict';
import test from 'node:test';

import { createApprovalService } from '../../src/runtime/approval-service.ts';

function parseCard(content: string): {
  body?: { elements?: Array<{ tag?: string; content?: string; columns?: Array<{ elements?: Array<{ tag?: string }> }> }> };
  config?: { wide_screen_mode?: boolean };
  header?: { title?: { content?: string }; subtitle?: { content?: string } };
} {
  return JSON.parse(content);
}

function cardHasButton(card: ReturnType<typeof parseCard>): boolean {
  for (const element of card.body?.elements ?? []) {
    if (element.tag === 'button') return true;
    if (element.tag === 'column_set') {
      for (const column of element.columns ?? []) {
        for (const colElement of column.elements ?? []) {
          if (colElement.tag === 'button') return true;
        }
      }
    }
  }
  return false;
}

function countButtons(card: ReturnType<typeof parseCard>): number {
  let count = 0;
  for (const element of card.body?.elements ?? []) {
    if (element.tag === 'button') {
      count += 1;
    }
    if (element.tag === 'column_set') {
      for (const column of element.columns ?? []) {
        for (const colElement of column.elements ?? []) {
          if (colElement.tag === 'button') {
            count += 1;
          }
        }
      }
    }
  }
  return count;
}

test('registers approval requests and renders action buttons', async () => {
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
      responses.push({ requestId: Number(requestId), result });
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
    '  actions: 授权 | 授权所有 | 自动授权',
  ]);
  assert.equal(announcement.card.msg_type, 'interactive');
  const card = parseCard(announcement.card.content);
  assert.equal(card.header?.title?.content, 'Approval required');
  assert.equal(card.config?.wide_screen_mode, true);
  assert.ok(cardHasButton(card));
  assert.equal(countButtons(card), 3);
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('**Request ID:** 99')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('**Command:**')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('授权ID: 99')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('注: 自动授权有效期 1 小时')));

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

test('denies permissions requests by returning an empty grant and action buttons', async () => {
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
    '  actions: 授权 | 授权所有 | 自动授权',
  ]);
  assert.equal(announcement.card.msg_type, 'interactive');
  const card = parseCard(announcement.card.content);
  assert.equal(cardHasButton(card), true);
  assert.equal(countButtons(card), 3);
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

test('updates the original card in place for approve and deny actions', async () => {
  const responses: Array<{ requestId: string; result: unknown }> = [];
  const service = createApprovalService();

  await service.registerRequest({
    requestId: 'approve-1',
    projectInstanceId: 'project-a',
    sessionId: 'chat-a',
    threadId: 'thr_123',
    turnId: 'turn_1',
    itemId: 'item-1',
    kind: 'commandExecution',
    command: 'git status',
    respond: async (requestId, result) => {
      responses.push({ requestId: String(requestId), result });
    },
  });
  await service.attachCardMessage('approve-1', 'card-approve-1');

  await service.registerRequest({
    requestId: 'deny-1',
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
  await service.attachCardMessage('deny-1', 'card-deny-1');

  const approveResult = await service.handleAction({
    sessionId: 'chat-a',
    projectInstanceId: 'project-a',
    action: 'approve',
    requestId: 'approve-1',
  });

  assert.deepEqual(approveResult?.lines, ['[lark-agent-bridge] approved request approve-1']);
  assert.equal(approveResult?.updates.length, 1);
  const approvedCard = parseCard(approveResult?.updates[0]?.card.content ?? '{}');
  assert.equal(approvedCard.body?.elements?.some((element) => element.tag === 'action'), false);
  assert.ok(approvedCard.body?.elements?.some((element) => String(element.content).includes('已授权')));
  assert.ok(approvedCard.body?.elements?.some((element) => String(element.content).includes('授权ID: approve-1')));

  const denyResult = await service.handleAction({
    sessionId: 'chat-a',
    projectInstanceId: 'project-a',
    action: 'deny',
    requestId: 'deny-1',
  });

  assert.deepEqual(denyResult?.lines, ['[lark-agent-bridge] denied request deny-1']);
  assert.equal(denyResult?.updates.length, 1);
  const deniedCard = parseCard(denyResult?.updates[0]?.card.content ?? '{}');
  assert.equal(deniedCard.body?.elements?.some((element) => element.tag === 'action'), false);
  assert.ok(deniedCard.body?.elements?.some((element) => String(element.content).includes('已拒绝')));
  assert.ok(deniedCard.body?.elements?.some((element) => String(element.content).includes('授权ID: deny-1')));

  assert.deepEqual(responses, [
    {
      requestId: 'approve-1',
      result: {
        decision: 'accept',
      },
    },
    {
      requestId: 'deny-1',
      result: {
        decision: 'decline',
      },
    },
  ]);
});

test('updates all pending cards in place for approve-all actions', async () => {
  const responses: Array<{ requestId: string; result: unknown }> = [];
  const service = createApprovalService();

  await service.registerRequest({
    requestId: 'bulk-1',
    projectInstanceId: 'project-a',
    sessionId: 'chat-a',
    threadId: 'thr_123',
    turnId: 'turn_1',
    itemId: 'item-1',
    kind: 'commandExecution',
    command: 'git status',
    respond: async (requestId, result) => {
      responses.push({ requestId: String(requestId), result });
    },
  });
  await service.attachCardMessage('bulk-1', 'card-bulk-1');

  await service.registerRequest({
    requestId: 'bulk-2',
    projectInstanceId: 'project-a',
    sessionId: 'chat-a',
    threadId: 'thr_123',
    turnId: 'turn_2',
    itemId: 'item-2',
    kind: 'commandExecution',
    command: 'touch /tmp/example',
    respond: async (requestId, result) => {
      responses.push({ requestId: String(requestId), result });
    },
  });
  await service.attachCardMessage('bulk-2', 'card-bulk-2');

  const result = await service.handleAction({
    sessionId: 'chat-a',
    projectInstanceId: 'project-a',
    action: 'approve-all',
  });

  assert.deepEqual(result?.lines, ['[lark-agent-bridge] approved request(s) for the session: bulk-1, bulk-2']);
  assert.equal(result?.updates.length, 2);
  const updatedOne = parseCard(result?.updates.find((update) => update.requestId === 'bulk-1')?.card.content ?? '{}');
  const updatedTwo = parseCard(result?.updates.find((update) => update.requestId === 'bulk-2')?.card.content ?? '{}');
  assert.equal(updatedOne.body?.elements?.some((element) => element.tag === 'action'), false);
  assert.equal(updatedTwo.body?.elements?.some((element) => element.tag === 'action'), false);
  assert.ok(updatedOne.body?.elements?.some((element) => String(element.content).includes('已授权所有待处理请求')));
  assert.ok(updatedTwo.body?.elements?.some((element) => String(element.content).includes('已授权所有待处理请求')));
  assert.ok(updatedOne.body?.elements?.some((element) => String(element.content).includes('授权ID: bulk-1')));
  assert.ok(updatedTwo.body?.elements?.some((element) => String(element.content).includes('授权ID: bulk-2')));

  assert.deepEqual(responses, [
    {
      requestId: 'bulk-1',
      result: {
        decision: 'acceptForSession',
      },
    },
    {
      requestId: 'bulk-2',
      result: {
        decision: 'acceptForSession',
      },
    },
  ]);
});

test('enables auto-approval for one hour and auto-resolves future requests', async () => {
  let now = 1_000_000;
  const responses: Array<{ requestId: string; result: unknown }> = [];
  const service = createApprovalService({
    now: () => now,
  });

  await service.registerRequest({
    requestId: 'auto-1',
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
  await service.attachCardMessage('auto-1', 'card-auto-1');

  const enableResult = await service.handleAction({
    sessionId: 'chat-a',
    projectInstanceId: 'project-a',
    action: 'approve-auto',
  });

  assert.deepEqual(enableResult?.lines, ['[lark-agent-bridge] auto-approved approval request(s) for this chat: auto-1']);
  assert.equal(enableResult?.updates.length, 1);
  const enabledCard = parseCard(enableResult?.updates[0]?.card.content ?? '{}');
  assert.equal(enabledCard.body?.elements?.some((element) => element.tag === 'action'), false);
  assert.ok(enabledCard.body?.elements?.some((element) => String(element.content).includes('已开启自动授权并处理了当前待处理请求')));

  const future = await service.registerRequest({
    requestId: 'auto-2',
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
      requestId: 'auto-1',
      result: {
        decision: 'acceptForSession',
      },
    },
    {
      requestId: 'auto-2',
      result: {
        decision: 'acceptForSession',
      },
    },
  ]);

  now += 61 * 60 * 1000;

  const expired = await service.registerRequest({
    requestId: 'auto-3',
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

test('forcePending keeps a test approval card visible during auto-approval', async () => {
  let now = 1_000_000;
  const responses: Array<{ requestId: string; result: unknown }> = [];
  const service = createApprovalService({
    now: () => now,
  });

  await service.handleCommand({
    sessionId: 'chat-a',
    text: '//approve-auto 30',
  });

  const announcement = await service.registerRequest({
    requestId: 'test-1',
    projectInstanceId: 'project-a',
    sessionId: 'chat-a',
    threadId: 'thr_123',
    turnId: 'turn_1',
    itemId: 'item-1',
    kind: 'commandExecution',
    command: '//approve-test',
    reason: 'manual test card',
    forcePending: true,
    respond: async (requestId, result) => {
      responses.push({ requestId: String(requestId), result });
    },
  });

  assert.notEqual(announcement.card, null);
  assert.ok(announcement.lines.includes('[lark-agent-bridge] Approval required:'));
  assert.equal(responses.length, 0);
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
