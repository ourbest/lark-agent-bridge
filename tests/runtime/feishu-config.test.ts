import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFeishuRuntimeConfig } from '../../src/runtime/feishu-config.ts';

test('returns null when FEISHU_APP_ID is not set', () => {
  assert.equal(resolveFeishuRuntimeConfig({}), null);
});

test('returns null when FEISHU_APP_ID is empty string', () => {
  assert.equal(resolveFeishuRuntimeConfig({ FEISHU_APP_ID: '' }), null);
});

test('resolves feishu config when app id and secret are provided', () => {
  const config = resolveFeishuRuntimeConfig({
    FEISHU_APP_ID: 'cli_abc123',
    FEISHU_APP_SECRET: 'secret_xyz',
  });
  assert.deepEqual(config, {
    appId: 'cli_abc123',
    appSecret: 'secret_xyz',
    wsEnabled: false,
  });
});

test('resolves feishu config with ws enabled flag', () => {
  const config = resolveFeishuRuntimeConfig({
    FEISHU_APP_ID: 'cli_abc123',
    FEISHU_APP_SECRET: 'secret_xyz',
    BRIDGE_FEISHU_WS_ENABLED: '1',
  });
  assert.deepEqual(config, {
    appId: 'cli_abc123',
    appSecret: 'secret_xyz',
    wsEnabled: true,
  });
});
