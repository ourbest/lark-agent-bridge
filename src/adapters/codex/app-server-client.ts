import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { allocateWebSocketPort } from './websocket-port.ts';

const WEBSOCKET_RECONNECT_DELAY_MS = 100;

export interface CodexClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface CodexGenerateReplyInput {
  text: string;
  cwd?: string;
}

export interface CodexStartThreadInput {
  cwd?: string;
  force?: boolean;
}

export interface CodexResumeThreadInput {
  threadId: string;
  cwd?: string;
}

export interface CodexExecuteCommandInput {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexProcess {
  stdin: {
    write(chunk: string): boolean;
  };
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface CodexWebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export interface CodexServerRequest {
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerClientOptions {
  command: string;
  args?: string[];
  clientInfo: CodexClientInfo;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  getModel?: () => string | undefined;
  serviceName?: string;
  transport?: 'stdio' | 'websocket';
  websocketUrl?: string;
  onTextDelta?: (text: string) => void;
  onTurnCompleted?: () => void;
  onThreadChanged?: (threadId: string) => void;
  onStderr?: (text: string) => void;
  allocateWebSocketPort?: () => Promise<number>;
  connectWebSocket?: (url: string) => Promise<CodexWebSocketLike>;
  spawnAppServer?: (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => CodexProcess;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private activeTransport: 'stdio' | 'websocket';
  private process: CodexProcess | null = null;
  private reader: ReturnType<typeof createInterface> | null = null;
  private socket: CodexWebSocketLike | null = null;
  private nextRequestId = 0;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private threadId: string | null = null;
  private pendingReplyResolver: ((value: string) => void) | null = null;
  private pendingReplyRejecter: ((error: Error) => void) | null = null;
  private replyChunks: string[] = [];
  private finalReplyText: string | null = null;
  private currentReplyDeltaCount = 0;
  private currentReplyCompletedCount = 0;
  private currentReplyTurnId: string | null = null;
  private currentReplyStatus: string | null = null;
  private currentReplyAborted = false;
  private jsonBuffer = '';
  onTextDelta: ((text: string) => void) | null = null;
  onTurnCompleted: (() => void) | null = null;
  onThreadChanged: ((threadId: string) => void) | null = null;
  onNotification: ((message: { method: string; params?: Record<string, unknown> }) => void) | null = null;
  onServerRequest: ((request: CodexServerRequest) => void | Promise<void>) | null = null;

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
    this.activeTransport = options.transport ?? 'stdio';
  }

  private resolveModel(defaultModel: string): string {
    return this.options.getModel?.() ?? this.options.model ?? defaultModel;
  }

  async generateReply(input: CodexGenerateReplyInput): Promise<string> {
    await this.ensureStarted();
    await this.ensureThread(input.cwd);

    this.replyChunks = [];
    this.finalReplyText = null;
    this.currentReplyDeltaCount = 0;
    this.currentReplyCompletedCount = 0;
    this.currentReplyTurnId = null;
    this.currentReplyStatus = null;
    this.currentReplyAborted = false;
    const reply = new Promise<string>((resolve, reject) => {
      this.pendingReplyResolver = resolve;
      this.pendingReplyRejecter = reject;
    });

    await this.sendRequest('turn/start', {
      approvalPolicy: 'on-request',
      cwd: input.cwd ?? this.options.cwd,
      input: [{ type: 'text', text: input.text }],
      model: this.resolveModel('gpt-5.4-mini'),
      sandbox: 'workspace-write',
      threadId: this.threadId,
    });

    return reply;
  }

  async startThread(input: CodexStartThreadInput): Promise<string> {
    await this.ensureStarted();

    if (this.threadId !== null && input.force !== true) {
      return this.threadId;
    }

    const response = await this.sendRequest('thread/start', {
      approvalPolicy: 'on-request',
      cwd: input.cwd ?? this.options.cwd,
      model: this.resolveModel('gpt-5.4-mini'),
      sandbox: 'workspace-write',
      personality: 'friendly',
      serviceName: this.options.serviceName ?? 'lark-agent-bridge',
    });

    const threadId = this.readString(response, ['thread', 'id']);
    if (threadId === null) {
      throw new Error('Codex app-server thread/start response did not include thread.id');
    }

    this.threadId = threadId;
    this.onThreadChanged?.(threadId);
    this.options.onThreadChanged?.(threadId);
    return threadId;
  }

  async executeCommand(input: CodexExecuteCommandInput): Promise<unknown> {
    await this.ensureStarted();
    return await this.sendRequest(input.method, input.params);
  }

  async resumeThread(input: CodexResumeThreadInput): Promise<string> {
    await this.ensureStarted();

    const response = await this.sendRequest('thread/resume', {
      threadId: input.threadId,
      persistExtendedHistory: true,
      cwd: input.cwd ?? this.options.cwd,
    });

    const threadId = this.readString(response, ['thread', 'id']) ?? input.threadId;
    this.threadId = threadId;
    this.onThreadChanged?.(threadId);
    this.options.onThreadChanged?.(threadId);
    return threadId;
  }

  async listThreads(): Promise<Array<Record<string, unknown>>> {
    await this.ensureStarted();
    const response = await this.sendRequest('thread/list', {});
    return this.readArray(response, ['threads']);
  }

  async cancelThread(id: string): Promise<void> {
    await this.ensureStarted();
    await this.sendRequest('thread/cancel', { threadId: id });
  }

  async pauseThread(id: string): Promise<void> {
    await this.ensureStarted();
    await this.sendRequest('thread/pause', { threadId: id });
  }

  async abortCurrentTask(): Promise<boolean> {
    if (this.pendingReplyRejecter === null) {
      return false;
    }

    this.currentReplyAborted = true;
    this.replyChunks = [];
    this.finalReplyText = null;

    const error = new Error('task aborted');
    error.name = 'AbortError';
    this.pendingReplyRejecter(error);
    this.pendingReplyResolver = null;
    this.pendingReplyRejecter = null;
    return true;
  }

  async respondToServerRequest(requestId: number | string, result: unknown): Promise<void> {
    await this.ensureStarted();
    this.sendRaw({ id: requestId, result });
  }

  async stop(): Promise<void> {
    this.reader?.close();
    this.reader = null;
    this.socket?.close();
    this.socket = null;
    if (this.process !== null) {
      this.process.kill();
      this.process = null;
    }
    this.currentReplyAborted = false;
  }

  private async ensureStarted(): Promise<void> {
    if (this.process !== null) {
      return;
    }

    if (this.socket !== null) {
      if (this.isSocketOpen()) {
        return;
      }

      this.handleConnectionClosed();
    }

    if (this.activeTransport === 'websocket') {
      await this.ensureWebSocketStartedWithRetry();
    } else {
      const spawnAppServer =
        this.options.spawnAppServer ??
        ((command, args, options) =>
          spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: 'pipe',
          }) as ChildProcessWithoutNullStreams);

      const args = this.buildArgs('stdio', null);
      const env = {
        ...process.env,
        ...this.options.env,
      };
      const spawned = spawnAppServer(this.options.command, args, {
        cwd: this.options.cwd,
        env,
      });

      this.process = spawned;
      spawned.on('error', (error) => {
        this.handleProcessTermination(error instanceof Error ? error : new Error(String(error)));
      });
      spawned.on('exit', (code, signal) => {
        if (this.process === spawned) {
          const reason =
            code === 0
              ? new Error('Codex app-server exited unexpectedly')
              : new Error(`Codex app-server exited with code ${code ?? 'null'}${signal !== null ? ` signal ${signal}` : ''}`);
          this.handleProcessTermination(reason);
        }
      });
      spawned.stderr?.on('data', (chunk) => {
        this.options.onStderr?.(String(chunk));
      });

      this.reader = createInterface({ input: spawned.stdout });
      this.reader.on('line', (line) => {
        this.jsonBuffer += line;
        try {
          JSON.parse(this.jsonBuffer);
        } catch (err) {
          if (!(err instanceof SyntaxError)) {
            this.jsonBuffer = '';
            return;
          }
          const isIncompleteString = err.message.includes('Unterminated string');
          if (!isIncompleteString) {
            this.options.onStderr?.(`[codex-app-server-client] non-JSON output: ${line.slice(0, 200)}`);
            this.jsonBuffer = '';
            return;
          }
          this.jsonBuffer += '\n';
          return;
        }
        void this.handleMessage(this.jsonBuffer);
        this.jsonBuffer = '';
      });
    }

    const initialize = this.sendRequest('initialize', {
      clientInfo: this.options.clientInfo,
      capabilities: {
        experimentalApi: true,
      },
    });
    this.sendNotification('initialized', {});
    await initialize;
  }

