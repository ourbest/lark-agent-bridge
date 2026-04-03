# Feishu WebSocket 集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 使用 `@larksuiteoapi/node-sdk` 官方 SDK 的 WebSocket 客户端实现飞书消息收发，替换 openclaw-lite 插件运行时。

**架构：** 在 `src/adapters/lark/feishu-websocket.ts` 中实现 `createFeishuWebSocketTransport` 工厂函数，通过 `LarkTransport` 接口与现有 bridge 集成。接收消息通过 SDK 的 `lark_ws.Client`，发送消息直接调用 `im.v1.MessagesAPI.send_message()`。

**技术栈：** `@larksuiteoapi/node-sdk`，Node.js 24 原生测试（`node:test`），ES modules。

---

## 文件结构

### 新增
```
src/adapters/lark/feishu-websocket.ts       # WebSocket 传输层实现
src/runtime/feishu-config.ts               # 飞书配置解析
tests/adapters/lark/feishu-websocket.test.ts  # 单元测试
tests/runtime/feishu-config.test.ts        # 配置解析测试
```

### 删除
```
src/adapters/lark/openclaw-lark.ts          # @larksuite/openclaw-lark
src/adapters/lark/openclaw-lite-transport.ts # openclaw-lite 传输
src/channel/protocol.ts                     # 进程间 JSON protocol
src/channel/process-manager.ts              # 进程管理
src/channel/openclaw-lite-process.ts        # openclaw-lite 插件进程
src/channel/feishu-plugin-process.ts        # feishu 插件进程
src/runtime/openclaw-lite-config.ts
src/runtime/openclaw-lite-plugin-config.ts
tests/adapters/lark/openclaw-lark.test.ts
tests/adapters/lark/openclaw-lite-transport.test.ts
tests/channel/protocol.test.ts
tests/channel/process-manager.test.ts
tests/channel/feishu-plugin-process.test.ts
tests/runtime/openclaw-lite-config.test.ts
tests/runtime/openclaw-lite-plugin-config.test.ts
```

### 修改
```
src/adapters/lark/index.ts       # 移除 openclaw-lark、openclaw-lite 导出
src/app.ts                       # 移除 openclawConfig/openclawLark 参数
src/main.ts                      # 移除 openclaw-lite transport 创建
src/runtime/bootstrap.ts          # 重构，移除 openclaw-lite 相关
tests/runtime/bootstrap.test.ts   # 移除 openclaw-lite 引用
tests/all.test.ts                # 移除已删除测试文件的引用
package.json                     # 移除 @larksuite/openclaw-lark
CLAUDE.md                        # 更新文档
```

---

## Task 1: 清理旧依赖和文件

**目标：** 移除 `@larksuite/openclaw-lark`、openclaw-lite 相关文件和所有引用。

### 步骤

- [ ] **Step 1: 从 package.json 移除 `@larksuite/openclaw-lark`**
  文件: `package.json`

- [ ] **Step 2: 删除 openclaw-lark.ts 及其测试**
  文件: `src/adapters/lark/openclaw-lark.ts`, `tests/adapters/lark/openclaw-lark.test.ts`

- [ ] **Step 3: 删除 openclaw-lite-transport.ts 及其测试**
  文件: `src/adapters/lark/openclaw-lite-transport.ts`, `tests/adapters/lark/openclaw-lite-transport.test.ts`

- [ ] **Step 4: 删除 channel/ 目录（protocol.ts, process-manager.ts, openclaw-lite-process.ts, feishu-plugin-process.ts）及其测试**
  文件: `src/channel/`, `tests/channel/`

- [ ] **Step 5: 删除 openclaw-lite-config.ts 和 openclaw-lite-plugin-config.ts 及其测试**
  文件: `src/runtime/openclaw-lite-config.ts`, `src/runtime/openclaw-lite-plugin-config.ts`, `tests/runtime/openclaw-lite-config.test.ts`, `tests/runtime/openclaw-lite-plugin-config.test.ts`

- [ ] **Step 6: 清理 src/adapters/lark/index.ts — 移除 openclaw-lark 和 openclaw-lite 导出**
  文件: `src/adapters/lark/index.ts`

- [ ] **Step 7: 清理 src/app.ts — 移除 openclawConfig 和 openclawLark 参数**
  文件: `src/app.ts:25-54`

