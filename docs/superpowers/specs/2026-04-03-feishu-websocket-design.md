# Feishu WebSocket 集成设计

## 概述

使用官方 `lark-oapi` SDK 的 WebSocket 客户端（`lark_ws`）与飞书服务器保持持久连接，避免配置 HTTPS Webhook 的复杂性。

## 环境变量

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |
| `BRIDGE_FEISHU_WS_ENABLED` | 启用飞书 WebSocket 模式（值为 `1`） |

## 新增文件

### `src/adapters/lark/feishu-websocket.ts`

`createFeishuWebSocketTransport(options)` 工厂函数，返回实现 `LarkTransport` 接口的传输层。

**接收消息流程：**

1. SDK 接收 `P2ImMessageReceiveV1` 事件
2. 从事件中提取 `message_id`、`chat_id`、`open_id`、消息内容
3. 解析消息文本（`content` 字段为 JSON 字符串 `{"text": "..."}`）
4. 构造 `LarkEventPayload` 并通过 `onEvent` 回调抛出

**发送消息流程：**

1. 调用方通过 `sendMessage({ sessionId, text })` 发送
2. 直接调用 `lark.im.v1.MessagesAPI.send_message()` 发送至飞书
3. 使用 `chat_id` 作为 `receive_id`

**队列机制：**

- 按 `chat_id` 维护内部队列
- 同一聊天消息串行发送（FIFO）
- 不同聊天并行处理

### `src/config/env.ts`

扩展 `loadConfig`，增加飞书配置结构：

```ts
feishu: {
  appId?: string;
  appSecret?: string;
  wsEnabled?: boolean;
}
```

### `src/runtime/bootstrap.ts`

- 检测 `BRIDGE_FEISHU_WS_ENABLED`
- 若启用，创建 `createFeishuWebSocketTransport`
- 否则回退至现有 `LocalDevLarkTransport`

### `src/app.ts`

无需修改，已通过 `larkTransport` 参数解耦传输层。

## 数据流

```
飞书 → lark_ws.Client (P2ImMessageReceiveV1)
     → normalize → LarkEventPayload
     → LarkAdapter.onMessage()
     → BridgeRouter.routeInboundMessage()
     → BindingService (chat_id → projectInstanceId)
     → Codex 项目处理器
     → FeishuWebSocketTransport.send() [直接调用 SDK]
     → 飞书聊天
```

## 错误处理

- SDK 自动重连（`lark_ws.Client` 内置）
- 未绑定 `chat_id` → 静默丢弃（匹配现有行为）
- SDK 错误通过 `onStderr` 回调输出

## 测试

`tests/adapters/lark/feishu-websocket.test.ts`

- Mock `lark_ws.Client`
- 验证事件标准化
- 验证队列串行化
- 验证未知 chat_id 静默处理
