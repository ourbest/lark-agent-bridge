import type { CodexProjectClient, SystemInitData } from './codex-project.ts';
import type { CodexServerRequest } from '../adapters/codex/app-server-client.ts';
import type { BridgeRouter } from '../core/router/router.ts';
import type { BridgeStateStore } from '../storage/binding-store.ts';
import type { Thread } from './thread-manager.ts';
import { ProviderManager } from './provider-manager.ts';
import type { ProviderDescriptor, ProviderKind, ProviderState } from './provider-registry.ts';
import type { PermissionMode } from './project-config.ts';

export interface ProjectConfig {
  projectInstanceId: string;
  command: string;
  args: string[];
  cwd?: string;
  model?: string;
  permissionMode?: string;
  serviceName: string;
  transport: 'stdio' | 'websocket';
  websocketUrl?: string;
  adapterType?: 'codex' | 'claude-code' | 'qwen-code' | 'opencode' | 'gemini-cli';
  qwenExecutable?: string;
  providers?: ProviderDescriptor[];
  activeProvider?: string;
  /**
   * OpenCode (opencode serve) 相关配置。
   *
   * - 当 adapterType = "opencode" 时，bridge 会在首次绑定/首次请求时拉起 `opencode serve`
   * - hostname/port 用于确定 baseUrl；若不提供 port，将自动分配空闲端口（仅在进程存活期内有效）
   * - username/password 会通过 HTTP Basic Auth 传递（同时也会作为 OPENCODE_SERVER_* 环境变量注入到 serve 进程）
   */
  opencodeHostname?: string;
  opencodePort?: number;
  opencodeCommand?: string;
  opencodeExtraArgs?: string[];
  opencodeUsername?: string;
  opencodePassword?: string;
}

export interface ProjectRegistryOptions {
  getProjectConfig: (projectInstanceId: string) => ProjectConfig | null;
  createClient: (projectInstanceId: string, config: ProjectConfig, provider?: ProviderDescriptor) => CodexProjectClient;
  bridgeStateStore?: BridgeStateStore;
  allocateWebSocketPort?: () => Promise<number>;
  router?: Pick<BridgeRouter, 'registerProjectHandler'>;
  onStatusChange?: (input: {
    projectInstanceId: string;
    status: 'working' | 'waiting_approval' | 'done' | 'failed';
    reason?: string | null;
    source?: ProjectDiagnostics['source'];
  }) => void | Promise<void>;
  onProgress?: (input: {
    projectInstanceId: string;
    sessionId: string;
    textDelta?: string;
    summary?: string;
  }) => void | Promise<void>;
  onToolUse?: (input: {
    projectInstanceId: string;
    toolName: string;
    input?: string;
    output?: string;
    status: 'started' | 'completed' | 'failed';
    timestamp: number;
  }) => void | Promise<void>;
  onServerRequest?: (input: {
    projectInstanceId: string;
    request: CodexServerRequest;
    respond: (result: unknown) => Promise<void>;
  }) => Promise<void>;
  onSystemInit?: (projectInstanceId: string, data: SystemInitData) => void;
  getLastThread?: (projectInstanceId: string, sessionId: string) => string | null;
  setLastThread?: (projectInstanceId: string, sessionId: string, threadId: string) => void;
}

