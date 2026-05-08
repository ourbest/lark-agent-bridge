import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import https from 'node:https';
import 'dotenv/config';

import { createBridgeApp } from './app.ts';
import { createSshStdioCodexClient } from './adapters/codex/index.ts';
import {
  createLocalDevLarkTransport,
  resolveBridgeConfig,
  resolveProjectsFilePath,
  resolveProjectsRootPath,
  resolveStoragePath,
  resolveAgentIdleTimeoutMs,
} from './runtime/bootstrap.ts';
import { resolveCodexRuntimeConfigs, type ProjectConfigEntry, writeProjectsFile, loadProjectsFromFile } from './runtime/codex-config.ts';
import { CodexAppServerClient } from './adapters/codex/app-server-client.ts';
import { ClaudeCodeClient } from './adapters/claude-code/index.ts';
import { GeminiCliClient } from './adapters/gemini-cli/index.ts';
import { QwenCodeClient } from './adapters/qwen-code/index.ts';
import { OpencodeClient } from './adapters/opencode/index.ts';
import { resolveConsoleRuntimeConfig, runCodexConsoleSession } from './runtime/codex-console.ts';
import { createProjectRegistry } from './runtime/project-registry.ts';
import { AgentStatusManager } from './runtime/agent-status.ts';
import type { ProviderDescriptor } from './runtime/provider-registry.ts';
import { createProjectConfigWatcher } from './runtime/project-config-watcher.ts';
import { createProjectManagementService } from './runtime/project-management-service.ts';
import { loadProjectConfigs } from './runtime/project-discovery.ts';
import { resolveFeishuRuntimeConfig } from './runtime/feishu-config.ts';
import { formatCodexCommandResult } from './runtime/codex-command-formatting.ts';
import { createFeishuWebSocketTransport } from './adapters/lark/feishu-websocket.ts';
import { buildStartupNotificationCard } from './adapters/lark/cards.ts';
import { JsonBindingStore } from './storage/json-binding-store.ts';
import { createApprovalService } from './runtime/approval-service.ts';
import { resolveFunasrRuntimeConfig } from './runtime/funasr-config.ts';
import { LarkChatInfoService } from './services/lark-chat-info-service.ts';
import { defaultHttpInstance, LoggerLevel, WSClient, EventDispatcher, Client } from '@larksuiteoapi/node-sdk';
import { createFileDownloadHandler } from './adapters/lark/file-downloader.ts';
import { createFunasrTranscriptionService } from './services/funasr-transcription-service.ts';

/**
 * Extract a human-readable command string from Claude Code request params.
 * Claude Code sends tool input as an object (e.g., { command: "ls -la" } for Bash).
 */
function extractCommandFromParams(params: Record<string, unknown>): string | null {
  // First check if there's a direct command param (Codex protocol)
  if (typeof params.command === 'string' && params.command.trim() !== '') {
    return params.command;
  }

  // Claude Code sends input as an object with tool-specific fields
  const input = params.input;
  if (typeof input === 'object' && input !== null) {
    const inputRecord = input as Record<string, unknown>;

    // Bash: { command: "..." }
    if (typeof inputRecord.command === 'string') {
      return inputRecord.command;
    }

    // Edit: { file_path: "...", old_string: "...", new_string: "..." }
    if (typeof inputRecord.file_path === 'string') {
      const ops: string[] = [];
      if (typeof inputRecord.old_string === 'string') {
        ops.push(`- "${inputRecord.old_string.slice(0, 50)}"`);
      }
      if (typeof inputRecord.new_string === 'string') {
        ops.push(`+ "${inputRecord.new_string.slice(0, 50)}"`);
      }
      if (ops.length > 0) {
        return `edit ${inputRecord.file_path}: ${ops.join(' ')}`;
      }
      return `edit ${inputRecord.file_path}`;
    }

    // Read: { file_path: "..." }
    if (typeof inputRecord.file_path === 'string') {
      return `read ${inputRecord.file_path}`;
    }

    // Grep: { path: "...", pattern: "..." }
    if (typeof inputRecord.pattern === 'string') {
      return `grep "${inputRecord.pattern}" ${typeof inputRecord.path === 'string' ? inputRecord.path : ''}`.trim();
    }

    // Fallback: stringify the input object (truncated)
    const str = JSON.stringify(inputRecord);
    return str.length > 100 ? str.slice(0, 100) + '...' : str;
  }

  return null;
}

