import type { CodexProjectClient } from './codex-project.ts';
import { allocateWebSocketPort } from '../adapters/codex/websocket-port.ts';
import type { BridgeProjectStateRecord, BridgeStateStore } from '../storage/binding-store.ts';
import {
  defaultProviderDescriptors,
  providerToAdapterType,
  type ProviderDescriptor,
  type ProviderKind,
  type ProviderState,
} from './provider-registry.ts';

export interface ProviderManagerProjectConfig {
  projectInstanceId: string;
  cwd?: string;
  providers?: ProviderDescriptor[];
  activeProvider?: string;
  command?: string;
  args?: string[];
  model?: string;
  serviceName?: string;
  transport?: 'stdio' | 'websocket';
  websocketUrl?: string;
  adapterType?: 'codex' | 'claude-code' | 'qwen-code' | 'opencode' | 'gemini-cli';
  qwenExecutable?: string;
  opencodeHostname?: string;
  opencodePort?: number;
  opencodeCommand?: string;
  opencodeExtraArgs?: string[];
  opencodeUsername?: string;
  opencodePassword?: string;
}

export interface ProviderClientFactoryInput extends ProviderManagerProjectConfig {
  provider: ProviderDescriptor;
}

export interface ProviderManagerOptions {
  projectConfig?: ProviderManagerProjectConfig;
  projectInstanceId?: string;
  cwd?: string;
  providers?: ProviderDescriptor[];
  activeProvider?: string;
  command?: string;
  args?: string[];
  model?: string;
  serviceName?: string;
  transport?: 'stdio' | 'websocket';
  websocketUrl?: string;
  adapterType?: 'codex' | 'claude-code' | 'qwen-code' | 'opencode' | 'gemini-cli';
  qwenExecutable?: string;
  opencodeHostname?: string;
  opencodePort?: number;
  opencodeCommand?: string;
  opencodeExtraArgs?: string[];
  opencodeUsername?: string;
  opencodePassword?: string;
  stateStore?: BridgeStateStore;
  allocatePort?: () => Promise<number>;
  getPersistedState?: () => BridgeProjectStateRecord | null;
  setPersistedState?: (state: BridgeProjectStateRecord) => void;
  onClientCreated?: (providerId: string, client: CodexProjectClient) => void;
  createClient: (input: ProviderClientFactoryInput) => CodexProjectClient;
}

type ProviderEntry = {
  descriptor: ProviderDescriptor;
  client: CodexProjectClient | null;
};

function cloneDescriptor(descriptor: ProviderDescriptor): ProviderDescriptor {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    transport: descriptor.transport,
    ...(descriptor.port !== undefined ? { port: descriptor.port } : {}),
    ...(descriptor.websocketUrl !== undefined ? { websocketUrl: descriptor.websocketUrl } : {}),
    ...(descriptor.remoteCwd !== undefined ? { remoteCwd: descriptor.remoteCwd } : {}),
    ...(descriptor.sshHost !== undefined ? { sshHost: descriptor.sshHost } : {}),
    ...(descriptor.sshPort !== undefined ? { sshPort: descriptor.sshPort } : {}),
    ...(descriptor.sshUser !== undefined ? { sshUser: descriptor.sshUser } : {}),
    ...(descriptor.sshIdentityFile !== undefined ? { sshIdentityFile: descriptor.sshIdentityFile } : {}),
    ...(descriptor.sshCommand !== undefined ? { sshCommand: descriptor.sshCommand } : {}),
    ...(descriptor.sshArgs !== undefined ? { sshArgs: [...descriptor.sshArgs] } : {}),
  };
}

function readStateStore(
  options: ProviderManagerOptions,
): { getProjectState?: (projectInstanceId: string) => BridgeProjectStateRecord | null; setProjectState?: (state: BridgeProjectStateRecord) => void } {
  if (options.stateStore !== undefined) {
    return {
      getProjectState: (projectInstanceId) => options.stateStore?.getProjectState(projectInstanceId) ?? null,
      setProjectState: (state) => options.stateStore?.setProjectState(state),
    };
  }

  return {
    getProjectState: options.getPersistedState,
    setProjectState: options.setPersistedState,
  };
}

