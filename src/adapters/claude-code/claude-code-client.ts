import { spawn, type ChildProcess } from 'node:child_process';
import type { CodexProjectClient } from '../../runtime/codex-project.ts';
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
onSystemInit?: (data: { model: string; sessionId: string; cwd: string; permissionMode: string }) => void;
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
  onSystemInit: ((data: { model: string; sessionId: string; cwd: string; permissionMode: string }) => void) | null;

  private sessionId: string | null = null;
  private replyBuffer = '';
  private pendingReplyResolver: ((value: string) => void) | null = null;
  private pendingReplyRejecter: ((error: Error) => void) | null = null;
  private pendingRequestResolver: Map<string, (result: unknown) => void> = new Map();
  private pendingServerRequests: Map<string, { toolName?: string; input?: unknown }> = new Map();
  private sessionApprovedRequestSignatures: Set<string> = new Set();
  private stdinReady = false;
  private initialized = false;

  constructor(options: ClaudeCodeClientOptions) {
    this.command = options.command ?? 'claude';
    this.args = options.args ?? ['--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'];
    this.cwd = options.cwd;
    this.env = { ...process.env, ...options.env };
    this.onTextDelta = options.onTextDelta ?? null;
    this.onTurnCompleted = options.onTurnCompleted ?? null;
    this.onNotification = options.onNotification ?? null;
    this.onServerRequest = options.onServerRequest ?? null;
    this.onThreadChanged = options.onThreadChanged ?? null;
    this.onSystemInit = options.onSystemInit ?? null;
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

      // Mark stdin as ready immediately - process is spawned
      this.stdinReady = true;

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
        // Log stderr for debugging - may contain Claude Code logs/warnings
        console.log(`[claude-code:stderr] ${chunk.trim()}`);
      });

      this.proc.on('error', (err) => {
        console.error(`[claude-code] process error: ${err.message}`);
        reject(err);
      });

      this.proc.on('close', (code) => {
        console.log(`[claude-code] process exited with code ${code}`);
        this.proc = null;
      });

      // Wait for initialization - give Claude Code time to start up
      const checkReady = () => {
        if (this.stdinReady) {
          resolve();
        } else {
          setTimeout(checkReady, 50);
        }
      };
      checkReady();

      // Timeout after 30 seconds for slower startup
      setTimeout(() => {
        if (!this.initialized) {
          reject(new Error('Claude Code initialization timeout (cwd=' + this.cwd + ')'));
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

          // Emit system/init data for AgentStatusManager
          this.onSystemInit?.({
            model: msg.model ?? 'unknown',
            sessionId: msg.session_id ?? 'unknown',
            cwd: msg.cwd ?? '',
            permissionMode: msg.request?.mode ?? 'default',
          });
        } else if (msg.subtype === 'status') {
          this.onNotification?.({ method: 'system/status', params: { permissionMode: msg.request?.mode } });
        } else if (msg.subtype === 'hook_started' || msg.subtype === 'hook_response') {
          // Hook events are informational - don't affect initialization
          // stdin is ready once process spawns, even before hooks complete
          this.stdinReady = true;
        }
        break;

      case 'assistant':
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              console.log(`[claude-code] text delta: "${block.text}"`);
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
        // Tool use/result notifications - forward as notification
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              this.onNotification?.({
                method: 'tool/use',
                params: {
                  tool_name: block.tool_name,
                  input: block.input,
                  status: 'started',
                  timestamp: Date.now(),
                },
              });
            } else if (block.type === 'tool_result') {
              this.onNotification?.({
                method: 'tool/use',
                params: {
                  tool_name: block.tool_name,
                  output: (block as { text?: string }).text,
                  status: 'completed',
                  timestamp: Date.now(),
                },
              });
            }
          }
        }
        break;

      case 'result':
        console.log(`[claude-code] result: subtype=${msg.subtype}, result="${msg.result}"`);
        if (msg.subtype === 'success' || msg.subtype === 'error_during_execution' || msg.subtype === 'error_max_turns') {
          if (msg.is_error || msg.subtype === 'error_during_execution' || msg.subtype === 'error_max_turns') {
            const error = new Error(msg.result ?? 'Execution failed');
            this.pendingReplyRejecter?.(error);
          } else {
            // Final result text - already streamed via onTextDelta
            console.log(`[claude-code] resolving reply with buffer="${this.replyBuffer}"`);
            this.onTurnCompleted?.();
            this.pendingReplyResolver?.(this.replyBuffer || (msg.result ?? ''));
          }
          this.replyBuffer = '';
        }
        break;

      case 'control_request':
        // Permission request from Claude Code
        console.log(`[claude-code] control_request: subtype=${msg.request?.subtype}, request_id=${msg.request_id}`);
        if (msg.request && this.onServerRequest) {
          const requestId = msg.request_id ?? '';
          const requestKey = String(requestId);
          const pendingRequest = {
            toolName: msg.request.tool_name,
            input: msg.request.input,
          };
          this.pendingServerRequests.set(requestKey, pendingRequest);
          const signature = this.buildApprovalSignature(pendingRequest);
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
              // Claude Code doesn't provide threadId/turnId/itemId - use sessionId as threadId
              threadId: this.sessionId ?? undefined,
              turnId: msg.uuid ?? undefined,
              itemId: msg.request.tool_use_id ?? undefined,
            } as Record<string, unknown>,
          };

          if (signature !== null && this.sessionApprovedRequestSignatures.has(signature)) {
            void this.respondToServerRequest(request.id, { decision: 'acceptForSession' });
            return;
          }

          // Forward to handler - the handler will call respondToServerRequest which sends control_response
          try {
            void this.onServerRequest(request);
          } catch (err) {
            console.error(`[claude-code] onServerRequest error: ${err}`);
          }
        } else {
          console.log(`[claude-code] control_request ignored: no handler or no request`);
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

  private sendMessage(msg: object): boolean {
    if (!this.proc?.stdin || !this.stdinReady) {
      console.warn(`[claude-code] stdin not ready, cannot send: ${JSON.stringify(msg).slice(0, 100)}`);
      return false;
    }
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n');
      return true;
    } catch (err) {
      console.error(`[claude-code] write error: ${err}`);
      return false;
    }
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

  async sendInput(text: string): Promise<void> {
    if (!this.proc) {
      await this.start();
    }
    const sent = this.sendMessage({
      type: 'user',
      message: {
        role: 'user',
        content: text,
      },
    });
    if (!sent) {
      throw new Error(`Failed to send input: stdin not ready`);
    }
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
    console.log(`[claude-code] respondToServerRequest called: requestId=${requestId}, result=${JSON.stringify(result)}`);
    // Map bridge approval response format to Claude Code control_response format.
    // ApprovalService returns:
    //   { decision: 'accept' | 'acceptForSession' | 'decline' }  - for command/file
    //   { permissions: {...}, scope: 'turn' | 'session' }        - for permissions
    let behavior = 'allow';
    let message: string | undefined;
    const requestKey = String(requestId);
    const pendingRequest = this.pendingServerRequests.get(requestKey) ?? null;
    const signature = this.buildApprovalSignature(pendingRequest);

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
        if (r.decision === 'acceptForSession' && signature !== null) {
          this.sessionApprovedRequestSignatures.add(signature);
        }
      } else if ('permissions' in r) {
        // Permissions response - Claude Code doesn't have a direct equivalent
        // so we allow with empty permissions scope
        behavior = 'allow';
        if (r.scope === 'session' && signature !== null) {
          this.sessionApprovedRequestSignatures.add(signature);
        }
      }
    }

    console.log(`[claude-code] sending control_response: behavior=${behavior}`);
    const sent = this.sendMessage({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: String(requestId),
        response: {
          behavior,
          ...(pendingRequest?.input !== undefined ? { updatedInput: pendingRequest.input } : {}),
          ...(message !== undefined ? { message } : {}),
        },
      },
    });
    if (!sent) {
      throw new Error(`Failed to send control_response: stdin not ready`);
    }
    this.pendingServerRequests.delete(requestKey);
  }

  private buildApprovalSignature(request: { toolName?: string; input?: unknown } | null): string | null {
    if (request === null) {
      return null;
    }

    const toolName = typeof request.toolName === 'string' ? request.toolName.trim() : '';
    if (toolName === '') {
      return null;
    }

    return `${toolName}:${JSON.stringify(request.input ?? null)}`;
  }
}
