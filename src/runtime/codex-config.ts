import {
  cloneProjectConfigEntry as cloneProjectConfigEntryBase,
  createProjectConfigEntry as createProjectConfigEntryBase,
  loadProjectsFromFile as loadProjectConfigEntriesFromFile,
  parseProjectConfigEntries as parseProjectConfigEntriesBase,
  normalizeProjectConfig,
  resolvePathLikeInput,
  writeProjectsFile as writeProjectConfigFile,
  type ProjectConfigEntry as ProjectConfigFileEntry,
} from './project-config.ts';

export type ProjectConfigEntry = ProjectConfigFileEntry;
export const cloneProjectConfigEntry = cloneProjectConfigEntryBase;
export const createProjectConfigEntry = createProjectConfigEntryBase;
export const writeProjectsFile = writeProjectConfigFile;

function normalizeProjectConfigEntry(entry: ProjectConfigFileEntry): ProjectConfigEntry {
  const project = cloneProjectConfigEntryBase(entry);
  const runtime = createCodexRuntimeConfig({
    projectInstanceId: entry.projectInstanceId,
    command: typeof entry.command === 'string' ? entry.command : undefined,
    args: Array.isArray(entry.args) ? entry.args : undefined,
    cwd: entry.cwd,
    model: typeof entry.model === 'string' ? entry.model : undefined,
    serviceName: typeof entry.serviceName === 'string' ? entry.serviceName : undefined,
    transport: entry.transport === 'stdio' ? 'stdio' : 'websocket',
    websocketUrl: typeof entry.websocketUrl === 'string' ? entry.websocketUrl : undefined,
    qwenExecutable: typeof entry.qwenExecutable === 'string' ? entry.qwenExecutable : undefined,
    opencodeHostname: typeof entry.opencodeHostname === 'string' ? entry.opencodeHostname : undefined,
    opencodePort: typeof entry.opencodePort === 'number' ? entry.opencodePort : undefined,
    opencodeCommand: typeof entry.opencodeCommand === 'string' ? entry.opencodeCommand : undefined,
    opencodeExtraArgs: Array.isArray(entry.opencodeExtraArgs) ? entry.opencodeExtraArgs : undefined,
    opencodeUsername: typeof entry.opencodeUsername === 'string' ? entry.opencodeUsername : undefined,
    opencodePassword: typeof entry.opencodePassword === 'string' ? entry.opencodePassword : undefined,
  });

  return Object.assign(project, entry, runtime, {
    providers: entry.providers,
    adapterType: typeof entry.adapterType === 'string' ? entry.adapterType : 'codex',
  });
}

export function parseProjectConfigEntries(raw: string): ProjectConfigEntry[] | null {
  const entries = parseProjectConfigEntriesBase(raw);
  return entries === null ? null : entries.map((entry) => normalizeProjectConfigEntry(entry));
}

export function loadProjectsFromFile(filePath: string): ProjectConfigEntry[] | null {
  const entries = loadProjectConfigEntriesFromFile(filePath);
  return entries === null ? null : entries.map((entry) => normalizeProjectConfigEntry(entry));
}

export interface RuntimeEnvCodexConfig {
  BRIDGE_CODEX_PROJECTS_JSON?: string;
  BRIDGE_CODEX_PROJECT_INSTANCE_ID?: string;
  BRIDGE_CODEX_COMMAND?: string;
  BRIDGE_CODEX_ARGS_JSON?: string;
  BRIDGE_CODEX_CWD?: string;
  BRIDGE_CODEX_MODEL?: string;
  BRIDGE_CODEX_SERVICE_NAME?: string;
  BRIDGE_CODEX_TRANSPORT?: string;
  BRIDGE_CODEX_WEBSOCKET_URL?: string;
  BRIDGE_CODEX_QWEN_EXECUTABLE?: string;
}

export interface CodexRuntimeConfig {
  projectInstanceId: string;
  command: string;
  args: string[];
  cwd?: string;
  model?: string;
  serviceName: string;
  transport: 'stdio' | 'websocket';
  websocketUrl?: string;
  adapterType?: 'codex' | 'claude-code' | 'qwen-code' | 'opencode';
  qwenExecutable?: string;
  opencodeHostname?: string;
  opencodePort?: number;
  opencodeCommand?: string;
  opencodeExtraArgs?: string[];
  opencodeUsername?: string;
  opencodePassword?: string;
}

export type CodexProjectRuntimeConfig = CodexRuntimeConfig;

function parseArgs(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return ['app-server'];
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('BRIDGE_CODEX_ARGS_JSON must be a JSON array of strings');
  }

  return parsed;
}