- [ ] **Step 8: 清理 src/main.ts — 移除 openclaw-lite transport 创建逻辑**
  文件: `src/main.ts:1-200`

- [ ] **Step 9: 清理 tests/runtime/bootstrap.test.ts — 移除 openclaw-lite 相关**
  文件: `tests/runtime/bootstrap.test.ts`

- [ ] **Step 10: 清理 tests/all.test.ts — 移除已删除测试文件的引用**
  文件: `tests/all.test.ts`

- [ ] **Step 11: 运行测试验证破坏最小化**
  Run: `npm test`
  Expected: 大部分测试通过（新增的 feishu-websocket 测试暂不存在会有 import 错误，可暂时跳过）

- [ ] **Step 12: 提交**
  ```bash
  git add -A && git commit -m "refactor: remove openclaw-lite and openclaw-lark in favor of @larksuiteoapi/node-sdk"
  ```

---

## Task 2: 实现飞书配置解析

**Files:**
- Create: `src/runtime/feishu-config.ts`
- Create: `tests/runtime/feishu-config.test.ts`

### 步骤

- [ ] **Step 1: 编写测试**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFeishuRuntimeConfig } from '../../../src/runtime/feishu-config.ts';

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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --experimental-strip-types --test tests/runtime/feishu-config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 编写实现**

```ts
// src/runtime/feishu-config.ts

export interface FeishuRuntimeConfig {
  appId: string;
  appSecret: string;
  wsEnabled: boolean;
}

export interface FeishuRuntimeEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  BRIDGE_FEISHU_WS_ENABLED?: string;
}

export function resolveFeishuRuntimeConfig(env: FeishuRuntimeEnv = process.env): FeishuRuntimeConfig | null {
  const appId = env.FEISHU_APP_ID?.trim() ?? '';
  const appSecret = env.FEISHU_APP_SECRET?.trim() ?? '';

  if (appId === '') {
    return null;
  }

  return {
    appId,
    appSecret,
    wsEnabled: env.BRIDGE_FEISHU_WS_ENABLED === '1',
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node --experimental-strip-types --test tests/runtime/feishu-config.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 提交**

```bash
git add src/runtime/feishu-config.ts tests/runtime/feishu-config.test.ts
git commit -m "feat: add Feishu config resolution"
```

---

## Task 3: 实现 `feishu-websocket.ts` 传输层

**Files:**
- Create: `src/adapters/lark/feishu-websocket.ts`
- Create: `tests/adapters/lark/feishu-websocket.test.ts`

### 步骤

- [ ] **Step 1: 编写测试**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeishuWebSocketTransport } from '../../../src/adapters/lark/feishu-websocket.ts';
import type { LarkEventPayload } from '../../../src/adapters/lark/adapter.ts';

// Mock lark_ws module
const mockClient = {
  start: async () => {},
  stop: async () => {},
  on: function(event: string, handler: (...args: unknown[]) => void) {
    (this as Record<string, unknown>)[`handler_${event}`] = handler;
    return this;
  },
};

let mockSendMessage: (opts: { receiveId: string; msgType: string; content: string }) => Promise<void>;

test('implements LarkTransport interface', () => {
  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    larkClient: mockClient as never,
    sendMessageFn: mockSendMessage as never,
    onStderr: () => {},
  });

  assert.equal(typeof transport.onEvent, 'function');
  assert.equal(typeof transport.sendMessage, 'function');
  assert.equal(typeof transport.start, 'function');
  assert.equal(typeof transport.stop, 'function');
});

test('normalizes P2ImMessageReceiveV1 event to LarkEventPayload', async () => {
  const receivedEvents: LarkEventPayload[] = [];

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    larkClient: mockClient as never,
    sendMessageFn: mockSendMessage as never,
    onStderr: () => {},
  });

  transport.onEvent((event) => {
    receivedEvents.push(event);
  });

  await transport.start();

  // Simulate P2ImMessageReceiveV1 event from SDK
  const content = JSON.stringify({ text: 'hello world' });
  const handler = (mockClient as Record<string, { (): void }>).handler_P2ImMessageReceiveV1;
  handler({
    event: {
      message: {
        message_id: 'msg_123',
        chat_id: 'chat_abc',
        content,
      },
      sender: {
        sender_id: { open_id: 'user_xyz' },
      },
    },
  });

  assert.equal(receivedEvents.length, 1);
  assert.deepEqual(receivedEvents[0], {
    sessionId: 'chat_abc',
    messageId: 'msg_123',
    text: 'hello world',
    senderId: 'user_xyz',
    timestamp: '',
  });
});

test('sends message via sendMessageFn with chat_id as receive_id', async () => {
  let sentTo: string | null = null;
  let sentContent: string | null = null;

  const mockSend = async (opts: {
    receiveId: string;
    msgType: string;
    content: string;
  }) => {
    sentTo = opts.receiveId;
    sentContent = opts.content;
  };

  const transport = createFeishuWebSocketTransport({
    appId: 'cli_test',
    appSecret: 'secret',
    larkClient: mockClient as never,
    sendMessageFn: mockSend as never,
    onStderr: () => {},
  });

  await transport.start();
  await transport.sendMessage({ sessionId: 'chat_abc', text: 'reply text' });

  assert.equal(sentTo, 'chat_abc');
  assert.equal(sentContent, JSON.stringify({ text: 'reply text' }));
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --experimental-strip-types --test tests/adapters/lark/feishu-websocket.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 编写实现**

```ts
// src/adapters/lark/feishu-websocket.ts

