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

export function createBridgeApp(options: {
  config: BridgeConfig;
  larkTransport: LarkTransport;
  bindingStore?: BindingStore;
  consoleHandler?: MessageHandler;
  projectRegistry: {
    describeProject(projectInstanceId: string): Promise<ProjectState>;
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
    // React immediately so the sender sees a busy indicator on the original message.
    await larkAdapter.react({
      targetMessageId: message.messageId,
      emojiType: BUSY_REACTION_EMOJI_TYPE,
    });

    const text = message.text.trim();
    const commandLines = await chatCommandService.execute({
      sessionId: message.sessionId,
      senderId: message.senderId,
      text,
    });

    if (commandLines !== null) {
      await larkAdapter.send({
        targetSessionId: message.sessionId,
        text: commandLines.join('\n'),
      });
      return;
    }

    const outboundMessage = await router.routeInboundMessage(message);
    if (outboundMessage !== null) {
      await larkAdapter.send(outboundMessage);
      return;
    }

    // Unbound session — reply with unbound info
    const bound = await bindingService.getProjectBySession(message.sessionId);
    await larkAdapter.send({
      targetSessionId: message.sessionId,
      text: bound === null
        ? `[codex-bridge] unbound session. chatId: ${message.sessionId}, openId: ${message.senderId}\n\nCommands:\n  //bind <projectId> - bind this chat to a project\n  //unbind - unbind this chat\n  //list - list all bindings\n  //sessions - show bridge and codex state\n  //reload projects - reload projects.json\n  //help - show this help`
        : `[codex-bridge] project not found for binding: ${message.sessionId}`,
    });
  });

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
