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
    '[codex-bridge] Approval required:',
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
    body?: { elements?: Array<{ tag?: string }> };
  };
  assert.equal(card.header?.title?.content, 'Approval required');
  assert.ok(card.body?.elements?.some((element) => element.tag === 'action'));

  const lines = await service.handleCommand({
    sessionId: 'chat-a',
    text: '//approve-all 99',
  });

  assert.deepEqual(lines, ['[codex-bridge] approved request 99 for the session']);
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
    '[codex-bridge] Approval required:',
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

  const lines = await service.handleCommand({
    sessionId: 'chat-a',
    text: '//deny perm-1',
  });

  assert.deepEqual(lines, ['[codex-bridge] denied permissions request perm-1 by withholding additional permissions']);
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
