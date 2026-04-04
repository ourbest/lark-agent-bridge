import type { Server } from 'node:http';

import { LarkAdapter } from './adapters/lark/adapter.ts';
import { createApiServer } from './api/server.ts';
import { createChatCommandService } from './commands/chat-command-service.ts';
import { BindingService } from './core/binding/binding-service.ts';
import { BridgeRouter } from './core/router/router.ts';
import type { BridgeConfig } from './types/index.ts';
import { InMemoryBindingStore } from './storage/binding-store.ts';
import type { LarkTransport } from './adapters/lark/adapter.ts';
import type { BindingStore } from './storage/binding-store.ts';
import type { ProjectState } from './runtime/project-registry.ts';
import type { ApprovalService } from './runtime/approval-service.ts';
import type { ProjectConfig } from './runtime/project-registry.ts';
import { buildHelpCard, buildProjectReplyCard, buildUnboundCard } from './adapters/lark/cards.ts';

const BUSY_REACTION_EMOJI_TYPE = 'THUMBSUP';

export interface BridgeRuntime {
  config: BridgeConfig;
  bindingService: BindingService;
  router: BridgeRouter;
  larkAdapter: LarkAdapter;
  apiServer: Server;
  ready: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type MessageHandler = (message: { sessionId: string; text: string; senderId: string }) => Promise<void>;

const HELP_CARD_BRIDGE_COMMANDS = [
  { command: '//bind <projectId>', description: 'Bind this chat to a project.' },
  { command: '//unbind', description: 'Unbind this chat.' },
  { command: '//list', description: 'Show the current binding.' },
  { command: '//new', description: 'Start a fresh Codex thread for this chat.' },
  { command: '//sessions', description: 'Show bridge and Codex session state.' },
  { command: '//reload projects', description: 'Reload the projects.json file.' },
  { command: '//resume <threadId|last>', description: 'Resume a Codex thread for this chat.' },
  { command: '//approvals', description: 'List pending approval requests.' },
  { command: '//approve <id>', description: 'Approve a single request.' },
  { command: '//approve-all <id>', description: 'Approve the request for the whole chat session.' },
  { command: '//deny <id>', description: 'Deny a pending request.' },
  { command: '//help', description: 'Show this help card.' },
] as const;

const HELP_CARD_CODEX_COMMANDS = [
  { command: 'app/list', description: 'List supported Codex apps.' },
  { command: 'session/list', description: 'List Codex sessions.' },
  { command: 'thread/list', description: 'List Codex threads.' },
  { command: 'session/get <id>', description: 'Inspect a Codex session.' },
  { command: 'thread/start', description: 'Start a new Codex thread.' },
  { command: 'thread/read <id>', description: 'Inspect a Codex thread.' },
] as const;

function isHelpCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized === '//help' || normalized === 'help';
}

export function createBridgeApp(options: {
  config: BridgeConfig;
  larkTransport: LarkTransport;
  bindingStore?: BindingStore;
  onInboundMessage?: (message: { sessionId: string; messageId: string; senderId: string; text: string }) => void;
  consoleHandler?: MessageHandler;
  projectRegistry: {
    describeProject(projectInstanceId: string): Promise<ProjectState>;
    getProjectConfig?(projectInstanceId: string): ProjectConfig | null;
    startThread?(projectInstanceId: string, options?: { cwd?: string; force?: boolean }): Promise<string>;
  };
  approvalService?: ApprovalService;
  reloadProjects?: () => Promise<string[]>;
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
    method: 'app/list' | 'thread/list' | 'thread/read';
    params: Record<string, unknown>;
  }) => Promise<string[]>;
}): BridgeRuntime {
  if (options.projectRegistry === undefined) {
    throw new Error('projectRegistry is required');
  }

  const bindingStore = options.bindingStore ?? new InMemoryBindingStore();
  const bindingService = new BindingService(bindingStore);
  const router = new BridgeRouter(bindingService);
  const larkAdapter = new LarkAdapter(options.larkTransport);
  const apiServer = createApiServer({
    bindingService,
  });
  const chatCommandService = createChatCommandService({
    bindingService,
    projectRegistry: options.projectRegistry,
    approvalService: options.approvalService,
    reloadProjects: options.reloadProjects,
    executeCodexCommand: options.executeCodexCommand,
    executeStructuredCodexCommand: options.executeStructuredCodexCommand,
  });

  larkAdapter.onMessage(async (message) => {
    await handleInboundMessage(message, true);
  });

  larkAdapter.onCardAction?.(async (message) => {
    await handleInboundMessage(message, false);
  });

  async function handleInboundMessage(message: { sessionId: string; text: string; senderId: string; messageId: string }, react: boolean): Promise<void> {
    options.onInboundMessage?.({
      sessionId: message.sessionId,
      messageId: message.messageId,
      senderId: message.senderId,
      text: message.text,
    });

    if (react) {
      // React immediately so the sender sees a busy indicator on the original message.
      await larkAdapter.react({
        targetMessageId: message.messageId,
        emojiType: BUSY_REACTION_EMOJI_TYPE,
      });
    }

    const text = message.text.trim();
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

      await larkAdapter.send({
        targetSessionId: message.sessionId,
        text: commandLines.join('\n'),
      });
      return;
    }

    const outboundMessage = await router.routeInboundMessage(message);
    if (outboundMessage !== null) {
      const projectId = await bindingService.getProjectBySession(message.sessionId);
      if (projectId === null) {
        return;
      }
      const projectConfig = options.projectRegistry.getProjectConfig?.(projectId);
      await larkAdapter.sendCard({
        targetSessionId: message.sessionId,
        card: buildProjectReplyCard({
          projectTitle: projectConfig?.projectInstanceId ?? projectId,
          bodyMarkdown: outboundMessage.text,
          footerItems: [
            { label: 'PATH', value: projectConfig?.cwd ?? 'n/a' },
            { label: 'Transport', value: projectConfig?.transport ?? 'n/a' },
          ],
        }),
        fallbackText: outboundMessage.text,
      });
      return;
    }

    // Unbound session — reply with unbound info
    const bound = await bindingService.getProjectBySession(message.sessionId);
    if (bound === null) {
      const fallbackText =
        `[codex-bridge] unbound session. chatId: ${message.sessionId}, openId: ${message.senderId}\n\nCommands:\n  //bind <projectId> - bind this chat to a project\n  //unbind - unbind this chat\n  //list - list all bindings\n  //new - start a new codex thread for this chat\n  //sessions - show bridge and codex state\n  //reload projects - reload projects.json\n  //help - show this help\n  thread/start - start a new codex thread`;

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
      return;
    }

    await larkAdapter.send({
      targetSessionId: message.sessionId,
      text: `[codex-bridge] project not found for binding: ${message.sessionId}`,
    });
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