function parseProjectConfigs(value: string | undefined, homeDir: string | undefined): CodexRuntimeConfig[] | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }

  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('BRIDGE_CODEX_PROJECTS_JSON must be a JSON array');
  }

  return parsed.map((entry) => {
    if (typeof entry !== 'object' || entry === null || typeof (entry as { projectInstanceId?: unknown }).projectInstanceId !== 'string') {
      throw new Error('BRIDGE_CODEX_PROJECTS_JSON entries must include a projectInstanceId string');
    }

    const record = entry as Partial<CodexRuntimeConfig> & { projectInstanceId: string };
    normalizeProjectConfig(
      {
        projectInstanceId: record.projectInstanceId,
        cwd: record.cwd,
        providers: [],
      },
      { homeDir },
    );
    const transport = record.transport ?? 'websocket';

    return {
      projectInstanceId: record.projectInstanceId,
      command: record.command?.trim() || 'codex',
      args: Array.isArray(record.args) ? record.args : ['app-server'],
      cwd: resolvePathLikeInput(record.cwd, homeDir),
      ...(record.model?.trim() ? { model: record.model.trim() } : {}),
      serviceName: record.serviceName?.trim() || 'lark-agent-bridge',
      transport,
      websocketUrl: transport === 'stdio' ? undefined : record.websocketUrl?.trim() || 'ws://127.0.0.1:4000',
      adapterType: record.adapterType ?? 'codex',
      ...(record.qwenExecutable?.trim() ? { qwenExecutable: record.qwenExecutable.trim() } : {}),
      ...(record.opencodeHostname?.trim() ? { opencodeHostname: record.opencodeHostname.trim() } : {}),
      ...(typeof record.opencodePort === 'number' ? { opencodePort: record.opencodePort } : {}),
      ...(record.opencodeCommand?.trim() ? { opencodeCommand: record.opencodeCommand.trim() } : {}),
      ...(Array.isArray(record.opencodeExtraArgs) ? { opencodeExtraArgs: record.opencodeExtraArgs } : {}),
      ...(record.opencodeUsername?.trim() ? { opencodeUsername: record.opencodeUsername.trim() } : {}),
      ...(record.opencodePassword?.trim() ? { opencodePassword: record.opencodePassword.trim() } : {}),
    };
  });
}

function resolveWebSocketUrl(env: RuntimeEnvCodexConfig): string {
  return env.BRIDGE_CODEX_WEBSOCKET_URL?.trim() || 'ws://127.0.0.1:4000';
}

export function resolveCodexRuntimeConfigs(env: RuntimeEnvCodexConfig = process.env): CodexRuntimeConfig[] | null {
  const projects = parseProjectConfigs(env.BRIDGE_CODEX_PROJECTS_JSON, env.HOME ?? process.env.HOME);
  if (projects !== null) {
    return projects;
  }

  const projectInstanceId = env.BRIDGE_CODEX_PROJECT_INSTANCE_ID?.trim();
  if (!projectInstanceId) {
    return null;
  }

  return [
    createCodexRuntimeConfig({
      projectInstanceId,
      command: env.BRIDGE_CODEX_COMMAND?.trim() || 'codex',
      args: parseArgs(env.BRIDGE_CODEX_ARGS_JSON),
      cwd: env.BRIDGE_CODEX_CWD?.trim(),
      model: env.BRIDGE_CODEX_MODEL?.trim(),
      serviceName: env.BRIDGE_CODEX_SERVICE_NAME?.trim() || 'lark-agent-bridge',
      transport: env.BRIDGE_CODEX_TRANSPORT?.trim() === 'stdio' ? 'stdio' : 'websocket',
      websocketUrl: resolveWebSocketUrl(env),
      qwenExecutable: env.BRIDGE_CODEX_QWEN_EXECUTABLE?.trim(),
    }),
  ];
}

export function resolveCodexRuntimeConfig(env: RuntimeEnvCodexConfig = process.env): CodexRuntimeConfig | null {
  return resolveCodexRuntimeConfigs(env)?.[0] ?? null;
}

export function createCodexRuntimeConfig(input: {
  projectInstanceId: string;
  command?: string;
  args?: string[];
  cwd?: string;
  model?: string;
  serviceName?: string;
  transport?: 'stdio' | 'websocket';
  websocketUrl?: string;
  qwenExecutable?: string;
  opencodeHostname?: string;
  opencodePort?: number;
  opencodeCommand?: string;
  opencodeExtraArgs?: string[];
  opencodeUsername?: string;
  opencodePassword?: string;
}): CodexRuntimeConfig {
  const model = input.model?.trim();
  const entry = {
    projectInstanceId: input.projectInstanceId.trim(),
    command: input.command?.trim() || 'codex',
    args: input.args ?? ['app-server'],
    cwd: resolvePathLikeInput(input.cwd),
    ...(model !== undefined && model !== '' ? { model } : {}),
    serviceName: input.serviceName?.trim() || 'lark-agent-bridge',
    transport: input.transport ?? 'websocket',
    websocketUrl:
      (input.transport ?? 'websocket') === 'stdio' ? undefined : input.websocketUrl?.trim() || 'ws://127.0.0.1:4000',
    ...(input.qwenExecutable?.trim() ? { qwenExecutable: input.qwenExecutable.trim() } : {}),
    ...(input.opencodeHostname?.trim() ? { opencodeHostname: input.opencodeHostname.trim() } : {}),
    ...(typeof input.opencodePort === 'number' ? { opencodePort: input.opencodePort } : {}),
    ...(input.opencodeCommand?.trim() ? { opencodeCommand: input.opencodeCommand.trim() } : {}),
    ...(Array.isArray(input.opencodeExtraArgs) ? { opencodeExtraArgs: input.opencodeExtraArgs } : {}),
    ...(input.opencodeUsername?.trim() ? { opencodeUsername: input.opencodeUsername.trim() } : {}),
    ...(input.opencodePassword?.trim() ? { opencodePassword: input.opencodePassword.trim() } : {}),
    adapterType: 'codex' as const,
  };
  return createProjectConfigEntry(entry, input.cwd?.trim() || undefined) as unknown as CodexRuntimeConfig;
}
