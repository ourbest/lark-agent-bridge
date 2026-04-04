import type { BindingService } from '../core/binding/binding-service.ts';
import type { ProjectState } from '../runtime/project-registry.ts';
import type { ApprovalService } from '../runtime/approval-service.ts';

export interface ChatCommandInput {
  sessionId: string;
  senderId: string;
  text: string;
}

export interface CodexCommandExecutionInput {
  sessionId: string;
  senderId: string;
  projectInstanceId: string;
  command: string;
  args: string[];
}

export interface StructuredCodexCommandExecutionInput {
  sessionId: string;
  senderId: string;
  projectInstanceId: string;
  method: 'app/list' | 'thread/list' | 'thread/read';
  params: Record<string, unknown>;
}

export interface ChatCommandServiceDependencies {
  bindingService: BindingService;
  projectRegistry: {
    describeProject(projectInstanceId: string): Promise<ProjectState>;
    getLastThread?(projectInstanceId: string, sessionId: string): Promise<string | null>;
    resumeThread?(projectInstanceId: string, threadId: string): Promise<string>;
  };
  approvalService?: ApprovalService;
  executeCodexCommand?: (input: CodexCommandExecutionInput) => Promise<string[]>;
  executeStructuredCodexCommand?: (input: StructuredCodexCommandExecutionInput) => Promise<string[]>;
  reloadProjects?: () => Promise<string[]>;
}

export interface ChatCommandService {
  execute(input: ChatCommandInput): Promise<string[] | null>;
}

function isBridgeCommandToken(token: string): boolean {
  return token === 'bind' || token === 'unbind' || token === 'list' || token === 'help' || token === 'sessions' || token === 'reload' || token === 'resume';
}

function isCodexCommandToken(token: string): boolean {
  const root = token.split('/')[0]?.toLowerCase();
  return root === 'app' || root === 'session' || root === 'thread';
}

const SUPPORTED_CODEX_METHODS = new Set([
  'app/list',
  'session/list',
  'thread/list',
  'session/get',
  'thread/get',
  'thread/read',
] as const);

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}

function formatNotBoundMessage(): string[] {
  return ['[codex-bridge] this chat is not bound to any project'];
}

function buildHelpLines(): string[] {
  return [
    '[codex-bridge] commands:',
    '  //bind <projectId>  - bind this chat to a project',
    '  //unbind            - unbind this chat',
    '  //list              - show current binding',
    '  //sessions          - show bridge and codex state',
    '  //reload projects   - reload projects.json',
    '  //resume <threadId|last> - resume a codex thread (threadId comes from thread/list)',
    '  //approvals         - list pending approval requests',
    '  //approve <id>      - approve one request',
    '  //approve-all <id>  - approve one request for the session',
    '  //deny <id>         - deny one request',
    '  //help              - show this help',
    '  app/list            - list codex apps',
    '  session/list        - list codex sessions',
    '  thread/list         - list codex threads',
    '  session/get <id>    - get a codex session',
    '  thread/read <id>    - get a codex thread',
  ];
}

async function buildSessionStateLines(
  bindingService: BindingService,
  projectRegistry: ChatCommandServiceDependencies['projectRegistry'],
  sessionId: string,
  senderId: string,
): Promise<string[] | null> {
  const projectId = await bindingService.getProjectBySession(sessionId);
  if (projectId === null) {
    return formatNotBoundMessage();
  }

  const state = await projectRegistry.describeProject(projectId);
  return [
    '[codex-bridge] Bridge State:',
    `  chatId: ${sessionId}`,
    `  senderId: ${senderId}`,
    `  projectId: ${projectId}`,
    '[codex-bridge] Codex State:',
    `  projectId: ${state.projectInstanceId}`,
    `  configured: ${yesNo(state.configured)}`,
    `  active: ${yesNo(state.active)}`,
    `  removed: ${yesNo(state.removed)}`,
  ];
}

function parseCommand(text: string): { kind: 'bridge' | 'codex' | 'unknown' | 'none'; command: string; args: string[] } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { kind: 'none', command: '', args: [] };
  }

  if (trimmed.startsWith('//')) {
    const parts = trimmed.slice(2).trim().split(/\s+/).filter(Boolean);
    const command = parts[0]?.toLowerCase() ?? '';
    return {
      kind: isBridgeCommandToken(command) ? 'bridge' : 'unknown',
      command,
      args: parts.slice(1),
    };
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const command = parts[0]?.toLowerCase() ?? '';
  if (isBridgeCommandToken(command)) {
    return {
      kind: 'bridge',
      command,
      args: parts.slice(1),
    };
  }

  if (isCodexCommandToken(command)) {
    return {
      kind: 'codex',
      command: parts[0] ?? '',
      args: parts.slice(1),
    };
  }

  return { kind: 'none', command, args: parts.slice(1) };
}

function buildUnknownCommandLines(input: string): string[] {
  return [
    `[codex-bridge] unknown command: ${input.trim()}`,
    ...buildHelpLines(),
  ];
}

function buildCodexSupportNotConfiguredLines(projectId: string, method: string): string[] {
  return [
    '[codex-bridge] codex command support is not configured',
    `  projectId: ${projectId}`,
    `  command: ${method}`,
  ];
}

