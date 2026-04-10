import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { CodexAppServerClient } from '../../../src/adapters/codex/app-server-client.ts';

test('surfaces app-server approval requests and can respond to them', async () => {
  const writes: string[] = [];
  const stdout = new PassThrough();
  const requests: Array<{
    id: number;
    method: string;
    params: Record<string, unknown>;
  }> = [];

  const client = new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.2.0-dev',
    },
    spawnAppServer() {
      return {
        stdin: {
          write(chunk: string) {
            const text = String(chunk);
            writes.push(text);
            const payload = JSON.parse(text);
            if (payload.method === 'initialize') {
              stdout.write(`${JSON.stringify({ id: payload.id, result: {} })}\n`);
            } else if (payload.method === 'thread/start') {
              stdout.write(`${JSON.stringify({ id: payload.id, result: { thread: { id: 'thr_123' } } })}\n`);
            } else if (payload.method === 'turn/start') {
              stdout.write(`${JSON.stringify({ id: payload.id, result: { turn: { id: 'turn_1' } } })}\n`);
              stdout.write(
                `${JSON.stringify({
                  id: 99,
                  method: 'item/commandExecution/requestApproval',
                  params: {
                    threadId: 'thr_123',
                    turnId: 'turn_1',
                    itemId: 'item-1',
                    command: 'rm -rf /tmp/example',
                    reason: 'needs approval',
                  },
                })}\n`,
              );
              stdout.write(
                `${JSON.stringify({
                  method: 'turn/completed',
                  params: { threadId: 'thr_123', turnId: 'turn_1', status: 'completed' },
                })}\n`,
              );
            }

            return true;
          },
        },
        stdout,
        stderr: new PassThrough(),
        kill() {
          return true;
        },
        on() {
          return undefined;
        },
      };
    },
  });

  client.onServerRequest = (request) => {
    requests.push(request);
  };

  const reply = client.generateReply({
    text: 'Summarize this repo.',
  });

  await new Promise((resolve) => setImmediate(resolve));

  await client.respondToServerRequest(99, { decision: 'accept' });

  await assert.doesNotReject(reply);
  assert.equal(await reply, '');
  assert.deepEqual(requests, [
    {
      id: 99,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_123',
        turnId: 'turn_1',
        itemId: 'item-1',
        command: 'rm -rf /tmp/example',
        reason: 'needs approval',
      },
    },
  ]);
  assert.deepEqual(
    writes.map((entry) => JSON.parse(entry)),
    [
      {
        id: 0,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'bridge-test',
            title: 'Bridge Test',
            version: '0.2.0-dev',
          },
          capabilities: {
            experimentalApi: true,
          },
        },
      },
      {
        method: 'initialized',
        params: {},
      },
      {
        id: 1,
        method: 'thread/start',
        params: {
          approvalPolicy: 'on-request',
          model: 'gpt-5.4-mini',
          sandbox: 'workspace-write',
          serviceName: 'lark-agent-bridge',
        },
      },
      {
        id: 2,
        method: 'turn/start',
        params: {
          approvalPolicy: 'on-request',
          input: [{ text: 'Summarize this repo.', type: 'text' }],
          model: 'gpt-5.4-mini',
          sandbox: 'workspace-write',
          threadId: 'thr_123',
        },
      },
      {
        id: 99,
        result: {
          decision: 'accept',
        },
      },
    ],
  );
});
