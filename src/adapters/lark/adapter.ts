import type { InboundMessage, InboundAttachment, OutboundMessage } from '../../core/events/message.ts';
import type { OutboundReaction } from '../../core/events/message.ts';
import type { FeishuInteractiveCardMessage } from './cards.ts';

export interface LarkEventPayload {
  sessionId: string;
  messageId: string;
  text: string;
  senderId: string;
  timestamp: string;
  attachments?: InboundAttachment[];
  cardAction?: {
    action: 'approve' | 'approve-all' | 'approve-auto' | 'deny';
    requestId: string;
  } | {
    action: 'thread-cancel' | 'thread-pause' | 'thread-resume' | 'thread-refresh';
    threadId: string;
  };
}

export interface LarkSendResult {
  messageId?: string;
}

export interface LarkTransport {
  onEvent(handler: (event: LarkEventPayload) => void | Promise<void>): void;
  sendMessage(message: { sessionId: string; text: string; format?: 'auto' | 'text' }): Promise<LarkSendResult | void>;
  sendFile?(message: { sessionId: string; filePath: string; fileName: string; fallbackText?: string }): Promise<LarkSendResult | void>;
  sendCard?(message: { sessionId: string; card: FeishuInteractiveCardMessage; fallbackText?: string }): Promise<LarkSendResult | void>;
  updateCard?(message: { sessionId: string; messageId: string; card: FeishuInteractiveCardMessage; fallbackText?: string }): Promise<void>;
  sendReaction(message: OutboundReaction): Promise<void>;
  onCardAction?(handler: (event: LarkEventPayload) => void | Promise<void>): void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

type MessageHandler = (message: InboundMessage) => Promise<void>;

export class LarkAdapter {
  private readonly transport: LarkTransport;
  private messageHandler: MessageHandler | null = null;
  private started = false;

  constructor(transport: LarkTransport) {
    this.transport = transport;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onCardAction(handler: MessageHandler): void {
    this.transport.onCardAction?.(handler);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.transport.onEvent(async (event) => {
      console.log(`[lark-adapter] received event: messageId=${event.messageId}, sessionId=${event.sessionId}, textLength=${event.text.length}, attachments=${event.attachments?.length ?? 0}, cardAction=${event.cardAction !== undefined}`);
      const normalized = this.normalizeInboundEvent(event);
      if (normalized === null || this.messageHandler === null) {
        console.warn(`[lark-adapter] dropping event: normalized=${normalized === null ? 'null' : 'valid'}, handler=${this.messageHandler === null ? 'null' : 'present'}`);
        return;
      }

      console.log(`[lark-adapter] forwarding to messageHandler: text="${normalized.text.substring(0, 100)}${normalized.text.length > 100 ? '...' : ''}"`);
      await this.messageHandler(normalized);
    });
    await this.transport.start?.();
    this.started = true;
  }

  async stop(): Promise<void> {
    await this.transport.stop?.();
    this.started = false;
  }

  normalizeInboundEvent(event: LarkEventPayload): InboundMessage {
    const result: InboundMessage = {
      source: 'lark',
      sessionId: event.sessionId,
      messageId: event.messageId,
      text: event.text,
      senderId: event.senderId,
      timestamp: event.timestamp,
    };

    if (event.attachments !== undefined) {
      result.attachments = event.attachments;
    }

    if (event.cardAction !== undefined) {
      result.cardAction = event.cardAction;
    }

    return result;
  }

  async send(message: OutboundMessage): Promise<LarkSendResult | void> {
    const payload = {
      sessionId: message.targetSessionId,
      text: message.text,
      ...(message.format === undefined ? {} : { format: message.format }),
    };
    const result = await this.transport.sendMessage(payload);
    return normalizeSendResult(result);
  }

  async sendFile(message: { targetSessionId: string; filePath: string; fileName: string; fallbackText?: string }): Promise<LarkSendResult | void> {
    if (this.transport.sendFile !== undefined) {
      const result = await this.transport.sendFile({
        sessionId: message.targetSessionId,
        filePath: message.filePath,
        fileName: message.fileName,
        fallbackText: message.fallbackText,
      });
      return normalizeSendResult(result);
    }

    if (message.fallbackText !== undefined) {
      const result = await this.transport.sendMessage({
        sessionId: message.targetSessionId,
        text: message.fallbackText,
        format: 'text',
      });
      return normalizeSendResult(result);
    }

    throw new Error('File sending is not supported by this transport');
  }

  async sendCard(message: { targetSessionId: string; card: FeishuInteractiveCardMessage; fallbackText?: string }): Promise<LarkSendResult | void> {
    if (this.transport.sendCard !== undefined) {
      const result = await this.transport.sendCard({
        sessionId: message.targetSessionId,
        card: message.card,
        fallbackText: message.fallbackText,
      });
      return normalizeSendResult(result);
    }

    const result = await this.transport.sendMessage({
      sessionId: message.targetSessionId,
      text: message.fallbackText ?? message.card.content,
    });
    return normalizeSendResult(result);
  }

  async updateCard(message: { sessionId: string; messageId: string; card: FeishuInteractiveCardMessage; fallbackText?: string }): Promise<boolean> {
    if (this.transport.updateCard === undefined) {
      return false;
    }

    await this.transport.updateCard(message);
    return true;
  }

  async react(message: OutboundReaction): Promise<void> {
    await this.transport.sendReaction(message);
  }
}

function normalizeSendResult(result: LarkSendResult | { message_id?: string } | void): LarkSendResult | void {
  if (result === undefined) {
    return undefined;
  }

  if (typeof result.messageId === 'string' && result.messageId !== '') {
    return { messageId: result.messageId };
  }

  if ('message_id' in result && typeof result.message_id === 'string' && result.message_id !== '') {
    return { messageId: result.message_id };
  }

  return result;
}
