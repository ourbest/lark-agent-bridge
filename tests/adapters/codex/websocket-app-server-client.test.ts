import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexAppServerClient } from '../../../src/adapters/codex/app-server-client.ts';

test('uses websocket transport when configured and collects streamed agent text', async () => {
  const sentFrames: string[] = [];
  const openedUrls: string[] = [];
  let spawned = false;

  const fakeSocket = {
    readyState: 1,
    send(frame: string) {
      sentFrames.push(frame);
    },
    close() {
      return undefined;
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };

  const client = new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.2.0-dev',
    },
    transport: 'websocket',
    websocketUrl: 'ws://127.0.0.1:4000',
    connectWebSocket(url) {
      openedUrls.push(url);
      setImmediate(() => {
        fakeSocket.onopen?.(new Event('open'));
      });
      return fakeSocket;
    },
    spawnAppServer() {
      spawned = true;
      throw new Error('spawnAppServer should not be called in websocket mode');
    },
  });

  const replyPromise = client.generateReply({ text: 'Hello over websocket.' });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(openedUrls, ['ws://127.0.0.1:4000']);
  assert.equal(spawned, false);

  const requestId = (method: string): number => {
    const frame = sentFrames.find((entry) => JSON.parse(entry).method === method);
    assert.ok(frame, `missing frame for ${method}`);
    return JSON.parse(frame).id;
  };

  const waitForFrame = async (method: string) => {
    for (let attempts = 0; attempts < 20; attempts++) {
      if (sentFrames.some((entry) => JSON.parse(entry).method === method)) {
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`missing frame for ${method}`);
  };

  await waitForFrame('initialize');
  fakeSocket.onmessage?.({ data: `${JSON.stringify({ id: requestId('initialize'), result: {} })}` });
  await new Promise((resolve) => setImmediate(resolve));
  await waitForFrame('thread/start');
  fakeSocket.onmessage?.({
    data: `${JSON.stringify({ id: requestId('thread/start'), result: { thread: { id: 'thr_123' } } })}`,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await waitForFrame('turn/start');
  fakeSocket.onmessage?.({ data: `${JSON.stringify({ id: requestId('turn/start'), result: { turn: { id: 'turn_1' } } })}` });
  await new Promise((resolve) => setImmediate(resolve));
  fakeSocket.onmessage?.({
    data: `${JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'item-1', text: 'hello ' } })}`,
  });
  fakeSocket.onmessage?.({
    data: `${JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'item-1', text: 'websocket' } })}`,
  });
  await new Promise((resolve) => setImmediate(resolve));
  fakeSocket.onmessage?.({
    data: `${JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } })}`,
  });

  await assert.doesNotReject(replyPromise);
  assert.equal(await replyPromise, 'hello websocket');
});

test('rejects an in-flight reply when the websocket connection closes', async () => {
  const sentFrames: string[] = [];
  const openedUrls: string[] = [];

  const fakeSocket = {
    readyState: 1,
    send(frame: string) {
      sentFrames.push(frame);
    },
    close() {
      return undefined;
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };

  const client = new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.2.0-dev',
    },
    transport: 'websocket',
    websocketUrl: 'ws://127.0.0.1:4000',
    connectWebSocket(url) {
      openedUrls.push(url);
      setImmediate(() => {
        fakeSocket.onopen?.(new Event('open'));
      });
      return fakeSocket;
    },
  });

  const replyPromise = client.generateReply({ text: 'Hello over websocket.' });

  await new Promise((resolve) => setImmediate(resolve));

  const requestId = (method: string): number => {
    const frame = sentFrames.find((entry) => JSON.parse(entry).method === method);
    assert.ok(frame, `missing frame for ${method}`);
    return JSON.parse(frame).id;
  };

  const waitForFrame = async (method: string) => {
    for (let attempts = 0; attempts < 20; attempts++) {
      if (sentFrames.some((entry) => JSON.parse(entry).method === method)) {
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`missing frame for ${method}`);
  };

  await waitForFrame('initialize');
  fakeSocket.onmessage?.({ data: `${JSON.stringify({ id: requestId('initialize'), result: {} })}` });
  await new Promise((resolve) => setImmediate(resolve));
  await waitForFrame('thread/start');
  fakeSocket.onmessage?.({
    data: `${JSON.stringify({ id: requestId('thread/start'), result: { thread: { id: 'thr_123' } } })}`,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await waitForFrame('turn/start');
  fakeSocket.onmessage?.({ data: `${JSON.stringify({ id: requestId('turn/start'), result: { turn: { id: 'turn_1' } } })}` });
  await new Promise((resolve) => setImmediate(resolve));

  fakeSocket.onclose?.(new Event('close'));

  await assert.rejects(replyPromise, /Codex websocket connection closed/);
  assert.deepEqual(openedUrls, ['ws://127.0.0.1:4000']);
});

test('reconnects before sending when the existing websocket is no longer open', async () => {
  const sentFrames: string[] = [];
  const openedUrls: string[] = [];
  const sockets: Array<{
    readyState: number;
    send(data: string): void;
    close(): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onclose: ((event: unknown) => void) | null;
  }> = [];

  const client = new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: {
      name: 'bridge-test',
      title: 'Bridge Test',
      version: '0.0.0',
    },
    transport: 'websocket',
    websocketUrl: 'ws://127.0.0.1:4000',
    connectWebSocket(url) {
      openedUrls.push(url);
      const socket = {
        readyState: 1,
        send(frame: string) {
          if (socket.readyState !== 1) {
            throw new Error('socket is not open');
          }
          sentFrames.push(frame);
        },
        close() {
          socket.readyState = 3;
        },
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      sockets.push(socket);
      setImmediate(() => {
        socket.onopen?.(new Event('open'));
      });
      return socket;
    },
  });

  const waitForFrame = async (method: string, count = 1) => {
    for (let attempts = 0; attempts < 20; attempts++) {
      const matches = sentFrames.filter((entry) => JSON.parse(entry).method === method);
      if (matches.length >= count) {
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`missing frame for ${method}`);
  };

  const requestIds = (method: string): number[] =>
    sentFrames
      .filter((entry) => JSON.parse(entry).method === method)
      .map((entry) => JSON.parse(entry).id as number);

  const firstReplyPromise = client.generateReply({ text: 'first request' });
  await waitForFrame('initialize');
  sockets[0].onmessage?.({ data: JSON.stringify({ id: requestIds('initialize')[0], result: {} }) });
  await new Promise((resolve) => setImmediate(resolve));
  await waitForFrame('thread/start');
  sockets[0].onmessage?.({ data: JSON.stringify({ id: requestIds('thread/start')[0], result: { thread: { id: 'thr_1' } } }) });
  await new Promise((resolve) => setImmediate(resolve));
  await waitForFrame('turn/start');
  sockets[0].onmessage?.({ data: JSON.stringify({ id: requestIds('turn/start')[0], result: { turn: { id: 'turn_1' } } }) });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0].onmessage?.({ data: JSON.stringify({ method: 'item/agentMessage/delta', params: { text: 'first reply' } }) });
  sockets[0].onmessage?.({ data: JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }) });
  assert.equal(await firstReplyPromise, 'first reply');

  sockets[0].readyState = 3;

  const secondReplyPromise = client.generateReply({ text: 'second request' });
  await new Promise((resolve) => setImmediate(resolve));
  await waitForFrame('initialize', 2);
  sockets[1].onmessage?.({ data: JSON.stringify({ id: requestIds('initialize')[1], result: {} }) });
  await new Promise((resolve) => setImmediate(resolve));
  await waitForFrame('thread/start', 2);
  sockets[1].onmessage?.({ data: JSON.stringify({ id: requestIds('thread/start')[1], result: { thread: { id: 'thr_2' } } }) });
  await new Promise((resolve) => setImmediate(resolve));
  await waitForFrame('turn/start', 2);
  sockets[1].onmessage?.({ data: JSON.stringify({ id: requestIds('turn/start')[1], result: { turn: { id: 'turn_2' } } }) });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1].onmessage?.({ data: JSON.stringify({ method: 'item/agentMessage/delta', params: { text: 'second reply' } }) });
  sockets[1].onmessage?.({ data: JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }) });

  assert.equal(await secondReplyPromise, 'second reply');
  assert.deepEqual(openedUrls, ['ws://127.0.0.1:4000', 'ws://127.0.0.1:4000']);
});
