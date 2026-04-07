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
  method: 'app/list' | 'thread/list' | 'thread/read' | 'review/start';
  params: Record<string, unknown>;
}

export interface ChatCommandServiceDependencies {
  bindingService: BindingService;
  projectRegistry: {
    describeProject(projectInstanceId: string): Promise<ProjectState>;
    getProjectConfig?(projectInstanceId: string): { cwd?: string | null; model?: string | null } | null;
    updateProjectConfig?(projectInstanceId: string, input: { model?: string | null }): Promise<{ model?: string | null } | null> | { model?: string | null } | null;
    startThread?(projectInstanceId: string, options?: { cwd?: string; force?: boolean }): Promise<string>;
    getLastThread?(projectInstanceId: string, sessionId: string): Promise<string | null>;
    resumeThread?(projectInstanceId: string, threadId: string): Promise<string>;
  };
  approvalService?: ApprovalService;
  getCodexStatusLines?: () => Promise<string[]>;
  executeCodexCommand?: (input: CodexCommandExecutionInput) => Promise<string[]>;
  executeStructuredCodexCommand?: (input: StructuredCodexCommandExecutionInput) => Promise<string[]>;
  reloadProjects?: () => Promise<string[]>;
}

export interface ChatCommandService {
  execute(input: ChatCommandInput): Promise<string[] | null>;
}

function isBridgeCommandToken(token: string): boolean {
  return token === 'bind' || token === 'unbind' || token === 'list' || token === 'help' || token === 'status' || token === 'sessions' || token === 'read' || token === 'restart' || token === 'reload' || token === 'resume' || token === 'new' || token === 'model';
}

function isCodexCommandToken(token: string): boolean {
  const root = token.split('/')[0]?.toLowerCase();
  return root === 'app' || root === 'session' || root === 'thread' || root === 'review';
}

const SUPPORTED_CODEX_METHODS = new Set([
  'app/list',
  'session/list',
  'thread/list',
  'thread/read',
  'review',
] as const);

type SupportedCodexMethod =
  | 'app/list'
  | 'session/list'
  | 'thread/list'
  | 'thread/read'
  | 'review/start';

const REVIEW_USAGE = 'Usage: review [--uncommitted | --base <branch> | --commit <sha> [--title <title>] | <instructions>]';

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
    '  //new               - start a new codex thread for this chat',
    '  //status            - show bridge and codex state',
    '  //read <path>       - read a project file as a card',
    '  //model <model>     - set the project model',
    '  //restart           - restart the bridge process',
    '  //reload projects   - reload projects.json',
    '  //resume <threadId|last> - resume a codex thread (threadId comes from thread/list)',
    '  //approvals         - list pending approval requests',
    '  //approve <id>      - approve one request',
    '  //approve-all <id>  - approve one request for the session',
    '  //approve-auto <minutes> - auto-approve this chat for N minutes',
    '  //deny <id>         - deny one request',
    '  //help              - show this help',
    '  //app/list          - list codex apps',
    '  //session/list      - list codex sessions',
    '  //thread/list       - list codex threads',
    '  //thread/read <id>  - inspect a codex thread',
    '  //review            - review the current working tree',
  ];
}

