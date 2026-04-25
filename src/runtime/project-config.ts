import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SERIALIZED_CWD = Symbol('serializedCwd');

export type ProjectProviderKind = 'codex' | 'cc' | 'qwen' | 'gemini';
export type ProjectProviderName = ProjectProviderKind;

export type PermissionMode = 'plan' | 'auto-edit' | 'yolo';

export interface ProjectProviderConfig {
  id: string;
  kind: ProjectProviderKind;
  transport?: 'stdio' | 'websocket' | 'ssh+stdio';
  port?: number;
  websocketUrl?: string;
  remoteCwd?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshIdentityFile?: string;
  sshCommand?: string;
  sshArgs?: string[];
  provider?: ProjectProviderKind;
}

export interface ProjectConfig {
  projectInstanceId: string;
  cwd: string;
  providers: ProjectProviderConfig[];
  model?: string;
  permissionMode?: PermissionMode;
}

export interface ProjectConfigMetadata {
  [SERIALIZED_CWD]?: string;
}

export type ProjectConfigEntry = ProjectConfig & ProjectConfigMetadata & Record<string, unknown>;

export interface ProjectConfigInput {
  projectInstanceId?: unknown;
  cwd?: unknown;
  providers?: unknown;
}

export const DEFAULT_PROJECT_PROVIDER_NAMES = ['codex', 'cc', 'qwen', 'gemini'] as const;

export function resolvePathLikeInput(
  value: string | undefined,
  homeDir: string | undefined = process.env.HOME,
  baseDir?: string,
): string | undefined {
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

  if (baseDir !== undefined && !path.isAbsolute(trimmed)) {
    return path.resolve(baseDir, trimmed);
  }

  return trimmed;
}

function normalizeProviderKind(value: unknown): ProjectProviderKind {
  if (value !== 'codex' && value !== 'cc' && value !== 'qwen' && value !== 'gemini') {
    throw new Error('provider kind must be one of codex, cc, qwen, or gemini');
  }

  return value;
}

function normalizeProviderTransport(value: unknown): 'stdio' | 'websocket' | 'ssh+stdio' {
  if (value === undefined || value === null || value === '') {
    return 'stdio';
  }

  if (value !== 'stdio' && value !== 'websocket' && value !== 'ssh+stdio') {
    throw new Error('provider transport must be stdio, websocket, or ssh+stdio');
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultProviders(): ProjectProviderConfig[] {
  return DEFAULT_PROJECT_PROVIDER_NAMES.map((provider) => ({
    id: provider,
    kind: provider,
    transport: 'stdio',
  }));
}

export function normalizeProjectProviders(providers: unknown): ProjectProviderConfig[] {
  if (!Array.isArray(providers) || providers.length === 0) {
    return defaultProviders();
  }

  const normalizedProviders: ProjectProviderConfig[] = [];

  for (const entry of providers) {
    if (!isRecord(entry)) {
      throw new Error('providers entries must be objects');
    }

    const id =
      typeof entry.id === 'string' && entry.id.trim() !== ''
        ? entry.id.trim()
        : typeof entry.provider === 'string' && entry.provider.trim() !== ''
          ? entry.provider.trim()
          : '';
    if (id === '') {
      throw new Error('provider id is required');
    }

    const kind = normalizeProviderKind(typeof entry.kind === 'string' ? entry.kind : entry.provider);
    if (normalizedProviders.some((provider) => provider.id === id)) {
      throw new Error(`duplicate provider id: ${id}`);
    }

    normalizedProviders.push({
      id,
      kind,
      transport: normalizeProviderTransport(entry.transport),
      ...(typeof entry.port === 'number' ? { port: entry.port } : {}),
      ...(typeof entry.websocketUrl === 'string' ? { websocketUrl: entry.websocketUrl } : {}),
      ...(typeof entry.remoteCwd === 'string' ? { remoteCwd: entry.remoteCwd } : {}),
      ...(typeof entry.sshHost === 'string' ? { sshHost: entry.sshHost } : {}),
      ...(typeof entry.sshPort === 'number' ? { sshPort: entry.sshPort } : {}),
      ...(typeof entry.sshUser === 'string' ? { sshUser: entry.sshUser } : {}),
      ...(typeof entry.sshIdentityFile === 'string' ? { sshIdentityFile: entry.sshIdentityFile } : {}),
      ...(typeof entry.sshCommand === 'string' ? { sshCommand: entry.sshCommand } : {}),
      ...(Array.isArray(entry.sshArgs) ? { sshArgs: entry.sshArgs as string[] } : {}),
    });
  }

  return normalizedProviders;
}

export function normalizeProjectConfig(input: ProjectConfigInput, options?: { homeDir?: string; baseDir?: string }): ProjectConfig {
  const projectInstanceId = typeof input.projectInstanceId === 'string' ? input.projectInstanceId.trim() : '';
  if (projectInstanceId === '') {
    throw new Error('projectInstanceId is required');
  }

  const cwdValue = typeof input.cwd === 'string' ? input.cwd : '';
  const cwd = resolvePathLikeInput(cwdValue, options?.homeDir, options?.baseDir);
  if (cwd === undefined || cwd.trim() === '') {
    throw new Error('cwd is required');
  }

  return {
    projectInstanceId,
    cwd,
    providers: normalizeProjectProviders(input.providers),
  };
}

export function createProjectConfigEntry(entry: ProjectConfig & Record<string, unknown>, serializedCwd?: string): ProjectConfigEntry {
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

export function cloneProjectConfigEntry(entry: ProjectConfigEntry): ProjectConfigEntry {
  return createProjectConfigEntry(entry, readSerializedCwd(entry));
}

function readSerializedCwd(entry: ProjectConfigEntry): string | undefined {
  return entry[SERIALIZED_CWD];
}

export function writeProjectsFile(filePath: string, projects: ProjectConfigEntry[]): void {
  const snapshot = {
    projects: projects.map((entry) => {
      const serializedCwd = readSerializedCwd(entry);
      return {
        ...entry,
        ...(serializedCwd !== undefined ? { cwd: serializedCwd } : {}),
      };
    }),
  };

  writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

export function parseProjectConfigEntries(raw: string, options?: { homeDir?: string; baseDir?: string }): ProjectConfigEntry[] | null {
  if (raw.trim() === '') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.projects)) {
    return null;
  }

  const projects: ProjectConfigEntry[] = [];
  for (const entry of parsed.projects) {
    try {
      if (!isRecord(entry)) {
        continue;
      }

      const normalized = normalizeProjectConfig(entry, options);
      const { provider: _provider, ...rest } = entry;
      projects.push(
        createProjectConfigEntry(
          {
            ...rest,
            projectInstanceId: normalized.projectInstanceId,
            cwd: normalized.cwd,
            providers: normalized.providers,
          },
          typeof entry.cwd === 'string' && entry.cwd.trim() !== '' ? entry.cwd : undefined,
        ),
      );
    } catch {
      // Skip malformed entries so one bad project does not block the whole file.
    }
  }

  return projects.length === 0 ? null : projects;
}

export function loadProjectsFromFile(filePath: string, options?: { homeDir?: string }): ProjectConfigEntry[] | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }

    const raw = readFileSync(filePath, 'utf8');
    return parseProjectConfigEntries(raw, { ...options, baseDir: path.dirname(filePath) });
  } catch {
    return null;
  }
}
