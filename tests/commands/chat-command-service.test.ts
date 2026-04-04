import assert from 'node:assert/strict';
import test from 'node:test';

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
    '[codex-bridge] pending approvals:',
    '  42 | command execution | project-a | thr_123/turn_1',
  ]);

  const approveLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: '//approve 42',
  });

  assert.deepEqual(approveLines, ['[codex-bridge] approved request 42']);
  assert.deepEqual(responses, [
    {
      requestId: 42,
      result: {
        decision: 'accept',
      },
    },
  ]);
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

  assert.deepEqual(lines, ['[codex-bridge] resumed thread thr_123 for this chat']);
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

  assert.deepEqual(lines, ['[codex-bridge] resumed thread thr_456 for this chat']);
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

test('starts a fresh thread for //new and thread/start on the bound chat', async () => {
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

  const threadStartLines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: 'thread/start',
  });

  assert.deepEqual(newLines, ['[codex-bridge] started new thread thr_new_1 for this chat']);
  assert.deepEqual(threadStartLines, ['[codex-bridge] started new thread thr_new_2 for this chat']);
  assert.deepEqual(calls, [
    {
      projectInstanceId: 'project-a',
      options: {
        cwd: '/repo/project-a',
        force: true,
      },
    },
    {
      projectInstanceId: 'project-a',
      options: {
        cwd: '/repo/project-a',
        force: true,
      },
    },
  ]);
});

test('returns bridge and codex state for //sessions on a bound chat', async () => {
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
    text: '//sessions',
  });

  assert.deepEqual(lines, [
    '[codex-bridge] Bridge State:',
    '  chatId: chat-a',
    '  senderId: user-a',
    '  projectId: project-a',
    '[codex-bridge] Codex State:',
    '  projectId: project-a',
    '  configured: yes',
    '  active: yes',
    '  removed: no',
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
    '[codex-bridge] current binding:',
    '  chatId: chat-a',
    '  senderId: user-a',
    '  projectId: project-a',
  ]);
});

test('routes bare codex commands through the executor when bound', async () => {
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

  const service = createChatCommandService({
    bindingService,
    projectRegistry: registry,
    executeCodexCommand: async (input) => {
      calls.push(input);
      return ['[codex-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: 'app/list',
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
  assert.deepEqual(lines, ['[codex-bridge] codex ok']);
});

test('returns a configuration error when the codex executor is unavailable', async () => {
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
    text: 'app/list',
  });

  assert.deepEqual(lines, [
    '[codex-bridge] codex command support is not configured',
    '  projectId: project-a',
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
      return ['[codex-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: 'session/get chat-a',
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
  assert.deepEqual(lines, ['[codex-bridge] codex ok']);
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
      return ['[codex-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: 'session/list',
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
  assert.deepEqual(lines, ['[codex-bridge] codex ok']);
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
      return ['[codex-bridge] codex ok'];
    },
  });

  const lines = await service.execute({
    sessionId: 'chat-a',
    senderId: 'user-a',
    text: 'thread/list',
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
  assert.deepEqual(lines, ['[codex-bridge] codex ok']);
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
    '[codex-bridge] unknown command: session/delete chat-a',
    '[codex-bridge] commands:',
    '  //bind <projectId>  - bind this chat to a project',
    '  //unbind            - unbind this chat',
    '  //list              - show current binding',
    '  //new               - start a new codex thread for this chat',
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
    '  thread/start        - start a new codex thread',
    '  thread/read <id>    - get a codex thread',
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
    '[codex-bridge] unknown command: //sesions',
    '[codex-bridge] commands:',
    '  //bind <projectId>  - bind this chat to a project',
    '  //unbind            - unbind this chat',
    '  //list              - show current binding',
    '  //new               - start a new codex thread for this chat',
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
    '  thread/start        - start a new codex thread',
    '  thread/read <id>    - get a codex thread',
  ]);
});
