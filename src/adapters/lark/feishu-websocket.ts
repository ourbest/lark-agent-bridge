import type { LarkEventPayload, LarkTransport } from './adapter.ts';

export interface FeishuWebSocketTransportOptions {
  appId: string;
  appSecret: string;
  wsClient: {
    start(params: { eventDispatcher: { register(handler: Record<string, Function>): { invoke(data: unknown, params?: object): Promise<unknown> } } }): Promise<void>;
    close(): void;
  };
  eventDispatcher: {
    register(handler: Record<string, Function>): { invoke(data: unknown, params?: object): Promise<unknown> };
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
  stop(): void;
  isReady(): boolean;
}

export function createFeishuWebSocketTransport(options: FeishuWebSocketTransportOptions): FeishuWebSocketTransport {
  let eventHandler: ((event: LarkEventPayload) => void | Promise<void>) | null = null;
  let started = false;
  let stopped = false;

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

  async function startWebSocket() {
    if (started || stopped) {
      return;
    }

    options.eventDispatcher.register({
      async 'im.message.receive_v1'(data: {
        sender?: {
          sender_id?: {
            open_id?: string;
            user_id?: string;
            union_id?: string;
          };
          sender_type?: string;
          tenant_key?: string;
        };
        message?: {
          message_id?: string;
          chat_id?: string;
          chat_type?: string;
          content?: string;
          create_time?: string;
        };
      }) {
        const msg = data?.message;
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
          senderId: data.sender?.sender_id?.open_id ?? '',
          timestamp: msg.create_time ?? '',
        };

        void eventHandler?.(event);
      },
    });

    await options.wsClient.start({ eventDispatcher: options.eventDispatcher });
    started = true;
  }

  return {
    onEvent(handler) {
      eventHandler = handler;
    },
    async start() {
      await startWebSocket();
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      options.wsClient.close();
    },
    isReady() {
      return started && !stopped;
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
