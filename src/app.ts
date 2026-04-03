import type { Server } from 'node:http';

import { LarkAdapter } from './adapters/lark/adapter.ts';
import { createApiServer } from './api/server.ts';
import { BindingService } from './core/binding/binding-service.ts';
import { BridgeRouter } from './core/router/router.ts';
import type { BridgeConfig } from './types/index.ts';
import { InMemoryBindingStore } from './storage/binding-store.ts';
import type { LarkTransport } from './adapters/lark/adapter.ts';
import type { BindingStore } from './storage/binding-store.ts';

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
}): BridgeRuntime {
  const bindingStore = options.bindingStore ?? new InMemoryBindingStore();
  const bindingService = new BindingService(bindingStore);
  const router = new BridgeRouter(bindingService);
  const larkAdapter = new LarkAdapter(options.larkTransport);
  const apiServer = createApiServer({
    bindingService,
  });

  larkAdapter.onMessage(async (message) => {
    const outboundMessage = await router.routeInboundMessage(message);
    if (outboundMessage !== null) {
      await larkAdapter.send(outboundMessage);
      return;
    }

    // Unbound session — treat as console command
    const text = message.text.trim();
    const isCommand = text.startsWith('//') || text.startsWith('//bind ') || text === '//unbind' || text === '//list' || text === '//help';

    if (isCommand) {
      const lines = await handleConsoleCommand(bindingService, message.sessionId, message.senderId, text);
      for (const line of lines) {
        await larkAdapter.send({ targetSessionId: message.sessionId, text: line });
      }
      return;
    }

    // Not a command, reply with unbound info
    const bound = await bindingService.getProjectBySession(message.sessionId);
    await larkAdapter.send({
      targetSessionId: message.sessionId,
      text: bound === null
        ? `[codex-bridge] unbound session. chatId: ${message.sessionId}, openId: ${message.senderId}\n\nCommands:\n  //bind <projectId> - bind this chat to a project\n  //unbind - unbind this chat\n  //list - list all bindings\n  //help - show this help`
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

async function handleConsoleCommand(
  bindingService: BindingService,
  sessionId: string,
  senderId: string,
  text: string,
): Promise<string[]> {
  const parts = text.split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case '//bind':
    case 'bind': {
      if (args.length === 0) {
        return ['Usage: //bind <projectId>'];
      }
      const projectId = args[0];
      await bindingService.bindProjectToSession(projectId, sessionId);
      return [`[codex-bridge] bound chat ${sessionId} to project "${projectId}"`];
    }

    case '//unbind':
    case 'unbind': {
      await bindingService.unbindSession(sessionId);
      return [`[codex-bridge] unbound session ${sessionId}`];
    }

    case '//list':
    case 'list': {
      // List all bindings (we need internal access to the store)
      const projectId = await bindingService.getProjectBySession(sessionId);
      if (projectId === null) {
        return [`[codex-bridge] this chat is not bound to any project`];
      }
      return [
        `[codex-bridge] current binding:`,
        `  chatId: ${sessionId}`,
        `  openId: ${senderId}`,
        `  projectId: ${projectId}`,
      ];
    }

    case '//help':
    case 'help':
    default: {
      return [
        `[codex-bridge] commands:`,
        `  //bind <projectId>  - bind this chat to a project`,
        `  //unbind            - unbind this chat`,
        `  //list              - show current binding`,
        `  //help              - show this help`,
      ];
    }
  }
}
