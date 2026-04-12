import { readFile, realpath } from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';

import { LarkAdapter } from './adapters/lark/adapter.ts';
import { createApiServer } from './api/server.ts';
import { createChatCommandService } from './commands/chat-command-service.ts';
import { BindingService } from './core/binding/binding-service.ts';
import { BridgeRouter } from './core/router/router.ts';
import type { LarkChatInfoService } from './services/lark-chat-info-service.ts';
import type { BridgeConfig } from './types/index.ts';
import { InMemoryBindingStore } from './storage/binding-store.ts';
import type { LarkTransport } from './adapters/lark/adapter.ts';
import type { BindingStore } from './storage/binding-store.ts';
import type { ProjectDiagnostics, ProjectState } from './runtime/project-registry.ts';
import type { ApprovalService } from './runtime/approval-service.ts';
import type { ProjectConfig } from './runtime/project-registry.ts';
import { readCodexStatusLines } from './runtime/codex-status.ts';
import {
  buildBridgeStatusCard,
  buildCommandResultCard,
  buildHelpCard,
  buildMarkdownContentCard,
  buildProjectReplyCard,
  buildThreadListCard,
  buildUnavailableProjectCard,
  buildUnboundCard,
  buildFileReceivedCard,
  type CardFooterItem,
} from './adapters/lark/cards.ts';
import { saveMessageAttachments, type FileUploadResult } from './services/file-upload-service.ts';
import type { InboundAttachment } from './core/events/message.ts';

const MAX_READ_CARD_CHARS = 12000;

export interface BridgeRuntime {
  config: BridgeConfig;
  bindingService: BindingService;
  router: BridgeRouter;
  larkAdapter: LarkAdapter;
  apiServer: Server;
  ready: boolean;
  reportProjectStatus(input: {
    projectId: string;
    sessionId: string;
    status: 'working' | 'waiting_approval' | 'done' | 'failed';
    reason?: string | null;
    source?: ProjectDiagnostics['source'];
  }): Promise<void>;
  reportProjectProgress(input: {
    projectId: string;
    sessionId: string;
    textDelta?: string;
    summary?: string | null;
  }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type MessageHandler = (message: { sessionId: string; text: string; senderId: string }) => Promise<void>;

const HELP_CARD_BRIDGE_COMMANDS = [
  { command: '//bind <projectId>', description: 'Bind this chat to a project.' },
  { command: '//unbind', description: 'Unbind this chat.' },
  { command: '//list', description: 'Show the current binding.' },
  { command: '//projects', description: 'List all known projects.' },
  { command: '//providers', description: 'List providers for the bound project.' },
  { command: '//provider <id>', description: 'Switch the active provider.' },
  { command: '//new', description: 'Start a fresh Codex thread for this chat.' },
  { command: '//status', description: 'Show bridge and Codex session state.' },
  { command: '//abort', description: 'Abort the current task.' },
  { command: '//read <path>', description: 'Read a project file and send it to chat.' },
  { command: '//model <model>', description: 'Set the active model for the bound project.' },
  { command: '//reload projects', description: 'Reload the projects.json file.' },
  { command: '//resume <threadId|last>', description: 'Resume a Codex thread for this chat.' },
  { command: '//approvals', description: 'List pending approval requests.' },
  { command: '//approve <id>', description: 'Approve a single request.' },
  { command: '//approve-all <id>', description: 'Approve the request for the whole chat session.' },
  { command: '//approve-auto <minutes>', description: 'Auto-approve approval requests in this chat for N minutes.' },
  { command: '//approve-test', description: 'Create a test approval card for manual button checks.' },
  { command: '//deny <id>', description: 'Deny a pending request.' },
  { command: '//help', description: 'Show this help card.' },
] as const;

const HELP_CARD_CODEX_COMMANDS = [
  { command: '//app/list', description: 'List supported Codex apps.' },
  { command: '//session/list', description: 'List Codex sessions.' },
  { command: '//thread/list', description: 'List Codex threads.' },
  { command: '//thread/read <id>', description: 'Inspect a Codex thread.' },
  { command: '//review', description: 'Review the current working tree.' },
] as const;

function isHelpCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '//help';
}

function isRestartCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '//restart';
}

function isAbortCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '//abort';
}

function isApproveTestCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '//approve-test';
}

function hashToBase36(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function buildApproveTestRequestId(messageId: string): string {
  return `approve-test-${hashToBase36(messageId)}`;
}

function parseReadCommand(text: string): { kind: 'usage' } | { kind: 'read'; targetPath: string } | null {
  const match = text.trim().match(/^\/\/read(?:\s+(.+))?$/i);
  if (match === null) {
    return null;
  }

  const targetPath = match[1]?.trim();
  if (targetPath === undefined || targetPath === '') {
    return { kind: 'usage' };
  }

  return { kind: 'read', targetPath };
}

function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function inferFenceLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.ts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.js':
      return 'js';
    case '.jsx':
      return 'jsx';
    case '.json':
      return 'json';
    case '.md':
      return 'md';
    case '.sh':
      return 'bash';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.css':
      return 'css';
    case '.html':
      return 'html';
    default:
      return 'text';
  }
}

function sanitizeCodeFence(content: string): string {
  return content.replaceAll('```', '``\\`');
}

function buildFileCardMarkdown(filePath: string, content: string): string {
  if (filePath.toLowerCase().endsWith('.md')) {
    return content;
  }

  return `\`\`\`${inferFenceLanguage(filePath)}\n${sanitizeCodeFence(content)}\n\`\`\``;
}

