import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeCodeClient } from '../../../src/adapters/claude-code/claude-code-client.ts';

test('keeps respondToServerRequest callable on ClaudeCodeClient instances', () => {
  const client = new ClaudeCodeClient({
    command: 'claude',
  });

  assert.equal(typeof client.respondToServerRequest, 'function');
});

test('reuses session approvals for repeated Claude Code tool requests', async () => {
  const writes: string[] = [];
  const requests: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  const client = new ClaudeCodeClient({
    command: 'claude',
  });

  (client as unknown as {
    proc: { stdin: { write(chunk: string): boolean }; kill(): boolean };
    stdinReady: boolean;
    initialized: boolean;
  }).proc = {
    stdin: {
      write(chunk: string) {
        writes.push(String(chunk));
        return true;
      },
    },
    kill() {
      return true;
    },
  };
  (client as unknown as { stdinReady: boolean }).stdinReady = true;
  (client as unknown as { initialized: boolean }).initialized = true;

  client.onServerRequest = async (request) => {
    requests.push({
      id: String(request.id),
      method: request.method,
      params: request.params,
    });
    await client.respondToServerRequest(request.id, { decision: 'acceptForSession' });
  };

  const firstRequest = JSON.stringify({
    type: 'control_request',
    request_id: 'req-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: {
        command: 'git add app/pom.xml',
      },
      tool_use_id: 'tool-1',
    },
  });

  const secondRequest = JSON.stringify({
    type: 'control_request',
    request_id: 'req-2',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: {
        command: 'git add app/pom.xml',
      },
      tool_use_id: 'tool-2',
    },
  });

  await (client as unknown as { handleMessage(line: string): Promise<void> }).handleMessage(firstRequest);
  await new Promise((resolve) => setImmediate(resolve));
  await (client as unknown as { handleMessage(line: string): Promise<void> }).handleMessage(secondRequest);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requests.map((request) => request.id), ['req-1']);
  assert.equal(writes.length, 2);

  const firstResponse = JSON.parse(writes[0]) as {
    response?: { response?: { behavior?: string; updatedInput?: Record<string, unknown> } };
  };
  const secondResponse = JSON.parse(writes[1]) as {
    response?: { response?: { behavior?: string; updatedInput?: Record<string, unknown> } };
  };

  assert.equal(firstResponse.response?.response?.behavior, 'allow');
  assert.deepEqual(firstResponse.response?.response?.updatedInput, {
    command: 'git add app/pom.xml',
  });
  assert.equal(secondResponse.response?.response?.behavior, 'allow');
  assert.deepEqual(secondResponse.response?.response?.updatedInput, {
    command: 'git add app/pom.xml',
  });
});
