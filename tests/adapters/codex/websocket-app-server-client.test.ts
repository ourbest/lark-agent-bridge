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
      version: '0.1.0',
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
      version: '0.1.0',
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
