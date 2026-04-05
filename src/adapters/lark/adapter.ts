import type { InboundMessage, OutboundMessage } from '../../core/events/message.ts';
import type { OutboundReaction } from '../../core/events/message.ts';
import type { FeishuInteractiveCardMessage } from './cards.ts';

export interface LarkEventPayload {
  sessionId: string;
  messageId: string;
  text: string;
  senderId: string;
  timestamp: string;
}

export interface LarkSendResult {
  messageId?: string;
}

export interface LarkTransport {
  onEvent(handler: (event: LarkEventPayload) => void | Promise<void>): void;
  sendMessage(message: { sessionId: string; text: string }): Promise<LarkSendResult | void>;
  sendCard?(message: { sessionId: string; card: FeishuInteractiveCardMessage; fallbackText?: string }): Promise<LarkSendResult | void>;
  updateCard?(message: { messageId: string; card: FeishuInteractiveCardMessage; fallbackText?: string }): Promise<void>;
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
      const normalized = this.normalizeInboundEvent(event);
      if (normalized === null || this.messageHandler === null) {
        return;
      }

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
    return {
      source: 'lark',
      sessionId: event.sessionId,
      messageId: event.messageId,
      text: event.text,
      senderId: event.senderId,
      timestamp: event.timestamp,
    };
  }

  async send(message: OutboundMessage): Promise<LarkSendResult | void> {
    const result = await this.transport.sendMessage({
      sessionId: message.targetSessionId,
      text: message.text,
    });
    return normalizeSendResult(result);
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

  async updateCard(message: { messageId: string; card: FeishuInteractiveCardMessage; fallbackText?: string }): Promise<boolean> {
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
