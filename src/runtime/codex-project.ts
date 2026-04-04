import type { InboundMessage, ProjectReply } from '../core/events/message.ts';
import type { BridgeRouter } from '../core/router/router.ts';
import type { CodexServerRequest } from '../adapters/codex/app-server-client.ts';

export interface CodexProjectClient {
  generateReply(input: { text: string; cwd?: string }): Promise<string>;
  executeCommand?(input: { method: string; params: Record<string, unknown> }): Promise<unknown>;
  resumeThread?(input: { threadId: string; cwd?: string }): Promise<string>;
  onServerRequest?: ((request: CodexServerRequest) => void | Promise<void>) | null;
  onThreadChanged?: ((threadId: string) => void) | null;
  respondToServerRequest?: (requestId: number | string, result: unknown) => Promise<void>;
  stop(): Promise<void>;
  onTextDelta?: ((text: string) => void) | null;
  onTurnCompleted?: (() => void) | null;
}

export interface CodexProjectSessionOptions {
  projectInstanceId: string;
  client: CodexProjectClient;
}

type ProjectMessageHandler = (input: {
  projectInstanceId: string;
  message: InboundMessage;
}) => Promise<ProjectReply | null>;

export class CodexProjectSession {
  private readonly projectInstanceId: string;
  private readonly client: CodexProjectClient;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: CodexProjectSessionOptions) {
    this.projectInstanceId = options.projectInstanceId;
    this.client = options.client;
  }

  attach(router: Pick<BridgeRouter, 'registerProjectHandler'>): void {
    const handler: ProjectMessageHandler = async ({ message }) => {
      const text = await this.enqueue(() => this.client.generateReply({ text: message.text }));
      return { text };
    };

    router.registerProjectHandler(this.projectInstanceId, handler);
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  async executeCommand(input: { method: string; params: Record<string, unknown> }): Promise<unknown> {
    if (this.client.executeCommand === undefined) {
      throw new Error('Structured Codex commands are not supported by this client');
    }

    return await this.client.executeCommand(input);
  }

  async resumeThread(input: { threadId: string; cwd?: string }): Promise<string> {
    if (this.client.resumeThread === undefined) {
      throw new Error('Thread resume is not supported by this client');
    }

    return await this.client.resumeThread(input);
  }

  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const execution = this.queue.then(task, task);
    this.queue = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }
}

export function createCodexProjectSession(options: CodexProjectSessionOptions): CodexProjectSession {
  return new CodexProjectSession(options);
}
