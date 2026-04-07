import type { LarkEventPayload, LarkTransport } from './adapter.ts';
import { buildFeishuPostMessage, isMarkdown } from './md-to-feishu.ts';
import {
  extractCardActionCommand,
  extractCardActionMessageId,
  extractCardActionSenderId,
  extractCardActionSessionId,
  type FeishuInteractiveCardMessage,
} from './cards.ts';

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
    content: string | object;
  }) => Promise<{ messageId?: string } | void>;
  updateMessageFn?: (opts: {
    sessionId: string;
    messageId: string;
    msgType: string;
    content: string | object;
  }) => Promise<void>;
  sendReactionFn: (opts: {
    messageId: string;
    emojiType: string;
  }) => Promise<void>;
  onStderr?: (text: string) => void;
  onSend?: (message: { sessionId: string; text: string }) => void;
  onSendCard?: (message: { sessionId: string; card: FeishuInteractiveCardMessage; fallbackText?: string }) => void;
  onReact?: (message: { targetMessageId: string; emojiType: string }) => void;
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

  function logTransportError(action: string, sessionId: string, error: unknown): void {
    const reason = error instanceof Error && error.message !== '' ? error.message : String(error ?? 'unknown error');
    console.error(`[feishu] ${action} failed, session=${sessionId}, reason="${reason}"`);
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
      async 'card.action.trigger'(data: unknown) {
        const command = extractCardActionCommand(data);
        const sessionId = extractCardActionSessionId(data);
        const messageId = extractCardActionMessageId(data) ?? 'card-action';
        const senderId = extractCardActionSenderId(data) ?? '';

        if (command === null || sessionId === null) {
          return;
        }

        const event: LarkEventPayload = {
          sessionId,
          messageId,
          text: command,
          senderId,
          timestamp: new Date().toISOString(),
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
      return await new Promise<{ messageId?: string } | void>((resolve) => {
        enqueueMessage(message.sessionId, async () => {
          let payload: { msg_type: string; content: string } = {
            msg_type: 'text',
            content: JSON.stringify({ text: message.text }),
          };
          try {
            options.onSend?.(message);
            payload = isMarkdown(message.text)
              ? buildFeishuPostMessage(message.text)
              : {
                  msg_type: 'text',
                  content: JSON.stringify({ text: message.text }),
                };

            console.log(`[feishu] sending ${payload.msg_type}, session=${message.sessionId}`);
            const result = await options.sendMessageFn({
              receiveId: message.sessionId,
              msgType: payload.msg_type,
              content: payload.content,
            });
            resolve(result);
          } catch (error) {
            logTransportError(`send ${payload.msg_type}`, message.sessionId, error);
            resolve(undefined);
          }
        });
      });
    },
    async sendCard(message) {
      return await new Promise<{ messageId?: string } | void>((resolve) => {
        enqueueMessage(message.sessionId, async () => {
          try {
            options.onSendCard?.(message);
            console.log(`[feishu] sending interactive, session=${message.sessionId}`);
            const result = await options.sendMessageFn({
              receiveId: message.sessionId,
              msgType: 'interactive',
              content: message.card.content,
            });
            resolve(result);
          } catch (error) {
            logTransportError('send interactive', message.sessionId, error);
            resolve(undefined);
          }
        });
      });
    },
    async updateCard(message) {
      if (options.updateMessageFn === undefined) {
        return;
      }

      await new Promise<void>((resolve) => {
        enqueueMessage(message.sessionId, async () => {
          try {
            await options.updateMessageFn({
              sessionId: message.sessionId,
              messageId: message.messageId,
              msgType: 'interactive',
              content: message.card.content,
            });
            resolve();
          } catch (error) {
            logTransportError('update interactive', message.sessionId, error);
            resolve();
          }
        });
      });
    },
    async sendReaction(message) {
      options.onReact?.(message);
      try {
        await options.sendReactionFn({
          messageId: message.targetMessageId,
          emojiType: message.emojiType,
        });
      } catch (error) {
        logTransportError(`react ${message.emojiType}`, message.targetMessageId, error);
      }
    },
  };
}
