import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { CodexAppServerClient } from '../../../src/adapters/codex/app-server-client.ts';

test('initializes codex app-server, starts a thread, and collects streamed agent text', async () => {
  const writes: string[] = [];
  const stdout = new PassThrough();

  const client = new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.1.0',
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
                `${JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'item-1', text: 'hello' } })}\n`,
              );
              stdout.write(
                `${JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'item-1', text: ' world' } })}\n`,
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

  const reply = await client.generateReply({
    text: 'Summarize this repo.',
  });

  assert.equal(reply, 'hello world');
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
            version: '0.1.0',
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
          approvalPolicy: 'never',
          model: 'gpt-5.4',
          sandbox: 'workspace-write',
          serviceName: 'codex-bridge',
        },
      },
      {
        id: 2,
        method: 'turn/start',
        params: {
          approvalPolicy: 'never',
          input: [{ text: 'Summarize this repo.', type: 'text' }],
          model: 'gpt-5.4',
          sandbox: 'workspace-write',
          threadId: 'thr_123',
        },
      },
    ],
  );
});

test('resolves codex replies from completed agent items when no delta stream arrives', async () => {
  const stdout = new PassThrough();

  const client = new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.1.0',
    },
    spawnAppServer() {
      return {
        stdin: {
          write(chunk: string) {
            const payload = JSON.parse(String(chunk));
            if (payload.method === 'initialize') {
              stdout.write(`${JSON.stringify({ id: payload.id, result: {} })}\n`);
            } else if (payload.method === 'thread/start') {
              stdout.write(`${JSON.stringify({ id: payload.id, result: { thread: { id: 'thr_123' } } })}\n`);
            } else if (payload.method === 'turn/start') {
              stdout.write(`${JSON.stringify({ id: payload.id, result: { turn: { id: 'turn_1' } } })}\n`);
              stdout.write(
                `${JSON.stringify({
                  method: 'item/completed',
                  params: {
                    item: {
                      id: 'item-1',
                      type: 'agentMessage',
                      text: 'final answer',
                    },
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

  const reply = await client.generateReply({
    text: 'Summarize this repo.',
  });

  assert.equal(reply, 'final answer');
});

test('executes a structured codex command without starting a turn', async () => {
  const writes: string[] = [];
  const stdout = new PassThrough();

  const client = new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.1.0',
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
            } else if (payload.method === 'session/list') {
              stdout.write(`${JSON.stringify({ id: payload.id, result: { sessions: [] } })}\n`);
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

  const result = await client.executeCommand({
    method: 'session/list',
    params: {},
  });

  assert.deepEqual(result, { sessions: [] });
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
            version: '0.1.0',
          },
        },
      },
      {
        method: 'initialized',
        params: {},
      },
      {
        id: 1,
        method: 'session/list',
        params: {},
      },
    ],
  );
});

test('resumes an existing thread before generating the next reply', async () => {
  const writes: string[] = [];
  const stdout = new PassThrough();

  const client = new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.1.0',
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
            } else if (payload.method === 'thread/resume') {
              stdout.write(`${JSON.stringify({ id: payload.id, result: { thread: { id: 'thr_123' } } })}\n`);
            } else if (payload.method === 'turn/start') {
              stdout.write(`${JSON.stringify({ id: payload.id, result: { turn: { id: 'turn_2' } } })}\n`);
              stdout.write(
                `${JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'item-2', text: 'resumed' } })}\n`,
              );
              stdout.write(
                `${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr_123', turnId: 'turn_2', status: 'completed' } })}\n`,
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

  await client.resumeThread({
    threadId: 'thr_123',
  });

  const reply = await client.generateReply({
    text: 'Continue from the saved thread.',
  });

  assert.equal(reply, 'resumed');
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
            version: '0.1.0',
          },
        },
      },
      {
        method: 'initialized',
        params: {},
      },
      {
        id: 1,
        method: 'thread/resume',
        params: {
          persistExtendedHistory: true,
          threadId: 'thr_123',
        },
      },
      {
        id: 2,
        method: 'turn/start',
        params: {
          approvalPolicy: 'never',
          input: [{ text: 'Continue from the saved thread.', type: 'text' }],
          model: 'gpt-5.4',
          sandbox: 'workspace-write',
          threadId: 'thr_123',
        },
      },
    ],
  );
});

test('rejects when the app-server process fails to spawn', async () => {
  const stdout = new PassThrough();
  const errorListeners: Array<(error: Error) => void> = [];

  const client = new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.1.0',
    },
    spawnAppServer() {
      queueMicrotask(() => {
        for (const listener of errorListeners) {
          listener(new Error('spawn codex ENOENT'));
        }
      });

      return {
        stdin: {
          write() {
            return true;
          },
        },
        stdout,
        stderr: new PassThrough(),
        kill() {
          return true;
        },
        on(event: 'error' | 'exit', listener: (error: Error) => void) {
          if (event === 'error') {
            errorListeners.push(listener);
          }
        },
      };
    },
  });

  await assert.rejects(
    client.generateReply({
      text: 'Summarize this repo.',
    }),
    /spawn codex ENOENT/,
  );
});
