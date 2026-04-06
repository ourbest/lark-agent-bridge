import { spawn, type ChildProcess } from 'node:child_process';
import { CodexProjectClient } from '../../runtime/codex-project.ts';
import type { CodexServerRequest } from '../codex/app-server-client.ts';

export interface ClaudeCodeClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  onTextDelta?: (text: string) => void | null;
  onTurnCompleted?: (() => void) | null;
  onNotification?: ((message: { method: string; params?: Record<string, unknown> }) => void | Promise<void>) | null;
  onServerRequest?: ((request: CodexServerRequest) => void | Promise<void>) | null;
  onThreadChanged?: ((threadId: string) => void) | null;
  respondToServerRequest?: (requestId: number | string, result: unknown) => Promise<void>;
}

interface ClaudeCodeMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string; tool_use?: unknown; tool_use_id?: string; tool_name?: string; input?: unknown; thinking?: string; signature?: string }>;
    id?: string;
    model?: string;
    stop_reason?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  permission_denials?: string[];
  request_id?: string;
  request?: {
    subtype: string;
    tool_name?: string;
    input?: unknown;
    tool_use_id?: string;
    permission_suggestions?: string[];
    blocked_path?: string;
    decision_reason?: string;
    mode?: string;
  };
  response?: {
    subtype: string;
    request_id?: string;
    response?: unknown;
    behavior?: string;
    updatedInput?: unknown;
    message?: string;
  };
}

export class ClaudeCodeClient implements CodexProjectClient {
  private proc: ChildProcess | null = null;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly env: Record<string, string>;

  onTextDelta: ((text: string) => void | null) | null;
  onTurnCompleted: (() => void) | null;
  onNotification: ((message: { method: string; params?: Record<string, unknown> }) => void | Promise<void>) | null;
  onServerRequest: ((request: CodexServerRequest) => void | Promise<void>) | null;
  onThreadChanged: ((threadId: string) => void) | null;
  respondToServerRequest: ((requestId: number | string, result: unknown) => Promise<void>) | null;

  private sessionId: string | null = null;
  private replyBuffer = '';
  private pendingReplyResolver: ((value: string) => void) | null = null;
  private pendingReplyRejecter: ((error: Error) => void) | null = null;
  private pendingRequestResolver: Map<string, (result: unknown) => void> = new Map();
  private stdinReady = false;
  private initialized = false;

  constructor(options: ClaudeCodeClientOptions) {
    this.command = options.command ?? 'claude';
    this.args = options.args ?? ['--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio', '--verbose'];
    this.cwd = options.cwd;
    this.env = { ...process.env, ...options.env };
    this.onTextDelta = options.onTextDelta ?? null;
    this.onTurnCompleted = options.onTurnCompleted ?? null;
    this.onNotification = options.onNotification ?? null;
    this.onServerRequest = options.onServerRequest ?? null;
    this.onThreadChanged = options.onThreadChanged ?? null;
    this.respondToServerRequest = options.respondToServerRequest ?? null;
  }

