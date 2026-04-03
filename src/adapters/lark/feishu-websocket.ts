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
  onSend?: (message: { sessionId: string; text: string }) => void;
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
        options.onSend?.(message);
        await options.sendMessageFn({
          receiveId: message.sessionId,
          msgType: 'text',
          content: JSON.stringify({ text: message.text }),
        });
      });
    },
  };
}
