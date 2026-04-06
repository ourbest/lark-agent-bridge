import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
  adapterType?: 'codex' | 'claude-code';
}

const SERIALIZED_CWD = Symbol('serializedCwd');

type ProjectConfigEntryMetadata = {
  [SERIALIZED_CWD]?: string;
};

export type CodexProjectRuntimeConfig = CodexRuntimeConfig;

export type ProjectConfigEntry = CodexRuntimeConfig & ProjectConfigEntryMetadata;

export function cloneProjectConfigEntry(entry: ProjectConfigEntry): ProjectConfigEntry {
  return createProjectConfigEntry(entry, readSerializedCwd(entry));
}

export function writeProjectsFile(filePath: string, projects: ProjectConfigEntry[]): void {
  const snapshot = {
    projects: projects.map((entry) => {
      const serializedCwd = readSerializedCwd(entry);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { adapterType, ...rest } = entry;
      return {
        ...rest,
        ...(serializedCwd !== undefined ? { cwd: serializedCwd } : {}),
      };
    }),
  };
  writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

export function resolvePathLikeInput(value: string | undefined, homeDir: string | undefined = process.env.HOME): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') {
    return undefined;
  }

  if (trimmed === '~') {
    return homeDir?.trim() || undefined;
  }

  if (trimmed.startsWith('~/')) {
    const resolvedHome = homeDir?.trim();
    if (!resolvedHome) {
      return trimmed.slice(2);
    }

    return path.join(resolvedHome, trimmed.slice(2));
  }

  return trimmed;
}

export function parseProjectConfigEntries(raw: string): ProjectConfigEntry[] | null {
  if (raw.trim() === '') {
    return null;
  }

  const parsed = JSON.parse(raw) as { projects?: Array<Partial<CodexRuntimeConfig> & { projectInstanceId: string }> };
  if (!Array.isArray(parsed.projects)) {
    return null;
  }

  return parsed.projects
    .filter((entry): entry is Partial<CodexRuntimeConfig> & { projectInstanceId: string } =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.projectInstanceId === 'string' &&
      entry.projectInstanceId.trim() !== ''
    )
    .map((entry) => {
      const normalized = normalizeProjectConfig(entry);
      return createProjectConfigEntry(normalized, typeof entry.cwd === 'string' && entry.cwd.trim() !== '' ? entry.cwd : undefined);
    });
}

export function loadProjectsFromFile(filePath: string): ProjectConfigEntry[] | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const raw = readFileSync(filePath, 'utf8');
    return parseProjectConfigEntries(raw);
  } catch {
    return null;
  }
}

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

function normalizeProjectConfig(input: Partial<CodexRuntimeConfig> & { projectInstanceId: string }): CodexRuntimeConfig {
  const transport = input.transport ?? 'websocket';
  const model = input.model?.trim();
  const adapterType = input.adapterType ?? 'codex';
  const result: CodexRuntimeConfig = {
    projectInstanceId: input.projectInstanceId.trim(),
    command: input.command?.trim() || 'codex',
    args: input.args ?? ['app-server'],
    cwd: resolvePathLikeInput(input.cwd),
    ...(model !== undefined && model !== '' ? { model } : {}),
    serviceName: input.serviceName?.trim() || 'codex-bridge',
    transport,
    websocketUrl: transport === 'stdio' ? undefined : input.websocketUrl?.trim() || 'ws://127.0.0.1:4000',
    adapterType,
  };
  return result;
}

function createProjectConfigEntry(entry: CodexRuntimeConfig, serializedCwd?: string): ProjectConfigEntry {
  const projectConfig = { ...entry } as ProjectConfigEntry;
  if (serializedCwd !== undefined) {
    Object.defineProperty(projectConfig, SERIALIZED_CWD, {
      value: serializedCwd,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  return projectConfig;
}

function readSerializedCwd(entry: ProjectConfigEntry): string | undefined {
  return entry[SERIALIZED_CWD];
}

function parseProjectConfigs(value: string | undefined): CodexRuntimeConfig[] | null {
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
    return {
      projectInstanceId: record.projectInstanceId,
      command: record.command?.trim() || 'codex',
      args: Array.isArray(record.args) ? record.args : ['app-server'],
      cwd: resolvePathLikeInput(record.cwd),
      ...(record.model?.trim() ? { model: record.model.trim() } : {}),
      serviceName: record.serviceName?.trim() || 'codex-bridge',
      transport: record.transport ?? 'websocket',
      websocketUrl:
        (record.transport ?? 'websocket') === 'stdio' ? undefined : record.websocketUrl?.trim() || 'ws://127.0.0.1:4000',
      adapterType: record.adapterType ?? 'codex',
    };
  });
}

function resolveWebSocketUrl(env: RuntimeEnvCodexConfig): string {
  return env.BRIDGE_CODEX_WEBSOCKET_URL?.trim() || 'ws://127.0.0.1:4000';
}

export function resolveCodexRuntimeConfigs(env: RuntimeEnvCodexConfig = process.env): CodexRuntimeConfig[] | null {
  const projects = parseProjectConfigs(env.BRIDGE_CODEX_PROJECTS_JSON);
  if (projects !== null) {
    return projects;
  }

  const projectInstanceId = env.BRIDGE_CODEX_PROJECT_INSTANCE_ID?.trim();
  if (!projectInstanceId) {
    return null;
  }

  return [
    normalizeProjectConfig({
      projectInstanceId,
      command: env.BRIDGE_CODEX_COMMAND?.trim() || 'codex',
      args: parseArgs(env.BRIDGE_CODEX_ARGS_JSON),
      cwd: resolvePathLikeInput(env.BRIDGE_CODEX_CWD, env.HOME ?? process.env.HOME),
      model: env.BRIDGE_CODEX_MODEL?.trim(),
      serviceName: env.BRIDGE_CODEX_SERVICE_NAME?.trim() || 'codex-bridge',
      transport: env.BRIDGE_CODEX_TRANSPORT?.trim() === 'stdio' ? 'stdio' : 'websocket',
      websocketUrl: resolveWebSocketUrl(env),
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
}): CodexRuntimeConfig {
  const model = input.model?.trim();
  const entry = {
    projectInstanceId: input.projectInstanceId.trim(),
    command: input.command?.trim() || 'codex',
    args: input.args ?? ['app-server'],
    cwd: resolvePathLikeInput(input.cwd),
    ...(model !== undefined && model !== '' ? { model } : {}),
    serviceName: input.serviceName?.trim() || 'codex-bridge',
    transport: input.transport ?? 'websocket',
    websocketUrl:
      (input.transport ?? 'websocket') === 'stdio' ? undefined : input.websocketUrl?.trim() || 'ws://127.0.0.1:4000',
  };
  return createProjectConfigEntry(entry, input.cwd?.trim() || undefined);
}
