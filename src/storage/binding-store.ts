export interface BindingStore {
  getSessionByProject(projectInstanceId: string): string | null;
  getProjectBySession(sessionId: string): string | null;
  setBinding(projectInstanceId: string, sessionId: string): void;
  deleteByProject(projectInstanceId: string): void;
  deleteBySession(sessionId: string): void;
  getAllBindings(): BindingRecord[];
}

export interface ThreadMemoryRecord {
  projectInstanceId: string;
  sessionId: string;
  threadId: string;
}

export interface ThreadMemoryStore {
  getLastThreadId(projectInstanceId: string, sessionId: string): string | null;
  setLastThreadId(projectInstanceId: string, sessionId: string, threadId: string): void;
  deleteLastThreadByProject(projectInstanceId: string): void;
  deleteLastThreadBySession(sessionId: string): void;
}

export interface BindingRecord {
  projectInstanceId: string;
  sessionId: string;
}

export class InMemoryBindingStore implements BindingStore {
  private readonly projectToSession = new Map<string, string>();
  private readonly sessionToProject = new Map<string, string>();
  private readonly lastThreads = new Map<string, Map<string, string>>();

  getSessionByProject(projectInstanceId: string): string | null {
    return this.projectToSession.get(projectInstanceId) ?? null;
  }

  getProjectBySession(sessionId: string): string | null {
    return this.sessionToProject.get(sessionId) ?? null;
  }

  setBinding(projectInstanceId: string, sessionId: string): void {
    this.deleteByProject(projectInstanceId);
    this.deleteBySession(sessionId);

    this.projectToSession.set(projectInstanceId, sessionId);
    this.sessionToProject.set(sessionId, projectInstanceId);
  }

  deleteByProject(projectInstanceId: string): void {
    const sessionId = this.projectToSession.get(projectInstanceId);
    if (sessionId !== undefined) {
      this.projectToSession.delete(projectInstanceId);
      this.sessionToProject.delete(sessionId);
    }
  }

  deleteBySession(sessionId: string): void {
    const projectInstanceId = this.sessionToProject.get(sessionId);
    if (projectInstanceId !== undefined) {
      this.sessionToProject.delete(sessionId);
      this.projectToSession.delete(projectInstanceId);
    }
  }

  getAllBindings(): BindingRecord[] {
    return Array.from(this.projectToSession.entries()).map(
      ([projectInstanceId, sessionId]) => ({ projectInstanceId, sessionId }),
    );
  }

  getLastThreadId(projectInstanceId: string, sessionId: string): string | null {
    return this.lastThreads.get(projectInstanceId)?.get(sessionId) ?? null;
  }

  setLastThreadId(projectInstanceId: string, sessionId: string, threadId: string): void {
    let projectThreads = this.lastThreads.get(projectInstanceId);
    if (projectThreads === undefined) {
      projectThreads = new Map<string, string>();
      this.lastThreads.set(projectInstanceId, projectThreads);
    }

    projectThreads.set(sessionId, threadId);
  }

  deleteLastThreadByProject(projectInstanceId: string): void {
    this.lastThreads.delete(projectInstanceId);
  }

  deleteLastThreadBySession(sessionId: string): void {
    for (const [projectInstanceId, projectThreads] of this.lastThreads) {
      projectThreads.delete(sessionId);
      if (projectThreads.size === 0) {
        this.lastThreads.delete(projectInstanceId);
      }
    }
  }
}

export interface BindingSnapshot {
  bindings: BindingRecord[];
  threadMemories: ThreadMemoryRecord[];
}
