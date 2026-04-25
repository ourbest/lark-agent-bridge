import type { BindingService } from '../core/binding/binding-service.ts';
import type { ProjectState } from '../runtime/project-registry.ts';
import type { ApprovalService } from '../runtime/approval-service.ts';
import type { PermissionMode } from '../runtime/project-config.ts';
import type { ProviderDescriptor, ProviderState } from '../runtime/provider-registry.ts';
import type { Thread } from '../runtime/thread-manager.ts';

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

export interface ProjectSummary {
  projectInstanceId: string;
  cwd?: string | null;
  source?: string | null;
  activeProvider?: string | null;
  providers?: ProviderDescriptor[];
  configured?: boolean;
  active?: boolean;
  removed?: boolean;
}

export interface ProjectProviderSummary extends ProviderDescriptor {
  started?: boolean;
  active?: boolean;
}

export interface ChatCommandServiceDependencies {
  bindingService: BindingService;
  projectRegistry: {
    describeProject(projectInstanceId: string): Promise<ProjectState>;
    getProjectConfig?(projectInstanceId: string): { cwd?: string | null; model?: string | null; providers?: ProviderDescriptor[] | null; activeProvider?: string | null } | null;
    listProjects?(): Promise<ProjectSummary[]>;
    listProjectProviders?(projectInstanceId: string): Promise<Array<ProjectProviderSummary | ProviderState>>;
    getActiveProvider?(projectInstanceId: string): Promise<string | null>;
    setActiveProvider?(projectInstanceId: string, provider: string): Promise<void> | void;
    updateProjectConfig?(projectInstanceId: string, input: { model?: string | null; permissionMode?: PermissionMode | null }): Promise<{ model?: string | null; permissionMode?: PermissionMode | null } | null> | { model?: string | null; permissionMode?: PermissionMode | null } | null;
    startThread?(projectInstanceId: string, options?: { cwd?: string; force?: boolean }): Promise<string>;
    getLastThread?(projectInstanceId: string, sessionId: string): Promise<string | null>;
    resumeThread?(projectInstanceId: string, threadId: string): Promise<string>;
    listThreads?(projectInstanceId: string): Promise<Thread[]>;
    cancelThread?(projectInstanceId: string, threadId: string): Promise<void>;
    pauseThread?(projectInstanceId: string, threadId: string): Promise<void>;
  };
  approvalService?: ApprovalService;
  getCodexStatusLines?: () => Promise<string[]>;
  executeCodexCommand?: (input: CodexCommandExecutionInput) => Promise<string[]>;
  executeStructuredCodexCommand?: (input: StructuredCodexCommandExecutionInput) => Promise<string[]>;
  reloadProjects?: () => Promise<string[]>;
  addLocalProject?(input: { path: string; id?: string }): Promise<{ projectInstanceId: string; cwd: string }>;
  addRemoteProject?(input: { gitRemote: string }): Promise<{ projectInstanceId: string; cwd: string }>;
}

export interface ChatCommandService {
  execute(input: ChatCommandInput): Promise<string[] | null>;
}

function isBridgeCommandToken(token: string): boolean {
  return token === 'bind' || token === 'unbind' || token === 'list' || token === 'help' || token === 'status' || token === 'sessions' || token === 'read' || token === 'restart' || token === 'abort' || token === 'reload' || token === 'resume' || token === 'new' || token === 'model' || token === 'mode' || token === 'projects' || token === 'providers' || token === 'provider' || token === 'project' || token === 'approve-test' || token === 'thread';
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
  return ['[lark-agent-bridge] this chat is not bound to any project'];
}