  private async ensureWebSocketStartedWithRetry(): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.startWebSocketTransport();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === 0 && this.isRetryableWebSocketError(lastError)) {
          await new Promise((resolve) => setTimeout(resolve, WEBSOCKET_RECONNECT_DELAY_MS));
          continue;
        }
        break;
      }
    }

    throw lastError ?? new Error('Codex websocket connection failed');
  }

  private async startWebSocketTransport(): Promise<void> {
    const websocketUrl = await this.resolveWebSocketUrl();
    this.socket = await this.connectWebSocket(websocketUrl);
    this.socket.onmessage = (event) => {
      void this.handleMessage(String(event.data));
    };
    this.socket.onclose = () => {
      this.handleConnectionClosed();
    };
    this.socket.onerror = (event) => {
      this.handleConnectionError(event);
    };
  }

  private async ensureThread(cwd?: string): Promise<void> {
    if (this.threadId !== null) {
      return;
    }

    const response = await this.sendRequest('thread/start', {
      approvalPolicy: 'on-request',
      cwd,
      model: this.options.model ?? 'gpt-5.4-mini',
      sandbox: 'workspace-write',
      serviceName: this.options.serviceName ?? 'lark-agent-bridge',
    });

    const threadId = this.readString(response, ['thread', 'id']);
    if (threadId === null) {
      throw new Error('Codex app-server thread/start response did not include thread.id');
    }

    this.threadId = threadId;
    this.onThreadChanged?.(threadId);
    this.options.onThreadChanged?.(threadId);
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (this.process === null && this.socket === null) {
      throw new Error('Codex app-server transport is not started');
    }

    this.sendRaw({ method, params });
  }

  private async sendRequest(method: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    if (this.process === null && this.socket === null) {
      throw new Error('Codex app-server transport is not started');
    }

    const id = this.nextRequestId++;
    const message = { id, method, params };

    let timeoutId: NodeJS.Timeout | null = null;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request "${method}" (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      this.sendRaw(message);
      return await response;
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }
  }

  private sendRaw(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    if (this.socket !== null) {
      if (!this.isSocketOpen()) {
        this.handleConnectionClosed();
        throw new Error('Codex websocket connection closed');
      }
      this.socket.send(payload);
      return;
    }

    if (this.process !== null) {
      this.process.stdin.write(`${payload}\n`);
      return;
    }

    throw new Error('Codex app-server transport is not started');
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
    };

    try {
      message = JSON.parse(raw) as typeof message;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.warn(`[codex-app-server-client] failed to parse JSON message (${error.message}): ${raw.slice(0, 200)}`);
      return;
    }

    if (message.id !== undefined && message.method !== undefined) {
      this.onServerRequest?.({
        id: message.id,
        method: message.method,
        params: message.params ?? {},
      });
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending !== undefined) {
        this.pendingRequests.delete(message.id);
        if (message.error !== undefined) {
          pending.reject(new Error(message.error.message ?? 'Codex app-server request failed'));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (message.method !== undefined) {
      this.onNotification?.({
        method: message.method,
        params: message.params,
      });
    }

    if (message.method === 'item/agentMessage/delta') {
      if (this.currentReplyAborted) {
        return;
      }
      const text = this.readString(message.params, ['text']);
      if (text !== null) {
        this.currentReplyDeltaCount += 1;
        this.replyChunks.push(text);
        this.options.onTextDelta?.(text);
        this.onTextDelta?.(text);
      }
      return;
    }

    if (message.method === 'item/completed') {
      if (this.currentReplyAborted) {
        return;
      }
      const item = this.readRecord(message.params, ['item']);
      const text = this.readItemText(item);
      this.currentReplyCompletedCount += 1;
      if (text !== null) {
        this.finalReplyText = text;
      }
      return;
    }

    if (message.method === 'error') {
      const errorMessage = this.readErrorMessage(message.params);
      this.pendingReplyRejecter?.(new Error(errorMessage));
      this.pendingReplyResolver = null;
      this.pendingReplyRejecter = null;
      return;
    }

    if (message.method === 'turn/completed') {
      if (this.currentReplyAborted) {
        return;
      }
      const status = this.readTurnStatus(message.params);
      this.currentReplyStatus = status;
      this.currentReplyTurnId =
        this.readString(message.params, ['turnId']) ?? this.readString(message.params, ['turn', 'id']);
      if (status === 'failed' || status === 'interrupted') {
        const errorMessage = this.readErrorMessage(message.params) ?? 'Codex turn failed';
        this.pendingReplyRejecter?.(new Error(errorMessage));
        this.pendingReplyResolver = null;
        this.pendingReplyRejecter = null;
        return;
      }

      const reply = this.finalReplyText ?? this.replyChunks.join('');
      if (reply.trim() === '') {
        console.warn(
          `[codex-app-server-client] empty reply: thread=${this.threadId ?? 'n/a'} turn=${this.currentReplyTurnId ?? 'n/a'} status=${this.currentReplyStatus ?? 'unknown'} deltas=${this.currentReplyDeltaCount} completedItems=${this.currentReplyCompletedCount}`,
        );
      }
      this.replyChunks = [];
      this.finalReplyText = null;
      this.options.onTurnCompleted?.();
      this.onTurnCompleted?.();
      this.pendingReplyResolver?.(reply);
      this.pendingReplyResolver = null;
      this.pendingReplyRejecter = null;
      return;
    }
  }

  private buildArgs(transport: 'stdio' | 'websocket', websocketUrl: string | null): string[] {
    const args = [...(this.options.args ?? ['app-server'])];
    if (transport === 'websocket') {
      args.push('--listen', websocketUrl ?? 'ws://127.0.0.1:0');
    }
    return args;
  }

  private async resolveAllocatedWebSocketPort(): Promise<number> {
    if (this.options.allocateWebSocketPort !== undefined) {
      return await this.options.allocateWebSocketPort();
    }

    return await allocateWebSocketPort();
  }

  private async resolveWebSocketUrl(): Promise<string> {
    if (this.options.websocketUrl !== undefined) {
      return this.options.websocketUrl;
    }

    const port = await this.resolveAllocatedWebSocketPort();
    return `ws://127.0.0.1:${port}`;
  }

  private async connectWebSocket(url: string): Promise<CodexWebSocketLike> {
    const connectWebSocket =
      this.options.connectWebSocket ??
      (async (targetUrl: string) => {
        const socket = new WebSocket(targetUrl) as unknown as CodexWebSocketLike;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (fn: () => void) => {
            if (settled) {
              return;
            }
            settled = true;
            fn();
          };
          socket.onopen = () => settle(() => resolve());
          socket.onerror = () => settle(() => reject(new Error(`Failed to connect to Codex websocket at ${targetUrl}`)));
          socket.onclose = () => settle(() => reject(new Error(`Codex websocket closed before opening at ${targetUrl}`)));
        });
        return socket;
      });

    return await connectWebSocket(url);
  }

  private handleConnectionClosed(): void {
    this.handleConnectionTermination(new Error('Codex websocket connection closed'));
  }

  private handleConnectionError(event: unknown): void {
    this.handleConnectionTermination(this.readErrorEvent(event));
  }

  private handleConnectionTermination(error: Error): void {
    this.handleProcessTermination(error);
  }

  private isRetryableWebSocketError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('websocket') ||
      message.includes('connection closed') ||
      message.includes('failed to connect') ||
      message.includes('closed before opening')
    );
  }

  private handleProcessTermination(error: Error): void {
    this.socket = null;
    this.process = null;
    this.threadId = null;
    this.replyChunks = [];
    this.finalReplyText = null;
    this.currentReplyDeltaCount = 0;
    this.currentReplyCompletedCount = 0;
    this.currentReplyTurnId = null;
    this.currentReplyStatus = null;
    this.currentReplyAborted = false;

    const pendingRequests = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const pending of pendingRequests) {
      pending.reject(error);
    }

    this.pendingReplyResolver = null;
    this.pendingReplyRejecter?.(error);
    this.pendingReplyRejecter = null;
  }

  private isSocketOpen(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  private readString(value: unknown, path: string[]): string | null {
    let current: unknown = value;
    for (const segment of path) {
      if (typeof current !== 'object' || current === null || !(segment in current)) {
        return null;
      }
      current = (current as Record<string, unknown>)[segment];
    }

    return typeof current === 'string' ? current : null;
  }

  private readRecord(value: unknown, path: string[]): Record<string, unknown> | null {
    let current: unknown = value;
    for (const segment of path) {
      if (typeof current !== 'object' || current === null || !(segment in current)) {
        return null;
      }
      current = (current as Record<string, unknown>)[segment];
    }

    return typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : null;
  }

  private readArray(value: unknown, path: string[]): Array<Record<string, unknown>> {
    let current: unknown = value;
    for (const segment of path) {
      if (typeof current !== 'object' || current === null || !(segment in current)) {
        return [];
      }
      current = (current as Record<string, unknown>)[segment];
    }

    return Array.isArray(current) ? (current as Array<Record<string, unknown>>) : [];
  }

  private readItemText(item: Record<string, unknown> | null): string | null {
    if (item === null) {
      return null;
    }

    return this.readTextValue(item.text) ?? this.readTextValue(item.content);
  }

  private readTextValue(value: unknown): string | null {
    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const part of value) {
        const text = this.readTextValue(part);
        if (text !== null) {
          parts.push(text);
        }
      }
      return parts.length > 0 ? parts.join('') : null;
    }

    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      return this.readTextValue(record.text) ?? this.readTextValue(record.content);
    }

    return null;
  }

  private readTurnStatus(params: Record<string, unknown> | undefined): string | null {
    const turn = params?.turn;
    if (typeof turn === 'object' && turn !== null && 'status' in turn) {
      const status = (turn as Record<string, unknown>).status;
      return typeof status === 'string' ? status : null;
    }

    const status = params?.status;
    return typeof status === 'string' ? status : null;
  }

  private readErrorMessage(params: Record<string, unknown> | undefined): string | null {
    const candidates = [params?.error, params?.turn && typeof params.turn === 'object' ? (params.turn as Record<string, unknown>).error : undefined];
    for (const candidate of candidates) {
      if (typeof candidate === 'object' && candidate !== null) {
        const message = (candidate as Record<string, unknown>).message;
        if (typeof message === 'string' && message.trim()) {
          return message;
        }
      }
    }

    return null;
  }

  private readErrorEvent(event: unknown): Error {
    if (event instanceof Error) {
      return event;
    }

    if (typeof event === 'object' && event !== null) {
      const message = (event as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return new Error(message);
      }
    }

    return new Error('Codex websocket connection error');
  }
}
