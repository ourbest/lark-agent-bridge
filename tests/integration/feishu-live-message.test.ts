import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import 'dotenv/config';
import { Client, LoggerLevel, defaultHttpInstance } from '@larksuiteoapi/node-sdk';

import { markdownToFeishuPost } from '../../src/adapters/lark/md-to-feishu.ts';

function resolveLiveConfig() {
  const appId = process.env.FEISHU_APP_ID?.trim() ?? '';
  const appSecret = process.env.FEISHU_APP_SECRET?.trim() ?? '';
  const openId = process.env.BRIDGE_STARTUP_NOTIFY_OPENID?.trim() ?? '';

  if (appId === '' || appSecret === '' || openId === '') {
    return null;
  }

  return { appId, appSecret, openId };
}

function extractLatestMarkdownFromLog(logPath: string): string {
  const log = readFileSync(logPath, 'utf8');
  const matches = [...log.matchAll(/\[lark-agent-bridge\] outbound -> .*?: ([\s\S]*?)\n\[feishu\] sending post, session=/g)];

  if (matches.length === 0) {
    throw new Error(`could not find an outbound markdown message in ${logPath}`);
  }

  return matches[matches.length - 1][1];
}

const liveConfig = resolveLiveConfig();
const liveFeishuTest = liveConfig === null ? test.skip : test;

liveFeishuTest('sends the logged markdown message to Feishu open_id successfully', async () => {
  const markdown = extractLatestMarkdownFromLog('/tmp/bridge.log');
  const post = markdownToFeishuPost(markdown);

  defaultHttpInstance.defaults.proxy = false;
  const client = new Client({
    appId: liveConfig!.appId,
    appSecret: liveConfig!.appSecret,
    loggerLevel: LoggerLevel.warn,
    httpInstance: defaultHttpInstance,
  });

  const response = await client.im.v1.message.create({
    data: {
      receive_id: liveConfig!.openId,
      msg_type: 'post',
      content: JSON.stringify({ zh_cn: post.post.zh_cn }),
    },
    params: {
      receive_id_type: 'open_id',
    },
  });

  assert.equal(response.code ?? 0, 0);
  assert.ok(response.data?.message_id);
});