function truncateFileContent(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_READ_CARD_CHARS) {
    return { text: content, truncated: false };
  }

  return {
    text: `${content.slice(0, MAX_READ_CARD_CHARS)}\n\n[truncated]`,
    truncated: true,
  };
}

function readCommandCardTitle(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === '//status' || normalized === '//sessions') {
    return 'Session State';
  }

  if (!normalized.startsWith('//')) {
    return null;
  }

  const command = normalized.slice(2).trim().split(/\s+/)[0];
  if (command === 'app/list' || command === 'session/list' || command === 'thread/list' || command === 'thread/read') {
    return command;
  }

  return null;
}

function formatBooleanFlag(value: boolean): string {
  return value ? 'yes' : 'no';
}

function formatUnavailableProjectMessage(input: {
  projectId: string;
  state: ProjectState;
  diagnostics: ProjectDiagnostics | null;
  hasHandler: boolean;
  recovery: 'restore not attempted' | 'restored handler but route still failed' | 'restore failed' | 'restore retry exhausted';
  recoveryReason?: string | null;
}): string {
  const lines = [`[lark-agent-bridge] bound project is unavailable: ${input.projectId}`];
  lines.push(`status: ${input.diagnostics?.status ?? 'unknown'}`);
  lines.push(`configured: ${formatBooleanFlag(input.state.configured)}`);
  lines.push(`active: ${formatBooleanFlag(input.state.active)}`);
  lines.push(`removed: ${formatBooleanFlag(input.state.removed)}`);
  lines.push(`handler: ${input.hasHandler ? 'present' : 'missing'}`);
  lines.push(`recovery: ${input.recovery}`);

  const reason = input.recoveryReason ?? input.diagnostics?.reason ?? null;
  if (reason !== null && reason.trim() !== '') {
    lines.push(`reason: ${reason}`);
  }

  if (input.diagnostics?.source !== undefined) {
    lines.push(`source: ${input.diagnostics.source}`);
  }

  return lines.join('\n');
}

function buildProjectFooterItems(
  projectId: string,
  projectConfig?: { cwd?: string | null; transport?: string | null; activeProvider?: string | null } | null,
  activeProvider?: string | null,
): CardFooterItem[] {
  return [
    { label: '', value: projectId },
    { label: '', value: projectConfig?.cwd ?? 'n/a' },
    { label: '', value: activeProvider ?? projectConfig?.activeProvider ?? 'n/a' },
    { label: '', value: projectConfig?.transport ?? 'n/a' },
  ];
}

function buildProcessingStatusFallback(projectId: string, text: string): string {
  return `[lark-agent-bridge] processing request for ${projectId}\n${text}`;
}

function buildCompletionStatusFallback(projectId: string): string {
  return `[lark-agent-bridge] completed request for ${projectId}`;
}

function buildEmptyReplyFallback(projectTitle: string): string {
  return `[lark-agent-bridge] empty reply from ${projectTitle}`;
}

function logEmptyReplyFallback(input: {
  projectId: string;
  sessionId: string;
  requestTextLength: number;
}): void {
  console.warn(
    `[lark-agent-bridge] empty reply fallback: project=${input.projectId} session=${input.sessionId} requestLength=${input.requestTextLength}`,
  );
}

function deriveCommandCardTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 'lark-agent-bridge';
  }

  const token = trimmed.split(/\s+/)[0] ?? 'lark-agent-bridge';
  const normalized = token.startsWith('//') ? token.slice(2) : token;
  return normalized === '' ? 'lark-agent-bridge' : normalized;
}

type ActiveStatusCard = {
  projectId: string;
  sessionId: string;
  projectTitle: string;
  footerItems: CardFooterItem[];
  messageId: string | null;
  lastSignature: string | null;
  requestText: string;
  streamedReply: string;
  latestSummary: string | null;
};

function buildInFlightStatusMarkdown(input: {
  requestText: string;
  streamedReply: string;
  latestSummary?: string | null;
}): string {
  const sections = [
    `Handling message:\n\n\`\`\`text\n${sanitizeCodeFence(input.requestText)}\n\`\`\``,
  ];

  if (input.latestSummary?.trim()) {
    sections.push(`Latest activity:\n\n\`\`\`text\n${sanitizeCodeFence(input.latestSummary)}\n\`\`\``);
  }

  if (input.streamedReply.trim() !== '') {
    sections.push(`Reply so far:\n\n\`\`\`text\n${sanitizeCodeFence(input.streamedReply)}\n\`\`\``);
  }

  return sections.join('\n\n');
}

