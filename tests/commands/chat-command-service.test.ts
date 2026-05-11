import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { BindingService } from '../../src/core/binding/binding-service.ts';
import { createChatCommandService } from '../../src/commands/chat-command-service.ts';
import { createApprovalService } from '../../src/runtime/approval-service.ts';
import { InMemoryBindingStore } from '../../src/storage/binding-store.ts';
import { createProjectRegistry } from '../../src/runtime/project-registry.ts';

function createBindingService(): BindingService {
  return new BindingService(new InMemoryBindingStore());
}

test('routes approval commands through the approval service', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const approvalService = createApprovalService();
  const responses: Array<{ requestId: number; result: unknown }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  await approvalService.registerRequest({
    requestId: 42,
    projectInstanceId: 'project-a',
    sessionId: 'chat-a',
    threadId: 'thr_123',
    turnId: 'turn_1',
    itemId: 'item-1',
    kind: 'commandExecution',
    command: 'rm -rf /tmp/example',
    respond: async (requestId, result) => {
      responses.push({ requestId: Number(requestId), result });
    },
  });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
    approvalService,
  });

  const listLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//approvals',
  });

  assert.deepEqual(listLines, [
    '[lark-agent-bridge] pending approvals:',
    '  42 | command execution | project-a',
  ]);

  const approveLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//approve 42',
  });

  assert.deepEqual(approveLines, ['[lark-agent-bridge] approved request 42']);
  assert.deepEqual(responses, [
    {
      requestId: 42,
      result: {
        decision: 'accept',
      },
    },
  ]);
});

test('shows approve-auto in help output', async () => {
  const bindingService = createBindingService();
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//help',
  });

  assert.ok(lines?.some((line) => line.includes('//approve-auto <minutes>')));
  assert.ok(lines?.some((line) => line.includes('//approve-test')));
});

test('resumes a thread by explicit id for the bound chat', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const calls: Array<{ projectInstanceId: string; threadId: string }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });
  await registry.setActiveProvider('project-a', 'cc');

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      async resumeThread(projectInstanceId: string, threadId: string) {
        calls.push({ projectInstanceId, threadId });
        return threadId;
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//resume thr_123',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] resumed thread thr_123 for this chat']);
  assert.deepEqual(calls, [
    {
      projectInstanceId: 'project-a',
      threadId: 'thr_123',
    },
  ]);
});

test('resumes the last thread for the bound chat', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const calls: Array<{ projectInstanceId: string; sessionId: string }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });
  await registry.setActiveProvider('project-a', 'cc');

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      async getLastThread(projectInstanceId: string, sessionId: string) {
        calls.push({ projectInstanceId, sessionId });
        return 'thr_456';
      },
      async resumeThread(projectInstanceId: string, threadId: string) {
        calls.push({ projectInstanceId, sessionId: threadId });
        return threadId;
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//resume last',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] resumed thread thr_456 for this chat']);
  assert.deepEqual(calls, [
    {
      projectInstanceId: 'project-a',
      sessionId: 'chat-a',
    },
    {
      projectInstanceId: 'project-a',
      sessionId: 'thr_456',
    },
  ]);
});

test('starts a fresh thread for //new on the bound chat', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async startThread() {
        return 'thr_unused';
      },
      async stop() {},
    }),
  });
  const calls: Array<{
    projectInstanceId: string;
    options?: { cwd?: string; force?: boolean };
  }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      getProjectConfig(projectInstanceId: string) {
        return projectInstanceId === 'project-a'
          ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' }
          : null;
      },
      async startThread(projectInstanceId: string, options?: { cwd?: string; force?: boolean }) {
        calls.push({ projectInstanceId, options });
        return calls.length === 1 ? 'thr_new_1' : 'thr_new_2';
      },
    },
  });

  const newLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//new',
  });

  assert.deepEqual(newLines, ['[lark-agent-bridge] started new thread thr_new_1 for this chat']);
  assert.deepEqual(calls, [
    {
      projectInstanceId: 'project-a',
      options: {
        cwd: '/repo/project-a',
        force: true,
      },
    },
  ]);
});

