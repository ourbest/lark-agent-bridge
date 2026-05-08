import { loadConfig } from '../config/env.ts';
import type { BridgeConfig } from '../types/index.ts';
import type { LarkEventPayload, LarkTransport } from '../adapters/lark/adapter.ts';

export interface RuntimeEnv {
  BRIDGE_HOST?: string;
  BRIDGE_PORT?: string;
  BRIDGE_STORAGE_PATH?: string;
  BRIDGE_PROJECTS_FILE?: string;
  BRIDGE_PROJECTS_ROOT?: string;
  BRIDGE_AGENT_IDLE_TIMEOUT_HOURS?: string;
}

export interface LocalDevLarkTransport extends LarkTransport {
  emit(event: LarkEventPayload): void;
  emitCardAction(event: LarkEventPayload): void;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid BRIDGE_PORT value: ${value}`);
  }

  return parsed;
}

export function resolveBridgeConfig(env: RuntimeEnv = process.env): BridgeConfig {
  return loadConfig({
    server: {
      host: env.BRIDGE_HOST,
      port: parsePort(env.BRIDGE_PORT),
    },
    storage: {
      path: env.BRIDGE_STORAGE_PATH,
    },
  });
}

export function resolveStoragePath(env: RuntimeEnv = process.env): string {
  return env.BRIDGE_STORAGE_PATH ?? './data/bridge.json';
}

export function resolveProjectsFilePath(env: RuntimeEnv = process.env): string {
  return env.BRIDGE_PROJECTS_FILE ?? './projects.json';
}

export function resolveProjectsRootPath(env: RuntimeEnv = process.env): string | undefined {
  const rootPath = env.BRIDGE_PROJECTS_ROOT?.trim();
  return rootPath === undefined || rootPath === '' ? undefined : rootPath;
}

export function resolveAgentIdleTimeoutHours(env: RuntimeEnv = process.env): number {
  const raw = env.BRIDGE_AGENT_IDLE_TIMEOUT_HOURS;
  if (raw === undefined || raw.trim() === '') {
    return 48;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[bootstrap] invalid BRIDGE_AGENT_IDLE_TIMEOUT_HOURS=${raw}, falling back to 48`);
    return 48;
  }
  return Math.floor(parsed);
}

export function resolveAgentIdleTimeoutMs(env: RuntimeEnv = process.env): number {
  return resolveAgentIdleTimeoutHours(env) * 60 * 60 * 1000;
}

export function createLocalDevLarkTransport(options?: {
  onSend?: (message: { sessionId: string; text: string; format?: 'auto' | 'text' }) => void;
  onSendFile?: (message: { sessionId: string; filePath: string; fileName: string; fallbackText?: string }) => void;
  onSendCard?: (message: { sessionId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }) => void;
  onUpdateCard?: (message: { sessionId: string; messageId: string; card: { msg_type: 'interactive'; content: string }; fallbackText?: string }) => void;
  onReact?: (message: { targetMessageId: string; emojiType: string }) => void;
  onEmit?: (event: LarkEventPayload) => void;
}): LocalDevLarkTransport {
  let eventHandler: ((event: LarkEventPayload) => void | Promise<void>) | null = null;
  let cardActionHandler: ((event: LarkEventPayload) => void | Promise<void>) | null = null;
  let nextMessageId = 1;

  return {
    onEvent(handler) {
      eventHandler = handler;
    },
    async sendMessage(message) {
      options?.onSend?.(message);
      return { messageId: `local-msg-${nextMessageId++}` };
    },
    async sendFile(message) {
      options?.onSendFile?.(message);
      return { messageId: `local-file-${nextMessageId++}` };
    },
    async sendCard(message) {
      options?.onSendCard?.({
        sessionId: message.sessionId,
        card: message.card,
        fallbackText: message.fallbackText,
      });
      return { messageId: `local-card-${nextMessageId++}` };
    },
    async updateCard(message) {
      options?.onUpdateCard?.(message);
    },
    async sendReaction(message) {
      options?.onReact?.(message);
    },
    onCardAction(handler) {
      cardActionHandler = handler;
    },
    emit(event) {
      options?.onEmit?.(event);
      void eventHandler?.(event);
    },
    emitCardAction(event) {
      void cardActionHandler?.(event);
    },
  };
}