function buildRealtimeStatusPresentation(input: {
  projectTitle: string;
  status: 'working' | 'waiting_approval' | 'done' | 'failed';
  reason?: string | null;
  completedMarkdown?: string | null;
  footerItems: CardFooterItem[];
}) {
  if (input.status === 'waiting_approval') {
    return {
      card: buildBridgeStatusCard({
        projectTitle: input.projectTitle,
        statusLabel: 'Waiting Approval',
        bodyMarkdown: input.reason?.trim() ? input.reason : 'Approval is required before Codex can continue.',
        footerItems: input.footerItems,
        template: 'yellow',
      }),
      fallbackText: `[lark-agent-bridge] waiting approval for ${input.projectTitle}${input.reason?.trim() ? `\n${input.reason}` : ''}`,
    };
  }

  if (input.status === 'failed' && (input.reason ?? '').includes('Reconnecting...')) {
    return {
      card: buildBridgeStatusCard({
        projectTitle: input.projectTitle,
        statusLabel: 'Reconnecting',
        bodyMarkdown: input.reason ?? 'Reconnecting to Codex.',
        footerItems: input.footerItems,
        template: 'yellow',
      }),
      fallbackText: `[lark-agent-bridge] reconnecting ${input.projectTitle}${input.reason?.trim() ? `\n${input.reason}` : ''}`,
    };
  }

  if (input.status === 'done') {
    const completedMarkdown = input.completedMarkdown?.trim() || input.reason?.trim() || 'Reply delivered below.';
    return {
      card: buildBridgeStatusCard({
        projectTitle: input.projectTitle,
        statusLabel: 'Completed',
        bodyMarkdown: completedMarkdown,
        footerItems: input.footerItems,
        template: 'green',
      }),
      fallbackText: completedMarkdown,
    };
  }

  if (input.status === 'failed') {
    return {
      card: buildBridgeStatusCard({
        projectTitle: input.projectTitle,
        statusLabel: 'Failed',
        bodyMarkdown: input.reason?.trim() ? input.reason : 'The request failed.',
        footerItems: input.footerItems,
        template: 'red',
      }),
      fallbackText: `[lark-agent-bridge] failed request for ${input.projectTitle}${input.reason?.trim() ? `\n${input.reason}` : ''}`,
    };
  }

  return {
    card: buildBridgeStatusCard({
      projectTitle: input.projectTitle,
      statusLabel: 'Processing',
      bodyMarkdown: input.reason?.trim() ? input.reason : 'Request in progress.',
      footerItems: input.footerItems,
      template: 'blue',
    }),
    fallbackText: `[lark-agent-bridge] processing request for ${input.projectTitle}${input.reason?.trim() ? `\n${input.reason}` : ''}`,
  };
}

