import { CodexAppServerClient } from '../adapters/codex/app-server-client.ts';
import type { BridgeRouter } from '../core/router/router.ts';
import { createCodexProjectSession, type CodexProjectClient, type CodexProjectSession } from './codex-project.ts';
import type { CodexRuntimeConfig } from './codex-config.ts';

export interface CodexProjectRegistryEntry {
  projectInstanceId: string;
  client: CodexProjectClient;
}

export interface CodexProjectRegistryOptions {
  projects: CodexRuntimeConfig[];
  createClient?: (project: CodexRuntimeConfig) => CodexProjectClient;
}

export class CodexProjectRegistry {
  private readonly sessions: CodexProjectSession[];

  constructor(options: CodexProjectRegistryOptions) {
    const createClient =
      options.createClient ??
      ((project) =>
        new CodexAppServerClient({
          command: project.command,
          args: project.args,
          cwd: project.cwd,
          clientInfo: {
            name: 'lark-agent-bridge',
            title: 'Codex Bridge',
            version: '0.2.0-dev',
          },
          getModel: () => project.model,
          serviceName: project.serviceName,
          transport: project.transport,
          websocketUrl: project.websocketUrl,
        }));

    this.sessions = options.projects.map((project) =>
      createCodexProjectSession({
        projectInstanceId: project.projectInstanceId,
        client: createClient(project),
      }),
    );
  }

  attach(router: Pick<BridgeRouter, 'registerProjectHandler'>): void {
    for (const session of this.sessions) {
      session.attach(router);
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.sessions.map(async (session) => session.stop()));
  }
}

export function createCodexProjectRegistry(options: CodexProjectRegistryOptions | CodexProjectRegistryEntry[]): CodexProjectRegistry {
  if (Array.isArray(options)) {
    return new CodexProjectRegistry({
      projects: options.map((entry) => ({
        projectInstanceId: entry.projectInstanceId,
        command: 'codex',
        args: ['app-server'],
        serviceName: 'lark-agent-bridge',
        cwd: undefined,
        transport: 'websocket',
        websocketUrl: 'ws://127.0.0.1:4000',
      })),
      createClient: (project) => {
        const entry = options.find((candidate) => candidate.projectInstanceId === project.projectInstanceId);
        if (entry === undefined) {
          throw new Error(`Missing Codex client for projectInstanceId: ${project.projectInstanceId}`);
        }
        return entry.client;
      },
    });
  }

  return new CodexProjectRegistry(options);
}