function buildHelpLines(): string[] {
  return [
    '[lark-agent-bridge] commands:',
    '  //bind <projectId>  - bind this chat to a project',
    '  //unbind            - unbind this chat',
    '  //list              - show current binding',
    '  //projects          - list all projects',
    '  //providers         - list providers for the bound project',
    '  //provider <id>     - switch the active provider',
    '  //new               - start a new codex thread for this chat',
    '  //status            - show bridge and codex state',
    '  //read <path>       - read a project file and send it to chat as a file',
    '  //model <model>     - set the project model',
    '  //mode [plan|auto-edit|yolo] - set the project execution mode',
    '  //restart           - restart the bridge process',
    '  //abort             - abort the current task',
    '  //reload projects   - reload projects.json',
    '  //project add local <path> [id] - add a local project',
    '  //project add remote <git-remote> - add a project from git remote',
    '  //resume <threadId|last> - resume a codex thread (threadId comes from thread/list)',
    '  //approvals         - list pending approval requests',
    '  //approve <id>      - approve one request',
    '  //approve-all <id>  - approve one request for the session',
    '  //approve-auto <minutes> - auto-approve this chat for N minutes',
    '  //approve-test      - create a test approval card for manual button checks',
    '  //deny <id>         - deny one request',
    '  //thread list       - list background tasks (interactive card)',
    '  //thread cancel <id> - cancel a background task',
    '  //thread pause <id>  - pause a background task',
    '  //thread resume <id> - resume a background task',
    '  //help              - show this help',
    '  //app/list          - list codex apps',
    '  //session/list      - list codex sessions',
    '  //thread/list       - list codex threads',
    '  //thread/read <id>  - inspect a codex thread',
    '  //review            - review the current working tree',
  ];
}

function looksLikeProjectId(token: string): boolean {
  return token.length > 0 && token.length <= 24 && /^[a-z0-9_-]*[0-9_-][a-z0-9_-]*$/.test(token);
}

function resolveLocalProjectInput(remainder: string): { path: string; id?: string } {
  const lastSpaceIndex = remainder.lastIndexOf(' ');
  if (lastSpaceIndex === -1) {
    return { path: remainder };
  }

  const potentialPath = remainder.slice(0, lastSpaceIndex).trim();
  const lastToken = remainder.slice(lastSpaceIndex + 1).trim();

  if (!looksLikeProjectId(lastToken)) {
    return { path: remainder };
  }

  return { path: potentialPath, id: lastToken };
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
    '## [lark-agent-bridge] Bridge State',
    `- chatId: ${sessionId}`,
    `- senderId: ${senderId}`,
    `- projectId: ${projectId}`,
    '## [lark-agent-bridge] Codex State',
    `- projectId: ${state.projectInstanceId}`,
    `- configured: ${yesNo(state.configured)}`,
    `- active: ${yesNo(state.active)}`,
    `- removed: ${yesNo(state.removed)}`,
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

async function canBindProject(
  projectRegistry: ChatCommandServiceDependencies['projectRegistry'],
  projectId: string,
): Promise<boolean> {
  const state = await projectRegistry.describeProject(projectId);
  return state.configured || state.active;
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
    `[lark-agent-bridge] unknown command: ${input.trim()}`,
    ...buildHelpLines(),
  ];
}

function formatProviderSummary(provider: ProjectProviderSummary, activeProvider?: string | null): string {
  const parts = [
    `- ${provider.id}`,
    `kind=${provider.kind}`,
    provider.transport ? `transport=${provider.transport}` : null,
    provider.port !== undefined ? `port=${provider.port}` : null,
    provider.active === true || activeProvider === provider.id ? 'active' : null,
    provider.started === true ? 'running' : 'stopped',
  ].filter((part): part is string => part !== null);

  return parts.join(' | ');
}

async function buildProjectsLines(dependencies: ChatCommandServiceDependencies): Promise<string[]> {
  if (dependencies.projectRegistry.listProjects === undefined) {
    return ['## [lark-agent-bridge] projects', '- project listing is not configured'];
  }

  const [projects, bindings] = await Promise.all([
    dependencies.projectRegistry.listProjects(),
    dependencies.bindingService.getAllBindings(),
  ]);
  if (projects.length === 0) {
    return ['## [lark-agent-bridge] projects', '- no projects configured'];
  }

  const bindingByProject = new Map(bindings.map((binding) => [binding.projectInstanceId, binding] as const));
  const lines = ['## [lark-agent-bridge] projects'];
  for (const project of projects) {
    const binding = bindingByProject.get(project.projectInstanceId);
    lines.push(`- ${project.projectInstanceId}`);
    if (binding !== undefined) {
      lines.push(`  - session: ${binding.sessionName ?? binding.sessionId}`);
      lines.push(`  - session id: ${binding.sessionId}`);
    }
    if (project.cwd !== undefined && project.cwd !== null) {
      lines.push(`  - cwd: ${project.cwd}`);
    }
    if (project.source !== undefined && project.source !== null) {
      lines.push(`  - source: ${project.source}`);
    }
    if (project.activeProvider !== undefined && project.activeProvider !== null) {
      lines.push(`  - active provider: ${project.activeProvider}`);
    }
    if (Array.isArray(project.providers) && project.providers.length > 0) {
      lines.push(`  - providers: ${project.providers.map((entry) => entry.id).join(', ')}`);
    }
    if (project.active === true || project.configured === true || project.removed === true) {
      lines.push(`  - configured: ${yesNo(project.configured === true)}`);
      lines.push(`  - active: ${yesNo(project.active === true)}`);
      lines.push(`  - removed: ${yesNo(project.removed === true)}`);
    }
  }

  return lines;
}