test('shows and updates the bound project model through //model', async () => {
  const bindingService = createBindingService();
  const projectConfig: {
    projectInstanceId: string;
    websocketUrl: string;
    cwd: string;
    model?: string;
  } = {
    projectInstanceId: 'project-a',
    websocketUrl: 'ws://localhost:4000',
    cwd: '/repo/project-a',
    model: 'gpt-5.4',
  };
  const updates: Array<{ projectInstanceId: string; input: { model?: string | null } }> = [];
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a' ? projectConfig : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      getProjectConfig(projectInstanceId: string) {
        return projectInstanceId === 'project-a' ? projectConfig : null;
      },
      async updateProjectConfig(projectInstanceId: string, input: { model?: string | null }) {
        updates.push({ projectInstanceId, input });
        if (input.model !== undefined) {
          projectConfig.model = input.model?.trim() || undefined;
        }
        return projectConfig;
      },
    },
  });

  const readLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//model',
  });

  const updateLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//model gpt-5.4-mini',
  });

  assert.deepEqual(readLines, ['[lark-agent-bridge] project model: gpt-5.4']);
  assert.deepEqual(updateLines, ['[lark-agent-bridge] project model set to gpt-5.4-mini']);
  assert.deepEqual(updates, [
    {
      projectInstanceId: 'project-a',
      input: {
        model: 'gpt-5.4-mini',
      },
    },
  ]);
  assert.equal(projectConfig.model, 'gpt-5.4-mini');
});

test('shows and updates the bound project mode through //mode', async () => {
  const bindingService = createBindingService();
  await bindingService.bindProjectToSession('project-a', 'chat-a');

  const projectConfig: {
    projectInstanceId: string;
    cwd?: string | null;
    model?: string | null;
    permissionMode?: string | null;
    providers?: ProviderDescriptor[];
  } = {
    projectInstanceId: 'project-a',
    cwd: '/tmp',
    permissionMode: 'auto-edit',
  };

  const updates: Array<{ projectInstanceId: string; input: { permissionMode?: string | null } }> = [];

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject(id) {
        return { projectInstanceId: id, configured: true, active: true, removed: false };
      },
      getProjectConfig(id) {
        return id === 'project-a' ? projectConfig : null;
      },
      async updateProjectConfig(id, input) {
        updates.push({ projectInstanceId: id, input });
        if (input.permissionMode !== undefined) {
          projectConfig.permissionMode = input.permissionMode ?? null;
        }
        return projectConfig;
      },
    },
  });

  const readLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//mode',
  });

  assert.deepEqual(readLines, ['[lark-agent-bridge] project mode: auto-edit']);

  const planLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//mode plan',
  });

  assert.deepEqual(planLines, ['[lark-agent-bridge] project mode set to plan']);
  assert.deepEqual(updates, [{ projectInstanceId: 'project-a', input: { permissionMode: 'plan' } }]);

  const yoloLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//mode yolo',
  });

  assert.deepEqual(yoloLines, ['[lark-agent-bridge] project mode set to yolo']);

  const invalidLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//mode invalid',
  });

  assert.deepEqual(invalidLines, ['Usage: //mode <plan|auto-edit|yolo>']);
});

test('//mode shows not-bound message when chat is not bound', async () => {
  const bindingService = createBindingService();
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() { return { projectInstanceId: '', configured: false, active: false, removed: false }; },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-b',
    senderId: 'user-b',
    text: '//mode plan',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] this chat is not bound to any project']);
});

test('returns bridge and codex state for //status on a bound chat', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });
  await registry.setActiveProvider('project-a', 'cc');

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
    getCodexStatusLines: async () => [
      '[codex] model: gpt-5.4-mini (reasoning medium, summaries auto)',
      '[codex] directory: ~/git/lark-agent-bridge',
      '[codex] permissions: Full Access',
      '[codex] agents.md: AGENTS.md',
      '[codex] collaboration mode: Default',
      '[codex] session: 019d5e2f-9356-7903-9cdd-5ed89c556893',
      '[codex] 5h limit: 99% left (resets 11:01)',
      '[codex] weekly limit: 25% left (resets 18:26 on 8 Apr)',
    ],
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//status',
  });

  assert.deepEqual(lines, [
    '## [lark-agent-bridge] Bridge State',
    '- chatId: chat-a',
    '- senderId: user-a',
    '- projectId: project-a',
    '## [lark-agent-bridge] Codex State',
    '- projectId: project-a',
    '- configured: yes',
    '- active: yes',
    '- removed: no',
    '[codex] model: gpt-5.4-mini (reasoning medium, summaries auto)',
    '[codex] directory: ~/git/lark-agent-bridge',
    '[codex] permissions: Full Access',
    '[codex] agents.md: AGENTS.md',
    '[codex] collaboration mode: Default',
    '[codex] session: 019d5e2f-9356-7903-9cdd-5ed89c556893',
    '[codex] 5h limit: 99% left (resets 11:01)',
    '[codex] weekly limit: 25% left (resets 18:26 on 8 Apr)',
  ]);
});

test('returns the current binding for //list', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });
  await registry.setActiveProvider('project-a', 'cc');

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//list',
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] current binding:',
    '  chatId: chat-a',
    '  senderId: user-a',
    '  projectId: project-a',
  ]);
});