function resolveCodexCommand(
  command: string,
  args: string[],
): { kind: 'supported'; method: StructuredCodexCommandExecutionInput['method']; params: Record<string, unknown>; legacyArgs: string[] } | { kind: 'unsupported'; raw: string } | { kind: 'usage'; lines: string[] } {
  const normalizedCommand = command.toLowerCase();
  if (!SUPPORTED_CODEX_METHODS.has(normalizedCommand as StructuredCodexCommandExecutionInput['method'])) {
    return { kind: 'unsupported', raw: command };
  }

  if (normalizedCommand === 'app/list' || normalizedCommand === 'session/list' || normalizedCommand === 'thread/list') {
    if (args.length > 0) {
      return { kind: 'usage', lines: [`Usage: ${normalizedCommand}`] };
    }

    return {
      kind: 'supported',
      method: normalizedCommand === 'app/list' ? 'app/list' : 'thread/list',
      params: {},
      legacyArgs: [],
    };
  }

  if (args.length !== 1) {
    return { kind: 'usage', lines: [`Usage: ${normalizedCommand} <id>`] };
  }

  return {
    kind: 'supported',
    method: 'thread/read',
    params: {
      id: args[0],
    },
    legacyArgs: args.slice(0, 1),
  };
}

export function createChatCommandService(dependencies: ChatCommandServiceDependencies): ChatCommandService {
  return {
    async execute(input: ChatCommandInput): Promise<string[] | null> {
      if (dependencies.approvalService !== undefined) {
        const approvalLines = await dependencies.approvalService.handleCommand({
          sessionId: input.sessionId,
          text: input.text,
        });
        if (approvalLines !== null) {
          return approvalLines;
        }
      }

      const parsed = parseCommand(input.text);

      if (parsed.kind === 'none') {
        return null;
      }

      if (parsed.kind === 'unknown') {
        return buildUnknownCommandLines(input.text);
      }

      if (parsed.kind === 'bridge') {
        switch (parsed.command) {
          case 'bind': {
            if (parsed.args.length === 0) {
              return ['Usage: //bind <projectId>'];
            }
            const projectId = parsed.args[0];
            await dependencies.bindingService.bindProjectToSession(projectId, input.sessionId);
            return [`[codex-bridge] bound chat ${input.sessionId} to project "${projectId}"`];
          }

          case 'unbind': {
            await dependencies.bindingService.unbindSession(input.sessionId);
            return [`[codex-bridge] unbound session ${input.sessionId}`];
          }

          case 'list': {
            const projectId = await dependencies.bindingService.getProjectBySession(input.sessionId);
            if (projectId === null) {
              return formatNotBoundMessage();
            }
            return [
              '[codex-bridge] current binding:',
              `  chatId: ${input.sessionId}`,
              `  senderId: ${input.senderId}`,
              `  projectId: ${projectId}`,
            ];
          }

          case 'sessions':
            return await buildSessionStateLines(
              dependencies.bindingService,
              dependencies.projectRegistry,
              input.sessionId,
              input.senderId,
            );

          case 'resume': {
            if (parsed.args.length !== 1) {
              return ['Usage: //resume <threadId|last>'];
            }

            const projectId = await dependencies.bindingService.getProjectBySession(input.sessionId);
            if (projectId === null) {
              return formatNotBoundMessage();
            }

            const requestedThreadId =
              parsed.args[0].toLowerCase() === 'last'
                ? dependencies.projectRegistry.getLastThread === undefined
                  ? null
                  : await dependencies.projectRegistry.getLastThread(projectId, input.sessionId)
                : parsed.args[0];

            if (requestedThreadId === null) {
              return ['[codex-bridge] no previous thread available for this chat'];
            }

            if (dependencies.projectRegistry.resumeThread === undefined) {
              return ['[codex-bridge] thread resume is not configured'];
            }

            const resumedThreadId = await dependencies.projectRegistry.resumeThread(projectId, requestedThreadId);
            return [`[codex-bridge] resumed thread ${resumedThreadId} for this chat`];
          }

          case 'reload': {
            if (parsed.args.length !== 1 || parsed.args[0] !== 'projects') {
              return ['Usage: //reload projects'];
            }

            if (dependencies.reloadProjects === undefined) {
              return ['[codex-bridge] project reload is not configured'];
            }

            return await dependencies.reloadProjects();
          }

          case 'help':
          default:
            return buildHelpLines();
        }
      }

      const projectId = await dependencies.bindingService.getProjectBySession(input.sessionId);
      if (projectId === null) {
        return formatNotBoundMessage();
      }

      const resolved = resolveCodexCommand(parsed.command, parsed.args);
      if (resolved.kind === 'unsupported') {
        return buildUnknownCommandLines(input.text);
      }

      if (resolved.kind === 'usage') {
        return resolved.lines;
      }

      if (dependencies.executeStructuredCodexCommand !== undefined) {
        return await dependencies.executeStructuredCodexCommand({
          sessionId: input.sessionId,
          senderId: input.senderId,
          projectInstanceId: projectId,
          method: resolved.method,
          params: resolved.params,
        });
      }

      if (dependencies.executeCodexCommand !== undefined) {
        return await dependencies.executeCodexCommand({
          sessionId: input.sessionId,
          senderId: input.senderId,
          projectInstanceId: projectId,
          command: resolved.method,
          args: resolved.legacyArgs,
        });
      }

      return buildCodexSupportNotConfiguredLines(projectId, resolved.method);
    },
  };
}