async function buildProvidersLines(
  dependencies: ChatCommandServiceDependencies,
  sessionId: string,
): Promise<string[]> {
  const projectId = await dependencies.bindingService.getProjectBySession(sessionId);
  if (projectId === null) {
    return formatNotBoundMessage();
  }

  const projectConfig = dependencies.projectRegistry.getProjectConfig?.(projectId) ?? null;
  const activeProvider = dependencies.projectRegistry.getActiveProvider === undefined
    ? projectConfig?.activeProvider ?? null
    : await dependencies.projectRegistry.getActiveProvider(projectId);

  const providers = dependencies.projectRegistry.listProjectProviders !== undefined
    ? await dependencies.projectRegistry.listProjectProviders(projectId)
    : Array.isArray(projectConfig?.providers)
      ? projectConfig.providers.map((entry) => ({
          ...entry,
          active: activeProvider === entry.id,
        }))
      : [];

  if (providers.length === 0) {
    return [`## [lark-agent-bridge] providers for ${projectId}`, `- no providers configured for ${projectId}`];
  }

  const lines = [`## [lark-agent-bridge] providers for ${projectId}`];
  for (const provider of providers) {
    lines.push(formatProviderSummary(provider, activeProvider));
  }

  return lines;
}

async function switchActiveProviderLines(
  dependencies: ChatCommandServiceDependencies,
  sessionId: string,
  providerName: string,
): Promise<string[]> {
  const projectId = await dependencies.bindingService.getProjectBySession(sessionId);
  if (projectId === null) {
    return formatNotBoundMessage();
  }

  const normalizedProvider = providerName.trim();
  if (normalizedProvider === '') {
    return ['Usage: //provider <id>'];
  }

  if (dependencies.projectRegistry.setActiveProvider === undefined) {
    return ['[lark-agent-bridge] provider switching is not configured'];
  }

  try {
    await dependencies.projectRegistry.setActiveProvider(projectId, normalizedProvider);
    return [`[lark-agent-bridge] active provider for ${projectId} set to ${normalizedProvider}`];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`[lark-agent-bridge] failed to switch provider: ${message}`];
  }
}

function buildCodexSupportNotConfiguredLines(input: {
  projectId: string;
  method: string;
  activeProvider?: string | null;
}): string[] {
  return [
    '[lark-agent-bridge] codex command support is not configured',
    `  projectId: ${input.projectId}`,
    input.activeProvider !== undefined && input.activeProvider !== null ? `  activeProvider: ${input.activeProvider}` : null,
    `  command: ${input.method}`,
  ].filter((line): line is string => line !== null);
}

function isUnsupportedStructuredCodexCommandError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('does not support structured commands') || message.includes('does not support structured Codex commands');
}

function buildCodexCommandFailureLines(method: string, error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  return [`[lark-agent-bridge] codex command failed: ${method}`, `  reason: ${message}`];
}

async function startNewThreadLines(
  dependencies: ChatCommandServiceDependencies,
  projectId: string,
): Promise<string[]> {
  if (dependencies.projectRegistry.startThread === undefined) {
    const activeProvider = dependencies.projectRegistry.getActiveProvider === undefined
      ? null
      : await dependencies.projectRegistry.getActiveProvider(projectId);
    return buildCodexSupportNotConfiguredLines({
      projectId,
      method: '//new',
      activeProvider,
    });
  }

  const projectConfig = dependencies.projectRegistry.getProjectConfig?.(projectId);
  const threadId = await dependencies.projectRegistry.startThread(projectId, {
    cwd: projectConfig?.cwd ?? undefined,
    force: true,
  });

  return [`[lark-agent-bridge] started new thread ${threadId} for this chat`];
}