test('retries project discovery before binding when the project is missing initially', async () => {
  const bindingService = createBindingService();
  const discoveredProjects = new Set<string>();
  let reloadCalls = 0;

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject(projectInstanceId: string) {
        return {
          projectInstanceId,
          configured: discoveredProjects.has(projectInstanceId),
          active: false,
          removed: false,
          sessionCount: 0,
        };
      },
    },
    reloadProjects: async () => {
      reloadCalls += 1;
      discoveredProjects.add('project-a');
      return ['[lark-agent-bridge] reloaded projects: 1'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//bind project-a',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] bound chat chat-a to project "project-a"']);
  assert.equal(reloadCalls, 1);
  assert.equal(await bindingService.getProjectBySession('chat-a'), 'project-a');
});

test('returns project不存在 when project discovery still cannot find the project after reload', async () => {
  const bindingService = createBindingService();
  let reloadCalls = 0;

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject(projectInstanceId: string) {
        return {
          projectInstanceId,
          configured: false,
          active: false,
          removed: false,
          sessionCount: 0,
        };
      },
    },
    reloadProjects: async () => {
      reloadCalls += 1;
      return ['[lark-agent-bridge] reloaded projects: 0'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//bind missing-project',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] 项目不存在: missing-project']);
  assert.equal(reloadCalls, 1);
  assert.equal(await bindingService.getProjectBySession('chat-a'), null);
});

test('returns an acknowledgement for //restart', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: () => null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//restart',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] restarting bridge process...']);
});

test('restarts a specific provider with //restart <provider>', async () => {
  const bindingService = createBindingService();
  const restartCalls: Array<{ projectId: string; provider: string }> = [];

  const registry = createProjectRegistry({
    getProjectConfig: (id) =>
      id === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({ generateReply: async () => 'ok', stop: async () => {} }),
  });

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      listProjectProviders: registry.getProjectProviders,
      async restartProjectProvider(projectId, provider) {
        restartCalls.push({ projectId, provider });
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//restart codex',
  });

  assert.deepEqual(restartCalls, [{ projectId: 'project-a', provider: 'codex' }]);
  assert.deepEqual(lines, ['[lark-agent-bridge] restarted codex for project-a']);
});

test('rejects //restart <provider> when no project is bound', async () => {
  const bindingService = createBindingService();
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {},
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//restart codex',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] this chat is not bound to any project']);
});

test('rejects //restart <provider> when provider does not exist', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (id) =>
      id === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({ generateReply: async () => 'ok', stop: async () => {} }),
  });

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      listProjectProviders: registry.getProjectProviders,
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//restart nonexistent',
  });

  assert.ok(lines?.[0]?.includes("provider 'nonexistent' not found"));
});

test('rejects //restart <provider> when restartProjectProvider is not configured', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (id) =>
      id === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({ generateReply: async () => 'ok', stop: async () => {} }),
  });

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      restartProjectProvider: undefined,
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//restart codex',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] provider restart is not configured']);
});

test('returns error when restartProjectProvider throws', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (id) =>
      id === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({ generateReply: async () => 'ok', stop: async () => {} }),
  });

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      listProjectProviders: registry.getProjectProviders,
      async restartProjectProvider() {
        throw new Error('provider crashed');
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//restart codex',
  });

  assert.ok(lines?.[0]?.includes('failed to restart codex'));
  assert.ok(lines?.[0]?.includes('provider crashed'));
});

test('rejects bare codex commands without the // prefix', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: () => null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
  });

  const expected = [
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
    '  //restart <provider> - restart a provider for the bound project',
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
    '  //mute on|off       - mute this chat (bot responds only when @mentioned)',
    '  //help              - show this help',
    '  //app/list          - list codex apps',
    '  //session/list      - list codex sessions',
    '  //thread/list       - list codex threads',
    '  //thread/read <id>  - inspect a codex thread',
    '  //review            - review the current working tree',
  ];

  for (const command of ['app/list', 'session/list', 'session/get abc', 'thread/list', 'thread/start', 'thread/get abc', 'thread/read abc', 'review']) {
    const lines = await service.execute({
      sessionId: 'chat-a',
      senderId: 'user-a',
      text: command,
    });

    assert.deepEqual(lines, [`[lark-agent-bridge] unknown command: ${command}`, ...expected]);
  }
});