  async start(): Promise<void> {
    if (this.proc) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.proc = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.proc.stdout?.setEncoding('utf8');
      this.proc.stderr?.setEncoding('utf8');

      let stdoutBuffer = '';

      this.proc.stdout?.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim() === '') continue;
          this.handleMessage(line);
        }
      });

      this.proc.stderr?.on('data', (chunk: string) => {
        // Claude Code outputs logs to stderr - can be ignored or logged
        console.error(`[claude-code] ${chunk.trim()}`);
      });

      this.proc.on('error', (err) => {
        console.error(`[claude-code] process error: ${err.message}`);
        reject(err);
      });

      this.proc.on('close', (code) => {
        console.log(`[claude-code] process exited with code ${code}`);
        this.proc = null;
      });

      // Wait for stdin to be ready
      const checkReady = () => {
        if (this.stdinReady) {
          resolve();
        } else {
          setTimeout(checkReady, 10);
        }
      };
      checkReady();

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!this.initialized) {
          reject(new Error('Claude Code initialization timeout'));
        }
      }, 10000);
    });
  }

  private handleMessage(line: string): void {
    let msg: ClaudeCodeMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`[claude-code] failed to parse: ${line}`);
      return;
    }

    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          const previousSessionId = this.sessionId;
          this.sessionId = msg.session_id ?? null;
          this.stdinReady = true;
          this.initialized = true;
          this.onThreadChanged?.(this.sessionId ?? 'default');
          // Notify if session was restored after process restart (context lost)
          if (previousSessionId !== null && previousSessionId !== this.sessionId) {
            this.onNotification?.({ method: 'session/reset', params: { previousSessionId, newSessionId: this.sessionId } });
          }
          this.onNotification?.({ method: 'system/init', params: { session_id: msg.session_id, tools: msg.message?.content } });
        } else if (msg.subtype === 'status') {
          this.onNotification?.({ method: 'system/status', params: { permissionMode: msg.request?.mode } });
        }
        break;

      case 'assistant':
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              this.replyBuffer += block.text;
              this.onTextDelta?.(block.text);
            } else if (block.type === 'thinking' && block.thinking) {
              // Optionally forward thinking as notification
              this.onNotification?.({ method: 'assistant/thinking', params: { thinking: block.thinking } });
            }
          }
        }
        break;

      case 'user':
        // Tool result returned - forward as notification
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_result') {
              this.onNotification?.({ method: 'tool/result', params: { tool_use_id: block.tool_use_id, content: block } });
            }
          }
        }
        break;

      case 'result':
        if (msg.subtype === 'success' || msg.subtype === 'error_during_execution' || msg.subtype === 'error_max_turns') {
          if (msg.is_error || msg.subtype === 'error_during_execution' || msg.subtype === 'error_max_turns') {
            const error = new Error(msg.result ?? 'Execution failed');
            this.pendingReplyRejecter?.(error);
          } else {
            // Final result text - already streamed via onTextDelta
            this.onTurnCompleted?.();
            this.pendingReplyResolver?.(this.replyBuffer || (msg.result ?? ''));
          }
          this.replyBuffer = '';
        }
        break;

      case 'control_request':
        // Permission request from Claude Code
        if (msg.request && this.onServerRequest) {
          const requestId = msg.request_id ?? '';
          const request: CodexServerRequest = {
            id: requestId,
            method: `item/${msg.request.subtype}/requestApproval`,
            params: {
              tool_name: msg.request.tool_name,
              input: msg.request.input,
              tool_use_id: msg.request.tool_use_id,
              permission_suggestions: msg.request.permission_suggestions,
              blocked_path: msg.request.blocked_path,
              decision_reason: msg.request.decision_reason,
              mode: msg.request.mode,
            } as Record<string, unknown>,
          };

          // Forward to handler - the handler will call respondToServerRequest which sends control_response
          void this.onServerRequest(request);
        }
        break;

      case 'control_response':
        // Response to our control_request
        if (msg.response?.request_id) {
          const resolver = this.pendingRequestResolver.get(msg.response.request_id);
          if (resolver) {
            resolver(msg.response);
            this.pendingRequestResolver.delete(msg.response.request_id);
          }
        }
        break;

      case 'stream_event':
        // Partial message events (requires --include-partial-messages)
        // Not typically used, but handled for completeness
        break;
    }
  }

  private sendMessage(msg: object): void {
    if (!this.proc?.stdin) {
      throw new Error('Process stdin not available');
    }
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  async generateReply(input: { text: string; cwd?: string }): Promise<string> {
    if (!this.proc) {
      await this.start();
    }

    this.replyBuffer = '';
    this.pendingReplyResolver = null;
    this.pendingReplyRejecter = null;

    return new Promise((resolve, reject) => {
      this.pendingReplyResolver = resolve;
      this.pendingReplyRejecter = reject;

      this.sendMessage({
        type: 'user',
        message: {
          role: 'user',
          content: input.text,
        },
      });
    });
  }

  async startThread(input?: { cwd?: string; force?: boolean }): Promise<string> {
    // Claude Code doesn't have explicit thread start - each message is in the same session
    // We just return the session id
    if (!this.proc) {
      await this.start();
    }
    return this.sessionId ?? 'default';
  }

  async resumeThread(input: { threadId: string; cwd?: string }): Promise<string> {
    // Claude Code sessions cannot be restored across process restarts.
    // The session_id is tied to the running CLI process - if it restarts,
    // a fresh session begins with no conversation history.
    // resumeThread here just ensures the local sessionId matches.
    if (!this.proc) {
      await this.start();
    }
    this.sessionId = input.threadId;
    return input.threadId;
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this.sessionId = null;
      this.initialized = false;
      this.stdinReady = false;
    }
  }

  async respondToServerRequest(requestId: number | string, result: unknown): Promise<void> {
    // Map bridge approval response format to Claude Code control_response format.
    // ApprovalService returns:
    //   { decision: 'accept' | 'acceptForSession' | 'decline' }  - for command/file
    //   { permissions: {...}, scope: 'turn' | 'session' }        - for permissions
    let behavior = 'allow';
    let message: string | undefined;

    if (result !== null && typeof result === 'object') {
      const r = result as { decision?: string; permissions?: unknown; scope?: string; message?: string };

      if ('decision' in r) {
        // { decision: 'accept' | 'acceptForSession' | 'decline' }
        if (r.decision === 'decline') {
          behavior = 'deny';
        } else {
          behavior = 'allow'; // 'accept' and 'acceptForSession' both allow
        }
        if (typeof r.message === 'string') {
          message = r.message;
        }
      } else if ('permissions' in r) {
        // Permissions response - Claude Code doesn't have a direct equivalent
        // so we allow with empty permissions scope
        behavior = 'allow';
      }
    }

    this.sendMessage({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: String(requestId),
        response: {
          behavior,
          ...(message !== undefined ? { message } : {}),
        },
      },
    });
  }
}
