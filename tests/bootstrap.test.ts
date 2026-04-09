import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config/env.ts';
import { createApp } from '../src/index.ts';

test('loads the default bridge config', () => {
  const config = loadConfig({});

  assert.equal(config.server.port, 3000);
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.storage.path, './data/bridge.json');
});

test('creates the bridge app shell', () => {
  const app = createApp({
    config: loadConfig({}),
  });

  assert.equal(app.ready, false);
  assert.equal(app.name, 'lark-agent-bridge');
});