export interface ProjectRegistry {
  onBindingChanged(
    event: { type: string; projectId?: string; sessionId?: string },
    options?: { restore?: boolean },
  ): Promise<void>;
  restoreBinding(projectInstanceId: string, sessionId: string): Promise<void>;
  reconcileProjectConfigs(projectConfigs: ProjectConfig[]): Promise<void>;
  startThread(projectInstanceId: string, options?: { cwd?: string; force?: boolean }): Promise<string>;
  executeCommand(projectInstanceId: string, input: { method: string; params: Record<string, unknown> }): Promise<unknown>;
  resumeThread(projectInstanceId: string, threadId: string): Promise<string>;
  listThreads(projectInstanceId: string): Promise<Thread[]>;
  cancelThread(projectInstanceId: string, threadId: string): Promise<void>;
  pauseThread(projectInstanceId: string, threadId: string): Promise<void>;
  abortCurrentTask(projectInstanceId: string): Promise<boolean>;
  getLastThread(projectInstanceId: string, sessionId: string): Promise<string | null>;
  getHandler(projectInstanceId: string): ((input: { projectInstanceId: string; message: { text: string } }) => Promise<{ text: string } | null>) | null;
  getProjectProviders(projectInstanceId: string): Promise<ProviderState[]>;
  getActiveProvider(projectInstanceId: string): Promise<string | null>;
  setActiveProvider(projectInstanceId: string, provider: string): Promise<void>;
  setProjectMode(projectInstanceId: string, mode: PermissionMode): Promise<void>;
  describeProject(projectInstanceId: string): Promise<ProjectState>;
  getProjectDiagnostics(projectInstanceId: string): Promise<ProjectDiagnostics | null>;
  stop(): Promise<void>;
}

export interface ProjectState {
  projectInstanceId: string;
  configured: boolean;
  active: boolean;
  removed: boolean;
  sessionCount: number;
}

export interface ProjectDiagnostics {
  projectInstanceId: string;
  status: 'working' | 'waiting_approval' | 'done' | 'failed';
  reason: string | null;
  source: 'notification' | 'generateReply' | 'restoreBinding' | 'startThread' | 'resumeThread';
}

