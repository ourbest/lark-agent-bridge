import { randomUUID } from 'node:crypto';
import type { CodexProjectClient } from '../../runtime/codex-project.ts';
import type { CodexServerRequest } from '../codex/app-server-client.ts';

type QwenCanUseToolResult =
  | { behavior: 'allow'; updatedInput?: unknown; message?: string }
  | { behavior: 'deny'; message?: string };

type QwenCanUseToolContext = {
  signal?: AbortSignal;
};

type QwenUserMessage = {
  type: 'user';
  session_id: string;
  message: {
    role: 'user';
    content: string;
  };
  parent_tool_use_id: null;
};

type QwenAssistantMessage = {
  type?: string;
  message?: {
    content?: Array<
      | { type: 'text'; text?: string }
      | { type: string; text?: string; [key: string]: unknown }
    > | string;
  };
  result?: string;
  is_error?: boolean;
};

type QwenQueryHandle = AsyncIterable<unknown> & {
  getSessionId?: () => string;
  isClosed?: () => boolean;
  close?: () => Promise<void> | void;
  interrupt?: () => Promise<void> | void;
};

type QwenSdkModule = {
  query: (config: {
    prompt: string | AsyncIterable<QwenUserMessage>;
    options?: Record<string, unknown>;
  }) => QwenQueryHandle;
};

export interface QwenCodeClientOptions {
  cwd?: string;
  env?: Record<string, string>;
  model?: string;
  permissionMode?: 'default' | 'plan' | 'auto-edit' | 'yolo';
  pathToQwenExecutable?: string;
  onTextDelta?: (text: string) => void | null;
  onTurnCompleted?: (() => void) | null;
  onNotification?: ((message: { method: string; params?: Record<string, unknown> }) => void | Promise<void>) | null;
  onServerRequest?: ((request: CodexServerRequest) => void | Promise<void>) | null;
  onThreadChanged?: ((threadId: string) => void) | null;
  loadSdk?: () => Promise<QwenSdkModule>;
}

type PendingApproval = {
  toolName?: string;
  input?: unknown;
  resolve: (value: QwenCanUseToolResult) => void;
  reject: (error: Error) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      if (!isRecord(block)) {
        return '';
      }

      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }

      if (typeof block.text === 'string') {
        return block.text;
      }

      return '';
    })
    .join('');
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }

  if (typeof error === 'string' && error.trim() !== '') {
    return error;
  }

  return 'unknown error';
}

function buildApprovalSignature(request: { toolName?: string; input?: unknown } | null): string | null {
  if (request === null) {
    return null;
  }

  const toolName = typeof request.toolName === 'string' ? request.toolName.trim() : '';
  if (toolName === '') {
    return null;
  }

  return `${toolName}:${JSON.stringify(request.input ?? null)}`;
}

function classifyApprovalMethod(toolName: string, input: unknown): string {
  const normalizedTool = toolName.toLowerCase();

  if (
    normalizedTool.includes('edit') ||
    normalizedTool.includes('write') ||
    normalizedTool.includes('patch') ||
    normalizedTool.includes('apply')
  ) {
    return 'item/fileChange/requestApproval';
  }

  if (normalizedTool.includes('permission') || normalizedTool.includes('network')) {
    return 'item/permissions/requestApproval';
  }

  return 'item/commandExecution/requestApproval';
}

function extractCommandFromToolInput(toolName: string, input: unknown): string | null {
  if (typeof input === 'string' && input.trim() !== '') {
    return input;
  }

  if (!isRecord(input)) {
    return toolName;
  }

  if (typeof input.command === 'string' && input.command.trim() !== '') {
    return input.command;
  }

  if (typeof input.file_path === 'string' && input.file_path.trim() !== '') {
    return `${toolName} ${input.file_path}`;
  }

  if (typeof input.path === 'string' && input.path.trim() !== '') {
    return `${toolName} ${input.path}`;
  }

  const text = JSON.stringify(input);
  return text.length > 120 ? `${toolName} ${text.slice(0, 120)}...` : `${toolName} ${text}`;
}

export class QwenCodeClient implements CodexProjectClient {
  private readonly cwd?: string;
  private readonly env: Record<string, string>;
  private readonly model?: string;
  private readonly permissionMode: 'default' | 'plan' | 'auto-edit' | 'yolo';
  private readonly pathToQwenExecutable?: string;
  private readonly loadSdk: () => Promise<QwenSdkModule>;
  private readonly syntheticThreadId: string;

  onTextDelta: ((text: string) => void) | null;
  onTurnCompleted: (() => void) | null;
  onNotification: ((message: { method: string; params?: Record<string, unknown> }) => void | Promise<void>) | null;
  onServerRequest: ((request: CodexServerRequest) => void | Promise<void>) | null;
  onThreadChanged: ((threadId: string) => void) | null;

