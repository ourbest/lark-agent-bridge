import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createSshStdioCodexClient } from '../../../src/adapters/codex/ssh-stdio-client.ts';

test('spawns ssh with host, port, identity, user, and remote command', async () => {
  const writes: string[] = [];
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const stdout = new PassThrough();

  const client = createSshStdioCodexClient({
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.2.0-dev',
    },
    sshHost: 'cc-west.example.com',
    sshPort: 2222,
    sshUser: 'agent',
    sshIdentityFile: '/home/me/.ssh/id_ed25519',
    sshCommand: 'cc-server --stdio',
    spawnAppServer(command, args) {
      spawnCalls.push({ command, args });
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

  const threadId = await client.startThread({});

  assert.equal(threadId, 'thr_123');
  assert.deepEqual(spawnCalls, [
    {
      command: 'ssh',
      args: [
        '-p',
        '2222',
        '-i',
        '/home/me/.ssh/id_ed25519',
        'agent@cc-west.example.com',
        'cc-server --stdio',
      ],
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
          personality: 'friendly',
          model: 'gpt-5.4-mini',
          sandbox: 'workspace-write',
          serviceName: 'lark-agent-bridge',
        },
      },
    ],
  );
});

test('stops the ssh-backed client by killing the spawned process', async () => {
  let killCount = 0;
  const stdout = new PassThrough();

  const client = createSshStdioCodexClient({
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.2.0-dev',
    },
    sshHost: 'cc-west.example.com',
    sshCommand: 'cc-server --stdio',
    spawnAppServer() {
      return {
        stdin: {
          write(chunk: string) {
            const payload = JSON.parse(String(chunk));
            if (payload.method === 'initialize') {
              stdout.write(`${JSON.stringify({ id: payload.id, result: {} })}\n`);
            } else if (payload.method === 'thread/start') {
              stdout.write(`${JSON.stringify({ id: payload.id, result: { thread: { id: 'thr_123' } } })}\n`);
            }
            return true;
          },
        },
        stdout,
        stderr: new PassThrough(),
        kill() {
          killCount += 1;
          return true;
        },
        on() {
          return undefined;
        },
      };
    },
  });

  await client.startThread({});
  await client.stop();

  assert.equal(killCount, 1);
});