export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  // projectId -> { providerManager, client, bindingCount, sessions: Set<string> }
  const activeProjects = new Map<
    string,
    {
      client: CodexProjectClient;
      providerManager: ProviderManager;
      bindingCount: number;
      sessions: Set<string>;
      config: ProjectConfig;
      currentTaskController: AbortController | null;
    }
  >();
  const diagnosticsByProjectId = new Map<string, ProjectDiagnostics>();
  const knownProjectIds = new Set<string>();
  let configuredProjectIds = new Set<string>();
  let hasReconciledConfigs = false;

  function toErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }

    if (typeof error === 'string' && error !== '') {
      return error;
    }

    return 'unknown error';
  }

  function isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.message === 'task aborted');
  }

  function readFailureReason(method: string, params?: Record<string, unknown>): string | null {
    if (method === 'error') {
      const error = params?.error;
      if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = String((error as { message?: unknown }).message ?? '').trim();
        return message === '' ? null : message;
      }
    }

    if (method === 'turn/completed') {
      const turn = typeof params?.turn === 'object' && params.turn !== null ? params.turn : null;
      if (turn !== null && 'error' in turn) {
        const error = (turn as { error?: unknown }).error;
        if (typeof error === 'object' && error !== null && 'message' in error) {
          const message = String((error as { message?: unknown }).message ?? '').trim();
          if (message !== '') {
            return message;
          }
        }
      }

      if (typeof params?.error === 'object' && params.error !== null && 'message' in params.error) {
        const message = String((params.error as { message?: unknown }).message ?? '').trim();
        if (message !== '') {
          return message;
        }
      }
    }

    return null;
  }

  function setProjectDiagnostics(
    projectInstanceId: string,
    input: { status: 'working' | 'waiting_approval' | 'done' | 'failed'; reason?: string | null; source: ProjectDiagnostics['source'] },
  ): void {
    diagnosticsByProjectId.set(projectInstanceId, {
      projectInstanceId,
      status: input.status,
      reason: input.reason ?? null,
      source: input.source,
    });
  }

  function markProjectKnown(projectId: string): void {
    knownProjectIds.add(projectId);
  }

  function attachServerRequestHandler(projectId: string, client: CodexProjectClient): void {
    if (options.onServerRequest === undefined) {
      return;
    }

    client.onServerRequest = (request) => {
      void options.onServerRequest?.({
        projectInstanceId: projectId,
        request,
        respond: async (result: unknown) => {
          if (typeof client.respondToServerRequest !== 'function') {
            throw new Error(`Project ${projectId} does not support server request responses`);
          }

          await client.respondToServerRequest(request.id, result);
        },
      });
    };
  }

  function attachStatusHandler(projectId: string, client: CodexProjectClient): void {
    const previousHandler = client.onNotification ?? null;
    client.onNotification = (message) => {
      if (previousHandler !== null) {
        void previousHandler(message);
      }

      const summary = summarizeProgressNotification(message.method, message.params);
      if (summary !== null) {
        emitProgress(projectId, { summary });
      }

      if (message.method === 'tool/use' && options.onToolUse !== undefined) {
        const params = message.params as { tool_name?: string; input?: string; output?: string; status?: string; timestamp?: number } | undefined;
        if (params?.tool_name && params?.status) {
          void options.onToolUse({
            projectInstanceId: projectId,
            toolName: params.tool_name,
            input: params.input,
            output: params.output,
            status: params.status as 'started' | 'completed' | 'failed',
            timestamp: params.timestamp ?? Date.now(),
          });
        }
      }

      const status = readProjectStatus(message.method, message.params);
      if (status === null) {
        return;
      }

      const reason = status === 'failed' ? readFailureReason(message.method, message.params) : null;
      setProjectDiagnostics(projectId, {
        status,
        reason,
        source: 'notification',
      });

      if (options.onStatusChange !== undefined) {
        void options.onStatusChange({
          projectInstanceId: projectId,
          status,
          reason,
          source: 'notification',
        });
      }
    };
  }

  function attachTextDeltaHandler(projectId: string, client: CodexProjectClient): void {
    const previousHandler = client.onTextDelta ?? null;
    client.onTextDelta = (text) => {
      previousHandler?.(text);
      if (text !== '') {
        emitProgress(projectId, { textDelta: text });
      }
    };
  }

  function emitProgress(
    projectId: string,
    input: { textDelta?: string; summary?: string },
  ): void {
    if (options.onProgress === undefined) {
      return;
    }

    const entry = activeProjects.get(projectId);
    if (entry === undefined) {
      return;
    }

    for (const sessionId of entry.sessions) {
      void options.onProgress({
        projectInstanceId: projectId,
        sessionId,
        ...input,
      });
    }
  }

  function summarizeProgressNotification(method: string, params?: Record<string, unknown>): string | null {
    if (method !== 'item/completed') {
      return null;
    }

    const item = typeof params?.item === 'object' && params.item !== null ? params.item as Record<string, unknown> : null;
    if (item === null) {
      return null;
    }

    const type = typeof item.type === 'string' ? item.type : '';
    if (type === 'agentMessage') {
      return null;
    }

    const command = typeof item.command === 'string' ? item.command.trim() : '';
    if (type === 'commandExecution' && command !== '') {
      return `Completed command: ${command}`;
    }

    if (type !== '') {
      return `Completed ${type}`;
    }

    return null;
  }

  function attachThreadChangedHandler(projectId: string, client: CodexProjectClient): void {
    if (options.setLastThread === undefined) {
      return;
    }

    client.onThreadChanged = (threadId) => {
      const entry = activeProjects.get(projectId);
      if (!entry) {
        return;
      }

      for (const sessionId of entry.sessions) {
        options.setLastThread?.(projectId, sessionId, threadId);
      }
    };
  }

  function attachSystemInitHandler(projectId: string, client: CodexProjectClient): void {
    if (options.onSystemInit === undefined) {
      return;
    }

    client.onSystemInit = (data) => {
      options.onSystemInit?.(projectId, data);
    };
  }

  async function runProjectReply(
    projectId: string,
    entry: { client: CodexProjectClient; providerManager: ProviderManager; bindingCount: number; sessions: Set<string>; config: ProjectConfig; currentTaskController: AbortController | null },
    message: { text: string },
  ): Promise<{ text: string } | null> {
    const controller = new AbortController();
    entry.currentTaskController = controller;

    try {
      const reply = await Promise.race<
        { kind: 'reply'; text: string } | { kind: 'error'; error: unknown } | { kind: 'abort' }
      >([
        entry.client.generateReply({ text: message.text }).then(
          (text) => ({ kind: 'reply', text }),
          (error) => ({ kind: 'error', error }),
        ),
        new Promise<{ kind: 'abort' }>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve({ kind: 'abort' }), { once: true });
        }),
      ]);

      if (reply.kind === 'abort') {
        return { text: '[lark-agent-bridge] task aborted' };
      }

      if (reply.kind === 'error') {
        throw reply.error;
      }

      return { text: reply.text };
    } catch (error) {
      if (isAbortError(error)) {
        return { text: '[lark-agent-bridge] task aborted' };
      }

      setProjectDiagnostics(projectId, {
        status: 'failed',
        reason: toErrorMessage(error),
        source: 'generateReply',
      });
      return null;
    } finally {
      if (entry.currentTaskController === controller) {
        entry.currentTaskController = null;
      }
    }
  }

  async function createEntry(projectId: string, config: ProjectConfig) {
    const providerManager = new ProviderManager({
      projectConfig: config,
          createClient: (input) => options.createClient(projectId, { ...input }, input.provider),
      getPersistedState: () => options.bridgeStateStore?.getProjectState(projectId) ?? null,
      setPersistedState: (state) => options.bridgeStateStore?.setProjectState(state),
      allocatePort: options.allocateWebSocketPort,
      onClientCreated: (_, client) => {
        attachServerRequestHandler(projectId, client);
        attachStatusHandler(projectId, client);
        attachTextDeltaHandler(projectId, client);
        attachThreadChangedHandler(projectId, client);
        attachSystemInitHandler(projectId, client);
      },
    });
    const client = providerManager.getClient();
    const entry = {
      client,
      providerManager,
      bindingCount: 0,
      sessions: new Set<string>(),
      config,
      currentTaskController: null as AbortController | null,
    };
    activeProjects.set(projectId, entry);

    return entry;
  }

  async function disconnectProject(projectId: string): Promise<void> {
    const entry = activeProjects.get(projectId);
    if (entry) {
      await entry.providerManager.stop();
      activeProjects.delete(projectId);
    }
  }

  async function startThreadForEntry(
    projectId: string,
    entry: { providerManager: ProviderManager; bindingCount: number; sessions: Set<string>; config: ProjectConfig },
    threadOptions?: { cwd?: string; force?: boolean },
  ): Promise<string> {
    const client = await entry.providerManager.ensureActiveClient();
    if (client.startThread === undefined) {
      throw new Error(`Project ${projectId} does not support starting threads`);
    }

    const threadId = await client.startThread({
      cwd: threadOptions?.cwd ?? entry.config.cwd,
      force: threadOptions?.force ?? false,
    });

    if (options.setLastThread !== undefined) {
      for (const sessionId of entry.sessions) {
        options.setLastThread(projectId, sessionId, threadId);
      }
    }

    return threadId;
  }

  async function resumeThreadForEntry(
    projectId: string,
    entry: { providerManager: ProviderManager; bindingCount: number; sessions: Set<string>; config: ProjectConfig },
    threadId: string,
  ): Promise<string> {
    const client = await entry.providerManager.ensureActiveClient();
    if (client.resumeThread === undefined) {
      throw new Error(`Project ${projectId} does not support thread resume`);
    }

    const resumedThreadId = await client.resumeThread({ threadId, cwd: entry.config.cwd });

    if (options.setLastThread !== undefined) {
      for (const sessionId of entry.sessions) {
        options.setLastThread(projectId, sessionId, resumedThreadId);
      }
    }

    return resumedThreadId;
  }

  function shouldFallbackToFreshThread(error: unknown): boolean {
    const message =
      typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : String(error ?? '');
    return message.includes('no rollout found for thread id');
  }

  function readProjectStatus(method: string, params?: Record<string, unknown>): 'working' | 'waiting_approval' | 'done' | 'failed' | null {
    if (method === 'turn/started') {
      return 'working';
    }

    if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval'
    ) {
      return 'waiting_approval';
    }

    if (method === 'error') {
      return 'failed';
    }

    if (method === 'turn/completed') {
      const turn = params?.turn;
      const status =
        typeof turn === 'object' && turn !== null && 'status' in turn
          ? String((turn as { status?: unknown }).status ?? '')
          : typeof params?.status === 'string'
            ? String(params.status)
            : '';

      if (status === 'failed' || status === 'interrupted') {
        return 'failed';
      }

      if (status === 'completed') {
        return 'done';
      }
    }

    return null;
  }

  async function ensureActiveEntry(projectId: string): Promise<{
    entry: { client: CodexProjectClient; bindingCount: number; sessions: Set<string>; config: ProjectConfig };
    created: boolean;
  } | null> {
    const config = options.getProjectConfig(projectId);
    if (!config) {
      return null;
    }

    let entry = activeProjects.get(projectId);
    let created = false;

    if (!entry) {
      entry = await createEntry(projectId, config);
      created = true;
    } else if (JSON.stringify(entry.config) !== JSON.stringify(config)) {
      await disconnectProject(projectId);
      entry = await createEntry(projectId, config);
      created = true;
    }

    return { entry, created };
  }

  return {
    async reconcileProjectConfigs(projectConfigs: ProjectConfig[]): Promise<void> {
      hasReconciledConfigs = true;
      configuredProjectIds = new Set(projectConfigs.map((entry) => entry.projectInstanceId));
      for (const projectConfig of projectConfigs) {
        markProjectKnown(projectConfig.projectInstanceId);
      }
    },

    async onBindingChanged(
      event: { type: string; projectId?: string; sessionId?: string },
      bindingOptions?: { restore?: boolean },
    ) {
      if (event.type === 'bound' && event.projectId && event.sessionId) {
        const prepared = await ensureActiveEntry(event.projectId);
        if (!prepared) {
          return;
        }

        const { entry } = prepared;
        markProjectKnown(event.projectId);
        const isNewSession = !entry.sessions.has(event.sessionId);
        entry.sessions.add(event.sessionId);
        entry.bindingCount = entry.sessions.size;

        // Always register handler for this project so messages can be routed.
        // The handler lazily starts the provider on first message via ensureActiveClient().
        // It also attempts to resume the saved thread on each invocation so that
        // if the initial resume (in onBindingChanged) failed, subsequent messages
        // can still recover the thread.
        options.router?.registerProjectHandler(event.projectId, async ({ message }) => {
          // Try to resume saved thread if client has no thread yet.
          // This is safe to call multiple times (idempotent).
          if (options.getLastThread !== undefined) {
            const savedThread = options.getLastThread(event.projectId, event.sessionId);
            if (savedThread !== null) {
              try {
                await entry.client.resumeThread({ threadId: savedThread, cwd: entry.config.cwd });
              } catch {
                // Resume failed - runProjectReply will create a new thread via ensureThread
              }
            }
          }
          return await runProjectReply(event.projectId, entry, message);
        });

        // For restore=true with an existing lastThread, attempt to resume it.
        const isRestoreWithThread =
          bindingOptions?.restore === true &&
          isNewSession &&
          options.getLastThread !== undefined;
        if (isRestoreWithThread) {
          const lastThread = options.getLastThread(event.projectId, event.sessionId);
          if (lastThread !== null) {
            const activeClient = await entry.providerManager.ensureActiveClient();
            if (activeClient.resumeThread !== undefined) {
              try {
                await resumeThreadForEntry(event.projectId, entry, lastThread);
                return;
              } catch (error) {
                setProjectDiagnostics(event.projectId, {
                  status: 'failed',
                  reason: toErrorMessage(error),
                  source: 'resumeThread',
                });
                if (!shouldFallbackToFreshThread(error)) {
                  throw error;
                }
                // Fallback allowed: return without starting fresh thread,
                // lazy loading handles it when message arrives.
                return;
              }
            }
          }
        }

        // For fresh sessions (restore=false, or restore=true but no lastThread):
        // do NOT start provider here - it will be started lazily on first
        // message via the registered handler above.
        return;
      }

      if ((event.type === 'session-unbound' || event.type === 'unbound') && (event.projectId || event.sessionId)) {
        let projectId = event.projectId ?? '';
        const sessionId = event.sessionId ?? '';

        // Find project by session if needed
        if (!projectId && sessionId) {
          for (const [pid, entry] of activeProjects) {
            if (entry.sessions.has(sessionId)) {
              projectId = pid;
              break;
            }
          }
        }

        if (!projectId) return;

        const entry = activeProjects.get(projectId);
        if (!entry) return;

        if (sessionId) {
          entry.sessions.delete(sessionId);
        }

        if (entry.sessions.size === 0) {
          await disconnectProject(projectId);
        } else {
          entry.bindingCount = entry.sessions.size;
        }
      }
    },

    async restoreBinding(projectInstanceId: string, sessionId: string): Promise<void> {
      try {
        await this.onBindingChanged({ type: 'bound', projectId: projectInstanceId, sessionId }, { restore: true });
      } catch (error) {
        setProjectDiagnostics(projectInstanceId, {
          status: 'failed',
          reason: toErrorMessage(error),
          source: 'restoreBinding',
        });
        throw error;
      }
    },

    async startThread(projectInstanceId: string, threadOptions?: { cwd?: string; force?: boolean }): Promise<string> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) {
        throw new Error(`Project ${projectInstanceId} is not active`);
      }

      return await startThreadForEntry(projectInstanceId, entry, threadOptions);
    },

    getHandler(projectInstanceId) {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) return null;

      return async ({ message }) => {
        await entry.providerManager.ensureActiveClient();
        return await runProjectReply(projectInstanceId, entry, message);
      };
    },

    async executeCommand(projectInstanceId: string, input: { method: string; params: Record<string, unknown> }): Promise<unknown> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) {
        throw new Error(`Project ${projectInstanceId} is not active`);
      }

      const client = await entry.providerManager.ensureActiveClient();
      if (client.executeCommand === undefined) {
        throw new Error(`Project ${projectInstanceId} does not support structured Codex commands`);
      }

      return await client.executeCommand(input);
    },

    async resumeThread(projectInstanceId: string, threadId: string): Promise<string> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) {
        throw new Error(`Project ${projectInstanceId} is not active`);
      }

      const client = await entry.providerManager.ensureActiveClient();
      if (client.resumeThread === undefined) {
        throw new Error(`Project ${projectInstanceId} does not support thread resume`);
      }

      const resumedThreadId = await client.resumeThread({ threadId });
      if (options.setLastThread !== undefined) {
        for (const sessionId of entry.sessions) {
          options.setLastThread(projectInstanceId, sessionId, resumedThreadId);
        }
      }

      return resumedThreadId;
    },

    async listThreads(projectInstanceId: string): Promise<Thread[]> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) {
        throw new Error(`Project ${projectInstanceId} is not active`);
      }

      const client = entry.client;
      if (client.listThreads === undefined) {
        throw new Error(`Project ${projectInstanceId} does not support listing threads`);
      }

      const raw = await client.listThreads();
      return raw.map((t) => ({
        id: String(t.id ?? t.threadId ?? ''),
        name: String(t.name ?? t.title ?? t.description ?? 'Untitled'),
        description: String(t.description ?? ''),
        status: (t.status as Thread['status']) ?? 'running',
        createdAt: t.createdAt ? new Date(t.createdAt) : new Date(),
        duration: t.duration,
      }));
    },

    async cancelThread(projectInstanceId: string, threadId: string): Promise<void> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) {
        throw new Error(`Project ${projectInstanceId} is not active`);
      }

      if (entry.client.cancelThread === undefined) {
        throw new Error(`Project ${projectInstanceId} does not support canceling threads`);
      }

      await entry.client.cancelThread(threadId);
    },

    async pauseThread(projectInstanceId: string, threadId: string): Promise<void> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) {
        throw new Error(`Project ${projectInstanceId} is not active`);
      }

      if (entry.client.pauseThread === undefined) {
        throw new Error(`Project ${projectInstanceId} does not support pausing threads`);
      }

      await entry.client.pauseThread(threadId);
    },

    async abortCurrentTask(projectInstanceId: string): Promise<boolean> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry || entry.currentTaskController === null) {
        return false;
      }

      entry.currentTaskController.abort();
      if (typeof entry.client.abortCurrentTask === 'function') {
        await entry.client.abortCurrentTask();
      }
      return true;
    },

    async getLastThread(projectInstanceId: string, sessionId: string): Promise<string | null> {
      return options.getLastThread?.(projectInstanceId, sessionId) ?? null;
    },

    async getProjectProviders(projectInstanceId: string): Promise<ProviderState[]> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) {
        const config = options.getProjectConfig(projectInstanceId);
        if (!config) {
          return [];
        }

        const providerManager = new ProviderManager({
          projectConfig: config,
          createClient: (input) => options.createClient(projectInstanceId, { ...input }, input.provider),
          allocatePort: options.allocateWebSocketPort,
        });

        return providerManager.getProviderStates().map((state) => ({
          id: state.id,
          kind: state.kind,
          transport: state.transport,
          active: state.active,
          started: state.started,
          ...(state.port !== undefined ? { port: state.port } : {}),
        }));
      }

      return entry.providerManager.getProviderStates().map((state) => ({
        id: state.id,
        kind: state.kind,
        transport: state.transport,
        active: state.active,
        started: state.started,
        ...(state.port !== undefined ? { port: state.port } : {}),
      }));
    },

    async getActiveProvider(projectInstanceId: string): Promise<string | null> {
      const entry = activeProjects.get(projectInstanceId);
      if (entry) {
        return entry.providerManager.getActiveProvider();
      }

      const persistedState = options.bridgeStateStore?.getProjectState(projectInstanceId);
      if (persistedState?.activeProvider !== undefined) {
        return persistedState.activeProvider;
      }

      const config = options.getProjectConfig(projectInstanceId);
      if (!config) {
        return null;
      }

      return config.activeProvider ?? config.providers?.[0]?.id ?? 'codex';
    },

    async setActiveProvider(projectInstanceId: string, provider: string): Promise<void> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) {
        const config = options.getProjectConfig(projectInstanceId);
        if (!config) {
          throw new Error(`Project ${projectInstanceId} is not configured`);
        }

        const providerManager = new ProviderManager({
          projectConfig: config,
          createClient: (input) => options.createClient(projectInstanceId, { ...input }, input.provider),
          getPersistedState: () => options.bridgeStateStore?.getProjectState(projectInstanceId) ?? null,
          setPersistedState: (state) => options.bridgeStateStore?.setProjectState(state),
          allocatePort: options.allocateWebSocketPort,
        });
        await providerManager.setActiveProvider(provider);
        return;
      }

      await entry.providerManager.setActiveProvider(provider);
    },

    async setProjectMode(projectInstanceId: string, mode: PermissionMode): Promise<void> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) {
        throw new Error(`Project ${projectInstanceId} is not active`);
      }
      entry.config.permissionMode = mode;
    },

    async describeProject(projectInstanceId: string): Promise<ProjectState> {
      const active = activeProjects.get(projectInstanceId);
      const configured = hasReconciledConfigs
        ? configuredProjectIds.has(projectInstanceId)
        : options.getProjectConfig(projectInstanceId) !== null;
      if (configured || active !== undefined) {
        markProjectKnown(projectInstanceId);
      }
      return {
        projectInstanceId,
        configured,
        active: active !== undefined,
        removed: knownProjectIds.has(projectInstanceId) && !configured,
        sessionCount: active?.sessions.size ?? 0,
      };
    },

    async getProjectDiagnostics(projectInstanceId: string): Promise<ProjectDiagnostics | null> {
      return diagnosticsByProjectId.get(projectInstanceId) ?? null;
    },

    async stop() {
      const projectIds = Array.from(activeProjects.keys());
      await Promise.all(projectIds.map((id) => disconnectProject(id)));
    },
  };
}