export function resolveStartupNotificationTitle(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.BRIDGE_APP_NAME?.trim();
  return value === undefined || value === '' ? 'lark-agent-bridge' : value;
}

export async function patchFeishuMessageCard(
  client: Pick<Client, 'request'>,
  input: { messageId: string; content: string },
): Promise<void> {
  await client.request({
    method: 'PATCH',
    url: `/open-apis/im/v1/messages/${input.messageId}`,
    params: {
      msg_type: 'interactive',
    },
    data: {
      content: input.content,
    },
  });
}

type ExecuteCodexCommand = (projectInstanceId: string, input: { method: string; params: Record<string, unknown> }) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readThreadIdentifier(result: unknown): string | null {
  if (typeof result === 'string' && result.trim() !== '') {
    return result;
  }

  if (isRecord(result)) {
    if (typeof result.id === 'string' && result.id.trim() !== '') {
      return result.id;
    }

    if (typeof result.threadId === 'string' && result.threadId.trim() !== '') {
      return result.threadId;
    }
  }

  return null;
}

function isSparseThreadReadResult(result: unknown): boolean {
  if (typeof result === 'string') {
    return result.trim() !== '';
  }

  if (!isRecord(result)) {
    return false;
  }

  const keys = Object.keys(result);
  if (keys.length === 0 || keys.length > 2) {
    return false;
  }

  return keys.every((key) => key === 'id' || key === 'threadId') && readThreadIdentifier(result) !== null;
}

function readThreadItems(result: unknown): unknown[] | null {
  if (Array.isArray(result)) {
    return result;
  }

  if (!isRecord(result)) {
    return null;
  }

  if (Array.isArray(result.data)) {
    return result.data;
  }

  if (Array.isArray(result.threads)) {
    return result.threads;
  }

  return null;
}

function findThreadDetails(result: unknown, threadId: string): Record<string, unknown> | null {
  const items = readThreadItems(result);
  if (items === null) {
    return null;
  }

  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }

    if (typeof item.id === 'string' && item.id === threadId) {
      return item;
    }

    if (typeof item.threadId === 'string' && item.threadId === threadId) {
      return item;
    }
  }

  return null;
}

function mergeThreadReadResult(result: unknown, details: Record<string, unknown>, threadId: string): Record<string, unknown> {
  if (isRecord(result)) {
    const id = typeof result.id === 'string' && result.id.trim() !== '' ? result.id : typeof details.id === 'string' && details.id.trim() !== '' ? details.id : threadId;
    return {
      ...details,
      ...result,
      id,
    };
  }

  return {
    ...details,
    id: threadId,
  };
}

export async function formatCodexCommandResultWithFallback(input: {
  projectInstanceId: string;
  method: string;
  result: unknown;
  executeCommand: ExecuteCodexCommand;
  threadListParams?: Record<string, unknown>;
}): Promise<string[]> {
  if (input.method !== 'thread/read' || !isSparseThreadReadResult(input.result)) {
    return formatCodexCommandResult(input.method, input.result);
  }

  const threadId = readThreadIdentifier(input.result);
  if (threadId === null) {
    return formatCodexCommandResult(input.method, input.result);
  }

  try {
    const threadListResult = await input.executeCommand(input.projectInstanceId, {
      method: 'thread/list',
      params: input.threadListParams ?? {},
    });
    const threadDetails = findThreadDetails(threadListResult, threadId);
    if (threadDetails !== null) {
      return formatCodexCommandResult(input.method, mergeThreadReadResult(input.result, threadDetails, threadId));
    }
  } catch {
    // Fall back to the raw thread/read result when the lookup fails.
  }

  return formatCodexCommandResult(input.method, input.result);
}

