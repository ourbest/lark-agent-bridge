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
    ],
  );
});

test('logs empty reply diagnostics when a turn completes without text', async () => {
  const writes: string[] = [];
  const warnings: string[] = [];
  const originalConsoleWarn = console.warn;
  const stdout = new PassThrough();

  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
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

    assert.equal(reply, '');
    assert.ok(warnings.some((line) =>
      line.includes('[codex-app-server-client] empty reply:')
      && line.includes('thread=thr_123')
      && line.includes('turn=turn_1')
      && line.includes('status=completed')
      && line.includes('deltas=0')
      && line.includes('completedItems=0'),
    ));
  } finally {
    console.warn = originalConsoleWarn;
  }
});

test('reads the current model from a dynamic getter for each turn', async () => {
  const writes: string[] = [];
  const stdout = new PassThrough();
  let currentModel = 'gpt-5.4';

  const client = new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.2.0-dev',
    },
    getModel: () => currentModel,
    spawnAppServer() {
      let turnCount = 0;
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
              turnCount += 1;
              stdout.write(`${JSON.stringify({ id: payload.id, result: { turn: { id: `turn_${turnCount}` } } })}\n`);
              stdout.write(
                `${JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: `item-${turnCount}`, text: `reply-${turnCount}` } })}\n`,
              );
              stdout.write(
                `${JSON.stringify({
                  method: 'turn/completed',
                  params: { threadId: 'thr_123', turnId: `turn_${turnCount}`, status: 'completed' },
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

  const firstReply = await client.generateReply({
    text: 'first prompt',
  });
  currentModel = 'gpt-5.4-mini';
  const secondReply = await client.generateReply({
    text: 'second prompt',
  });

  assert.equal(firstReply, 'reply-1');
  assert.equal(secondReply, 'reply-2');
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
          input: [{ text: 'first prompt', type: 'text' }],
          model: 'gpt-5.4',
          sandbox: 'workspace-write',
          threadId: 'thr_123',
        },
      },
      {
        id: 3,
        method: 'turn/start',
        params: {
          approvalPolicy: 'on-request',
          input: [{ text: 'second prompt', type: 'text' }],
          model: 'gpt-5.4-mini',
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
      version: '0.2.0-dev',
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

test('resolves codex replies from nested completed agent item content', async () => {
  const stdout = new PassThrough();

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
                      content: [[{ text: 'final answer' }]],
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
        method: 'session/list',
        params: {},
      },
    ],
  );
});

test('starts a fresh thread with binding-friendly defaults', async () => {
  const writes: string[] = [];
  const stdout = new PassThrough();

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
              stdout.write(`${JSON.stringify({ id: payload.id, result: { thread: { id: 'thr_bind_1' } } })}\n`);
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

  const threadId = await client.startThread({
    cwd: '/Users/yonghui/git/lark-agent-bridge',
  });

  assert.equal(threadId, 'thr_bind_1');
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
          cwd: '/Users/yonghui/git/lark-agent-bridge',
          model: 'gpt-5.4-mini',
          sandbox: 'workspace-write',
          personality: 'friendly',
          serviceName: 'lark-agent-bridge',
        },
      },
    ],
  );
});

test('starts a fresh thread when forced even if one already exists', async () => {
  const writes: string[] = [];
  const stdout = new PassThrough();
  let threadStartCount = 0;

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
              threadStartCount += 1;
              stdout.write(`${JSON.stringify({ id: payload.id, result: { thread: { id: threadStartCount === 1 ? 'thr_123' : 'thr_456' } } })}\n`);
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

  const firstThreadId = await client.startThread({
    cwd: '/Users/yonghui/git/lark-agent-bridge',
  });
  const secondThreadId = await client.startThread({
    cwd: '/Users/yonghui/git/lark-agent-bridge',
    force: true,
  });

  assert.equal(firstThreadId, 'thr_123');
  assert.equal(secondThreadId, 'thr_456');
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
          cwd: '/Users/yonghui/git/lark-agent-bridge',
          model: 'gpt-5.4-mini',
          sandbox: 'workspace-write',
          personality: 'friendly',
          serviceName: 'lark-agent-bridge',
        },
      },
      {
        id: 2,
        method: 'thread/start',
        params: {
          approvalPolicy: 'on-request',
          cwd: '/Users/yonghui/git/lark-agent-bridge',
          model: 'gpt-5.4-mini',
          sandbox: 'workspace-write',
          personality: 'friendly',
          serviceName: 'lark-agent-bridge',
        },
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
          approvalPolicy: 'on-request',
          input: [{ text: 'Continue from the saved thread.', type: 'text' }],
          model: 'gpt-5.4-mini',
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
      version: '0.2.0-dev',
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

test('inherits the current environment when spawning codex app-server', async () => {
  const stdout = new PassThrough();
  const receivedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];

  const client = new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.1.0',
    },
    env: {
      BRIDGE_TEST_ONLY: 'yes',
    },
    spawnAppServer(command, args, options) {
      receivedEnvs.push(options.env);
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
        on() {
          return undefined;
        },
      };
    },
  });

  void client.generateReply({ text: 'hello' }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(receivedEnvs.length, 1);
  assert.equal(receivedEnvs[0]?.BRIDGE_TEST_ONLY, 'yes');
  assert.equal(receivedEnvs[0]?.PATH, process.env.PATH);
});