export function createBridgeApp(options: {
  config: BridgeConfig;
  larkTransport: LarkTransport;
  bindingStore?: BindingStore;
  larkChatInfoService?: LarkChatInfoService;
  onInboundMessage?: (message: { sessionId: string; messageId: string; senderId: string; text: string }) => void;
  consoleHandler?: MessageHandler;
  onRestartRequested?: (input: { sessionId: string; senderId: string; messageId: string; text: string }) => Promise<void>;
  /** 下载飞书消息附件的函数 */
  downloadFile?: (opts: { messageId: string; fileKey: string; type: 'image' | 'file' }) => Promise<{ buffer: Buffer; fileName: string; mimeType: string; fileSize: number }>;
  projectRegistry: {
    describeProject(projectInstanceId: string): Promise<ProjectState>;
    getProjectDiagnostics?(projectInstanceId: string): Promise<ProjectDiagnostics | null>;
    getProjectConfig?(projectInstanceId: string): ProjectConfig | null;
    listProjects?(): Promise<Array<{
      projectInstanceId: string;
      cwd?: string | null;
      activeProvider?: string | null;
      providers?: Array<{ id: string; kind: string; transport: string; port?: number }>;
      configured?: boolean;
      active?: boolean;
      removed?: boolean;
    }>>;
    getProjectProviders?(projectInstanceId: string): Promise<Array<{ id: string; kind: string; transport: string; active: boolean; started: boolean; port?: number }>>;
    getActiveProvider?(projectInstanceId: string): Promise<string | null>;
    setActiveProvider?(projectInstanceId: string, provider: string): Promise<void>;
    updateProjectConfig?(projectInstanceId: string, input: { model?: string | null }): Promise<ProjectConfig | null> | ProjectConfig | null;
    startThread?(projectInstanceId: string, options?: { cwd?: string; force?: boolean }): Promise<string>;
    abortCurrentTask?(projectInstanceId: string): Promise<boolean>;
    restoreBinding?(projectInstanceId: string, sessionId: string): Promise<void>;
    listThreads?(projectInstanceId: string): Promise<Array<{ id: string; name: string; description: string; status: 'running' | 'paused' | 'completed' | 'failed'; createdAt: Date; duration?: string }>>;
    cancelThread?(projectInstanceId: string, threadId: string): Promise<void>;
    pauseThread?(projectInstanceId: string, threadId: string): Promise<void>;
    resumeThread?(projectInstanceId: string, threadId: string): Promise<void>;
  };
  approvalService?: ApprovalService;
  reloadProjects?: () => Promise<string[]>;
  addLocalProject?(input: { path: string; id?: string }): Promise<{ projectInstanceId: string; cwd: string }>;
  addRemoteProject?(input: { gitRemote: string }): Promise<{ projectInstanceId: string; cwd: string }>;
  codexStatusProvider?: () => Promise<string[]>;
  executeCodexCommand?: (input: {
    sessionId: string;
    senderId: string;
    projectInstanceId: string;
    command: string;
    args: string[];
  }) => Promise<string[]>;
  executeStructuredCodexCommand?: (input: {
    sessionId: string;
    senderId: string;
    projectInstanceId: string;
    method: 'app/list' | 'thread/list' | 'thread/read' | 'review/start';
    params: Record<string, unknown>;
  }) => Promise<string[]>;
}): BridgeRuntime {
  if (options.projectRegistry === undefined) {
    throw new Error('projectRegistry is required');
  }

  const bindingStore = options.bindingStore ?? new InMemoryBindingStore();
  const bindingService = new BindingService(bindingStore, options.larkChatInfoService);
  const router = new BridgeRouter(bindingService);
  const larkAdapter = new LarkAdapter(options.larkTransport);
  const apiServer = createApiServer({
    bindingService,
  });
  const chatCommandService = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...options.projectRegistry,
      listProjectProviders: options.projectRegistry.getProjectProviders,
    },
    approvalService: options.approvalService,
    reloadProjects: options.reloadProjects,
    addLocalProject: options.addLocalProject,
    addRemoteProject: options.addRemoteProject,
    getCodexStatusLines: options.codexStatusProvider ?? readCodexStatusLines,
    executeCodexCommand: options.executeCodexCommand,
    executeStructuredCodexCommand: options.executeStructuredCodexCommand,
  });
  const activeStatusCards = new Map<string, ActiveStatusCard>();

  async function reportProjectStatus(input: {
    projectId: string;
    sessionId: string;
    status: 'working' | 'waiting_approval' | 'done' | 'failed';
    reason?: string | null;
    source?: ProjectDiagnostics['source'];
  }): Promise<void> {
    const entry = activeStatusCards.get(input.sessionId);
    if (entry === undefined || entry.projectId !== input.projectId) {
      return;
    }

    if (input.status === 'working' && input.reason?.trim()) {
      entry.latestSummary = input.reason;
    }

    const presentation = input.status === 'working'
      ? {
          card: buildBridgeStatusCard({
            projectTitle: entry.projectTitle,
            statusLabel: 'Processing',
            bodyMarkdown: buildInFlightStatusMarkdown({
              requestText: entry.requestText,
              streamedReply: entry.streamedReply,
              latestSummary: entry.latestSummary,
            }),
            footerItems: entry.footerItems,
            template: 'blue',
          }),
          fallbackText: buildInFlightStatusMarkdown({
            requestText: entry.requestText,
            streamedReply: entry.streamedReply,
            latestSummary: entry.latestSummary,
          }),
        }
      : buildRealtimeStatusPresentation({
          projectTitle: entry.projectTitle,
          status: input.status,
          reason: input.reason,
          completedMarkdown: input.status === 'done' ? entry.streamedReply : null,
          footerItems: entry.footerItems,
        });
    const signature = JSON.stringify({
      status: input.status,
      reason: input.status === 'working' ? entry.latestSummary : input.reason ?? null,
      streamedReply: input.status === 'working' ? entry.streamedReply : null,
      source: input.source ?? null,
    });
    if (entry.lastSignature === signature) {
      return;
    }

    let updated = false;
    if (entry.messageId !== null) {
      try {
        updated = await larkAdapter.updateCard({
          sessionId: input.sessionId,
          messageId: entry.messageId,
          card: presentation.card,
          fallbackText: presentation.fallbackText,
        });
      } catch (error) {
        const reason = error instanceof Error && error.message !== '' ? error.message : String(error ?? 'unknown error');
        console.error(
          `[lark-agent-bridge] status card update failed: project=${input.projectId} session=${input.sessionId} messageId=${entry.messageId} status=${input.status} reason="${reason}"`,
        );
        updated = false;
      }
    }

    if (!updated) {
      const result = await larkAdapter.sendCard({
        targetSessionId: input.sessionId,
        card: presentation.card,
        fallbackText: presentation.fallbackText,
      });
      entry.messageId = result?.messageId ?? entry.messageId;
    }

    entry.lastSignature = signature;
  }

  async function reportProjectProgress(input: {
    projectId: string;
    sessionId: string;
    textDelta?: string;
    summary?: string | null;
  }): Promise<void> {
    const entry = activeStatusCards.get(input.sessionId);
    if (entry === undefined || entry.projectId !== input.projectId) {
      return;
    }

    if (input.textDelta !== undefined && input.textDelta !== '') {
      entry.streamedReply += input.textDelta;
    }

    if (input.summary?.trim()) {
      entry.latestSummary = input.summary;
    }

    await reportProjectStatus({
      projectId: input.projectId,
      sessionId: input.sessionId,
      status: 'working',
      source: 'notification',
    });
  }

  larkAdapter.onMessage(async (message) => {
    await handleInboundMessage(message, true);
  });

  larkAdapter.onCardAction?.(async (message) => {
    await handleInboundMessage(message, false);
  });

  async function handleInboundMessage(message: InboundMessage, react: boolean): Promise<void> {
    console.log(`[bridge] handleInboundMessage: messageId=${message.messageId}, sessionId=${message.sessionId}, text="${message.text.substring(0, 100)}${message.text.length > 100 ? '...' : ''}", attachments=${message.attachments?.length ?? 0}, cardAction=${message.cardAction !== undefined}, react=${react}`);

    options.onInboundMessage?.({
      sessionId: message.sessionId,
      messageId: message.messageId,
      senderId: message.senderId,
      text: message.text,
    });

    if (message.cardAction !== undefined) {
      const cardAction = message.cardAction;
      const projectId = await bindingService.getProjectBySession(message.sessionId);

      // Handle thread card actions
      if (projectId !== null && 'threadId' in cardAction) {
        const { action, threadId } = cardAction;

        try {
          if (action === 'thread-refresh' && options.projectRegistry.listThreads) {
            const threads = await options.projectRegistry.listThreads(projectId);
            await larkAdapter.sendCard({
              targetSessionId: message.sessionId,
              card: buildThreadListCard({ threads, refresh: true }),
              fallbackText: threads.map((t) => `${t.name} (${t.status})`).join('\n'),
            });
          } else if (action === 'thread-cancel' && options.projectRegistry.cancelThread) {
            await options.projectRegistry.cancelThread(projectId, threadId);
            const threads = await options.projectRegistry.listThreads(projectId);
            await larkAdapter.sendCard({
              targetSessionId: message.sessionId,
              card: buildThreadListCard({ threads, refresh: true }),
              fallbackText: threads.map((t) => `${t.name} (${t.status})`).join('\n'),
            });
          } else if (action === 'thread-pause' && options.projectRegistry.pauseThread) {
            await options.projectRegistry.pauseThread(projectId, threadId);
            const threads = await options.projectRegistry.listThreads(projectId);
            await larkAdapter.sendCard({
              targetSessionId: message.sessionId,
              card: buildThreadListCard({ threads, refresh: true }),
              fallbackText: threads.map((t) => `${t.name} (${t.status})`).join('\n'),
            });
          } else if (action === 'thread-resume' && options.projectRegistry.resumeThread) {
            await options.projectRegistry.resumeThread(projectId, threadId);
            const threads = await options.projectRegistry.listThreads(projectId);
            await larkAdapter.sendCard({
              targetSessionId: message.sessionId,
              card: buildThreadListCard({ threads, refresh: true }),
              fallbackText: threads.map((t) => `${t.name} (${t.status})`).join('\n'),
            });
          }
        } catch (error) {
          const reason = error instanceof Error && error.message !== '' ? error.message : String(error ?? 'unknown error');
          console.error(`[lark-agent-bridge] thread action ${action} failed: project=${projectId} session=${message.sessionId} threadId=${threadId} reason="${reason}"`);
        }

        return;
      }

      // Handle approval card actions
      if ('requestId' in cardAction && options.approvalService !== undefined) {
        if (projectId !== null) {
          const result = await options.approvalService.handleAction({
            sessionId: message.sessionId,
            projectInstanceId: projectId,
            action: cardAction.action,
            requestId: cardAction.requestId,
          });

          if (result !== null) {
            for (const update of result.updates) {
              const messageId = update.messageId ?? (update.requestId === message.messageId ? message.messageId : null);
              if (messageId === null) {
                continue;
              }

              try {
                await larkAdapter.updateCard({
                  sessionId: message.sessionId,
                  messageId,
                  card: update.card,
                  fallbackText: result.lines.join('\n'),
                });
              } catch (error) {
                const reason = error instanceof Error && error.message !== '' ? error.message : String(error ?? 'unknown error');
                console.error(
                  `[lark-agent-bridge] approval card update failed: project=${projectId} session=${message.sessionId} messageId=${messageId} reason="${reason}"`,
                );
              }
            }
          }
        }

        return;
      }
    }

    const text = message.text.trim();
    const readCommand = parseReadCommand(text);
    if (readCommand !== null) {
      if (readCommand.kind === 'usage') {
        await larkAdapter.send({
          targetSessionId: message.sessionId,
          text: 'Usage: //read <path>',
        });
        return;
      }

      const projectId = await bindingService.getProjectBySession(message.sessionId);
      if (projectId === null) {
        await larkAdapter.sendCard({
          targetSessionId: message.sessionId,
          card: buildUnboundCard({
            sessionId: message.sessionId,
            senderId: message.senderId,
            bridgeCommands: [...HELP_CARD_BRIDGE_COMMANDS],
            codexCommands: [...HELP_CARD_CODEX_COMMANDS],
          }),
          fallbackText: '[lark-agent-bridge] this chat is not bound to any project',
        });
        return;
      }

      const projectConfig = options.projectRegistry.getProjectConfig?.(projectId) ?? null;
      const configuredCwd = projectConfig?.cwd?.trim();
      if (configuredCwd === undefined || configuredCwd === '') {
        await larkAdapter.send({
          targetSessionId: message.sessionId,
          text: '[lark-agent-bridge] project cwd is not configured for //read',
        });
        return;
      }

      try {
        const resolvedCwd = path.resolve(configuredCwd);
        const canonicalCwd = await realpath(resolvedCwd);
        const requestedPath = path.resolve(resolvedCwd, readCommand.targetPath);
        const canonicalPath = await realpath(requestedPath);

        if (!isPathWithinRoot(canonicalCwd, canonicalPath)) {
          await larkAdapter.send({
            targetSessionId: message.sessionId,
            text: '[lark-agent-bridge] //read only supports files under the project cwd',
          });
          return;
        }

        const rawContent = await readFile(canonicalPath, 'utf8');
        const fileContent = truncateFileContent(rawContent);
        const relativePath = path.relative(canonicalCwd, canonicalPath) || path.basename(canonicalPath);
        const bodyMarkdown = buildFileCardMarkdown(relativePath, fileContent.text);
        await larkAdapter.send({
          targetSessionId: message.sessionId,
          text: `[${projectId}] ${relativePath}\n\n${bodyMarkdown}`,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        await larkAdapter.send({
          targetSessionId: message.sessionId,
          text: `[lark-agent-bridge] failed to read file: ${messageText}`,
        });
      }
      return;
    }

    if (isApproveTestCommand(text)) {
      const projectId = await bindingService.getProjectBySession(message.sessionId);
      if (projectId === null) {
        await larkAdapter.sendCard({
          targetSessionId: message.sessionId,
          card: buildCommandResultCard({
            title: 'approve-test',
            lines: ['[lark-agent-bridge] this chat is not bound to any project'],
          }),
          fallbackText: '[lark-agent-bridge] this chat is not bound to any project',
        });
        return;
      }

      if (options.approvalService === undefined) {
        await larkAdapter.sendCard({
          targetSessionId: message.sessionId,
          card: buildCommandResultCard({
            title: 'approve-test',
            lines: ['[lark-agent-bridge] approval service is not configured'],
          }),
          fallbackText: '[lark-agent-bridge] approval service is not configured',
        });
        return;
      }

      const requestId = buildApproveTestRequestId(message.messageId);
      const result = await options.approvalService.registerRequest({
        requestId,
        projectInstanceId: projectId,
        sessionId: message.sessionId,
        threadId: message.messageId,
        turnId: message.messageId,
        itemId: message.messageId,
        kind: 'commandExecution',
        command: '//approve-test',
        reason: 'Test approval card generated by //approve-test',
        forcePending: true,
        respond: async () => {},
      });

      if (result.card === null) {
        await larkAdapter.sendCard({
          targetSessionId: message.sessionId,
          card: buildCommandResultCard({
            title: 'approve-test',
            lines: result.lines,
          }),
          fallbackText: result.lines.join('\n'),
        });
        return;
      }

      const sent = await larkAdapter.sendCard({
        targetSessionId: message.sessionId,
        card: result.card,
        fallbackText: result.lines.join('\n'),
      });
      if (sent?.messageId !== undefined && sent.messageId !== '') {
        await options.approvalService.attachCardMessage(requestId, sent.messageId);
      }
      return;
    }

    const commandLines = await chatCommandService.execute({
      sessionId: message.sessionId,
      senderId: message.senderId,
      text,
    });

    if (commandLines !== null) {
      if (isHelpCommand(text)) {
        await larkAdapter.sendCard({
          targetSessionId: message.sessionId,
          card: buildHelpCard({
            bridgeCommands: [...HELP_CARD_BRIDGE_COMMANDS],
            codexCommands: [...HELP_CARD_CODEX_COMMANDS],
          }),
          fallbackText: commandLines.join('\n'),
        });
        return;
      }

      const commandCardTitle = readCommandCardTitle(text);
      if (commandCardTitle !== null) {
        const projectId = await bindingService.getProjectBySession(message.sessionId);
        const projectConfig = projectId === null ? null : options.projectRegistry.getProjectConfig?.(projectId) ?? null;
        const footerItems =
          projectId === null
            ? []
            : [
                { label: 'Project', value: projectId },
                { label: 'PATH', value: projectConfig?.cwd ?? 'n/a' },
                { label: 'Transport', value: projectConfig?.transport ?? 'n/a' },
              ];

        await larkAdapter.sendCard({
          targetSessionId: message.sessionId,
          card: buildCommandResultCard({
            title: commandCardTitle,
            lines: commandLines,
            footerItems,
          }),
          fallbackText: commandLines.join('\n'),
        });
        return;
      }

      await larkAdapter.sendCard({
        targetSessionId: message.sessionId,
        card: buildCommandResultCard({
          title: deriveCommandCardTitle(text),
          lines: commandLines,
        }),
        fallbackText: commandLines.join('\n'),
      });

      if (isAbortCommand(text)) {
        const projectId = await bindingService.getProjectBySession(message.sessionId);
        if (projectId !== null) {
          const aborted = await options.projectRegistry.abortCurrentTask?.(projectId);
          if (!aborted) {
            await larkAdapter.sendCard({
              targetSessionId: message.sessionId,
              card: buildCommandResultCard({
                title: 'abort',
                lines: [`[lark-agent-bridge] no active task for ${projectId}`],
              }),
              fallbackText: `[lark-agent-bridge] no active task for ${projectId}`,
            });
          }
        }
      }

      if (isRestartCommand(text)) {
        await options.onRestartRequested?.({
          sessionId: message.sessionId,
          senderId: message.senderId,
          messageId: message.messageId,
          text,
        });
      }
      return;
    }

    const boundProjectId = await bindingService.getProjectBySession(message.sessionId);
    const boundProjectConfig = boundProjectId === null ? null : options.projectRegistry.getProjectConfig?.(boundProjectId) ?? null;

    // 处理文件附件
    let nonImageFiles: FileUploadResult['savedFiles'] = [];
    let attachmentErrors: FileUploadResult['errors'] = [];
    if (message.attachments && message.attachments.length > 0 && boundProjectId !== null && options.downloadFile) {
      const projectConfig = boundProjectConfig;
      if (projectConfig?.cwd) {
        try {
          const uploadResult = await saveMessageAttachments({
            cwd: projectConfig.cwd,
            attachments: message.attachments,
            downloadFile: async (attachment) => {
              const fileType = attachment.attachmentType ?? (attachment.mimeType.startsWith('image/') ? 'image' : 'file');
              const downloaded = await options.downloadFile!({
                messageId: message.messageId,
                fileKey: attachment.fileKey,
                type: fileType,
              });
              // 更新附件信息
              attachment.fileName = downloaded.fileName;
              attachment.mimeType = downloaded.mimeType;
              attachment.fileSize = downloaded.fileSize;
              return downloaded.buffer;
            },
          });

          attachmentErrors = uploadResult.errors;
          // 分离图片和非图片文件
          nonImageFiles = uploadResult.savedFiles.filter(f => f.attachmentType !== 'image');
          const images = uploadResult.savedFiles.filter(f => f.attachmentType === 'image');

          if (images.length > 0) {
            // 图片：追加到消息文本中转发给 Codex
            const imageInfo = `\n\n📷 图片附件 (${images.length} 张):\n${images.map(f => `- ${f.originalName} -> ${f.savedPath}`).join('\n')}`;
            message.text = message.text + imageInfo;
          }

          if (nonImageFiles.length > 0) {
            // 非图片文件：记录日志，稍后回复收到卡片
            const fileNames = nonImageFiles.map(f => f.originalName).join(', ');
            console.log(`[file-upload] received ${nonImageFiles.length} non-image file(s) for project ${boundProjectId}: ${fileNames}`);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(`[file-upload] failed to process attachments: ${errorMsg}`);
        }
      } else {
        console.warn(`[file-upload] skipping attachments for project ${boundProjectId}: cwd not configured`);
      }
    }

    // 如果所有附件下载都失败了，且消息文本为空，发送错误卡片并返回，不路由到模型
    const allAttachmentsFailed = attachmentErrors.length > 0
      && message.attachments
      && message.attachments.length > 0
      && message.attachments.every(a => attachmentErrors.some(e => e.fileKey === a.fileKey));
    if (allAttachmentsFailed && message.text.trim() === '' && boundProjectId !== null) {
      await larkAdapter.sendCard({
        targetSessionId: message.sessionId,
        card: buildCommandResultCard({
          title: '附件下载失败',
          lines: attachmentErrors.map(e => `❌ ${e.fileName}: ${e.reason}`),
        }),
        fallbackText: `附件下载失败: ${attachmentErrors.map(e => e.reason).join('; ')}`,
      });
      return;
    }

    // 如果上传成功，只有非图片文件，且消息文本为空，不路由到 agent
    // 直接发送 fileReceivedCard 并返回
    if (nonImageFiles.length > 0 && message.text.trim() === '' && boundProjectId !== null) {
      const fileReceivedCard = buildFileReceivedCard({
        files: nonImageFiles,
        footerItems: buildProjectFooterItems(
          boundProjectId,
          boundProjectConfig,
          options.projectRegistry.getActiveProvider === undefined
            ? boundProjectConfig?.activeProvider ?? null
            : await options.projectRegistry.getActiveProvider(boundProjectId),
        ),
      });
      await larkAdapter.sendCard({
        targetSessionId: message.sessionId,
        card: fileReceivedCard,
        fallbackText: `已收到 ${nonImageFiles.length} 个文件: ${nonImageFiles.map(f => f.originalName).join(', ')}`,
      });
      return;
    }

    const statusFooterItems = boundProjectId === null
      ? []
      : buildProjectFooterItems(
          boundProjectId,
          boundProjectConfig,
          options.projectRegistry.getActiveProvider === undefined
            ? boundProjectConfig?.activeProvider ?? null
            : await options.projectRegistry.getActiveProvider(boundProjectId),
        );
    const statusCardResult =
      boundProjectId === null
        ? null
        : await larkAdapter.sendCard({
            targetSessionId: message.sessionId,
            card: buildBridgeStatusCard({
              projectTitle: boundProjectConfig?.projectInstanceId ?? boundProjectId,
              statusLabel: 'Processing',
              bodyMarkdown: `Handling message:\n\n\`\`\`text\n${sanitizeCodeFence(message.text)}\n\`\`\``,
              footerItems: statusFooterItems,
              template: 'blue',
            }),
            fallbackText: buildProcessingStatusFallback(boundProjectId, message.text),
          });
    const statusCardMessageId = statusCardResult?.messageId ?? null;
    if (boundProjectId !== null) {
      activeStatusCards.set(message.sessionId, {
        projectId: boundProjectId,
        sessionId: message.sessionId,
        projectTitle: boundProjectConfig?.projectInstanceId ?? boundProjectId,
        footerItems: statusFooterItems,
        messageId: statusCardMessageId,
        lastSignature: JSON.stringify({ status: 'working', reason: null, source: null }),
        requestText: message.text,
        streamedReply: '',
        latestSummary: null,
      });
    }

    let outboundMessage = await router.routeInboundMessage(message);
    let recoveryState: 'restore not attempted' | 'restored handler but route still failed' | 'restore failed' | 'restore retry exhausted' =
      'restore not attempted';
    let recoveryReason: string | null = null;
    let handlerPresentAfterRetry = false;
    if (outboundMessage === null) {
      const hasHandler = boundProjectId !== null ? router.hasProjectHandler(boundProjectId) : false;
      if (boundProjectId !== null && !hasHandler && options.projectRegistry.restoreBinding !== undefined) {
        try {
          await options.projectRegistry.restoreBinding(boundProjectId, message.sessionId);
          handlerPresentAfterRetry = router.hasProjectHandler(boundProjectId);
          outboundMessage = await router.routeInboundMessage(message);
          recoveryState = outboundMessage !== null
            ? 'restore retry exhausted'
            : handlerPresentAfterRetry
              ? 'restored handler but route still failed'
              : 'restore retry exhausted';
        } catch (error) {
          recoveryState = 'restore failed';
          recoveryReason = error instanceof Error && error.message !== '' ? error.message : String(error ?? 'unknown error');
          outboundMessage = null;
        }
      }
    }

    if (outboundMessage !== null) {
      const projectId = boundProjectId ?? await bindingService.getProjectBySession(message.sessionId);
    if (projectId === null) {
      return;
    }
    const projectConfig = boundProjectConfig ?? options.projectRegistry.getProjectConfig?.(projectId);
    const replyText =
      outboundMessage.text.trim() === ''
        ? (() => {
            const resolvedProjectId = projectConfig?.projectInstanceId ?? projectId;
            logEmptyReplyFallback({
              projectId: resolvedProjectId,
              sessionId: message.sessionId,
              requestTextLength: message.text.length,
            });
            return buildEmptyReplyFallback(resolvedProjectId);
          })()
        : outboundMessage.text;
    const replyCard = buildProjectReplyCard({
      projectTitle: projectConfig?.projectInstanceId ?? projectId,
      bodyMarkdown: replyText,
      footerItems: buildProjectFooterItems(
        projectId,
        projectConfig,
        options.projectRegistry.getActiveProvider === undefined
          ? projectConfig?.activeProvider ?? null
            : await options.projectRegistry.getActiveProvider(projectId),
        ),
      });
      await larkAdapter.sendCard({
        targetSessionId: message.sessionId,
        card: replyCard,
        fallbackText: replyText,
      });

      // 如果有非图片文件，回复收到文件卡片
      if (nonImageFiles.length > 0) {
        const fileReceivedCard = buildFileReceivedCard({
          files: nonImageFiles,
          footerItems: buildProjectFooterItems(
            projectId,
            projectConfig,
            options.projectRegistry.getActiveProvider === undefined
              ? projectConfig?.activeProvider ?? null
              : await options.projectRegistry.getActiveProvider(projectId),
          ),
        });
        await larkAdapter.sendCard({
          targetSessionId: message.sessionId,
          card: fileReceivedCard,
          fallbackText: `已收到 ${nonImageFiles.length} 个文件: ${nonImageFiles.map(f => f.originalName).join(', ')}`,
        });
      }

      activeStatusCards.delete(message.sessionId);
      return;
    }

    // Unbound session — reply with unbound info
    const bound = boundProjectId ?? await bindingService.getProjectBySession(message.sessionId);
    if (bound === null) {
      const hasAttachments = message.attachments !== undefined && message.attachments.length > 0;
      const attachmentNote = hasAttachments
        ? '\n\n⚠️ File attachments are not supported for unbound chats. Please bind this chat first using //bind <projectId>.'
        : '';

      const fallbackText =
        `[lark-agent-bridge] unbound session. chatId: ${message.sessionId}, openId: ${message.senderId}${attachmentNote}\n\nCommands:\n  //bind <projectId> - bind this chat to a project\n  //unbind - unbind this chat\n  //list - list all bindings\n  //projects - list all projects\n  //providers - list providers for the bound project\n  //provider <id> - switch the active provider\n  //new - start a new codex thread for this chat\n  //status - show bridge and codex state\n  //abort - abort the current task\n  //reload projects - reload projects.json\n  //help - show this help`;

      if (hasAttachments) {
        // When there are attachments, use a content card that shows the attachment warning
        await larkAdapter.sendCard({
          targetSessionId: message.sessionId,
          card: buildMarkdownContentCard({
            title: '未绑定项目',
            subtitle: message.sessionId,
            bodyMarkdown: `⚠️ **文件附件在未绑定的聊天中不受支持。**

请先使用以下命令绑定此聊天：

\`\`\`text
//bind <projectId>
\`\`\``,
            template: 'yellow',
          }),
          fallbackText,
        });
      } else {
        await larkAdapter.sendCard({
          targetSessionId: message.sessionId,
          card: buildUnboundCard({
            sessionId: message.sessionId,
            senderId: message.senderId,
            bridgeCommands: [...HELP_CARD_BRIDGE_COMMANDS],
            codexCommands: [...HELP_CARD_CODEX_COMMANDS],
          }),
          fallbackText,
        });
      }
      return;
    }

    const state = await options.projectRegistry.describeProject(bound);
    const diagnostics = await options.projectRegistry.getProjectDiagnostics?.(bound) ?? null;
    const hasHandler = router.hasProjectHandler(bound);
    const reconnectingReason = diagnostics?.status === 'failed' ? diagnostics.reason ?? '' : '';
    if (reconnectingReason.includes('Reconnecting...')) {
      return;
    }
    const unavailableMessage = formatUnavailableProjectMessage({
      projectId: bound,
      state,
      diagnostics,
      hasHandler,
      recovery: recoveryState,
      recoveryReason,
    });
    console.error(
      `[lark-agent-bridge] bound project unavailable: project=${bound} session=${message.sessionId} status=${diagnostics?.status ?? 'unknown'} configured=${state.configured} active=${state.active} removed=${state.removed} handler=${hasHandler} recovery="${recoveryState}" reason="${recoveryReason ?? diagnostics?.reason ?? ''}" source="${diagnostics?.source ?? ''}"`,
    );
    const unavailableCard = buildUnavailableProjectCard({
      projectId: bound,
      lines: unavailableMessage.split('\n'),
      footerItems: buildProjectFooterItems(
        bound,
        options.projectRegistry.getProjectConfig?.(bound) ?? null,
        options.projectRegistry.getActiveProvider === undefined
          ? options.projectRegistry.getProjectConfig?.(bound)?.activeProvider ?? null
          : await options.projectRegistry.getActiveProvider(bound),
      ),
    });
    if (statusCardMessageId !== null) {
      let updated = false;
      try {
        updated = await larkAdapter.updateCard({
          sessionId: message.sessionId,
          messageId: statusCardMessageId,
          card: unavailableCard,
          fallbackText: unavailableMessage,
        });
      } catch (error) {
        const reason = error instanceof Error && error.message !== '' ? error.message : String(error ?? 'unknown error');
        console.error(
          `[lark-agent-bridge] status card update failed: project=${bound} session=${message.sessionId} messageId=${statusCardMessageId} status=unavailable reason="${reason}"`,
        );
        updated = false;
      }
      if (updated) {
        activeStatusCards.delete(message.sessionId);
        return;
      }
    }
    await larkAdapter.sendCard({
      targetSessionId: message.sessionId,
      card: unavailableCard,
      fallbackText: unavailableMessage,
    });
    activeStatusCards.delete(message.sessionId);
  }

  let ready = false;

  return {
    config: options.config,
    bindingService,
    router,
    larkAdapter,
    apiServer,
    get ready() {
      return ready;
    },
    reportProjectStatus,
    reportProjectProgress,
    async start() {
      await larkAdapter.start();
      ready = true;
    },
    async stop() {
      await larkAdapter.stop();
      ready = false;
    },
  };
}
