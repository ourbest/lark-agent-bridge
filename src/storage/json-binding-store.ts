import fs from 'node:fs';
import path from 'node:path';

import type {
  BindingRecord,
  BindingSnapshot,
  BindingStore,
  BridgeProjectStateRecord,
  BridgeStateStore,
  ThreadMemoryRecord,
  ThreadMemoryStore,
} from './binding-store.ts';

function ensureDirectory(filePath: string): void {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function readSnapshot(filePath: string): BindingSnapshot {
  if (!fs.existsSync(filePath)) {
    return { bindings: [], threadMemories: [], projectStates: [], mutedSessions: [] };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim() === '') {
    return { bindings: [], threadMemories: [], projectStates: [], mutedSessions: [] };
  }

  const parsed = JSON.parse(raw) as Partial<BindingSnapshot>;
  const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : [];
  const threadMemories = Array.isArray(parsed.threadMemories) ? parsed.threadMemories : [];
  const projectStates = Array.isArray(parsed.projectStates) ? parsed.projectStates : [];
  const mutedSessions = Array.isArray(parsed.mutedSessions) ? parsed.mutedSessions.filter((id): id is string => typeof id === 'string') : [];
  return {
    bindings: bindings
      .filter((entry): entry is BindingRecord => {
        return (
          typeof entry === 'object' &&
          entry !== null &&
          typeof entry.projectInstanceId === 'string' &&
          typeof entry.sessionId === 'string'
        );
      })
      .map((entry) => ({
        projectInstanceId: entry.projectInstanceId,
        sessionId: entry.sessionId,
        sessionName: typeof entry.sessionName === 'string' ? entry.sessionName : undefined,
      })),
    threadMemories: threadMemories
      .filter((entry): entry is ThreadMemoryRecord => {
        return (
          typeof entry === 'object' &&
          entry !== null &&
          typeof entry.projectInstanceId === 'string' &&
          typeof entry.sessionId === 'string' &&
          typeof entry.threadId === 'string'
        );
      })
      .map((entry) => ({
        projectInstanceId: entry.projectInstanceId,
        sessionId: entry.sessionId,
        threadId: entry.threadId,
      })),
    projectStates: projectStates
      .filter((entry): entry is BridgeProjectStateRecord => {
        return (
          typeof entry === 'object' &&
          entry !== null &&
          typeof entry.projectInstanceId === 'string'
        );
      })
      .map((entry) => ({
        projectInstanceId: entry.projectInstanceId,
        ...(typeof entry.activeProvider === 'string' && entry.activeProvider.trim() !== ''
          ? { activeProvider: entry.activeProvider }
          : {}),
        ...(typeof entry.websocketPorts === 'object' && entry.websocketPorts !== null && !Array.isArray(entry.websocketPorts)
          ? {
              websocketPorts: Object.fromEntries(
                Object.entries(entry.websocketPorts).filter(([, value]) => typeof value === 'number'),
              ),
            }
          : {}),
        ...(Array.isArray(entry.startedProviders)
          ? { startedProviders: entry.startedProviders.filter((value): value is string => typeof value === 'string' && value.trim() !== '') }
          : {}),
      })),
    mutedSessions,
  };
}

function writeSnapshot(filePath: string, snapshot: BindingSnapshot): void {
  ensureDirectory(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function cloneProjectState(state: BridgeProjectStateRecord): BridgeProjectStateRecord {
  return {
    projectInstanceId: state.projectInstanceId,
    ...(state.activeProvider !== undefined ? { activeProvider: state.activeProvider } : {}),
    ...(state.websocketPorts !== undefined ? { websocketPorts: { ...state.websocketPorts } } : {}),
    ...(state.startedProviders !== undefined ? { startedProviders: [...state.startedProviders] } : {}),
  };
}

export class JsonBindingStore implements BindingStore, ThreadMemoryStore, BridgeStateStore, MuteStateStore {
  private readonly filePath: string;
  private snapshot: BindingSnapshot;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.snapshot = readSnapshot(filePath);
  }

  private persist(): void {
    writeSnapshot(this.filePath, this.snapshot);
  }

  private removeProject(projectInstanceId: string): void {
    this.snapshot.bindings = this.snapshot.bindings.filter(
      (entry) => entry.projectInstanceId !== projectInstanceId,
    );
  }

  private removeSession(sessionId: string): void {
    this.snapshot.bindings = this.snapshot.bindings.filter((entry) => entry.sessionId !== sessionId);
  }

  private removeThreadProject(projectInstanceId: string): void {
    this.snapshot.threadMemories = this.snapshot.threadMemories.filter(
      (entry) => entry.projectInstanceId !== projectInstanceId,
    );
  }

  private removeThreadSession(sessionId: string): void {
    this.snapshot.threadMemories = this.snapshot.threadMemories.filter((entry) => entry.sessionId !== sessionId);
  }

  private removeProjectState(projectInstanceId: string): void {
    this.snapshot.projectStates = this.snapshot.projectStates.filter(
      (entry) => entry.projectInstanceId !== projectInstanceId,
    );
  }

  getSessionByProject(projectInstanceId: string): string | null {
    const binding = this.snapshot.bindings.find((entry) => entry.projectInstanceId === projectInstanceId);
    return binding?.sessionId ?? null;
  }

  getProjectBySession(sessionId: string): string | null {
    const binding = this.snapshot.bindings.find((entry) => entry.sessionId === sessionId);
    return binding?.projectInstanceId ?? null;
  }

  setBinding(projectInstanceId: string, sessionId: string): void {
    this.removeProject(projectInstanceId);
    this.removeSession(sessionId);
    this.snapshot.bindings.push({ projectInstanceId, sessionId });
    this.persist();
  }

  deleteByProject(projectInstanceId: string): void {
    this.removeProject(projectInstanceId);
    this.persist();
  }

  deleteBySession(sessionId: string): void {
    this.removeSession(sessionId);
    this.persist();
  }

  getAllBindings(): BindingRecord[] {
    return this.snapshot.bindings.map((entry) => ({
      projectInstanceId: entry.projectInstanceId,
      sessionId: entry.sessionId,
      ...(entry.sessionName !== undefined ? { sessionName: entry.sessionName } : {}),
    }));
  }

  updateSessionName(sessionId: string, name: string): void {
    this.snapshot.bindings = this.snapshot.bindings.map((entry) =>
      entry.sessionId === sessionId ? { ...entry, sessionName: name } : entry,
    );
    this.persist();
  }

  getLastThreadId(projectInstanceId: string, sessionId: string): string | null {
    const memory = this.snapshot.threadMemories.find(
      (entry) => entry.projectInstanceId === projectInstanceId && entry.sessionId === sessionId,
    );
    return memory?.threadId ?? null;
  }

  setLastThreadId(projectInstanceId: string, sessionId: string, threadId: string): void {
    this.snapshot.threadMemories = this.snapshot.threadMemories.filter(
      (entry) => !(entry.projectInstanceId === projectInstanceId && entry.sessionId === sessionId),
    );
    this.snapshot.threadMemories.push({ projectInstanceId, sessionId, threadId });
    this.persist();
  }

  deleteLastThreadByProject(projectInstanceId: string): void {
    this.removeThreadProject(projectInstanceId);
    this.persist();
  }

  deleteLastThreadBySession(sessionId: string): void {
    this.removeThreadSession(sessionId);
    this.persist();
  }

  getProjectState(projectInstanceId: string): BridgeProjectStateRecord | null {
    const state = this.snapshot.projectStates.find((entry) => entry.projectInstanceId === projectInstanceId);
    return state === undefined ? null : cloneProjectState(state);
  }

  getAllProjectStates(): BridgeProjectStateRecord[] {
    return this.snapshot.projectStates.map((state) => cloneProjectState(state));
  }

  setProjectState(state: BridgeProjectStateRecord): void {
    this.removeProjectState(state.projectInstanceId);
    this.snapshot.projectStates.push(cloneProjectState(state));
    this.persist();
  }

  deleteProjectState(projectInstanceId: string): void {
    this.removeProjectState(projectInstanceId);
    this.persist();
  }

  isMuted(sessionId: string): boolean {
    return this.snapshot.mutedSessions.includes(sessionId);
  }

  mute(sessionId: string): void {
    if (!this.snapshot.mutedSessions.includes(sessionId)) {
      this.snapshot.mutedSessions.push(sessionId);
      this.persist();
    }
  }

  unmute(sessionId: string): void {
    this.snapshot.mutedSessions = this.snapshot.mutedSessions.filter((id) => id !== sessionId);
    this.persist();
  }

  getAllMutedSessions(): string[] {
    return [...this.snapshot.mutedSessions];
  }
}
