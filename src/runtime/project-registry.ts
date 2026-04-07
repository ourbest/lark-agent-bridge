import type { CodexProjectClient } from './codex-project.ts';
import type { CodexServerRequest } from '../adapters/codex/app-server-client.ts';
import type { BridgeRouter } from '../core/router/router.ts';

export interface ProjectConfig {
  projectInstanceId: string;
  command: string;
  args: string[];
  cwd?: string;
  model?: string;
  serviceName: string;
  transport: 'stdio' | 'websocket';
  websocketUrl?: string;
  adapterType?: 'codex' | 'claude-code' | 'qwen-code';
  qwenExecutable?: string;
}

export interface ProjectRegistryOptions {
  getProjectConfig: (projectInstanceId: string) => ProjectConfig | null;
  createClient: (projectInstanceId: string, config: ProjectConfig) => CodexProjectClient;
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
  onServerRequest?: (input: {
    projectInstanceId: string;
    request: CodexServerRequest;
    respond: (result: unknown) => Promise<void>;
  }) => Promise<void>;
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
  getLastThread(projectInstanceId: string, sessionId: string): Promise<string | null>;
  getHandler(projectInstanceId: string): ((input: { projectInstanceId: string; message: { text: string } }) => Promise<{ text: string } | null>) | null;
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
  // projectId -> { client, bindingCount, sessions: Set<string> }
  const activeProjects = new Map<
    string,
    { client: CodexProjectClient; bindingCount: number; sessions: Set<string>; config: ProjectConfig }
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

  function createEntry(projectId: string, config: ProjectConfig) {
    const client = options.createClient(projectId, config);
    const entry = {
      client,
      bindingCount: 0,
      sessions: new Set<string>(),
      config,
    };
    activeProjects.set(projectId, entry);
    attachServerRequestHandler(projectId, client);
    attachStatusHandler(projectId, client);
    attachTextDeltaHandler(projectId, client);
    attachThreadChangedHandler(projectId, client);

    if (options.router) {
      options.router.registerProjectHandler(projectId, async ({ message }) => {
        try {
          const text = await client.generateReply({ text: message.text });
          return { text };
        } catch (error) {
          setProjectDiagnostics(projectId, {
            status: 'failed',
            reason: toErrorMessage(error),
            source: 'generateReply',
          });
          return null;
        }
      });
    }

    return entry;
  }

  async function disconnectProject(projectId: string): Promise<void> {
    const entry = activeProjects.get(projectId);
    if (entry) {
      await entry.client.stop();
      activeProjects.delete(projectId);
    }
  }

  async function startThreadForEntry(
    projectId: string,
    entry: { client: CodexProjectClient; bindingCount: number; sessions: Set<string>; config: ProjectConfig },
    threadOptions?: { cwd?: string; force?: boolean },
  ): Promise<string> {
    if (entry.client.startThread === undefined) {
      throw new Error(`Project ${projectId} does not support starting threads`);
    }

    const threadId = await entry.client.startThread({
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
    entry: { client: CodexProjectClient; bindingCount: number; sessions: Set<string>; config: ProjectConfig },
    threadId: string,
  ): Promise<string> {
    if (entry.client.resumeThread === undefined) {
      throw new Error(`Project ${projectId} does not support thread resume`);
    }

    const resumedThreadId = await entry.client.resumeThread({ threadId, cwd: entry.config.cwd });

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
      entry = createEntry(projectId, config);
      created = true;
    } else if (JSON.stringify(entry.config) !== JSON.stringify(config)) {
      await disconnectProject(projectId);
      entry = createEntry(projectId, config);
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

        const { entry, created } = prepared;
        markProjectKnown(event.projectId);
        const isNewSession = !entry.sessions.has(event.sessionId);
        entry.sessions.add(event.sessionId);
        entry.bindingCount = entry.sessions.size;

        if (bindingOptions?.restore === true && isNewSession) {
          if (options.getLastThread !== undefined) {
            const lastThread = options.getLastThread(event.projectId, event.sessionId);
            if (lastThread !== null && entry.client.resumeThread !== undefined) {
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
              }
            }
          }
        }

        if ((created || isNewSession) && entry.client.startThread !== undefined) {
          try {
            await startThreadForEntry(event.projectId, entry, { cwd: entry.config.cwd, force: true });
          } catch (error) {
            setProjectDiagnostics(event.projectId, {
              status: 'failed',
              reason: toErrorMessage(error),
              source: 'startThread',
            });
            throw error;
          }
        }
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
        try {
          const text = await entry.client.generateReply({ text: message.text });
          return { text };
        } catch (error) {
          setProjectDiagnostics(projectInstanceId, {
            status: 'failed',
            reason: toErrorMessage(error),
            source: 'generateReply',
          });
          return null;
        }
      };
    },

    async executeCommand(projectInstanceId: string, input: { method: string; params: Record<string, unknown> }): Promise<unknown> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) {
        throw new Error(`Project ${projectInstanceId} is not active`);
      }

      if (entry.client.executeCommand === undefined) {
        throw new Error(`Project ${projectInstanceId} does not support structured Codex commands`);
      }

      return await entry.client.executeCommand(input);
    },

    async resumeThread(projectInstanceId: string, threadId: string): Promise<string> {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) {
        throw new Error(`Project ${projectInstanceId} is not active`);
      }

      if (entry.client.resumeThread === undefined) {
        throw new Error(`Project ${projectInstanceId} does not support thread resume`);
      }

      const resumedThreadId = await entry.client.resumeThread({ threadId });
      if (options.setLastThread !== undefined) {
        for (const sessionId of entry.sessions) {
          options.setLastThread(projectInstanceId, sessionId, resumedThreadId);
        }
      }

      return resumedThreadId;
    },

    async getLastThread(projectInstanceId: string, sessionId: string): Promise<string | null> {
      return options.getLastThread?.(projectInstanceId, sessionId) ?? null;
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