test('lists projects with //projects', async () => {
  const store = new InMemoryBindingStore();
  const bindingService = new BindingService(store);
  store.setBinding('project-a', 'chat-a');
  store.updateSessionName('chat-a', 'Dev Team');
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
      async listProjects() {
        return [
          {
            projectInstanceId: 'project-a',
            cwd: '/repo/project-a',
            source: 'config',
            activeProvider: 'codex',
            providers: [
              { id: 'codex', kind: 'codex', transport: 'stdio' },
              { id: 'qwen', kind: 'qwen', transport: 'stdio' },
            ],
            configured: true,
            active: true,
            removed: false,
          },
          {
            projectInstanceId: 'project-b',
            cwd: '/repo/project-b',
            source: 'root',
            activeProvider: 'qwen',
            providers: [
              { id: 'codex', kind: 'codex', transport: 'stdio' },
              { id: 'cc', kind: 'cc', transport: 'stdio' },
              { id: 'qwen', kind: 'qwen', transport: 'stdio' },
            ],
            configured: true,
            active: false,
            removed: false,
          },
        ];
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//projects',
  });

  assert.deepEqual(lines, [
    '## [lark-agent-bridge] projects',
    '- project-a',
    '  - session: Dev Team',
    '  - session id: chat-a',
    '  - cwd: /repo/project-a',
    '  - source: config',
    '  - active provider: codex',
    '  - providers: codex, qwen',
    '  - configured: yes',
    '  - active: yes',
    '  - removed: no',
    '- project-b',
    '  - cwd: /repo/project-b',
    '  - source: root',
    '  - active provider: qwen',
    '  - providers: codex, cc, qwen',
    '  - configured: yes',
    '  - active: no',
    '  - removed: no',
  ]);
});

test('//projects reloads project configuration before listing', async () => {
  const bindingService = createBindingService();
  let reloadCount = 0;
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject(projectInstanceId: string) {
        return {
          projectInstanceId,
          configured: true,
          active: false,
          removed: false,
          sessionCount: 0,
        };
      },
      async listProjects() {
        return reloadCount === 0
          ? [
              {
                projectInstanceId: 'alpha',
                cwd: '/repo/alpha',
                source: 'config',
                activeProvider: 'codex',
                providers: [{ id: 'codex', kind: 'codex', transport: 'stdio' }],
                configured: true,
                active: false,
                removed: false,
              },
            ]
          : [
              {
                projectInstanceId: 'alpha',
                cwd: '/repo/alpha',
                source: 'config',
                activeProvider: 'codex',
                providers: [{ id: 'codex', kind: 'codex', transport: 'stdio' }],
                configured: true,
                active: false,
                removed: false,
              },
              {
                projectInstanceId: 'beta',
                cwd: '/repo/beta',
                source: 'root',
                activeProvider: 'qwen',
                providers: [
                  { id: 'codex', kind: 'codex', transport: 'stdio' },
                  { id: 'qwen', kind: 'qwen', transport: 'stdio' },
                ],
                configured: true,
                active: false,
                removed: false,
              },
            ];
      },
    },
    reloadProjects: async () => {
      reloadCount += 1;
      return ['[lark-agent-bridge] reloaded projects: 2'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//projects',
  });

  assert.deepEqual(lines, [
    '## [lark-agent-bridge] projects',
    '- alpha',
    '  - cwd: /repo/alpha',
    '  - source: config',
    '  - active provider: codex',
    '  - providers: codex',
    '  - configured: yes',
    '  - active: no',
    '  - removed: no',
    '- beta',
    '  - cwd: /repo/beta',
    '  - source: root',
    '  - active provider: qwen',
    '  - providers: codex, qwen',
    '  - configured: yes',
    '  - active: no',
    '  - removed: no',
  ]);
  assert.equal(reloadCount, 1);
});

test('lists and switches providers for the bound project', async () => {
  const bindingService = createBindingService();
  const setActiveCalls: Array<{ projectInstanceId: string; provider: string }> = [];
  await bindingService.bindProjectToSession('project-a', 'chat-a');

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
      async getProjectConfig(projectInstanceId: string) {
        return projectInstanceId === 'project-a'
          ? {
              projectInstanceId: 'project-a',
              cwd: '/repo/project-a',
              activeProvider: 'codex',
              providers: [
                { id: 'codex', kind: 'codex', transport: 'stdio' },
                { id: 'cc', kind: 'cc', transport: 'stdio' },
                { id: 'qwen', kind: 'qwen', transport: 'stdio' },
              ],
            }
          : null;
      },
      async listProjectProviders(projectInstanceId: string) {
        return projectInstanceId === 'project-a'
            ? [
              { id: 'codex', kind: 'codex', transport: 'stdio', started: true, active: true },
              { id: 'cc', kind: 'cc', transport: 'stdio', started: false, active: false },
              { id: 'qwen', kind: 'qwen', transport: 'stdio', started: true, active: false },
            ]
          : [];
      },
      async getActiveProvider(projectInstanceId: string) {
        return projectInstanceId === 'project-a' ? 'codex' : null;
      },
      async setActiveProvider(projectInstanceId: string, provider: string) {
        setActiveCalls.push({ projectInstanceId, provider });
      },
    },
  });

  const providersLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//providers',
  });

  const switchLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//provider qwen',
  });

  assert.deepEqual(providersLines, [
    '## [lark-agent-bridge] providers for project-a',
    '- codex | kind=codex | transport=stdio | active | running',
    '- cc | kind=cc | transport=stdio | stopped',
    '- qwen | kind=qwen | transport=stdio | running',
  ]);
  assert.deepEqual(switchLines, ['[lark-agent-bridge] active provider for project-a set to qwen']);
  assert.deepEqual(setActiveCalls, [
    {
      projectInstanceId: 'project-a',
      provider: 'qwen',
    },
  ]);
});