function buildBaseProjectConfig(options: ProviderManagerOptions): ProviderManagerProjectConfig {
  if (options.projectConfig !== undefined) {
    return {
      ...options.projectConfig,
      providers:
        Array.isArray(options.projectConfig.providers) && options.projectConfig.providers.length > 0
          ? options.projectConfig.providers.map(cloneDescriptor)
          : defaultProviderDescriptors(),
    };
  }

  if (typeof options.projectInstanceId !== 'string' || options.projectInstanceId.trim() === '') {
    throw new Error('projectInstanceId is required');
  }

  return {
    projectInstanceId: options.projectInstanceId,
    cwd: options.cwd,
    providers:
      Array.isArray(options.providers) && options.providers.length > 0
        ? options.providers.map(cloneDescriptor)
        : defaultProviderDescriptors(),
    activeProvider: options.activeProvider,
    command: options.command,
    args: options.args,
    model: options.model,
    serviceName: options.serviceName,
    transport: options.transport,
    websocketUrl: options.websocketUrl,
    adapterType: options.adapterType,
    qwenExecutable: options.qwenExecutable,
    opencodeHostname: options.opencodeHostname,
    opencodePort: options.opencodePort,
    opencodeCommand: options.opencodeCommand,
    opencodeExtraArgs: options.opencodeExtraArgs,
    opencodeUsername: options.opencodeUsername,
    opencodePassword: options.opencodePassword,
  };
}

export class ProviderManager {
  private readonly projectConfig: ProviderManagerProjectConfig;
  private readonly createClient: (input: ProviderClientFactoryInput) => CodexProjectClient;
  private readonly getProjectState?: (projectInstanceId: string) => BridgeProjectStateRecord | null;
  private readonly setProjectState?: (state: BridgeProjectStateRecord) => void;
  private readonly allocatePort?: () => Promise<number>;
  private readonly onClientCreated?: (providerId: string, client: CodexProjectClient) => void;
  private readonly entries = new Map<string, ProviderEntry>();
  private activeProvider: string;
  private readonly clientProxy: CodexProjectClient;

  constructor(options: ProviderManagerOptions) {
    this.projectConfig = buildBaseProjectConfig(options);
    this.createClient = options.createClient;
    const stateStore = readStateStore(options);
    this.getProjectState = stateStore.getProjectState;
    this.setProjectState = stateStore.setProjectState;
    this.allocatePort = options.allocatePort;
    this.onClientCreated = options.onClientCreated;

    for (const descriptor of this.projectConfig.providers ?? defaultProviderDescriptors()) {
      this.entries.set(descriptor.id, {
        descriptor: cloneDescriptor(descriptor),
        client: null,
      });
    }

    const persistedState = this.getProjectState?.(this.projectConfig.projectInstanceId) ?? null;
    const persistedActive = persistedState?.activeProvider;
    if (persistedActive !== undefined && this.entries.has(persistedActive)) {
      this.activeProvider = persistedActive;
    } else if (this.projectConfig.activeProvider !== undefined && this.entries.has(this.projectConfig.activeProvider)) {
      this.activeProvider = this.projectConfig.activeProvider;
    } else {
      this.activeProvider = this.entries.keys().next().value ?? 'codex';
    }

    if (persistedState?.websocketPorts !== undefined) {
      for (const [provider, port] of Object.entries(persistedState.websocketPorts)) {
        if (typeof port === 'number' && this.entries.has(provider)) {
          const entry = this.entries.get(provider);
          if (entry !== undefined) {
            entry.descriptor = { ...entry.descriptor, port };
          }
        }
      }
    }

    if (persistedState?.startedProviders !== undefined) {
      for (const provider of persistedState.startedProviders) {
        if (this.entries.has(provider)) {
          // We remember the provider as started through persisted state; the client is recreated lazily.
        }
      }
    }

    this.clientProxy = this.buildClientProxy();
  }

  private buildClientProxy(): CodexProjectClient {
    return {
      generateReply: async (input) => await (await this.ensureActiveProviderClient()).generateReply(input),
      startThread: async (input) => {
        const client = await this.ensureActiveProviderClient();
        if (client.startThread === undefined) {
          throw new Error(`Provider ${this.activeProvider} does not support starting threads`);
        }
        return await client.startThread(input);
      },
      executeCommand: async (input) => {
        const client = await this.ensureActiveProviderClient();
        if (client.executeCommand === undefined) {
          throw new Error(`Provider ${this.activeProvider} does not support structured commands`);
        }
        return await client.executeCommand(input);
      },
      resumeThread: async (input) => {
        const client = await this.ensureActiveProviderClient();
        if (client.resumeThread === undefined) {
          throw new Error(`Provider ${this.activeProvider} does not support thread resume`);
        }
        return await client.resumeThread(input);
      },
      listThreads: async () => {
        const client = await this.ensureActiveProviderClient();
        if (client.listThreads === undefined) {
          throw new Error(`Provider ${this.activeProvider} does not support listing threads`);
        }
        return await client.listThreads();
      },
      cancelThread: async (id: string) => {
        const client = await this.ensureActiveProviderClient();
        if (client.cancelThread === undefined) {
          throw new Error(`Provider ${this.activeProvider} does not support canceling threads`);
        }
        return await client.cancelThread(id);
      },
      pauseThread: async (id: string) => {
        const client = await this.ensureActiveProviderClient();
        if (client.pauseThread === undefined) {
          throw new Error(`Provider ${this.activeProvider} does not support pausing threads`);
        }
        return await client.pauseThread(id);
      },
      abortCurrentTask: async () => {
        let aborted = false;
        for (const provider of this.entries.keys()) {
          const client = this.getStartedClient(provider);
          if (client?.abortCurrentTask === undefined) {
            continue;
          }

          try {
            aborted = (await client.abortCurrentTask()) || aborted;
          } catch {
            // Best-effort cancel: keep trying the remaining started clients.
          }
        }
        return aborted;
      },
      stop: async () => {
        await this.stop();
      },
    };
  }