  private sdkHandle: QwenQueryHandle | null = null;
  private queryStarted = false;
  private stopped = false;
  private sessionId: string = '';
  private turnCounter = 0;
  private requestCounter = 0;
  private currentTurnId: string | null = null;
  private currentTurnBuffer = '';
  private currentTurnResolver: ((value: string) => void) | null = null;
  private currentTurnRejecter: ((error: Error) => void) | null = null;
  private pendingPromptMessages: QwenUserMessage[] = [];
  private pendingPromptWaiters: Array<(value: QwenUserMessage | null) => void> = [];
  private pendingApprovals = new Map<string, PendingApproval>();
  private sessionApprovedRequestSignatures = new Set<string>();

  constructor(options: QwenCodeClientOptions) {
    this.cwd = options.cwd;
    this.env = { ...process.env, ...options.env };
    this.model = options.model;
    this.permissionMode = options.permissionMode ?? 'default';
    this.pathToQwenExecutable = options.pathToQwenExecutable;
    this.loadSdk = options.loadSdk ?? (async () => await import('@qwen-code/sdk') as unknown as QwenSdkModule);
    this.syntheticThreadId = `qwen-${randomUUID()}`;
    this.sessionId = this.syntheticThreadId;
    this.onTextDelta = options.onTextDelta ?? null;
    this.onTurnCompleted = options.onTurnCompleted ?? null;
    this.onNotification = options.onNotification ?? null;
    this.onServerRequest = options.onServerRequest ?? null;
    this.onThreadChanged = options.onThreadChanged ?? null;
  }

  async start(): Promise<void> {
    await this.ensureStarted();
  }

  async generateReply(input: { text: string; cwd?: string }): Promise<string> {
    await this.ensureStarted();
    if (this.currentTurnResolver !== null || this.currentTurnRejecter !== null) {
      throw new Error('Qwen Code client is already processing a turn');
    }

    this.currentTurnBuffer = '';
    this.currentTurnId = `turn_${++this.turnCounter}`;

    const reply = new Promise<string>((resolve, reject) => {
      this.currentTurnResolver = resolve;
      this.currentTurnRejecter = reject;
    });

    this.enqueuePrompt({
      type: 'user',
      session_id: this.sessionId,
      message: {
        role: 'user',
        content: input.text,
      },
      parent_tool_use_id: null,
    });

    return reply;
  }

  async startThread(input?: { cwd?: string; force?: boolean }): Promise<string> {
    await this.ensureStarted();
    if (input?.force === true) {
      if (this.sdkHandle?.close !== undefined) {
        await this.sdkHandle.close();
      }
      this.sdkHandle = null;
      this.queryStarted = false;
      this.sessionId = `qwen-${randomUUID()}`;
      this.onThreadChanged?.(this.sessionId);
    }

    return this.sessionId;
  }

  async resumeThread(input: { threadId: string; cwd?: string }): Promise<string> {
    await this.ensureStarted();
    this.sessionId = input.threadId;
    this.onThreadChanged?.(input.threadId);
    return input.threadId;
  }

  async respondToServerRequest(requestId: number | string, result: unknown): Promise<void> {
    const pending = this.pendingApprovals.get(String(requestId));
    if (pending === undefined) {
      return;
    }

    let behavior: 'allow' | 'deny' = 'allow';
    let message: string | undefined;
    let updatedInput: unknown = pending.input;

    if (result !== null && typeof result === 'object') {
      const response = result as { decision?: string; permissions?: unknown; scope?: string; message?: string };

      if ('decision' in response) {
        if (response.decision === 'decline') {
          behavior = 'deny';
        }

        if (response.decision === 'acceptForSession') {
          const signature = buildApprovalSignature(pending);
          if (signature !== null) {
            this.sessionApprovedRequestSignatures.add(signature);
          }
        }
      } else if ('permissions' in response) {
        behavior = 'allow';
        if (response.scope === 'session') {
          const signature = buildApprovalSignature(pending);
          if (signature !== null) {
            this.sessionApprovedRequestSignatures.add(signature);
          }
        }
      }

      if (typeof response.message === 'string' && response.message.trim() !== '') {
        message = response.message;
      }
    }

    pending.resolve({
      behavior,
      ...(updatedInput !== undefined ? { updatedInput } : {}),
      ...(message !== undefined ? { message } : {}),
    });
    this.pendingApprovals.delete(String(requestId));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.rejectPendingTurn(new Error('Qwen Code client stopped'));
    this.rejectPendingApprovals(new Error('Qwen Code client stopped'));
    this.flushPromptWaiters();
    if (this.sdkHandle?.close !== undefined) {
      await this.sdkHandle.close();
    }
    this.sdkHandle = null;
    this.queryStarted = false;
  }

  private async ensureStarted(): Promise<void> {
    if (this.queryStarted && this.sdkHandle !== null && this.sdkHandle.isClosed?.() !== true) {
      return;
    }

    const sdk = await this.loadSdk();
    const handle = sdk.query({
      prompt: this.createPromptStream(),
      options: {
        cwd: this.cwd,
        model: this.model,
        pathToQwenExecutable: this.pathToQwenExecutable,
        permissionMode: this.permissionMode,
        env: this.env,
        canUseTool: async (toolName: string, input: unknown, context: QwenCanUseToolContext) => {
          return await this.handleCanUseTool(toolName, input, context);
        },
      },
    });

    this.sdkHandle = handle;
    this.queryStarted = true;
    this.sessionId = this.syntheticThreadId;
    this.onThreadChanged?.(this.sessionId);
    this.consumeQuery(handle).catch((error) => {
      const message = toErrorMessage(error);
      this.onNotification?.({ method: 'qwen/error', params: { message } });
      this.rejectPendingTurn(error instanceof Error ? error : new Error(message));
    });
  }