test('shows a friendly error when provider switching fails', async () => {
  const bindingService = createBindingService();
  await bindingService.bindProjectToSession('project-a', 'chat-a');

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: false,
          active: false,
          removed: true,
          sessionCount: 0,
        };
      },
      async setActiveProvider() {
        throw new Error('Project xiaoan-cli is not active');
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//provider cc',
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] failed to switch provider: Project xiaoan-cli is not active',
  ]);
});

test('shows //read in help output', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: () => null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//help',
  });

  assert.ok(lines?.includes('  //read <path>       - read a project file and send it to chat as a file'));
});

test('routes prefixed codex commands through the executor when bound', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const calls: Array<{
    sessionId: string;
    senderId: string;
    projectInstanceId: string;
    command: string;
    args: string[];
  }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });
  await registry.setActiveProvider('project-a', 'cc');

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
    executeCodexCommand: async (input) => {
      calls.push(input);
      return ['[lark-agent-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//app/list',
  });

  assert.deepEqual(calls, [
    {
      sessionId: 'chat-a',
      senderId: 'user-a',
      projectInstanceId: 'project-a',
      command: 'app/list',
      args: [],
    },
  ]);
  assert.deepEqual(lines, ['[lark-agent-bridge] codex ok']);
});

test('returns a configuration error when the prefixed codex executor is unavailable', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//app/list',
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] codex command support is not configured',
    '  projectId: project-a',
    '  activeProvider: codex',
    '  command: app/list',
  ]);
});

test('routes a whitelisted structured codex command through the executor', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const calls: Array<{
    sessionId: string;
    senderId: string;
    projectInstanceId: string;
    method: string;
    params: Record<string, unknown>;
  }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
    executeStructuredCodexCommand: async (input) => {
      calls.push(input);
      return ['[lark-agent-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//thread/read chat-a',
  });

  assert.deepEqual(calls, [
    {
      sessionId: 'chat-a',
      senderId: 'user-a',
      projectInstanceId: 'project-a',
      method: 'thread/read',
      params: {
        id: 'chat-a',
        threadId: 'chat-a',
      },
    },
  ]);
  assert.deepEqual(lines, ['[lark-agent-bridge] codex ok']);
});

test('treats unsupported structured codex commands as a non-fatal configuration issue', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });
  await registry.setActiveProvider('project-a', 'cc');

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
    executeStructuredCodexCommand: async () => {
      throw new Error('Project project-a does not support structured Codex commands');
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//thread/list',
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] codex command support is not configured',
    '  projectId: project-a',
    '  activeProvider: cc',
    '  command: thread/list',
  ]);
});

test('translates session/list to the current app-server thread/list method', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const calls: Array<{
    sessionId: string;
    senderId: string;
    projectInstanceId: string;
    method: string;
    params: Record<string, unknown>;
  }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
    executeStructuredCodexCommand: async (input) => {
      calls.push(input);
      return ['[lark-agent-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//session/list',
  });

  assert.deepEqual(calls, [
    {
      sessionId: 'chat-a',
      senderId: 'user-a',
      projectInstanceId: 'project-a',
      method: 'thread/list',
      params: {},
    },
  ]);
  assert.deepEqual(lines, ['[lark-agent-bridge] codex ok']);
});

test('injects the bound project cwd into thread/list requests', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const calls: Array<{
    sessionId: string;
    senderId: string;
    projectInstanceId: string;
    method: string;
    params: Record<string, unknown>;
  }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      getProjectConfig(projectInstanceId: string) {
        return projectInstanceId === 'project-a'
          ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' }
          : null;
      },
    },
    executeStructuredCodexCommand: async (input) => {
      calls.push(input);
      return ['[lark-agent-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//thread/list',
  });

  assert.deepEqual(calls, [
    {
      sessionId: 'chat-a',
      senderId: 'user-a',
      projectInstanceId: 'project-a',
      method: 'thread/list',
      params: {
        cwd: '/repo/project-a',
      },
    },
  ]);
  assert.deepEqual(lines, ['[lark-agent-bridge] codex ok']);
});

