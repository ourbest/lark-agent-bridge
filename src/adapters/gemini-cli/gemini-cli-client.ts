import { spawn, type ChildProcess } from 'node:child_process';
import type { CodexProjectClient } from '../../runtime/codex-project.ts';

export interface GeminiCliClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  onTextDelta?: (text: string) => void | null;
  onTurnCompleted?: (() => void) | null;
  onNotification?: ((message: { method: string; params?: Record<string, unknown> }) => void | Promise<void>) | null;
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

export class GeminiCliClient implements CodexProjectClient {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly env: Record<string, string>;

  onTextDelta: ((text: string) => void) | null;
  onTurnCompleted: (() => void) | null;
  onNotification: ((message: { method: string; params?: Record<string, unknown> }) => void | Promise<void>) | null;

  private proc: ChildProcess | null = null;
  private currentReplyResolver: ((value: string) => void) | null = null;
  private currentReplyRejecter: ((error: Error) => void) | null = null;
  private currentReplyText = '';
  private stderrText = '';

  constructor(options: GeminiCliClientOptions) {
    this.command = options.command ?? 'gemini';
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = { ...process.env, ...options.env };
    this.onTextDelta = options.onTextDelta ?? null;
    this.onTurnCompleted = options.onTurnCompleted ?? null;
    this.onNotification = options.onNotification ?? null;
  }

  async generateReply(input: { text: string; cwd?: string }): Promise<string> {
    if (this.proc !== null) {
      throw new Error('Gemini CLI client is already processing a turn');
    }

    this.currentReplyText = '';
    this.stderrText = '';

    return await new Promise<string>((resolve, reject) => {
      this.currentReplyResolver = resolve;
      this.currentReplyRejecter = reject;

      const proc = spawn(this.command, [...this.args, '-p', input.text], {
        cwd: input.cwd ?? this.cwd,
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = proc;

      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');

      proc.stdout?.on('data', (chunk: string) => {
        const text = String(chunk);
        if (text !== '') {
          this.currentReplyText += text;
          this.onTextDelta?.(text);
        }
      });

      proc.stderr?.on('data', (chunk: string) => {
        const text = String(chunk);
        if (text !== '') {
          this.stderrText += text;
          this.onNotification?.({ method: 'gemini/stderr', params: { chunk: text } });
        }
      });

      proc.on('error', (error) => {
        this.finishWithError(error);
      });

      proc.on('close', (code) => {
        if (code === 0) {
          const reply = this.currentReplyText.trim();
          this.finishWithSuccess(reply);
          return;
        }

        this.finishWithError(new Error(this.buildExitErrorMessage(code)));
      });
    });
  }

  async stop(): Promise<void> {
    if (this.proc === null) {
      return;
    }

    const proc = this.proc;
    this.proc = null;
    proc.kill();

    const error = new Error('Gemini CLI client stopped');
    this.currentReplyRejecter?.(error);
    this.resetTurnState();
  }

  private finishWithSuccess(reply: string): void {
    this.proc = null;
    this.onTurnCompleted?.();
    this.currentReplyResolver?.(reply);
    this.resetTurnState();
  }

  private finishWithError(error: unknown): void {
    this.proc = null;
    this.currentReplyRejecter?.(new Error(toErrorMessage(error)));
    this.resetTurnState();
  }

  private buildExitErrorMessage(code: number | null): string {
    const pieces = [`[gemini-cli] exited with code ${code ?? 'unknown'}`];
    const stderr = this.stderrText.trim();
    if (stderr !== '') {
      pieces.push(stderr);
    }

    return pieces.join(' ');
  }

  private resetTurnState(): void {
    this.currentReplyResolver = null;
    this.currentReplyRejecter = null;
    this.currentReplyText = '';
    this.stderrText = '';
  }
}