async function updateProjectModelLines(
  dependencies: ChatCommandServiceDependencies,
  projectId: string,
  model: string | null | undefined,
): Promise<string[]> {
  const projectConfig = dependencies.projectRegistry.getProjectConfig?.(projectId) ?? null;
  if (projectConfig === null) {
    return [`[lark-agent-bridge] project config is not available for ${projectId}`];
  }

  if (dependencies.projectRegistry.updateProjectConfig === undefined) {
    return ['[lark-agent-bridge] project model updates are not configured'];
  }

  if (model === undefined) {
    const currentModel = projectConfig.model?.trim();
    return currentModel ? [`[lark-agent-bridge] project model: ${currentModel}`] : ['[lark-agent-bridge] project model is not configured'];
  }

  const normalizedModel = model.trim();
  if (normalizedModel === '') {
    return ['Usage: //model <model>'];
  }

  await dependencies.projectRegistry.updateProjectConfig(projectId, { model: normalizedModel });
  return [`[lark-agent-bridge] project model set to ${normalizedModel}`];
}

async function updateProjectModeLines(
  dependencies: ChatCommandServiceDependencies,
  projectId: string,
  mode: string | null | undefined,
): Promise<string[]> {
  const projectConfig = dependencies.projectRegistry.getProjectConfig?.(projectId) ?? null;
  if (projectConfig === null) {
    return [`[lark-agent-bridge] project config is not available for ${projectId}`];
  }

  if (dependencies.projectRegistry.updateProjectConfig === undefined) {
    return ['[lark-agent-bridge] project mode updates are not configured'];
  }

  if (mode === undefined) {
    const currentMode = projectConfig.permissionMode;
    return currentMode ? [`[lark-agent-bridge] project mode: ${currentMode}`] : ['[lark-agent-bridge] project mode is not configured'];
  }

  const normalizedMode = mode.trim().toLowerCase();
  if (normalizedMode === '') {
    return ['Usage: //mode <plan|auto-edit|yolo>'];
  }

  const validModes: PermissionMode[] = ['plan', 'auto-edit', 'yolo'];
  if (!validModes.includes(normalizedMode as PermissionMode)) {
    return ['Usage: //mode <plan|auto-edit|yolo>'];
  }

  await dependencies.projectRegistry.updateProjectConfig(projectId, { permissionMode: normalizedMode as PermissionMode });

  return [`[lark-agent-bridge] project mode set to ${normalizedMode}`];
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
            let bindable = await canBindProject(dependencies.projectRegistry, projectId);
            if (!bindable && dependencies.reloadProjects !== undefined) {
              try {
                await dependencies.reloadProjects();
              } catch (error) {
                return [`[lark-agent-bridge] failed to reload projects: ${error instanceof Error ? error.message : String(error)}`];
              }

              bindable = await canBindProject(dependencies.projectRegistry, projectId);
            }

            if (!bindable) {
              return [`[lark-agent-bridge] 项目不存在: ${projectId}`];
            }

            await dependencies.bindingService.bindProjectToSession(projectId, input.sessionId);
            return [`[lark-agent-bridge] bound chat ${input.sessionId} to project "${projectId}"`];
          }

          case 'unbind': {
            await dependencies.bindingService.unbindSession(input.sessionId);
            return [`[lark-agent-bridge] unbound session ${input.sessionId}`];
          }

          case 'list': {
            const projectId = await dependencies.bindingService.getProjectBySession(input.sessionId);
            if (projectId === null) {
              return formatNotBoundMessage();
            }
            return [
              '[lark-agent-bridge] current binding:',
              `  chatId: ${input.sessionId}`,
              `  senderId: ${input.senderId}`,
              `  projectId: ${projectId}`,
            ];
          }

          case 'projects': {
            if (dependencies.reloadProjects !== undefined) {
              try {
                await dependencies.reloadProjects();
              } catch (error) {
                return [`[lark-agent-bridge] failed to reload projects: ${error instanceof Error ? error.message : String(error)}`];
              }
            }

            return await buildProjectsLines(dependencies);
          }

          case 'providers':
            return await buildProvidersLines(dependencies, input.sessionId);

          case 'provider': {
            if (parsed.args.length !== 1) {
              return ['Usage: //provider <codex|cc|qwen|gemini>'];
            }

            return await switchActiveProviderLines(dependencies, input.sessionId, parsed.args[0]);
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
            return parsed.args.length === 0 ? ['Usage: //read <path>'] : ['[lark-agent-bridge] preparing file upload...'];

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

          case 'mode': {
            if (parsed.args.length > 1) {
              return ['Usage: //mode [plan|auto-edit|yolo]'];
            }

            const projectId = await dependencies.bindingService.getProjectBySession(input.sessionId);
            if (projectId === null) {
              return formatNotBoundMessage();
            }

            return await updateProjectModeLines(dependencies, projectId, parsed.args[0]);
          }

          case 'restart':
            return ['[lark-agent-bridge] restarting bridge process...'];

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
              return ['[lark-agent-bridge] no previous thread available for this chat'];
            }

            if (dependencies.projectRegistry.resumeThread === undefined) {
              return ['[lark-agent-bridge] thread resume is not configured'];
            }

            const resumedThreadId = await dependencies.projectRegistry.resumeThread(projectId, requestedThreadId);
            return [`[lark-agent-bridge] resumed thread ${resumedThreadId} for this chat`];
          }

          case 'reload': {
            if (parsed.args.length !== 1 || parsed.args[0] !== 'projects') {
              return ['Usage: //reload projects'];
            }

            if (dependencies.reloadProjects === undefined) {
              return ['[lark-agent-bridge] project reload is not configured'];
            }

            return await dependencies.reloadProjects();
          }

          case 'project': {
            if (parsed.args.length === 0) {
              return [
                'Usage:',
                '  //project add local <path> [id]  - add a local project',
                '  //project add remote <git-remote> - add a project from git remote',
              ];
            }

            const subcommand = parsed.args[0].toLowerCase();

            if (subcommand === 'add') {
              if (parsed.args.length < 2) {
                return [
                  'Usage:',
                  '  //project add local <path> [id]  - add a local project',
                  '  //project add remote <git-remote> - add a project from git remote',
                ];
              }

              const addType = parsed.args[1].toLowerCase();

              if (addType === 'local') {
                if (parsed.args.length < 2) {
                  return ['Usage: //project add local <path> [id]'];
                }

                if (dependencies.addLocalProject === undefined) {
                  return ['[lark-agent-bridge] adding local projects is not configured'];
                }

                // 从原始文本中提取路径和 ID，支持带空格的路径
                // 格式: //project add local <path> [id]
                // 最后一个 token 是 ID（如果不包含路径分隔符），其余的是路径
                const rawText = input.text.trim();
                const prefix = '//project add local ';
                if (!rawText.toLowerCase().startsWith(prefix)) {
                  return ['Usage: //project add local <path> [id]'];
                }

                const remainder = rawText.slice(prefix.length).trim();
                if (remainder === '') {
                  return ['Usage: //project add local <path> [id]'];
                }

                const { path: projectPath, id: projectId } = resolveLocalProjectInput(remainder);

                try {
                  const result = await dependencies.addLocalProject({ path: projectPath.trim(), id: projectId?.trim() });
                  return [
                    `[lark-agent-bridge] added local project "${result.projectInstanceId}"`,
                    `  cwd: ${result.cwd}`,
                  ];
                } catch (error) {
                  return [`[lark-agent-bridge] failed to add local project: ${error instanceof Error ? error.message : String(error)}`];
                }
              }

              if (addType === 'remote') {
                if (parsed.args.length < 3) {
                  return ['Usage: //project add remote <git-remote>'];
                }

                if (dependencies.addRemoteProject === undefined) {
                  return ['[lark-agent-bridge] adding remote projects is not configured'];
                }

                const gitRemote = parsed.args[2];

                try {
                  const result = await dependencies.addRemoteProject({ gitRemote });
                  return [
                    `[lark-agent-bridge] added remote project "${result.projectInstanceId}"`,
                    `  cwd: ${result.cwd}`,
                  ];
                } catch (error) {
                  return [`[lark-agent-bridge] failed to add remote project: ${error instanceof Error ? error.message : String(error)}`];
                }
              }

              return [
                'Usage:',
                '  //project add local <path> [id]  - add a local project',
                '  //project add remote <git-remote> - add a project from git remote',
              ];
            }

            return [
              'Usage:',
              '  //project add local <path> [id]  - add a local project',
              '  //project add remote <git-remote> - add a project from git remote',
            ];
          }

          case 'thread': {
            const projectId = await dependencies.bindingService.getProjectBySession(input.sessionId);
            if (projectId === null) {
              return formatNotBoundMessage();
            }

            if (parsed.args.length === 0 || parsed.args[0] === 'list') {
              if (dependencies.projectRegistry.listThreads === undefined) {
                return ['[lark-agent-bridge] thread listing is not configured'];
              }

              let threads: Thread[];
              try {
                threads = await dependencies.projectRegistry.listThreads(projectId);
              } catch (error) {
                return [`[lark-agent-bridge] failed to list threads: ${error instanceof Error ? error.message : String(error)}`];
              }

              if (threads.length === 0) {
                return ['[lark-agent-bridge] no background tasks'];
              }

              return threads.map((t) =>
                `${t.status === 'running' ? '●' : t.status === 'paused' ? '○' : '○'} ${t.name} (${t.status}) ${t.duration ?? ''}`.trim()
              );
            }

            if (parsed.args[0] === 'cancel' || parsed.args[0] === 'pause' || parsed.args[0] === 'resume') {
              if (parsed.args.length < 2) {
                return [`Usage: //thread ${parsed.args[0]} <id>`];
              }

              const threadId = parsed.args[1];

              try {
                if (parsed.args[0] === 'cancel' && dependencies.projectRegistry.cancelThread) {
                  await dependencies.projectRegistry.cancelThread(projectId, threadId);
                } else if (parsed.args[0] === 'pause' && dependencies.projectRegistry.pauseThread) {
                  await dependencies.projectRegistry.pauseThread(projectId, threadId);
                } else if (parsed.args[0] === 'resume' && dependencies.projectRegistry.resumeThread) {
                  await dependencies.projectRegistry.resumeThread(projectId, threadId);
                } else {
                  return [`[lark-agent-bridge] ${parsed.args[0]} is not supported by this provider`];
                }
              } catch (error) {
                return [`[lark-agent-bridge] failed to ${parsed.args[0]} thread: ${error instanceof Error ? error.message : String(error)}`];
              }

              return [`[lark-agent-bridge] thread ${parsed.args[0]}d: ${threadId}`];
            }

            return [
              'Usage:',
              '  //thread list         - list background tasks',
              '  //thread cancel <id>  - cancel a task',
              '  //thread pause <id>   - pause a task',
              '  //thread resume <id>  - resume a task',
            ];
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
        const activeProvider = dependencies.projectRegistry.getActiveProvider === undefined
          ? null
          : await dependencies.projectRegistry.getActiveProvider(projectId);
        return buildCodexSupportNotConfiguredLines({
          projectId,
          method: resolved.method,
          activeProvider,
        });
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
        return ['[lark-agent-bridge] review requires an active codex thread'];
      }

      if (dependencies.executeStructuredCodexCommand !== undefined) {
        try {
          return await dependencies.executeStructuredCodexCommand({
            sessionId: input.sessionId,
            senderId: input.senderId,
            projectInstanceId: projectId,
            method: resolved.method,
            params,
          });
        } catch (error) {
          if (isUnsupportedStructuredCodexCommandError(error)) {
            const activeProvider = dependencies.projectRegistry.getActiveProvider === undefined
              ? null
              : await dependencies.projectRegistry.getActiveProvider(projectId);
            return buildCodexSupportNotConfiguredLines({
              projectId,
              method: resolved.method,
              activeProvider,
            });
          }

          return buildCodexCommandFailureLines(resolved.method, error);
        }
      }

      if (dependencies.executeCodexCommand !== undefined) {
        try {
          return await dependencies.executeCodexCommand({
            sessionId: input.sessionId,
            senderId: input.senderId,
            projectInstanceId: projectId,
            command: resolved.method,
            args: resolved.legacyArgs,
          });
        } catch (error) {
          return buildCodexCommandFailureLines(resolved.method, error);
        }
      }
    },
  };
}
