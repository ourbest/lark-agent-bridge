import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ToolCallEntry {
  timestamp: number;
  toolName: string;
  input?: string;
  output?: string;
  status: 'started' | 'completed' | 'failed';
}

export interface AgentStatusState {
  model: string | null;
  sessionId: string | null;
  cwd: string | null;
  permissionMode: string | null;
  gitStatus: 'modified' | 'clean' | 'unknown';
  gitBranch: string | null;
  gitDiffStat: string | null;
  backgroundTasks: Array<{ id: string; name: string; status: string }>;
  toolCalls: ToolCallEntry[];
}

export interface SystemInitData {
  model?: string;
  sessionId?: string;
  cwd?: string;
  permissionMode?: string;
}

export class AgentStatusManager {
  private states = new Map<string, AgentStatusState>();

  updateFromSystemInit(projectId: string, data: SystemInitData): void {
    const state = this.getOrCreateState(projectId);
    if (data.model !== undefined) state.model = data.model;
    if (data.sessionId !== undefined) state.sessionId = data.sessionId;
    if (data.cwd !== undefined) state.cwd = data.cwd;
    if (data.permissionMode !== undefined) state.permissionMode = data.permissionMode;
  }

  async updateGitState(projectId: string, cwd: string): Promise<void> {
    const state = this.getOrCreateState(projectId);
    try {
      const [statusOut, branchOut, diffStatOut] = await Promise.all([
        execFileAsync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }),
        execFileAsync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }),
        execFileAsync('git', ['diff', '--stat'], { cwd, encoding: 'utf8' }),
      ]);
      state.gitStatus = statusOut.trim() === '' ? 'clean' : 'modified';
      state.gitBranch = branchOut.trim() || null;
      state.gitDiffStat = diffStatOut.trim().split('\n').pop() || null;
    } catch {
      state.gitStatus = 'unknown';
      state.gitBranch = null;
      state.gitDiffStat = null;
    }
  }

  setBackgroundTasks(projectId: string, tasks: Array<{ id: string; name: string; status: string }>): void {
    const state = this.getOrCreateState(projectId);
    state.backgroundTasks = tasks;
  }

  addToolCall(projectId: string, entry: ToolCallEntry): void {
    const state = this.states.get(projectId);
    if (state) {
      state.toolCalls.push(entry);
    }
  }

  clearToolCalls(projectId: string): void {
    const state = this.states.get(projectId);
    if (state) {
      state.toolCalls = [];
    }
  }

  getStatus(projectId: string): AgentStatusState {
    return this.getOrCreateState(projectId);
  }

  private getOrCreateState(projectId: string): AgentStatusState {
    let state = this.states.get(projectId);
    if (!state) {
      state = {
        model: null,
        sessionId: null,
        cwd: null,
        permissionMode: null,
        gitStatus: 'unknown',
        gitBranch: null,
        gitDiffStat: null,
        backgroundTasks: [],
        toolCalls: [],
      };
      this.states.set(projectId, state);
    }
    return state;
  }
}