  private async *createPromptStream(): AsyncGenerator<QwenUserMessage, void, void> {
    while (!this.stopped) {
      const message = await this.nextPromptMessage();
      if (message === null) {
        return;
      }

      yield message;
    }
  }

  private async consumeQuery(handle: QwenQueryHandle): Promise<void> {
    try {
      for await (const message of handle) {
        this.handleQueryMessage(message);
      }
    } catch (error) {
      if (!this.stopped) {
        throw error;
      }
    } finally {
      this.sdkHandle = null;
      this.queryStarted = false;
      if (!this.stopped) {
        this.rejectPendingTurn(new Error('Qwen Code session ended unexpectedly'));
        this.rejectPendingApprovals(new Error('Qwen Code session ended unexpectedly'));
      }
    }
  }

  private handleQueryMessage(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }

    if (message.type === 'assistant') {
      const assistant = message as QwenAssistantMessage;
      const text = extractTextFromContent(assistant.message?.content);
      if (text !== '') {
        this.currentTurnBuffer += text;
        this.onTextDelta?.(text);
      }
      return;
    }

    if (message.type === 'result') {
      const result = typeof message.result === 'string' ? message.result : '';
      const reply = this.currentTurnBuffer.trim() !== '' ? this.currentTurnBuffer : result;
      this.currentTurnBuffer = '';
      this.currentTurnId = null;
      this.onTurnCompleted?.();
      this.currentTurnResolver?.(reply);
      this.currentTurnResolver = null;
      this.currentTurnRejecter = null;
      return;
    }

    if (message.type === 'system' && typeof message.session_id === 'string' && message.session_id.trim() !== '') {
      this.sessionId = message.session_id;
      this.onThreadChanged?.(this.sessionId);
    }
  }

  private async handleCanUseTool(toolName: string, input: unknown, context: QwenCanUseToolContext): Promise<QwenCanUseToolResult> {
    const pendingSignature = buildApprovalSignature({ toolName, input });
    if (pendingSignature !== null && this.sessionApprovedRequestSignatures.has(pendingSignature)) {
      return { behavior: 'allow', updatedInput: input };
    }

    const requestId = `qwen-${++this.requestCounter}`;
    const approvalPromise = new Promise<QwenCanUseToolResult>((resolve, reject) => {
      this.pendingApprovals.set(requestId, {
        toolName,
        input,
        resolve,
        reject,
      });

      if (context.signal !== undefined) {
        const abortHandler = (): void => {
          const pending = this.pendingApprovals.get(requestId);
          if (pending !== undefined) {
            pending.reject(new Error('Qwen Code approval request aborted'));
            this.pendingApprovals.delete(requestId);
          }
        };

        if (context.signal.aborted) {
          abortHandler();
          return;
        }

        context.signal.addEventListener('abort', abortHandler, { once: true });
      }
    });

    const method = classifyApprovalMethod(toolName, input);
    const request: CodexServerRequest = {
      id: requestId,
      method,
      params: {
        tool_name: toolName,
        input,
        command: extractCommandFromToolInput(toolName, input),
        threadId: this.sessionId,
        turnId: this.currentTurnId ?? `turn_${this.turnCounter}`,
        itemId: requestId,
      },
    };

    if (this.onServerRequest !== null) {
      void this.onServerRequest(request);
    } else {
      return { behavior: 'allow', updatedInput: input };
    }

    return await approvalPromise;
  }

  private enqueuePrompt(message: QwenUserMessage): void {
    const waiter = this.pendingPromptWaiters.shift();
    if (waiter !== undefined) {
      waiter(message);
      return;
    }

    this.pendingPromptMessages.push(message);
  }

  private async nextPromptMessage(): Promise<QwenUserMessage | null> {
    const queued = this.pendingPromptMessages.shift();
    if (queued !== undefined) {
      return queued;
    }

    return await new Promise<QwenUserMessage | null>((resolve) => {
      this.pendingPromptWaiters.push(resolve);
    });
  }

  private flushPromptWaiters(): void {
    while (this.pendingPromptWaiters.length > 0) {
      const waiter = this.pendingPromptWaiters.shift();
      waiter?.(null);
    }
  }

  private rejectPendingTurn(error: Error): void {
    if (this.currentTurnRejecter !== null) {
      this.currentTurnRejecter(error);
    }

    this.currentTurnResolver = null;
    this.currentTurnRejecter = null;
    this.currentTurnBuffer = '';
    this.currentTurnId = null;
  }

  private rejectPendingApprovals(error: Error): void {
    for (const [requestId, pending] of this.pendingApprovals.entries()) {
      pending.reject(error);
      this.pendingApprovals.delete(requestId);
    }
  }
}