async function buildSessionStateLines(
  bindingService: BindingService,
  projectRegistry: ChatCommandServiceDependencies['projectRegistry'],
  getCodexStatusLines: ChatCommandServiceDependencies['getCodexStatusLines'],
  sessionId: string,
  senderId: string,
): Promise<string[] | null> {
  const projectId = await bindingService.getProjectBySession(sessionId);
  if (projectId === null) {
    return formatNotBoundMessage();
  }

  const state = await projectRegistry.describeProject(projectId);
  const lines = [
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

  if (getCodexStatusLines !== undefined) {
    try {
      lines.push(...await getCodexStatusLines());
    } catch {
      // Keep the bridge status visible even if the local Codex status read fails.
    }
  }

  return lines;
}

function parseCommand(text: string): { kind: 'bridge' | 'codex' | 'unknown' | 'none'; command: string; args: string[] } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { kind: 'none', command: '', args: [] };
  }

  if (trimmed.startsWith('//')) {
    const parts = trimmed.slice(2).trim().split(/\s+/).filter(Boolean);
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
        command,
        args: parts.slice(1),
      };
    }

    return {
      kind: 'unknown',
      command,
      args: parts.slice(1),
    };
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const command = parts[0]?.toLowerCase() ?? '';
  if (isBridgeCommandToken(command) || isCodexCommandToken(command)) {
    return {
      kind: 'unknown',
      command,
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

async function startNewThreadLines(
  dependencies: ChatCommandServiceDependencies,
  projectId: string,
): Promise<string[]> {
  if (dependencies.projectRegistry.startThread === undefined) {
    return buildCodexSupportNotConfiguredLines(projectId, '//new');
  }

  const projectConfig = dependencies.projectRegistry.getProjectConfig?.(projectId);
  const threadId = await dependencies.projectRegistry.startThread(projectId, {
    cwd: projectConfig?.cwd ?? undefined,
    force: true,
  });

  return [`[codex-bridge] started new thread ${threadId} for this chat`];
}

async function updateProjectModelLines(
  dependencies: ChatCommandServiceDependencies,
  projectId: string,
  model: string | null | undefined,
): Promise<string[]> {
  const projectConfig = dependencies.projectRegistry.getProjectConfig?.(projectId) ?? null;
  if (projectConfig === null) {
    return [`[codex-bridge] project config is not available for ${projectId}`];
  }

  if (dependencies.projectRegistry.updateProjectConfig === undefined) {
    return ['[codex-bridge] project model updates are not configured'];
  }

  if (model === undefined) {
    const currentModel = projectConfig.model?.trim();
    return currentModel ? [`[codex-bridge] project model: ${currentModel}`] : ['[codex-bridge] project model is not configured'];
  }

  const normalizedModel = model.trim();
  if (normalizedModel === '') {
    return ['Usage: //model <model>'];
  }

  await dependencies.projectRegistry.updateProjectConfig(projectId, { model: normalizedModel });
  return [`[codex-bridge] project model set to ${normalizedModel}`];
}

function resolveCodexCommand(
  command: string,
  args: string[],
): { kind: 'supported'; method: SupportedCodexMethod; params: Record<string, unknown>; legacyArgs: string[] } | { kind: 'unsupported'; raw: string } | { kind: 'usage'; lines: string[] } {
  const normalizedCommand = command.toLowerCase();
  if (normalizedCommand === 'review') {
    return resolveReviewCommand(args);
  }

  if (!SUPPORTED_CODEX_METHODS.has(normalizedCommand as SupportedCodexMethod)) {
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
        threadId: args[0],
    },
    legacyArgs: args.slice(0, 1),
  };
}

function resolveReviewCommand(
  args: string[],
): { kind: 'supported'; method: 'review/start'; params: Record<string, unknown>; legacyArgs: string[] } | { kind: 'usage'; lines: string[] } {
  let target: Record<string, unknown> | null = null;
  let commitTitle: string | null = null;
  const freeform: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === '--uncommitted') {
      if (target !== null) {
        return { kind: 'usage', lines: [REVIEW_USAGE] };
      }
      target = { type: 'uncommittedChanges' };
      continue;
    }

    if (token === '--base') {
      const branch = args[index + 1];
      if (target !== null || branch === undefined) {
        return { kind: 'usage', lines: [REVIEW_USAGE] };
      }
      target = { type: 'baseBranch', branch };
      index += 1;
      continue;
    }

    if (token === '--commit') {
      const sha = args[index + 1];
      if (target !== null || sha === undefined) {
        return { kind: 'usage', lines: [REVIEW_USAGE] };
      }
      target = { type: 'commit', sha };
      index += 1;
      continue;
    }

    if (token === '--title') {
      if (target?.type !== 'commit' || commitTitle !== null || index + 1 >= args.length) {
        return { kind: 'usage', lines: [REVIEW_USAGE] };
      }
      commitTitle = args.slice(index + 1).join(' ');
      index = args.length;
      break;
    }

    if (token.startsWith('--')) {
      return { kind: 'usage', lines: [REVIEW_USAGE] };
    }

    freeform.push(token);
  }

  if (freeform.length > 0) {
    if (target !== null) {
      return { kind: 'usage', lines: [REVIEW_USAGE] };
    }
    target = {
      type: 'custom',
      instructions: freeform.join(' '),
    };
  }

  if (target === null) {
    target = { type: 'uncommittedChanges' };
  }

  if (commitTitle !== null) {
    target = { ...target, title: commitTitle };
  }

  return {
    kind: 'supported',
    method: 'review/start',
    params: { target },
    legacyArgs: args,
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

          case 'new': {
            const projectId = await dependencies.bindingService.getProjectBySession(input.sessionId);
            if (projectId === null) {
              return formatNotBoundMessage();
            }

            return await startNewThreadLines(dependencies, projectId);
          }

          case 'status':
          case 'sessions':
            return await buildSessionStateLines(
              dependencies.bindingService,
              dependencies.projectRegistry,
              dependencies.getCodexStatusLines,
              input.sessionId,
              input.senderId,
            );

          case 'read':
            return parsed.args.length === 0 ? ['Usage: //read <path>'] : ['[codex-bridge] reading file...'];

          case 'model': {
            if (parsed.args.length > 1) {
              return ['Usage: //model <model>'];
            }

            const projectId = await dependencies.bindingService.getProjectBySession(input.sessionId);
            if (projectId === null) {
              return formatNotBoundMessage();
            }

            return await updateProjectModelLines(dependencies, projectId, parsed.args[0]);
          }

          case 'restart':
            return ['[codex-bridge] restarting bridge process...'];

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

      const projectConfig = dependencies.projectRegistry.getProjectConfig?.(projectId);

      if (
        dependencies.executeStructuredCodexCommand === undefined &&
        dependencies.executeCodexCommand === undefined
      ) {
        return buildCodexSupportNotConfiguredLines(projectId, resolved.method);
      }

      const params =
        resolved.method === 'thread/list' && projectConfig?.cwd !== undefined
          ? { ...resolved.params, cwd: projectConfig.cwd }
          : resolved.method === 'review/start'
            ? {
                ...resolved.params,
                threadId:
                  (dependencies.projectRegistry.getLastThread === undefined
                    ? null
                    : await dependencies.projectRegistry.getLastThread(projectId, input.sessionId)) ??
                  (dependencies.projectRegistry.startThread === undefined
                    ? null
                    : await dependencies.projectRegistry.startThread(projectId, {
                        cwd: projectConfig?.cwd ?? undefined,
                        force: true,
                      })),
              }
            : resolved.params;

      if (resolved.method === 'review/start' && typeof params.threadId !== 'string') {
        return ['[codex-bridge] review requires an active codex thread'];
      }

      if (dependencies.executeStructuredCodexCommand !== undefined) {
        return await dependencies.executeStructuredCodexCommand({
          sessionId: input.sessionId,
          senderId: input.senderId,
          projectInstanceId: projectId,
          method: resolved.method,
          params,
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
    },
  };
}
