import fs from 'node:fs';
import path from 'node:path';

import type { BindingRecord, BindingSnapshot, BindingStore, ThreadMemoryRecord, ThreadMemoryStore } from './binding-store.ts';

function ensureDirectory(filePath: string): void {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function readSnapshot(filePath: string): BindingSnapshot {
  if (!fs.existsSync(filePath)) {
    return { bindings: [], threadMemories: [] };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim() === '') {
    return { bindings: [], threadMemories: [] };
  }

  const parsed = JSON.parse(raw) as Partial<BindingSnapshot>;
  const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : [];
  const threadMemories = Array.isArray(parsed.threadMemories) ? parsed.threadMemories : [];
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
  };
}

function writeSnapshot(filePath: string, snapshot: BindingSnapshot): void {
  ensureDirectory(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

export class JsonBindingStore implements BindingStore {
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
    }));
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
}
