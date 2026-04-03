import type { CodexProjectClient } from './codex-project-registry.ts';

export interface ProjectConfig {
  projectInstanceId: string;
  websocketUrl: string;
}

export interface ProjectRegistryOptions {
  getProjectConfig: (projectInstanceId: string) => ProjectConfig | null;
  createClient: (projectInstanceId: string, websocketUrl: string) => CodexProjectClient;
}

export interface ProjectRegistry {
  onBindingChanged(event: { type: string; projectId?: string; sessionId?: string }): Promise<void>;
  getHandler(projectInstanceId: string): ((input: { projectInstanceId: string; message: { text: string } }) => Promise<{ text: string } | null>) | null;
  stop(): Promise<void>;
}

export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  // projectId -> { client, bindingCount, sessions: Set<string> }
  const activeProjects = new Map<string, { client: CodexProjectClient; bindingCount: number; sessions: Set<string> }>();

  async function disconnectProject(projectId: string): Promise<void> {
    const entry = activeProjects.get(projectId);
    if (entry) {
      await entry.client.stop();
      activeProjects.delete(projectId);
    }
  }

  return {
    async onBindingChanged(event: { type: string; projectId?: string; sessionId?: string }) {
      if (event.type === 'bound' && event.projectId && event.sessionId) {
        let entry = activeProjects.get(event.projectId);

        if (!entry) {
          const config = options.getProjectConfig(event.projectId);
          if (!config) return;

          entry = {
            client: options.createClient(event.projectId, config.websocketUrl),
            bindingCount: 0,
            sessions: new Set(),
          };
          activeProjects.set(event.projectId, entry);
        }

        entry.sessions.add(event.sessionId);
        entry.bindingCount = entry.sessions.size;
      }

      if ((event.type === 'session-unbound' || event.type === 'unbound') && (event.projectId || event.sessionId)) {
        let projectId = event.projectId ?? '';
        const sessionId = event.sessionId ?? '';

        // Find project by session if needed
        if (!projectId && sessionId) {
          for (const [pid, entry] of activeProjects) {
            if (entry.sessions.has(sessionId)) {
              projectId = pid;
              break;
            }
          }
        }

        if (!projectId) return;

        const entry = activeProjects.get(projectId);
        if (!entry) return;

        if (sessionId) {
          entry.sessions.delete(sessionId);
        }

        if (entry.sessions.size === 0) {
          await disconnectProject(projectId);
        } else {
          entry.bindingCount = entry.sessions.size;
        }
      }
    },

    getHandler(projectInstanceId) {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) return null;

      return async ({ message }) => {
        try {
          const text = await entry.client.generateReply({ text: message.text });
          return { text };
        } catch {
          return null;
        }
      };
    },

    async stop() {
      const projectIds = Array.from(activeProjects.keys());
      await Promise.all(projectIds.map((id) => disconnectProject(id)));
    },
  };
}