export async function run(): Promise<void> {
  const config = resolveBridgeConfig();
  const storagePath = resolveStoragePath();
  const projectsFilePath = resolveProjectsFilePath();
  const projectsRootPath = resolveProjectsRootPath();
  const consoleRuntime = resolveConsoleRuntimeConfig();
  const codexRuntimes = resolveCodexRuntimeConfigs() ?? [];
  const feishuRuntime = resolveFeishuRuntimeConfig();
  const funasrRuntime = resolveFunasrRuntimeConfig();
  const approvalService = createApprovalService();
  const bridgeStore = new JsonBindingStore(storagePath);
  const agentStatusManager = new AgentStatusManager();
  let projectRegistryImpl: ReturnType<typeof createProjectRegistry> | null = null;
  let projectConfigWatcher: ReturnType<typeof createProjectConfigWatcher> | null = null;
  let projectManagementService: ReturnType<typeof createProjectManagementService> | null = null;
  let reloadProjectsHandler: (() => Promise<string[]>) | null = null;
  let projectConfigEntries: ProjectConfigEntry[] = loadProjectConfigs({
    projectsFilePath,
    projectsRoot: projectsRootPath,
  });
  let app: ReturnType<typeof createBridgeApp> | null = null;
  let restartInFlight = false;

  const transportBundle = feishuRuntime !== null && feishuRuntime.wsEnabled
    ? await createFeishuWebSocketTransportFromRuntime(feishuRuntime)
    : { transport: createLocalDevLarkTransport({
        onSend(message) {
          console.log(`[lark-agent-bridge] outbound -> ${message.sessionId}: ${message.text}`);
        },
        onReact(message) {
          console.log(`[lark-agent-bridge] reaction -> ${message.targetMessageId}: ${message.emojiType}`);
        },
      }), sendToOpenId: null, sendCardToOpenId: null, downloadFile: null, restClient: null };
  const { transport, sendToOpenId, sendCardToOpenId, downloadFile, restClient } = transportBundle;
  const larkChatInfoService = restClient === null ? undefined : new LarkChatInfoService(restClient);
  const funasrTranscriber = funasrRuntime === null
    ? undefined
    : createFunasrTranscriptionService(funasrRuntime);

  app = createBridgeApp({
    config,
    larkTransport: transport,
    bindingStore: bridgeStore,
    larkChatInfoService,
    approvalService,
    agentStatusManager,
    downloadFile: downloadFile ?? undefined,
    transcribeAudio: funasrTranscriber === undefined
      ? undefined
      : async (input) => await funasrTranscriber.transcribeAudioFile({
          filePath: input.filePath,
          fileName: input.fileName,
        }),
    onRestartRequested: async ({ sessionId, senderId }) => {
      if (restartInFlight) {
        await app?.larkAdapter.send({
          targetSessionId: sessionId,
          text: '[lark-agent-bridge] restart already in progress',
        });
        return;
      }

      restartInFlight = true;
      console.log(`[lark-agent-bridge] restart requested by ${senderId} in ${sessionId}`);

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
      async listProjects() {
        if (projectRegistryImpl === null) {
          throw new Error('project registry is not initialized');
        }

        return await Promise.all(
          projectConfigEntries.map(async (entry) => {
            const state = await projectRegistryImpl.describeProject(entry.projectInstanceId);
            const activeProvider = await projectRegistryImpl.getActiveProvider(entry.projectInstanceId);
            const providers = await projectRegistryImpl.getProjectProviders(entry.projectInstanceId);

            return {
              projectInstanceId: entry.projectInstanceId,
              cwd: entry.cwd,
              activeProvider,
              providers,
              configured: state.configured,
              active: state.active,
              removed: state.removed,
            };
          }),
        );
      },
      async getProjectProviders(projectInstanceId: string) {
        if (projectRegistryImpl === null) {
          throw new Error('project registry is not initialized');
        }

        return await projectRegistryImpl.getProjectProviders(projectInstanceId);
      },
      async getActiveProvider(projectInstanceId: string) {
        if (projectRegistryImpl === null) {
          throw new Error('project registry is not initialized');
        }

        return await projectRegistryImpl.getActiveProvider(projectInstanceId);
      },
      async setActiveProvider(projectInstanceId: string, provider: string) {
        if (projectRegistryImpl === null) {
          throw new Error('project registry is not initialized');
        }

        await projectRegistryImpl.setActiveProvider(projectInstanceId, provider);
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
      async updateProjectConfig(projectInstanceId: string, input: { model?: string | null; permissionMode?: string | null }) {
        const entry = projectConfigEntries.find((p) => p.projectInstanceId === projectInstanceId);
        if (entry === undefined) {
          return null;
        }

        if (input.model !== undefined) {
          const normalizedModel = input.model.trim();
          if (normalizedModel === '') {
            delete entry.model;
          } else {
            entry.model = normalizedModel;
          }
        }

        if (input.permissionMode !== undefined) {
          entry.permissionMode = input.permissionMode;
        }

        writeProjectsFile(projectsFilePath, projectConfigEntries);

        if (projectRegistryImpl !== null) {
          await projectRegistryImpl.reconcileProjectConfigs(projectConfigEntries);
        }

        return entry;
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
        return ['[lark-agent-bridge] project reload is not configured'];
      }

      return await reloadProjectsHandler();
    },
    addLocalProject: async (input) => {
      if (projectManagementService === null) {
        throw new Error('project management service is not initialized');
      }
      return await projectManagementService.addLocalProject(input);
    },
    addRemoteProject: async (input) => {
      if (projectManagementService === null) {
        throw new Error('project management service is not initialized');
      }
      return await projectManagementService.addRemoteProject(input);
    },
    executeStructuredCodexCommand: async (input) => {
      if (projectRegistryImpl === null) {
        return ['[lark-agent-bridge] codex command support is not configured'];
      }

      const result = await projectRegistryImpl.executeCommand(input.projectInstanceId, {
        method: input.method,
        params: input.params,
      });

      const projectConfig = projectConfigEntries.find((entry) => entry.projectInstanceId === input.projectInstanceId) ?? null;
      return await formatCodexCommandResultWithFallback({
        projectInstanceId: input.projectInstanceId,
        method: input.method,
        result,
        executeCommand: async (projectInstanceId, commandInput) => {
          return await projectRegistryImpl.executeCommand(projectInstanceId, commandInput);
        },
        threadListParams:
          input.method === 'thread/read' && projectConfig?.cwd !== undefined
            ? { cwd: projectConfig.cwd }
            : {},
      });
    },
  });

  if (consoleRuntime !== null) {
    const project = codexRuntimes.find((entry) => entry.projectInstanceId === consoleRuntime.projectInstanceId) ?? {
      projectInstanceId: consoleRuntime.projectInstanceId,
      command: 'codex',
      args: ['app-server'],
      cwd: consoleRuntime.cwd,
      serviceName: 'lark-agent-bridge',
      transport: 'websocket',
      websocketUrl: 'ws://127.0.0.1:4000',
    };

    const client = new CodexAppServerClient({
      command: project.command,
      args: project.args,
      cwd: project.cwd ?? consoleRuntime.cwd,
      clientInfo: {
        name: 'lark-agent-bridge',
        title: 'Codex Bridge',
        version: '0.2.0-dev',
      },
      getModel: () => project.model,
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
          process.stderr.write(`[lark-agent-bridge] ${errorMessage}\n`);
        }
        return;
      }

      if (message.method === 'turn/started') {
        process.stderr.write('[lark-agent-bridge] turn started\n');
        return;
      }

      if (message.method === 'turn/completed') {
        const turn = message.params?.turn;
        const status =
          typeof turn === 'object' && turn !== null && 'status' in turn ? String((turn as { status?: unknown }).status ?? '') : '';
        if (status) {
          process.stderr.write(`[lark-agent-bridge] turn completed: ${status}\n`);
        }

        const error = typeof turn === 'object' && turn !== null && 'error' in turn ? (turn as { error?: unknown }).error : undefined;
        const errorMessage =
          typeof error === 'object' && error !== null && 'message' in error ? String((error as { message?: unknown }).message ?? '') : '';
        if (errorMessage) {
          process.stderr.write(`[lark-agent-bridge] turn error: ${errorMessage}\n`);
        }
        return;
      }

      if (message.method === 'thread/status/changed') {
        const status = message.params?.status;
        const type = typeof status === 'object' && status !== null && 'type' in status ? String((status as { type?: unknown }).type ?? '') : '';
        if (type) {
          process.stderr.write(`[lark-agent-bridge] thread status: ${type}\n`);
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
    bridgeStateStore: bridgeStore,
    onSystemInit: (projectInstanceId, data) => {
      console.log(`[main] onSystemInit: projectInstanceId=${projectInstanceId} data=${JSON.stringify(data)}`);
      agentStatusManager.updateFromSystemInit(projectInstanceId, data);
    },
    getProjectConfig: (projectInstanceId: string) => {
      const entry = projectConfigEntries.find((p) => p.projectInstanceId === projectInstanceId);
      if (!entry) return null;
      return entry;
    },
    createClient: (projectInstanceId: string, config, provider?: ProviderDescriptor) => {
      let command = typeof config.command === 'string' && config.command.trim() !== '' ? config.command.trim() : 'codex';
      const kind = provider?.kind ?? 'codex';
      // Each provider kind defaults to its own command if project uses 'codex'
      if (command === 'codex') {
        if (kind === 'qwen') {
          command = 'qwen';
        }
      }
      const args = Array.isArray(config.args) && config.args.length > 0 ? config.args : ['app-server'];
      const serviceName = typeof config.serviceName === 'string' && config.serviceName.trim() !== '' ? config.serviceName.trim() : 'lark-agent-bridge';
      const providerId = provider?.id ?? projectInstanceId;
      const providerTransport = provider?.transport ?? (config.transport === 'stdio' ? 'stdio' : 'websocket');
      const providerCwd =
        typeof provider?.remoteCwd === 'string' && provider.remoteCwd.trim() !== ''
          ? provider.remoteCwd.trim()
          : config.cwd;
      const sshHost = typeof provider?.sshHost === 'string' ? provider.sshHost.trim() : '';
      const sshCommand = typeof provider?.sshCommand === 'string' ? provider.sshCommand.trim() : '';
      const websocketUrl =
        typeof provider?.websocketUrl === 'string' && provider.websocketUrl.trim() !== ''
          ? provider.websocketUrl.trim()
          : typeof config.websocketUrl === 'string' && config.websocketUrl.trim() !== ''
            ? config.websocketUrl.trim()
            : 'ws://127.0.0.1:4000';

      if (provider !== undefined) {
        if (provider.kind === 'cc' && provider.transport === 'ssh+stdio') {
          if (sshHost === '') {
            throw new Error(`Provider ${providerId} is missing sshHost`);
          }
          if (sshCommand === '') {
            throw new Error(`Provider ${providerId} is missing sshCommand`);
          }

          return createSshStdioCodexClient({
            command,
            args,
            cwd: providerCwd,
            clientInfo: { name: 'lark-agent-bridge', title: 'Codex Bridge', version: '0.2.0-dev' },
            getModel: () => config.model ?? projectConfigEntries.find((p) => p.projectInstanceId === projectInstanceId)?.model,
            serviceName,
            transport: 'stdio',
            sshHost,
            sshPort: provider.sshPort,
            sshUser: provider.sshUser,
            sshIdentityFile: provider.sshIdentityFile,
            sshCommand,
            sshArgs: provider.sshArgs,
          });
        }

        if (provider.kind === 'codex') {
          return new CodexAppServerClient({
            command,
            args,
            cwd: providerCwd,
            clientInfo: { name: 'lark-agent-bridge', title: 'Codex Bridge', version: '0.2.0-dev' },
            getModel: () => config.model ?? projectConfigEntries.find((p) => p.projectInstanceId === projectInstanceId)?.model,
            serviceName,
            transport: providerTransport === 'ssh+stdio' ? 'websocket' : providerTransport,
            websocketUrl,
          });
        }

        if (provider.kind === 'cc') {
          return new ClaudeCodeClient({
            command: 'claude',
            args: ['--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--verbose'],
            cwd: providerCwd,
          });
        }

        if (provider.kind === 'qwen') {
          return new QwenCodeClient({
            cwd: config.cwd,
            model: config.model,
            pathToQwenExecutable: config.qwenExecutable ?? (command !== 'codex' ? command : undefined),
          });
        }

        if (provider.kind === 'gemini') {
          const geminiCommand =
            typeof config.command === 'string' && config.command.trim() !== '' && config.command.trim() !== 'codex'
              ? config.command.trim()
              : 'gemini';
          const geminiArgs =
            Array.isArray(config.args) && !(config.args.length === 1 && config.args[0] === 'app-server')
              ? config.args
              : [];
          return new GeminiCliClient({
            command: geminiCommand,
            args: geminiArgs,
            cwd: config.cwd,
          });
        }
      }

      if (config.adapterType === 'opencode') {
        return new OpencodeClient({
          projectInstanceId,
          cwd: config.cwd,
          command: config.opencodeCommand ?? 'opencode',
          hostname: config.opencodeHostname ?? '127.0.0.1',
          port: config.opencodePort,
          extraArgs: config.opencodeExtraArgs ?? [],
          username: config.opencodeUsername,
          password: config.opencodePassword,
        });
      }
      if (config.adapterType === 'claude-code') {
        return new ClaudeCodeClient({
          command: 'claude',
          args: ['--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--verbose'],
          cwd: config.cwd,
        });
      }
      if (config.adapterType === 'qwen-code') {
        return new QwenCodeClient({
          cwd: config.cwd,
          model: config.model,
          pathToQwenExecutable: config.qwenExecutable ?? (command !== 'codex' ? command : undefined),
        });
      }
      if (config.adapterType === 'gemini-cli') {
        const geminiCommand =
          typeof config.command === 'string' && config.command.trim() !== '' && config.command.trim() !== 'codex'
            ? config.command.trim()
            : 'gemini';
        const geminiArgs =
          Array.isArray(config.args) && !(config.args.length === 1 && config.args[0] === 'app-server')
            ? config.args
            : [];
        return new GeminiCliClient({
          command: geminiCommand,
          args: geminiArgs,
          cwd: config.cwd,
        });
      }
      return new CodexAppServerClient({
        command,
        args,
        cwd: config.cwd,
        clientInfo: { name: 'lark-agent-bridge', title: 'Codex Bridge', version: '0.2.0-dev' },
        getModel: () => config.model ?? projectConfigEntries.find((p) => p.projectInstanceId === projectInstanceId)?.model,
        serviceName,
        transport: config.transport,
        websocketUrl,
      });
    },
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
        command: extractCommandFromParams(request.params),
        cwd: typeof request.params.cwd === 'string' ? request.params.cwd : null,
        grantRoot: typeof request.params.grantRoot === 'string' ? request.params.grantRoot : null,
        reason: typeof request.params.reason === 'string' ? request.params.reason : null,
        toolName: typeof request.params.tool_name === 'string' ? request.params.tool_name : null,
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

      if (announcement.card !== null) {
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

        const sent = await app.larkAdapter.sendCard({
          targetSessionId: sessionId,
          card: announcement.card,
          fallbackText: announcement.lines.join('\n'),
        });

        if (sent?.messageId !== undefined && sent.messageId !== '') {
          await approvalService.attachCardMessage(request.id, sent.messageId);
        }
      }
    },
    onProgress: async ({ projectInstanceId, sessionId, textDelta, summary }) => {
      await app.reportProjectProgress({
        projectId: projectInstanceId,
        sessionId,
        textDelta,
        summary,
      });
    },
    onToolUse: ({ projectInstanceId, toolName, input, output, status, timestamp }) => {
      console.log(`[lark-agent-bridge] tool/use: project=${projectInstanceId} tool=${toolName} status=${status}`);
      agentStatusManager.addToolCall(projectInstanceId, {
        timestamp,
        toolName,
        input,
        output,
        status,
      });
    },
    router: app.router,
    onStatusChange: async ({ projectInstanceId, status, reason, source }) => {
      console.log(
        `[lark-agent-bridge] project status -> project=${projectInstanceId} status=${status} source=${source ?? 'unknown'} reason="${reason ?? ''}"`,
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
    agentIdleTimeoutMs: resolveAgentIdleTimeoutMs(),
  });

  app.bindingService.onBindingChange(async (e) => {
    await projectRegistryImpl?.onBindingChanged(e);
  });

  projectConfigWatcher = createProjectConfigWatcher({
    filePath: projectsFilePath,
    readProjects: () => loadProjectConfigs({
      projectsFilePath,
      projectsRoot: projectsRootPath,
    }),
    onProjectsChanged: async (projects) => {
      projectConfigEntries = projects;
      if (projectRegistryImpl === null) {
        return;
      }
      await projectRegistryImpl.reconcileProjectConfigs(projectConfigEntries);
      // Do NOT restore bindings here - providers are started lazily on first message.
      // If bindings need to be re-established after a config change, the normal
      // message routing flow will handle it via restoreBinding.
    },
  });
  reloadProjectsHandler = async () => {
    if (projectConfigWatcher === null) {
      return ['[lark-agent-bridge] project reload is not configured'];
    }

    const projects = await projectConfigWatcher.reload();
    return [`[lark-agent-bridge] reloaded projects: ${projects.length}`];
  };

  projectManagementService = createProjectManagementService({
    configWatcher: projectConfigWatcher,
    projectsFilePath,
    getExplicitProjects: () => {
      return loadProjectsFromFile(projectsFilePath, { homeDir: process.env.HOME }) ?? [];
    },
  });

  projectConfigEntries = await projectConfigWatcher.reload();
  await projectRegistryImpl.reconcileProjectConfigs(projectConfigEntries);

  console.log(`[lark-agent-bridge] project registry active for ${projectConfigEntries.length} project${projectConfigEntries.length === 1 ? '' : 's'}`);

  await app.start();
  // Restore projects lazily on first message, not at startup.
  // restoreBoundProjects is removed here so no provider auto-starts.
  // When a message arrives for a bound project, the router calls
  // restoreBinding which handles restore lazily (onBindingChanged with restore=true).
  await projectConfigWatcher.start();

  // Send startup notification to specified openId
  const startupNotifyOpenId = process.env.BRIDGE_STARTUP_NOTIFY_OPENID;
  const appDisplayName = resolveStartupNotificationTitle();
  if (sendToOpenId && startupNotifyOpenId) {
    try {
      await sendCardToOpenId(startupNotifyOpenId, buildStartupNotificationCard({
        title: appDisplayName,
        bodyMarkdown: `[${appDisplayName}] 已上线`,
      }));
      console.log(`[lark-agent-bridge] startup notification sent to ${startupNotifyOpenId}`);
    } catch (err) {
      console.warn(`[lark-agent-bridge] failed to send startup notification:`, err);
    }
  }

  // File watcher for ~/lark folder - sends files to startupNotifyOpenId
  if (process.env.BRIDGE_FILE_WATCH_ENABLED === '1' && startupNotifyOpenId) {
    const { FileWatcherService } = await import('./runtime/file-watcher.ts');
    const watchDir = process.env.BRIDGE_FILE_WATCH_DIR
      ? path.resolve(os.homedir(), process.env.BRIDGE_FILE_WATCH_DIR.replace(/^~\//, ''))
      : path.join(os.homedir(), 'lark');

    const fileWatcher = new FileWatcherService({
      enabled: true,
      watchDir,
      openId: startupNotifyOpenId,
      pollIntervalMs: 2000,
      maxWaitMs: 300_000,
    }, {
      sendFileFn: async ({ receiveId, filePath }) => {
        const fileName = path.basename(filePath);
        const uploadResponse = await restClient.im.v1.file.create({
          data: {
            file_type: 'stream',
            file_name: fileName,
            file: createReadStream(filePath),
          },
        });
        const fileKey = uploadResponse?.file_key;
        if (fileKey === undefined || fileKey === '') {
          throw new Error('Feishu file upload did not return a file_key');
        }
        await restClient.im.v1.message.create({
          data: {
            receive_id: receiveId,
            msg_type: 'file',
            content: JSON.stringify({ file_key: fileKey }),
          },
          params: {
            receive_id_type: 'open_id',
          },
        });
      },
    });
    fileWatcher.start();
  }

  let keepAlive: NodeJS.Timeout | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      const server = app.apiServer;
      server.once('error', reject);
      server.listen(config.server.port, config.server.host, () => {
        console.log(
          `[lark-agent-bridge] listening on http://${config.server.host}:${config.server.port} (storage: ${storagePath})`,
        );
        resolve();
      });
    });
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
    if (code !== 'EPERM' && code !== 'EACCES') {
      throw error;
    }

    console.warn('[lark-agent-bridge] HTTP listen is unavailable in this environment, continuing in dry-run mode');
    keepAlive = setInterval(() => {}, 60_000);
    console.log(
      `[lark-agent-bridge] dry-run active (storage: ${storagePath}); set BRIDGE_PORT/BRIDGE_HOST in a normal environment to enable HTTP`,
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

  const downloadHandler = createFileDownloadHandler(restClient);

  // Fetch bot open_id to detect when bot is @mentioned vs other users
  let botOpenId: string | undefined;
  try {
    const botInfoResponse = await restClient.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    }) as { bot?: { open_id?: string } };
    botOpenId = botInfoResponse.bot?.open_id;
    console.log(`[main] bot open_id: ${botOpenId ?? 'unknown'}`);
  } catch (error) {
    console.warn(`[main] failed to fetch bot info: ${error}`);
  }

  const transport = createFeishuWebSocketTransport({
    appId: feishuRuntime.appId,
    appSecret: feishuRuntime.appSecret,
    botOpenId,
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
    sendFileFn: async ({ receiveId, filePath, fileName }) => {
      const uploadResponse = await restClient.im.v1.file.create({
        data: {
          file_type: 'stream',
          file_name: fileName,
          file: createReadStream(filePath),
        },
      });

      const fileKey = uploadResponse?.file_key;
      if (fileKey === undefined || fileKey === '') {
        throw new Error('Feishu file upload did not return a file_key');
      }

      const response = await restClient.im.v1.message.create({
        data: {
          receive_id: receiveId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
        params: {
          receive_id_type: 'chat_id',
        },
      });

      return {
        messageId: response.data?.message_id,
      };
    },
    updateMessageFn: async ({ sessionId, messageId, content }) => {
      void sessionId;
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
    onSend: (message) => console.log(`[lark-agent-bridge] outbound -> ${message.sessionId}: ${message.text}`),
    onSendFile: (message) => console.log(`[lark-agent-bridge] outbound file -> ${message.sessionId}: ${message.fileName}`),
    onReact: (message) => console.log(`[lark-agent-bridge] reaction -> ${message.targetMessageId}: ${message.emojiType}`),
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

  return { transport, sendToOpenId, sendCardToOpenId, downloadFile: downloadHandler, restClient };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().catch((error) => {
    console.error('[lark-agent-bridge] fatal startup error');
    console.error(error);
    process.exitCode = 1;
  });
}