test('routes review without arguments to a review/start request for uncommitted changes', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const calls: Array<{
    sessionId: string;
    senderId: string;
    projectInstanceId: string;
    method: string;
    params: Record<string, unknown>;
  }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      async getLastThread(projectInstanceId: string, sessionId: string) {
        assert.equal(projectInstanceId, 'project-a');
        assert.equal(sessionId, 'chat-a');
        return 'thr_current';
      },
    },
    executeStructuredCodexCommand: async (input) => {
      calls.push(input);
      return ['[lark-agent-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//review',
  });

  assert.deepEqual(calls, [
    {
      sessionId: 'chat-a',
      senderId: 'user-a',
      projectInstanceId: 'project-a',
      method: 'review/start',
      params: {
        threadId: 'thr_current',
        target: {
          type: 'uncommittedChanges',
        },
      },
    },
  ]);
  assert.deepEqual(lines, ['[lark-agent-bridge] codex ok']);
});

test('routes review --base to a review/start request', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const calls: Array<{
    sessionId: string;
    senderId: string;
    projectInstanceId: string;
    method: string;
    params: Record<string, unknown>;
  }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      async getLastThread() {
        return 'thr_current';
      },
    },
    executeStructuredCodexCommand: async (input) => {
      calls.push(input);
      return ['[lark-agent-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//review --base main',
  });

  assert.deepEqual(calls, [
    {
      sessionId: 'chat-a',
      senderId: 'user-a',
      projectInstanceId: 'project-a',
      method: 'review/start',
      params: {
        threadId: 'thr_current',
        target: {
          type: 'baseBranch',
          branch: 'main',
        },
      },
    },
  ]);
  assert.deepEqual(lines, ['[lark-agent-bridge] codex ok']);
});

test('routes review custom instructions to a review/start request', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const calls: Array<{
    sessionId: string;
    senderId: string;
    projectInstanceId: string;
    method: string;
    params: Record<string, unknown>;
  }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      async getLastThread() {
        return 'thr_current';
      },
    },
    executeStructuredCodexCommand: async (input) => {
      calls.push(input);
      return ['[lark-agent-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//review focus on security and data races',
  });

  assert.deepEqual(calls, [
    {
      sessionId: 'chat-a',
      senderId: 'user-a',
      projectInstanceId: 'project-a',
      method: 'review/start',
      params: {
        threadId: 'thr_current',
        target: {
          type: 'custom',
          instructions: 'focus on security and data races',
        },
      },
    },
  ]);
  assert.deepEqual(lines, ['[lark-agent-bridge] codex ok']);
});

test('starts a thread for review when no current thread is recorded', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const calls: Array<{
    sessionId: string;
    senderId: string;
    projectInstanceId: string;
    method: string;
    params: Record<string, unknown>;
  }> = [];
  const startCalls: Array<{ projectInstanceId: string; options?: { cwd?: string; force?: boolean } }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      getProjectConfig(projectInstanceId: string) {
        return projectInstanceId === 'project-a'
          ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' }
          : null;
      },
      async getLastThread() {
        return null;
      },
      async startThread(projectInstanceId: string, options?: { cwd?: string; force?: boolean }) {
        startCalls.push({ projectInstanceId, options });
        return 'thr_started_for_review';
      },
    },
    executeStructuredCodexCommand: async (input) => {
      calls.push(input);
      return ['[lark-agent-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//review',
  });

  assert.deepEqual(startCalls, [
    {
      projectInstanceId: 'project-a',
      options: {
        cwd: '/repo/project-a',
        force: true,
      },
    },
  ]);
  assert.deepEqual(calls, [
    {
      sessionId: 'chat-a',
      senderId: 'user-a',
      projectInstanceId: 'project-a',
      method: 'review/start',
      params: {
        threadId: 'thr_started_for_review',
        target: {
          type: 'uncommittedChanges',
        },
      },
    },
  ]);
  assert.deepEqual(lines, ['[lark-agent-bridge] codex ok']);
});

test('does not start a thread for review when codex executor support is unavailable', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  const startCalls: Array<{ projectInstanceId: string; options?: { cwd?: string; force?: boolean } }> = [];

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      ...registry,
      getProjectConfig(projectInstanceId: string) {
        return projectInstanceId === 'project-a'
          ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000', cwd: '/repo/project-a' }
          : null;
      },
      async getLastThread() {
        return null;
      },
      async startThread(projectInstanceId: string, options?: { cwd?: string; force?: boolean }) {
        startCalls.push({ projectInstanceId, options });
        return 'thr_started_for_review';
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//review',
  });

  assert.deepEqual(startCalls, []);
  assert.deepEqual(lines, [
    '[lark-agent-bridge] codex command support is not configured',
    '  projectId: project-a',
    '  activeProvider: codex',
    '  command: review/start',
  ]);
});

