import { pathToFileURL } from 'node:url';
import https from 'node:https';
import 'dotenv/config';

import { createBridgeApp } from './app.ts';
import {
  createLocalDevLarkTransport,
  resolveBridgeConfig,
  resolveProjectsFilePath,
  resolveStoragePath,
} from './runtime/bootstrap.ts';
import { loadProjectsFromFile, resolveCodexRuntimeConfigs, type ProjectConfigEntry } from './runtime/codex-config.ts';
import { CodexAppServerClient } from './adapters/codex/app-server-client.ts';
import { resolveConsoleRuntimeConfig, runCodexConsoleSession } from './runtime/codex-console.ts';
import { createProjectRegistry } from './runtime/project-registry.ts';
import { createProjectConfigWatcher } from './runtime/project-config-watcher.ts';
import { resolveFeishuRuntimeConfig } from './runtime/feishu-config.ts';
import { formatCodexCommandResult } from './runtime/codex-command-formatting.ts';
import { createFeishuWebSocketTransport } from './adapters/lark/feishu-websocket.ts';
import { buildStartupNotificationCard } from './adapters/lark/cards.ts';
import { JsonBindingStore } from './storage/json-binding-store.ts';
import { createApprovalService } from './runtime/approval-service.ts';
import { defaultHttpInstance, LoggerLevel, WSClient, EventDispatcher, Client } from '@larksuiteoapi/node-sdk';

export async function patchFeishuMessageCard(
  client: Pick<Client, 'request'>,
  input: { messageId: string; content: string },
): Promise<void> {
  await client.request({
    method: 'PATCH',
    url: `/open-apis/im/v1/messages/${input.messageId}`,
    data: {
      content: input.content,
    },
  });
}

