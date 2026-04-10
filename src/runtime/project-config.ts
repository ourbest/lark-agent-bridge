import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SERIALIZED_CWD = Symbol('serializedCwd');

export type ProjectProviderName = 'codex' | 'cc' | 'qwen' | 'gemini';

export interface ProjectProviderConfig {
  provider: ProjectProviderName;
  transport?: 'stdio' | 'websocket';
  port?: number;
}

export interface ProjectConfig {
  projectInstanceId: string;
  cwd: string;
  providers: ProjectProviderConfig[];
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

function normalizeProviderName(value: unknown): ProjectProviderName {
  if (value !== 'codex' && value !== 'cc' && value !== 'qwen' && value !== 'gemini') {
    throw new Error('provider must be one of codex, cc, qwen, or gemini');
  }

  return value;
}

function normalizeProviderTransport(value: unknown): 'stdio' | 'websocket' {
  if (value === undefined || value === null || value === '') {
    return 'stdio';
  }

  if (value !== 'stdio' && value !== 'websocket') {
    throw new Error('provider transport must be stdio or websocket');
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultProviders(): ProjectProviderConfig[] {
  return DEFAULT_PROJECT_PROVIDER_NAMES.map((provider) => ({
    provider,
    transport: 'stdio',
  }));
}

export function normalizeProjectProviders(providers: unknown): ProjectProviderConfig[] {
  if (!Array.isArray(providers) || providers.length === 0) {
    return defaultProviders();
  }

  return providers.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('providers entries must be objects');
    }

    return {
      provider: normalizeProviderName(entry.provider),
      transport: normalizeProviderTransport(entry.transport),
      ...(typeof entry.port === 'number' ? { port: entry.port } : {}),
    };
  });
}

export function normalizeProjectConfig(input: ProjectConfigInput, options?: { homeDir?: string }): ProjectConfig {
  const projectInstanceId = typeof input.projectInstanceId === 'string' ? input.projectInstanceId.trim() : '';
  if (projectInstanceId === '') {
    throw new Error('projectInstanceId is required');
  }

  const cwdValue = typeof input.cwd === 'string' ? input.cwd : '';
  const cwd = resolvePathLikeInput(cwdValue, options?.homeDir);
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

export function parseProjectConfigEntries(raw: string, options?: { homeDir?: string }): ProjectConfigEntry[] | null {
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
      projects.push(
        createProjectConfigEntry(
          {
            ...entry,
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
    return parseProjectConfigEntries(raw, options);
  } catch {
    return null;
  }
}
