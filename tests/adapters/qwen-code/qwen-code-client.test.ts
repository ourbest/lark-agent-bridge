import assert from 'node:assert/strict';
import test from 'node:test';

import { QwenCodeClient } from '../../../src/adapters/qwen-code/qwen-code-client.ts';

function createAsyncQueue<T>() {
  let closed = false;
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];

  return {
    push(value: T): void {
      if (closed) {
        return;
      }

      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter({ value, done: false });
        return;
      }

      values.push(value);
    },
    close(): void {
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined as T, done: true });
      }
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
      while (true) {
        if (values.length > 0) {
          yield values.shift() as T;
          continue;
        }

        if (closed) {
          return;
        }

        const next = await new Promise<IteratorResult<T>>((resolve) => {
          waiters.push(resolve);
        });

        if (next.done) {
          return;
        }

        yield next.value;
      }
    },
  };
}

test('routes qwen approval requests through the bridge and remembers approve-all', async () => {
  const requests: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];

  const fakeSdk = {
    query(config: {
      prompt: AsyncIterable<{ type: 'user'; session_id: string; message: { role: string; content: string }; parent_tool_use_id: null }>;
      options?: Record<string, unknown>;
    }) {
      const output = createAsyncQueue<unknown>();

      void (async () => {
        for await (const prompt of config.prompt) {
          const text = String(prompt.message.content);
          const canUseTool = config.options?.canUseTool as
            | ((toolName: string, input: unknown, context: { signal?: AbortSignal }) => Promise<{ behavior: string; updatedInput?: unknown }>)
            | undefined;

          if (text.includes('git add app/pom.xml')) {
            const response = await canUseTool?.('Bash', { command: 'git add app/pom.xml' }, {});
            output.push({
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: `approved:${response?.behavior ?? 'missing'}` }],
              },
            });
          } else {
            output.push({
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: `reply:${text}` }],
              },
            });
          }

          output.push({ type: 'result', result: `done:${text}` });
        }
      })().catch((error: Error) => {
        output.close();
        console.error(error);
      });

      return {
        getSessionId() {
          return 'qwen-session-1';
        },
        isClosed() {
          return false;
        },
        close() {
          output.close();
        },
        async *[Symbol.asyncIterator]() {
          yield* output;
        },
      };
    },
  };

  const client = new QwenCodeClient({
    cwd: '/repo/project-a',
    model: 'qwen-max',
    pathToQwenExecutable: '/usr/local/bin/qwen',
    loadSdk: async () => fakeSdk,
  });

  client.onServerRequest = async (request) => {
    requests.push({
      id: String(request.id),
      method: request.method,
      params: request.params,
    });
    await client.respondToServerRequest(request.id, { decision: 'acceptForSession' });
  };

  const firstReply = await client.generateReply({
    text: 'please git add app/pom.xml',
  });

  const secondReply = await client.generateReply({
    text: 'please git add app/pom.xml',
  });

  assert.equal(firstReply, 'approved:allow');
  assert.equal(secondReply, 'approved:allow');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    id: 'qwen-1',
    method: 'item/commandExecution/requestApproval',
    params: {
      tool_name: 'Bash',
      input: {
        command: 'git add app/pom.xml',
      },
      command: 'git add app/pom.xml',
      threadId: requests[0].params.threadId,
      turnId: 'turn_1',
      itemId: 'qwen-1',
    },
  });
  assert.equal(typeof requests[0].params.threadId, 'string');
  assert.match(String(requests[0].params.threadId), /^qwen-/);

  await client.stop();
});