export async function run(): Promise<void> {
  const config = resolveBridgeConfig();
  const storagePath = resolveStoragePath();
  const projectsFilePath = resolveProjectsFilePath();
  const consoleRuntime = resolveConsoleRuntimeConfig();
  const codexRuntimes = resolveCodexRuntimeConfigs() ?? [];
  const feishuRuntime = resolveFeishuRuntimeConfig();
  const approvalService = createApprovalService();
  const bridgeStore = new JsonBindingStore(storagePath);
  let projectRegistryImpl: ReturnType<typeof createProjectRegistry> | null = null;
  let projectConfigWatcher: ReturnType<typeof createProjectConfigWatcher> | null = null;
  let reloadProjectsHandler: (() => Promise<string[]>) | null = null;
  let projectConfigEntries: ProjectConfigEntry[] = loadProjectsFromFile(projectsFilePath) ?? [];
  let app: ReturnType<typeof createBridgeApp> | null = null;
  let restartInFlight = false;

  const { transport, sendToOpenId, sendCardToOpenId } = feishuRuntime !== null && feishuRuntime.wsEnabled
    ? await createFeishuWebSocketTransportFromRuntime(feishuRuntime)
    : { transport: createLocalDevLarkTransport({
        onSend(message) {
          console.log(`[codex-bridge] outbound -> ${message.sessionId}: ${message.text}`);
        },
        onReact(message) {
          console.log(`[codex-bridge] reaction -> ${message.targetMessageId}: ${message.emojiType}`);
        },
      }), sendToOpenId: null, sendCardToOpenId: null };

  app = createBridgeApp({
    config,
    larkTransport: transport,
    bindingStore: bridgeStore,
    approvalService,
    onRestartRequested: async ({ sessionId, senderId }) => {
      if (restartInFlight) {
        await app?.larkAdapter.send({
          targetSessionId: sessionId,
          text: '[codex-bridge] restart already in progress',
        });
        return;
      }

      restartInFlight = true;
      console.log(`[codex-bridge] restart requested by ${senderId} in ${sessionId}`);

      try {
        await app?.stop();
        await closeServer(app?.apiServer ?? null);
        await projectConfigWatcher?.stop();
      } finally {
        process.exit(0);
      }
    },
    projectRegistry: {
      async describeProject(projectInstanceId: string) {
        if (projectRegistryImpl === null) {
          throw new Error('project registry is not initialized');
        }
        return projectRegistryImpl.describeProject(projectInstanceId);
      },
      async getProjectDiagnostics(projectInstanceId: string) {
        if (projectRegistryImpl === null) {
          throw new Error('project registry is not initialized');
        }
        return await projectRegistryImpl.getProjectDiagnostics(projectInstanceId);
      },
      getProjectConfig(projectInstanceId: string) {
        const entry = projectConfigEntries.find((p) => p.projectInstanceId === projectInstanceId);
        return entry ?? null;
      },
      async startThread(projectInstanceId: string, options?: { cwd?: string; force?: boolean }) {
        if (projectRegistryImpl === null) {
          throw new Error('project registry is not initialized');
        }
        return await projectRegistryImpl.startThread(projectInstanceId, options);
      },
      async restoreBinding(projectInstanceId: string, sessionId: string) {
        if (projectRegistryImpl === null) {
          throw new Error('project registry is not initialized');
        }
        await projectRegistryImpl.restoreBinding(projectInstanceId, sessionId);
      },
    },
    reloadProjects: async () => {
      if (reloadProjectsHandler === null) {
        return ['[codex-bridge] project reload is not configured'];
      }

      return await reloadProjectsHandler();
    },
    executeStructuredCodexCommand: async (input) => {
      if (projectRegistryImpl === null) {
        return ['[codex-bridge] codex command support is not configured'];
      }

      const result = await projectRegistryImpl.executeCommand(input.projectInstanceId, {
        method: input.method,
        params: input.params,
      });

      return formatCodexCommandResult(input.method, result);
    },
  });

  const restoreBoundProjects = async () => {
    if (projectRegistryImpl === null) {
      return;
    }

    for (const binding of await app.bindingService.getAllBindings()) {
      await projectRegistryImpl.restoreBinding(binding.projectInstanceId, binding.sessionId);
    }
  };

  if (consoleRuntime !== null) {
    const project = codexRuntimes.find((entry) => entry.projectInstanceId === consoleRuntime.projectInstanceId) ?? {
      projectInstanceId: consoleRuntime.projectInstanceId,
      command: 'codex',
      args: ['app-server'],
      cwd: consoleRuntime.cwd,
      serviceName: 'codex-bridge',
      transport: 'websocket',
      websocketUrl: 'ws://127.0.0.1:4000',
    };

    const client = new CodexAppServerClient({
      command: project.command,
      args: project.args,
      cwd: project.cwd ?? consoleRuntime.cwd,
      clientInfo: {
        name: 'codex-bridge',
        title: 'Codex Bridge',
        version: '0.1.0',
      },
      serviceName: project.serviceName,
      transport: project.transport,
      websocketUrl: project.websocketUrl,
    });
    let printedCodexPrefix = false;
    client.onTextDelta = (text) => {
      if (!printedCodexPrefix) {
        process.stdout.write('codex> ');
        printedCodexPrefix = true;
      }
      process.stdout.write(text);
    };
    client.onTurnCompleted = () => {
      if (printedCodexPrefix) {
        process.stdout.write('\n');
        printedCodexPrefix = false;
      }
    };
    client.onStderr = (text) => {
      process.stderr.write(text);
    };
    client.onNotification = (message) => {
      if (message.method === 'error') {
        const error = message.params?.error;
        const errorMessage = typeof error === 'object' && error !== null && 'message' in error ? String((error as { message?: unknown }).message ?? '') : '';
        if (errorMessage) {
          process.stderr.write(`[codex-bridge] ${errorMessage}\n`);
        }
        return;
      }

      if (message.method === 'turn/started') {
        process.stderr.write('[codex-bridge] turn started\n');
        return;
      }

      if (message.method === 'turn/completed') {
        const turn = message.params?.turn;
        const status =
          typeof turn === 'object' && turn !== null && 'status' in turn ? String((turn as { status?: unknown }).status ?? '') : '';
        if (status) {
          process.stderr.write(`[codex-bridge] turn completed: ${status}\n`);
        }

        const error = typeof turn === 'object' && turn !== null && 'error' in turn ? (turn as { error?: unknown }).error : undefined;
        const errorMessage =
          typeof error === 'object' && error !== null && 'message' in error ? String((error as { message?: unknown }).message ?? '') : '';
        if (errorMessage) {
          process.stderr.write(`[codex-bridge] turn error: ${errorMessage}\n`);
        }
        return;
      }

      if (message.method === 'thread/status/changed') {
        const status = message.params?.status;
        const type = typeof status === 'object' && status !== null && 'type' in status ? String((status as { type?: unknown }).type ?? '') : '';
        if (type) {
          process.stderr.write(`[codex-bridge] thread status: ${type}\n`);
        }
      }
    };

    await runCodexConsoleSession({
      projectInstanceId: project.projectInstanceId,
      cwd: project.cwd ?? consoleRuntime.cwd,
      input: process.stdin,
      output: process.stdout,
      client,
    });
    return;
  }

  projectRegistryImpl = createProjectRegistry({
    getProjectConfig: (projectInstanceId: string) => {
      const entry = projectConfigEntries.find((p) => p.projectInstanceId === projectInstanceId);
      if (!entry) return null;
      return entry;
    },
    createClient: (projectInstanceId: string, config) =>
      new CodexAppServerClient({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        clientInfo: { name: 'codex-bridge', title: 'Codex Bridge', version: '0.1.0' },
        serviceName: config.serviceName,
        transport: config.transport,
        websocketUrl: config.websocketUrl,
      }),
    getLastThread: (projectInstanceId: string, sessionId: string) =>
      bridgeStore.getLastThreadId(projectInstanceId, sessionId),
    setLastThread: (projectInstanceId: string, sessionId: string, threadId: string) =>
      bridgeStore.setLastThreadId(projectInstanceId, sessionId, threadId),
    onServerRequest: async ({ projectInstanceId, request, respond }) => {
      const sessionId = await app.bindingService.getSessionByProject(projectInstanceId);
      if (sessionId === null) {
        return;
      }

      const approvalSummary = [
        request.method === 'item/fileChange/requestApproval'
          ? 'Awaiting file change approval'
          : request.method === 'item/permissions/requestApproval'
            ? 'Awaiting permissions approval'
            : 'Awaiting command approval',
        typeof request.params.command === 'string' && request.params.command.trim() !== ''
          ? request.params.command
          : typeof request.params.reason === 'string' && request.params.reason.trim() !== ''
            ? request.params.reason
            : null,
      ].filter((value): value is string => value !== null).join(': ');

      await app.reportProjectProgress({
        projectId: projectInstanceId,
        sessionId,
        summary: approvalSummary,
      });

      await app.reportProjectStatus({
        projectId: projectInstanceId,
        sessionId,
        status: 'waiting_approval',
        reason: typeof request.params.reason === 'string' ? request.params.reason : 'Approval required',
        source: 'notification',
      });

      const announcement = await approvalService.registerRequest({
        requestId: request.id,
        projectInstanceId,
        sessionId,
        threadId: String(request.params.threadId),
        turnId: String(request.params.turnId),
        itemId: String(request.params.itemId),
        kind:
          request.method === 'item/fileChange/requestApproval'
            ? 'fileChange'
            : request.method === 'item/permissions/requestApproval'
              ? 'permissions'
              : 'commandExecution',
        command: typeof request.params.command === 'string' ? request.params.command : null,
        cwd: typeof request.params.cwd === 'string' ? request.params.cwd : null,
        grantRoot: typeof request.params.grantRoot === 'string' ? request.params.grantRoot : null,
        reason: typeof request.params.reason === 'string' ? request.params.reason : null,
        permissions:
          request.method === 'item/permissions/requestApproval' && request.params.permissions !== undefined
            ? (request.params.permissions as {
                fileSystem?: { read?: string[]; write?: string[] } | null;
                network?: { enabled?: boolean | null } | null;
              })
            : null,
        respond: async (_requestId, result) => {
          await respond(result);
        },
      });

      await app.larkAdapter.sendCard({
        targetSessionId: sessionId,
        card: announcement.card,
        fallbackText: announcement.lines.join('\n'),
      });
    },
    onProgress: async ({ projectInstanceId, sessionId, textDelta, summary }) => {
      await app.reportProjectProgress({
        projectId: projectInstanceId,
        sessionId,
        textDelta,
        summary,
      });
    },
    router: app.router,
    onStatusChange: async ({ projectInstanceId, status, reason, source }) => {
      console.log(
        `[codex-bridge] project status -> project=${projectInstanceId} status=${status} source=${source ?? 'unknown'} reason="${reason ?? ''}"`,
      );
      const sessionId = await app.bindingService.getSessionByProject(projectInstanceId);
      if (sessionId === null) {
        return;
      }

      await app.reportProjectStatus({
        projectId: projectInstanceId,
        sessionId,
        status,
        reason,
        source,
      });
    },
  });

  app.bindingService.onBindingChange(async (e) => {
    await projectRegistryImpl?.onBindingChanged(e);
  });

  projectConfigWatcher = createProjectConfigWatcher({
    filePath: projectsFilePath,
    onProjectsChanged: async (projects) => {
      projectConfigEntries = projects;
      if (projectRegistryImpl === null) {
        return;
      }
      await projectRegistryImpl.reconcileProjectConfigs(projectConfigEntries);
      await restoreBoundProjects();
    },
  });
  reloadProjectsHandler = async () => {
    if (projectConfigWatcher === null) {
      return ['[codex-bridge] project reload is not configured'];
    }

    const projects = await projectConfigWatcher.reload();
    return [`[codex-bridge] reloaded projects: ${projects.length}`];
  };

  projectConfigEntries = await projectConfigWatcher.reload();
  await projectRegistryImpl.reconcileProjectConfigs(projectConfigEntries);

  console.log(`[codex-bridge] project registry active for ${projectConfigEntries.length} project${projectConfigEntries.length === 1 ? '' : 's'}`);

  await app.start();
  await restoreBoundProjects();
  await projectConfigWatcher.start();

  // Send startup notification to specified openId
  const startupNotifyOpenId = process.env.BRIDGE_STARTUP_NOTIFY_OPENID;
  if (sendToOpenId && startupNotifyOpenId) {
    try {
      await sendCardToOpenId(startupNotifyOpenId, buildStartupNotificationCard({
        title: 'codex-bridge',
        bodyMarkdown: '[codex-bridge] 已上线',
      }));
      console.log(`[codex-bridge] startup notification sent to ${startupNotifyOpenId}`);
    } catch (err) {
      console.warn(`[codex-bridge] failed to send startup notification:`, err);
    }
  }

  let keepAlive: NodeJS.Timeout | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const server = app.apiServer;
      server.once('error', reject);
      server.listen(config.server.port, config.server.host, () => {
        console.log(
          `[codex-bridge] listening on http://${config.server.host}:${config.server.port} (storage: ${storagePath})`,
        );
        resolve();
      });
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
    if (code !== 'EPERM' && code !== 'EACCES') {
      throw error;
    }

    console.warn('[codex-bridge] HTTP listen is unavailable in this environment, continuing in dry-run mode');
    keepAlive = setInterval(() => {}, 60_000);
    console.log(
      `[codex-bridge] dry-run active (storage: ${storagePath}); set BRIDGE_PORT/BRIDGE_HOST in a normal environment to enable HTTP`,
    );
  }

  const shutdown = async () => {
    if (keepAlive !== null) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
    await projectConfigWatcher?.stop();
    if (projectRegistryImpl !== null) {
      await projectRegistryImpl.stop();
      projectRegistryImpl = null;
    }
    await app.stop();
    await new Promise<void>((resolve) => {
      app.apiServer.close(() => resolve());
    });
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

async function closeServer(server: ReturnType<typeof createBridgeApp>['apiServer'] | null): Promise<void> {
  if (server === null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function createFeishuWebSocketTransportFromRuntime(feishuRuntime: { appId: string; appSecret: string }) {
  const directHttpInstance = defaultHttpInstance;
  directHttpInstance.defaults.proxy = false;

  const wsClient = new WSClient({
    appId: feishuRuntime.appId,
    appSecret: feishuRuntime.appSecret,
    loggerLevel: LoggerLevel.debug,
    httpInstance: directHttpInstance,
    agent: new https.Agent({ keepAlive: true }),
  });

  const eventDispatcher = new EventDispatcher({});

  const restClient = new Client({
    appId: feishuRuntime.appId,
    appSecret: feishuRuntime.appSecret,
    loggerLevel: LoggerLevel.warn,
    httpInstance: directHttpInstance,
  });

  const transport = createFeishuWebSocketTransport({
    appId: feishuRuntime.appId,
    appSecret: feishuRuntime.appSecret,
    wsClient,
    eventDispatcher,
    sendMessageFn: async ({ receiveId, msgType, content }) => {
      const response = await restClient.im.v1.message.create({
        data: {
          receive_id: receiveId,
          msg_type: msgType,
          content,
        },
        params: {
          receive_id_type: 'chat_id',
        },
      });
      return {
        messageId: response.data?.message_id,
      };
    },
    updateMessageFn: async ({ messageId, msgType, content }) => {
      void msgType;
      await patchFeishuMessageCard(restClient, {
        messageId,
        content: String(content),
      });
    },
    sendReactionFn: async ({ messageId, emojiType }) => {
      await restClient.im.v1.messageReaction.create({
        data: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
        path: {
          message_id: messageId,
        },
      });
    },
    onStderr: (text) => process.stderr.write(text),
    onSend: (message) => console.log(`[codex-bridge] outbound -> ${message.sessionId}: ${message.text}`),
    onReact: (message) => console.log(`[codex-bridge] reaction -> ${message.targetMessageId}: ${message.emojiType}`),
  });

  // Function to send message to open_id
  async function sendToOpenId(openId: string, text: string) {
    await restClient.im.v1.message.create({
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
      params: {
        receive_id_type: 'open_id',
      },
    });
  }

  async function sendCardToOpenId(openId: string, card: { msg_type: 'interactive'; content: string }) {
    await restClient.im.v1.message.create({
      data: {
        receive_id: openId,
        msg_type: card.msg_type,
        content: card.content,
      },
      params: {
        receive_id_type: 'open_id',
      },
    });
  }

  return { transport, sendToOpenId, sendCardToOpenId };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().catch((error) => {
    console.error('[codex-bridge] fatal startup error');
    console.error(error);
    process.exitCode = 1;
  });
}