import * as lark from '@larksuiteoapi/node-sdk';
import type { LarkEventPayload, LarkTransport } from './adapter.ts';

export interface FeishuWebSocketTransportOptions {
  appId: string;
  appSecret: string;
  larkClient: {
    start(): Promise<void>;
    stop(): Promise<void>;
    on(event: string, handler: (...args: unknown[]) => void): unknown;
  };
  sendMessageFn: (opts: {
    receiveId: string;
    msgType: string;
    content: string;
  }) => Promise<void>;
  onStderr?: (text: string) => void;
}

export interface FeishuWebSocketTransport extends LarkTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
}

export function createFeishuWebSocketTransport(options: FeishuWebSocketTransportOptions): FeishuWebSocketTransport {
  let eventHandler: ((event: LarkEventPayload) => void | Promise<void>) | null = null;
  let started = false;
  let ready = false;

  // Per-chat message queue for serializing messages within each chat
  const chatQueues = new Map<string, { running: boolean; tasks: (() => Promise<void>)[] }>();

  function processQueue(chatId: string) {
    const queue = chatQueues.get(chatId);
    if (!queue || queue.running || queue.tasks.length === 0) {
      return;
    }

    queue.running = true;
    const task = queue.tasks.shift()!;

    task().finally(() => {
      queue.running = false;
      if (queue.tasks.length > 0) {
        processQueue(chatId);
      } else {
        chatQueues.delete(chatId);
      }
    });
  }

  function enqueueMessage(chatId: string, task: () => Promise<void>) {
    let queue = chatQueues.get(chatId);
    if (queue === undefined) {
      queue = { running: false, tasks: [] };
      chatQueues.set(chatId, queue);
    }
    queue.tasks.push(task);
    processQueue(chatId);
  }

  // Register P2ImMessageReceiveV1 handler
  options.larkClient.on('P2ImMessageReceiveV1', (data: {
    event?: {
      message?: {
        message_id?: string;
        chat_id?: string;
        content?: string;
      };
      sender?: {
        sender_id?: { open_id?: string };
      };
    };
  }) => {
    const msg = data?.event?.message;
    if (!msg || !msg.message_id || !msg.chat_id) {
      return;
    }

    let text = '';
    try {
      const parsed = JSON.parse(msg.content);
      text = typeof parsed.text === 'string' ? parsed.text : '';
    } catch {
      text = '';
    }

    const event: LarkEventPayload = {
      sessionId: msg.chat_id,
      messageId: msg.message_id,
      text,
      senderId: data.event?.sender?.sender_id?.open_id ?? '',
      timestamp: '',
    };

    void eventHandler?.(event);
  });

  return {
    onEvent(handler) {
      eventHandler = handler;
    },
    async start() {
      if (started) {
        return;
      }
      started = true;
      await options.larkClient.start();
      ready = true;
    },
    async stop() {
      await options.larkClient.stop();
      started = false;
      ready = false;
    },
    isReady() {
      return ready;
    },
    async sendMessage(message) {
      enqueueMessage(message.sessionId, async () => {
        await options.sendMessageFn({
          receiveId: message.sessionId,
          msgType: 'text',
          content: JSON.stringify({ text: message.text }),
        });
      });
    },
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node --experimental-strip-types --test tests/adapters/lark/feishu-websocket.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 提交**

```bash
git add src/adapters/lark/feishu-websocket.ts tests/adapters/lark/feishu-websocket.test.ts
git commit -m "feat: add Feishu WebSocket transport implementation"
```

---

## Task 4: 集成到 bootstrap

**Files:**
- Modify: `src/runtime/bootstrap.ts`
- Modify: `src/main.ts`

### 步骤

- [ ] **Step 1: 重写 bootstrap.ts — 移除 openclaw-lite，添加飞书 WebSocket**

文件: `src/runtime/bootstrap.ts`

完整重写，保留 `resolveBridgeConfig` 和 `resolveStoragePath`，删除 `LocalDevLarkTransport` 和 openclaw-lite 相关。添加 `createFeishuWebSocketTransport` 的创建逻辑：

```ts
import { resolveFeishuRuntimeConfig, type FeishuRuntimeConfig } from './feishu-config.ts';
import type { LarkEventPayload, LarkTransport } from '../adapters/lark/adapter.ts';
// ... existing imports

// 在 run() 函数中：
const feishuRuntime = resolveFeishuRuntimeConfig();
let transport: LarkTransport;

if (feishuRuntime !== null && feishuRuntime.wsEnabled) {
  const { createFeishuWebSocketTransport } = await import('../adapters/lark/feishu-websocket.ts');
  const { default: lark } = await import('@larksuiteoapi/node-sdk');
  
  const client = new lark.ws.Client({
    appID: feishuRuntime.appId,
    appSecret: feishuRuntime.appSecret,
    loggerLevel: lark.LoggerLevel.warn,
  });

  transport = createFeishuWebSocketTransport({
    appId: feishuRuntime.appId,
    appSecret: feishuRuntime.appSecret,
    larkClient: client,
    sendMessageFn: async ({ receiveId, msgType, content }) => {
      await lark.im.v1.MessagesAPI.send_message(
        new lark.im.v1.SendMessageReq({
          path: { message_id: receiveId },
          data: new lark.im.v1.SendMessageReqData({ msg_type: msgType, content }),
        }),
      );
    },
    onStderr: (text) => process.stderr.write(text),
    onSend: (message) => console.log(`[codex-bridge] outbound -> ${message.sessionId}: ${message.text}`),
  });
} else {
  // 回退到 LocalDevLarkTransport（保留用于本地开发无飞书配置时）
  transport = createLocalDevLarkTransport({
    onSend: (message) => console.log(`[codex-bridge] outbound -> ${message.sessionId}: ${message.text}`),
  });
}
```

- [ ] **Step 2: 简化 main.ts — 移除 openclaw-lite 导入和 resolveOpenClawLiteRuntimeConfig**
  文件: `src/main.ts` — 删除 `createOpenClawLiteTransport` 和 `resolveOpenClawLiteRuntimeConfig` 导入

- [ ] **Step 3: 运行测试验证**

Run: `node --experimental-strip-types --test tests/runtime/bootstrap.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/runtime/bootstrap.ts src/main.ts
git commit -m "feat: wire Feishu WebSocket transport in bootstrap"
```

---

## Task 5: 导出模块

**Files:**
- Modify: `src/adapters/lark/index.ts`

### 步骤

- [ ] **Step 1: 更新导出**

```ts
export { LarkAdapter } from './adapter.ts';
export type { LarkEventPayload, LarkTransport } from './adapter.ts';
export { createFeishuWebSocketTransport } from './feishu-websocket.ts';
export type { FeishuWebSocketTransport, FeishuWebSocketTransportOptions } from './feishu-websocket.ts';
```

- [ ] **Step 2: 提交**

```bash
git add src/adapters/lark/index.ts
git commit -m "feat: export Feishu WebSocket transport"
```

---

## Task 6: 更新 CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

### 步骤

- [ ] **Step 1: 更新文档**

移除 openclaw-lite 相关描述，更新为飞书 WebSocket 传输层说明。

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Feishu WebSocket transport"
```

---

## 自检清单

- [ ] 所有测试通过
- [ ] 所有 task 已勾选完成
- [ ] 没有 placeholder（TODO、TBD）
- [ ] spec 覆盖完整
- [ ] 提交信息规范（feat: / refactor: 前缀）
