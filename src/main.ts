import { pathToFileURL } from 'node:url';
import 'dotenv/config';

import { createBridgeApp } from './app.ts';
import { createLocalDevLarkTransport, resolveBridgeConfig, resolveStoragePath } from './runtime/bootstrap.ts';
import { loadProjectsFromFile, resolveCodexRuntimeConfigs, type ProjectConfigEntry } from './runtime/codex-config.ts';
import { CodexAppServerClient } from './adapters/codex/app-server-client.ts';
import { resolveConsoleRuntimeConfig, runCodexConsoleSession } from './runtime/codex-console.ts';
import { createProjectRegistry } from './runtime/project-registry.ts';
import { resolveFeishuRuntimeConfig } from './runtime/feishu-config.ts';
import { createFeishuWebSocketTransport } from './adapters/lark/feishu-websocket.ts';
import { JsonBindingStore } from './storage/json-binding-store.ts';

export async function run(): Promise<void> {
  const config = resolveBridgeConfig();
  const storagePath = resolveStoragePath();
  const consoleRuntime = resolveConsoleRuntimeConfig();
  const codexRuntimes = resolveCodexRuntimeConfigs() ?? [];
  const feishuRuntime = resolveFeishuRuntimeConfig();

  const transport = feishuRuntime !== null && feishuRuntime.wsEnabled
    ? await createFeishuWebSocketTransportFromRuntime(feishuRuntime)
    : createLocalDevLarkTransport({
        onSend(message) {
          console.log(`[codex-bridge] outbound -> ${message.sessionId}: ${message.text}`);
        },
      });

  const app = createBridgeApp({
    config,
    larkTransport: transport,
    bindingStore: new JsonBindingStore(storagePath),
  });

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

  let codexProjectRegistry = null;
  const projectConfigEntries: ProjectConfigEntry[] = loadProjectsFromFile('projects.json') ?? [];
  if (projectConfigEntries.length > 0) {
    const projectRegistry = createProjectRegistry({
      getProjectConfig: (projectInstanceId: string) => {
        const entry = projectConfigEntries.find((p) => p.projectInstanceId === projectInstanceId);
        if (!entry || !entry.websocketUrl) return null;
        return { projectInstanceId: entry.projectInstanceId, websocketUrl: entry.websocketUrl };
      },
      createClient: (projectInstanceId: string, websocketUrl: string) =>
        new CodexAppServerClient({
          command: 'codex',
          args: ['app-server'],
          clientInfo: { name: 'codex-bridge', title: 'Codex Bridge', version: '0.1.0' },
          serviceName: 'codex-bridge',
          transport: 'websocket',
          websocketUrl,
        }),
      router: app.router,
    });

    app.bindingService.onBindingChange((e) => {
      void projectRegistry.onBindingChanged(e);
    });

    for (const binding of app.bindingService.getAllBindings()) {
      await projectRegistry.onBindingChanged({ type: 'bound', projectId: binding.projectInstanceId, sessionId: binding.sessionId });
    }

    codexProjectRegistry = projectRegistry;
    console.log(`[codex-bridge] project registry active for ${projectConfigEntries.length} project${projectConfigEntries.length === 1 ? '' : 's'}`);
  }

  await app.start();

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
    if (codexProjectRegistry !== null) {
      await codexProjectRegistry.stop();
      codexProjectRegistry = null;
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

async function createFeishuWebSocketTransportFromRuntime(feishuRuntime: { appId: string; appSecret: string }) {
  const lark = await import('@larksuiteoapi/node-sdk');

  const wsClient = new lark.WSClient({
    appId: feishuRuntime.appId,
    appSecret: feishuRuntime.appSecret,
    loggerLevel: lark.LoggerLevel.debug,
  });

  const eventDispatcher = new lark.EventDispatcher({});

  const restClient = new lark.Client({
    appId: feishuRuntime.appId,
    appSecret: feishuRuntime.appSecret,
    loggerLevel: lark.LoggerLevel.warn,
  });

  return createFeishuWebSocketTransport({
    appId: feishuRuntime.appId,
    appSecret: feishuRuntime.appSecret,
    wsClient,
    eventDispatcher,
    sendMessageFn: async ({ receiveId, msgType, content }) => {
      await restClient.im.v1.message.create({
        data: {
          receive_id: receiveId,
          msg_type: msgType,
          content,
        },
        params: {
          receive_id_type: 'chat_id',
        },
      });
    },
    onStderr: (text) => process.stderr.write(text),
    onSend: (message) => console.log(`[codex-bridge] outbound -> ${message.sessionId}: ${message.text}`),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().catch((error) => {
    console.error('[codex-bridge] fatal startup error');
    console.error(error);
    process.exitCode = 1;
  });
}
