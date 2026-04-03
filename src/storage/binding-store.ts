export interface BindingStore {
  getSessionByProject(projectInstanceId: string): string | null;
  getProjectBySession(sessionId: string): string | null;
  setBinding(projectInstanceId: string, sessionId: string): void;
  deleteByProject(projectInstanceId: string): void;
  deleteBySession(sessionId: string): void;
  getAllBindings(): BindingRecord[];
}

export interface BindingRecord {
  projectInstanceId: string;
  sessionId: string;
}

export class InMemoryBindingStore implements BindingStore {
  private readonly projectToSession = new Map<string, string>();
  private readonly sessionToProject = new Map<string, string>();

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
}

export interface BindingSnapshot {
  bindings: BindingRecord[];
}