test('returns usage for invalid review argument combinations', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  let called = false;

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
    executeStructuredCodexCommand: async () => {
      called = true;
      return ['unexpected'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//review --base main focus on security',
  });

  assert.equal(called, false);
  assert.deepEqual(lines, [
    'Usage: review [--uncommitted | --base <branch> | --commit <sha> [--title <title>] | <instructions>]',
  ]);
});

test('rejects unsupported codex commands before they reach the executor', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: (projectInstanceId) =>
      projectInstanceId === 'project-a'
        ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' }
        : null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });
  let called = false;

  await bindingService.bindProjectToSession('project-a', 'chat-a');
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-a' });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
    executeStructuredCodexCommand: async () => {
      called = true;
      return ['unexpected'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: 'session/delete chat-a',
  });

  assert.equal(called, false);
  assert.deepEqual(lines, [
    '[lark-agent-bridge] unknown command: session/delete chat-a',
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
    '  //restart <provider> - restart a provider for the bound project',
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
    '  //mute on|off       - mute this chat (bot responds only when @mentioned)',
    '  //help              - show this help',
    '  //app/list          - list codex apps',
    '  //session/list      - list codex sessions',
    '  //thread/list       - list codex threads',
    '  //thread/read <id>  - inspect a codex thread',
    '  //review            - review the current working tree',
  ]);
});

test('returns an error for unknown // commands instead of falling through', async () => {
  const bindingService = createBindingService();
  const registry = createProjectRegistry({
    getProjectConfig: () => null,
    createClient: () => ({
      async generateReply() {
        return 'reply';
      },
      async stop() {},
    }),
  });

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//sesions',
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] unknown command: //sesions',
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
    '  //restart <provider> - restart a provider for the bound project',
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
    '  //mute on|off       - mute this chat (bot responds only when @mentioned)',
    '  //help              - show this help',
    '  //app/list          - list codex apps',
    '  //session/list      - list codex sessions',
    '  //thread/list       - list codex threads',
    '  //thread/read <id>  - inspect a codex thread',
    '  //review            - review the current working tree',
  ]);
});

test('//project shows usage when called without arguments', async () => {
  const bindingService = createBindingService();
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project',
  });

  assert.deepEqual(lines, [
    'Usage:',
    '  //project add local <path> [id]  - add a local project',
    '  //project add remote <git-remote> - add a project from git remote',
  ]);
});

test('//project add local calls addLocalProject dependency', async () => {
  const bindingService = createBindingService();
  const addLocalProjectCalls: Array<{ path: string; id?: string }> = [];

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
    addLocalProject: async (input) => {
      addLocalProjectCalls.push(input);
      return { projectInstanceId: input.id || 'my-project', cwd: input.path };
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project add local /some/path',
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] added local project "my-project"',
    '  cwd: /some/path',
  ]);
  assert.deepEqual(addLocalProjectCalls, [{ path: '/some/path', id: undefined }]);
});

test('//project add local with custom id', async () => {
  const bindingService = createBindingService();
  const addLocalProjectCalls: Array<{ path: string; id?: string }> = [];

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
    addLocalProject: async (input) => {
      addLocalProjectCalls.push(input);
      return { projectInstanceId: input.id!, cwd: input.path };
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project add local /some/path custom-id',
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] added local project "custom-id"',
    '  cwd: /some/path',
  ]);
  assert.deepEqual(addLocalProjectCalls, [{ path: '/some/path', id: 'custom-id' }]);
});

test('//project add local keeps lower-case spaced paths intact', async () => {
  const bindingService = createBindingService();
  const addLocalProjectCalls: Array<{ path: string; id?: string }> = [];
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const projectDir = path.join(tempDir, 'my project');
  await mkdir(projectDir);

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
    addLocalProject: async (input) => {
      addLocalProjectCalls.push(input);
      return { projectInstanceId: input.id || 'my project', cwd: input.path };
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: `//project add local ${projectDir}`,
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] added local project "my project"',
    `  cwd: ${projectDir}`,
  ]);
  assert.deepEqual(addLocalProjectCalls, [{ path: projectDir, id: undefined }]);

  await rm(tempDir, { recursive: true, force: true });
});

