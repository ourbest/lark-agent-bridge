import { existsSync, readFileSync } from 'node:fs';

export interface RuntimeEnvCodexConfig {
  BRIDGE_CODEX_PROJECTS_JSON?: string;
  BRIDGE_CODEX_PROJECT_INSTANCE_ID?: string;
  BRIDGE_CODEX_COMMAND?: string;
  BRIDGE_CODEX_ARGS_JSON?: string;
  BRIDGE_CODEX_CWD?: string;
  BRIDGE_CODEX_SERVICE_NAME?: string;
  BRIDGE_CODEX_TRANSPORT?: string;
  BRIDGE_CODEX_WEBSOCKET_URL?: string;
}

export interface CodexRuntimeConfig {
  projectInstanceId: string;
  command: string;
  args: string[];
  cwd?: string;
  serviceName: string;
  transport: 'stdio' | 'websocket';
  websocketUrl?: string;
}

export type CodexProjectRuntimeConfig = CodexRuntimeConfig;

export type ProjectConfigEntry = CodexRuntimeConfig;

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
    .map((entry) => normalizeProjectConfig(entry));
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
  return {
    projectInstanceId: input.projectInstanceId.trim(),
    command: input.command?.trim() || 'codex',
    args: input.args ?? ['app-server'],
    cwd: input.cwd?.trim() || undefined,
    serviceName: input.serviceName?.trim() || 'codex-bridge',
    transport,
    websocketUrl: transport === 'stdio' ? undefined : input.websocketUrl?.trim() || 'ws://127.0.0.1:4000',
  };
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
      cwd: record.cwd?.trim() || undefined,
      serviceName: record.serviceName?.trim() || 'codex-bridge',
      transport: record.transport ?? 'websocket',
      websocketUrl:
        (record.transport ?? 'websocket') === 'stdio' ? undefined : record.websocketUrl?.trim() || 'ws://127.0.0.1:4000',
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
      cwd: env.BRIDGE_CODEX_CWD?.trim() || undefined,
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
  serviceName?: string;
  transport?: 'stdio' | 'websocket';
  websocketUrl?: string;
}): CodexRuntimeConfig {
  return {
    projectInstanceId: input.projectInstanceId.trim(),
    command: input.command?.trim() || 'codex',
    args: input.args ?? ['app-server'],
    cwd: input.cwd?.trim() || undefined,
    serviceName: input.serviceName?.trim() || 'codex-bridge',
    transport: input.transport ?? 'websocket',
    websocketUrl:
      (input.transport ?? 'websocket') === 'stdio' ? undefined : input.websocketUrl?.trim() || 'ws://127.0.0.1:4000',
  };
}
