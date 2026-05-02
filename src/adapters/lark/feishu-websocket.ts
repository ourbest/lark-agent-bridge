import type { LarkEventPayload, LarkTransport } from './adapter.ts';
import type { InboundAttachment } from '../../core/events/message.ts';
import { buildFeishuPostMessage, isMarkdown } from './md-to-feishu.ts';
import {
  extractCardActionDetails,
  extractCardActionCommand,
  extractCardActionMessageId,
  extractCardActionSenderId,
  extractCardActionSessionId,
  type FeishuInteractiveCardMessage,
} from './cards.ts';

export interface FeishuWebSocketTransportOptions {
  appId: string;
  appSecret: string;
  botOpenId?: string;
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
  sendFileFn?: (opts: {
    receiveId: string;
    filePath: string;
    fileName: string;
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
  onSend?: (message: { sessionId: string; text: string; format?: 'auto' | 'text' }) => void;
  onSendFile?: (message: { sessionId: string; filePath: string; fileName: string; fallbackText?: string }) => void;
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
          message_type?: string;
        };
      }) {
        const msg = data?.message;
        if (!msg || !msg.message_id || !msg.chat_id) {
          return;
        }

        let text = '';
        let attachments: InboundAttachment[] | undefined;
        let mentioned = false;
        const msgType = msg.message_type ?? '';

        console.log(`[feishu] message received: msgType=${msgType}, chatId=${msg.chat_id}, messageId=${msg.message_id}, contentLength=${msg.content?.length ?? 0}`);

        try {
          const parsed = JSON.parse(msg.content);
          console.log(`[feishu] parsed content: ${JSON.stringify(parsed)}`);

          if (msgType === 'file') {
            // 文件消息
            const fileKey = parsed.file_key;
            const fileName = parsed.file_name ?? 'unknown';
            if (fileKey) {
              attachments = [{
                fileKey,
                fileName,
                mimeType: '', // 将在下载时获取
                fileSize: parsed.file_size ?? 0,
                attachmentType: 'file',
              }];
              console.log(`[feishu] file message: fileKey=${fileKey}, fileName=${fileName}`);
            } else {
              console.warn(`[feishu] file message missing file_key: ${JSON.stringify(parsed)}`);
            }
          } else if (msgType === 'audio') {
            // 语音消息
            const fileKey = parsed.file_key;
            const fileName = parsed.file_name ?? 'voice.opus';
            if (fileKey) {
              attachments = [{
                fileKey,
                fileName,
                mimeType: parsed.mime_type ?? 'audio/opus',
                fileSize: parsed.file_size ?? 0,
                attachmentType: 'audio',
              }];
              console.log(`[feishu] audio message: fileKey=${fileKey}, fileName=${fileName}`);
            } else {
              console.warn(`[feishu] audio message missing file_key: ${JSON.stringify(parsed)}`);
            }
          } else if (msgType === 'image') {
            // 图片消息
            const imageKey = parsed.image_key;
            console.log(`[feishu] image message: imageKey=${imageKey ?? 'MISSING'}, parsed=${JSON.stringify(parsed)}`);
            if (imageKey) {
              attachments = [{
                fileKey: imageKey,
                fileName: 'image.png', // 默认名称，将在下载时获取
                mimeType: 'image/png',
                fileSize: 0,
                attachmentType: 'image',
              }];
              console.log(`[feishu] image attachment prepared: key=${imageKey}`);
            } else {
              console.warn(`[feishu] image message missing image_key: ${JSON.stringify(parsed)}`);
            }
          } else if (msgType === 'text') {
            // 普通文本消息
            text = parsed.text ?? '';
            console.log(`[feishu] text message: "${text}"`);
          } else if (msgType === 'post') {
            // 富文本消息：解析 content 数组中的文本和图片
            const parts: string[] = [];
            const imgs: InboundAttachment[] = [];
            const content = parsed.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (Array.isArray(block)) {
                  for (const item of block) {
                    if (item.tag === 'text' && typeof item.text === 'string') {
                      parts.push(item.text);
                    } else if (item.tag === 'at' && item.user_id) {
                      // Only mark as mentioned if it's the bot being @mentioned
                      if (options.botOpenId && item.user_id === options.botOpenId) {
                        mentioned = true;
                      }
                    } else if (item.tag === 'img' && item.image_key) {
                      imgs.push({
                        fileKey: item.image_key,
                        fileName: 'image.png',
                        mimeType: 'image/png',
                        fileSize: 0,
                        attachmentType: 'image',
                      });
                    }
                  }
                }
              }
            }
            text = parts.join('');
            if (imgs.length > 0) {
              attachments = imgs;
            }
            console.log(`[feishu] post message: textLength=${text.length}, imageCount=${imgs.length}`);
          } else {
            // 文本消息
            text = typeof parsed.text === 'string' ? parsed.text : '';
            console.log(`[feishu] text message: textLength=${text.length}`);
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[feishu] failed to parse message content: ${errMsg}, content="${msg.content}"`);
          text = '';
        }

        // 检查消息是否为空
        if (text === '' && attachments === undefined) {
          console.warn(`[feishu] empty message: msgType=${msgType}, chatId=${msg.chat_id}, messageId=${msg.message_id}`);
        } else if (attachments !== undefined) {
          console.log(`[feishu] message has ${attachments.length} attachment(s), text="${text}"`);
        }

        const event: LarkEventPayload = {
          sessionId: msg.chat_id,
          messageId: msg.message_id,
          text,
          senderId: data.sender?.sender_id?.open_id ?? '',
          timestamp: msg.create_time ?? '',
          mentioned,
        };

        console.log(`[feishu] event built: msgType=${msgType}, mentioned=${mentioned}, text="${text.substring(0, 50)}"`);
        if (mentioned) {
          console.log(`[feishu] bot was mentioned in message`);
        }

        if (attachments !== undefined) {
          event.attachments = attachments;
        }

        console.log(`[feishu] emitting event to handler: messageId=${event.messageId}, sessionId=${event.sessionId}, textLength=${event.text.length}, attachments=${event.attachments?.length ?? 0}`);
        void eventHandler?.(event);
      },
      // 空 handler，屏蔽 SDK 的 "no handle" 警告
      'im.chat.access_event.bot_p2p_chat_entered_v1'() {},

      async 'card.action.trigger'(data: unknown) {
        console.log('[feishu] card.action.trigger received, data:', JSON.stringify(data));

        const details = extractCardActionDetails(data);
        const command = extractCardActionCommand(data);
        const sessionId = extractCardActionSessionId(data);
        const messageId = extractCardActionMessageId(data) ?? 'card-action';
        const senderId = extractCardActionSenderId(data) ?? '';

        console.log('[feishu] card action parsed: details=', details, ', command=', command, ', sessionId=', sessionId);

        if (sessionId === null) {
          console.warn('[feishu] card.action.trigger: sessionId is null, ignoring event');
          return;
        }

        const event: LarkEventPayload = {
          sessionId,
          messageId,
          text: details !== null ? '' : command ?? '',
          senderId,
          timestamp: new Date().toISOString(),
          cardAction:
            details !== null && details.requestId !== null
              ? {
                  action: details.action,
                  requestId: details.requestId,
                }
              : details !== null && 'threadId' in details && details.threadId !== null
                ? {
                    action: details.action,
                    threadId: details.threadId,
                  }
                : undefined,
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
            payload = message.format === 'text'
              ? {
                  msg_type: 'text',
                  content: JSON.stringify({ text: message.text }),
                }
              : isMarkdown(message.text)
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
    async sendFile(message) {
      if (options.sendFileFn === undefined) {
        throw new Error('File sending is not configured');
      }

      return await new Promise<{ messageId?: string } | void>((resolve, reject) => {
        enqueueMessage(message.sessionId, async () => {
          try {
            options.onSendFile?.(message);
            console.log(`[feishu] sending file, session=${message.sessionId}, filePath=${message.filePath}, fileName=${message.fileName}`);
            const result = await options.sendFileFn!({
              receiveId: message.sessionId,
              filePath: message.filePath,
              fileName: message.fileName,
            });
            resolve(result);
          } catch (error) {
            logTransportError('send file', message.sessionId, error);
            reject(error);
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
        return false;
      }

      let updateFailed = false;
      await new Promise<void>((resolve) => {
        enqueueMessage(message.sessionId, async () => {
          try {
            await options.updateMessageFn({
              sessionId: message.sessionId,
              messageId: message.messageId,
              msgType: 'interactive',
              content: message.card.content,
            });
          } catch (error) {
            logTransportError('update interactive', message.sessionId, error);
            updateFailed = true;
          }
          resolve();
        });
      });
      return !updateFailed;
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