test('//project add local still parses a custom id after a spaced path', async () => {
  const bindingService = createBindingService();
  const addLocalProjectCalls: Array<{ path: string; id?: string }> = [];
  const tempDir = await mkdtemp(path.join(tmpdir(), 'bridge-test-'));
  const projectDir = path.join(tempDir, 'my project');
  await mkdir(projectDir);

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
    addLocalProject: async (input) => {
      addLocalProjectCalls.push(input);
      return { projectInstanceId: input.id!, cwd: input.path };
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: `//project add local ${projectDir} app1`,
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] added local project "app1"',
    `  cwd: ${projectDir}`,
  ]);
  assert.deepEqual(addLocalProjectCalls, [{ path: projectDir, id: 'app1' }]);

  await rm(tempDir, { recursive: true, force: true });
});

test('//project add local shows error when dependency not configured', async () => {
  const bindingService = createBindingService();
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project add local /some/path',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] adding local projects is not configured']);
});

test('//project add local shows usage when path is missing', async () => {
  const bindingService = createBindingService();
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
    addLocalProject: async () => ({ projectInstanceId: 'test', cwd: '/test' }),
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project add local',
  });

  assert.deepEqual(lines, ['Usage: //project add local <path> [id]']);
});

test('//project add remote calls addRemoteProject dependency', async () => {
  const bindingService = createBindingService();
  const addRemoteProjectCalls: Array<{ gitRemote: string }> = [];

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
    addRemoteProject: async (input) => {
      addRemoteProjectCalls.push(input);
      return { projectInstanceId: 'my-repo', cwd: '/repos/my-repo' };
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project add remote https://github.com/user/repo.git',
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] added remote project "my-repo"',
    '  cwd: /repos/my-repo',
  ]);
  assert.deepEqual(addRemoteProjectCalls, [{ gitRemote: 'https://github.com/user/repo.git' }]);
});

test('//project add remote shows error when dependency not configured', async () => {
  const bindingService = createBindingService();
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project add remote https://github.com/user/repo.git',
  });

  assert.deepEqual(lines, ['[lark-agent-bridge] adding remote projects is not configured']);
});

test('//project add remote shows usage when git remote is missing', async () => {
  const bindingService = createBindingService();
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
    addRemoteProject: async () => ({ projectInstanceId: 'test', cwd: '/test' }),
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project add remote',
  });

  assert.deepEqual(lines, ['Usage: //project add remote <git-remote>']);
});

test('//project add shows usage when type is missing', async () => {
  const bindingService = createBindingService();
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project add',
  });

  assert.deepEqual(lines, [
    'Usage:',
    '  //project add local <path> [id]  - add a local project',
    '  //project add remote <git-remote> - add a project from git remote',
  ]);
});

test('//project add shows usage for unknown type', async () => {
  const bindingService = createBindingService();
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project add unknown',
  });

  assert.deepEqual(lines, [
    'Usage:',
    '  //project add local <path> [id]  - add a local project',
    '  //project add remote <git-remote> - add a project from git remote',
  ]);
});

test('//project shows usage for unknown subcommand', async () => {
  const bindingService = createBindingService();
  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project unknown',
  });

  assert.deepEqual(lines, [
    'Usage:',
    '  //project add local <path> [id]  - add a local project',
    '  //project add remote <git-remote> - add a project from git remote',
  ]);
});

test('//project add local handles path with spaces', async () => {
  const bindingService = createBindingService();
  const addLocalProjectCalls: Array<{ path: string; id?: string }> = [];

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
    addLocalProject: async (input) => {
      addLocalProjectCalls.push(input);
      return { projectInstanceId: input.id || 'My Project', cwd: input.path };
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project add local /srv/My Project',
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] added local project "My Project"',
    '  cwd: /srv/My Project',
  ]);
  assert.deepEqual(addLocalProjectCalls, [{ path: '/srv/My Project', id: undefined }]);
});

test('//project add local handles path with spaces and custom id', async () => {
  const bindingService = createBindingService();
  const addLocalProjectCalls: Array<{ path: string; id?: string }> = [];

  const service = createChatCommandService({
    bindingService,
    projectRegistry: {
      async describeProject() {
        return {
          projectInstanceId: 'project-a',
          configured: true,
          active: true,
          removed: false,
          sessionCount: 1,
        };
      },
    },
    addLocalProject: async (input) => {
      addLocalProjectCalls.push(input);
      return { projectInstanceId: input.id!, cwd: input.path };
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//project add local /srv/My Project app1',
  });

  assert.deepEqual(lines, [
    '[lark-agent-bridge] added local project "app1"',
    '  cwd: /srv/My Project',
  ]);
  assert.deepEqual(addLocalProjectCalls, [{ path: '/srv/My Project', id: 'app1' }]);
});