  private persistState(): void {
    if (this.setProjectState === undefined) {
      return;
    }

    const websocketPorts: Record<string, number> = {};
    const startedProviders: string[] = [];

    for (const [provider, entry] of this.entries) {
      if (entry.client !== null) {
        startedProviders.push(provider);
      }
      if (entry.descriptor.port !== undefined) {
        websocketPorts[provider] = entry.descriptor.port;
      }
    }

    this.setProjectState({
      projectInstanceId: this.projectConfig.projectInstanceId,
      activeProvider: this.activeProvider,
      ...(Object.keys(websocketPorts).length > 0 ? { websocketPorts } : {}),
      ...(startedProviders.length > 0 ? { startedProviders } : {}),
    });
  }

  private async createStartedClient(provider: string): Promise<CodexProjectClient> {
    const entry = this.entries.get(provider);
    if (entry === undefined) {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    if (entry.client !== null) {
      return entry.client;
    }

    const descriptor = cloneDescriptor(entry.descriptor);
    if (descriptor.transport === 'websocket' && descriptor.port === undefined) {
      descriptor.port = this.allocatePort !== undefined ? await this.allocatePort() : await allocateWebSocketPort();
      entry.descriptor = { ...entry.descriptor, port: descriptor.port };
    }

    const client = this.createClient({
      ...this.projectConfig,
      activeProvider: provider,
      adapterType: providerToAdapterType(entry.descriptor.kind),
      transport: descriptor.transport,
      websocketUrl: descriptor.port !== undefined ? `ws://127.0.0.1:${descriptor.port}` : descriptor.websocketUrl ?? this.projectConfig.websocketUrl,
      provider: descriptor,
    });

    entry.client = client;
    this.onClientCreated?.(provider, client);
    this.persistState();
    return client;
  }

  getClient(): CodexProjectClient {
    return this.clientProxy;
  }

  getActiveProviderName(): string {
    return this.activeProvider;
  }

  getActiveProvider(): string {
    return this.getActiveProviderName();
  }

  async switchActiveProvider(provider: string): Promise<void> {
    if (!this.entries.has(provider)) {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    this.activeProvider = provider;
    this.persistState();
  }

  async setActiveProvider(provider: string): Promise<void> {
    await this.switchActiveProvider(provider);
  }

  async ensureActiveProviderClient(): Promise<CodexProjectClient> {
    return await this.createStartedClient(this.activeProvider);
  }

  async ensureActiveClient(): Promise<CodexProjectClient> {
    return await this.ensureActiveProviderClient();
  }

  async ensureProviderClient(provider: string): Promise<CodexProjectClient> {
    return await this.createStartedClient(provider);
  }

  getStartedClient(provider: string): CodexProjectClient | null {
    return this.entries.get(provider)?.client ?? null;
  }

  getDescriptor(provider: string): ProviderDescriptor | null {
    const entry = this.entries.get(provider);
    return entry === undefined ? null : cloneDescriptor(entry.descriptor);
  }

  getProviderStates(): ProviderState[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.descriptor.id,
      kind: entry.descriptor.kind,
      transport: entry.descriptor.transport,
      active: entry.descriptor.id === this.activeProvider,
      started: entry.client !== null,
      ...(entry.descriptor.port !== undefined ? { port: entry.descriptor.port } : {}),
    }));
  }

  listProviders(): ProviderState[] {
    return this.getProviderStates();
  }

  getStartedProviderNames(): string[] {
    return [...this.entries.entries()].filter(([, entry]) => entry.client !== null).map(([provider]) => provider);
  }

  getAllStartedClients(): CodexProjectClient[] {
    return [...this.entries.values()]
      .filter(entry => entry.client !== null)
      .map(entry => entry.client as CodexProjectClient);
  }

  async stop(): Promise<void> {
    const startedClients = [...this.entries.values()]
      .map((entry) => entry.client)
      .filter((client): client is CodexProjectClient => client !== null);

    for (const entry of this.entries.values()) {
      entry.client = null;
    }

    await Promise.allSettled(startedClients.map(async (client) => client.stop()));
    this.persistState();
  }
}

export function createProviderManager(options: ProviderManagerOptions): ProviderManager {
  return new ProviderManager(options);
}
