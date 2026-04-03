# 动态项目连接管理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标：** 实现按需建立 Codex 项目连接 — 只有当 chat 绑定到项目时才建立连接，解除绑定时断开连接。

**架构：**
- `projects.json` 配置文件定义所有可用项目
- `BindingService` 添加观察者回调，binding 变化时通知
- `CodexProjectRegistry` 改为动态管理 — 按需创建/销毁 sessions
- 启动时不建立任何 Codex 连接，等第一个 binding 触发

**技术栈：** Node.js 24 原生测试，ES modules，TypeScript

---

## 文件结构

```
新增: projects.json.example              # 项目配置示例
新增: src/runtime/project-registry.ts  # 动态项目连接管理器
修改: src/core/binding/binding-service.ts  # 添加 observer 回调
修改: src/main.ts                      # 使用新的动态 registry
修改: src/runtime/codex-config.ts       # 支持从文件加载 projects.json
修改: .env.example                     # 添加 projects.json 配置说明
修改: CLAUDE.md                        # 更新文档
```

---

## Task 1: BindingService 添加观察者回调

**目标：** Binding 变化时通知观察者

### 文件
- Modify: `src/core/binding/binding-service.ts`

### 步骤

- [ ] **Step 1: 编写测试**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { BindingService } from '../../../src/core/binding/binding-service.ts';
import { InMemoryBindingStore } from '../../../src/storage/binding-store.ts';

test('calls observer when binding is created', async () => {
  const store = new InMemoryBindingStore();
  const service = new BindingService(store);
  
  const events: Array<{ type: string; projectId?: string; sessionId?: string }> = [];
  service.onBindingChange((event) => events.push(event));
  
  await service.bindProjectToSession('project-a', 'chat-1');
  
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'bound');
  assert.equal(events[0].projectId, 'project-a');
  assert.equal(events[0].sessionId, 'chat-1');
});

test('calls observer when binding is removed', async () => {
  const store = new InMemoryBindingStore();
  const service = new BindingService(store);
  
  const events: Array<{ type: string; projectId?: string; sessionId?: string }> = [];
  service.onBindingChange((event) => events.push(event));
  
  await service.bindProjectToSession('project-a', 'chat-1');
  await service.unbindProject('project-a');
  
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'bound');
  assert.equal(events[1].type, 'unbound');
  assert.equal(events[1].projectId, 'project-a');
});

test('calls observer when session is unbound', async () => {
  const store = new InMemoryBindingStore();
  const service = new BindingService(store);
  
  const events: Array<{ type: string; projectId?: string; sessionId?: string }> = [];
  service.onBindingChange((event) => events.push(event));
  
  await service.bindProjectToSession('project-a', 'chat-1');
  await service.unbindSession('chat-1');
  
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'bound');
  assert.equal(events[1].type, 'session-unbound');
  assert.equal(events[1].sessionId, 'chat-1');
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --experimental-strip-types --test tests/core/binding/binding-service.test.ts`
Expected: FAIL — onBindingChange not defined

- [ ] **Step 3: 实现观察者模式**

修改 `src/core/binding/binding-service.ts`:

```ts
import type { BindingStore } from '../../storage/binding-store.ts';

export type BindingChangeEvent = 
  | { type: 'bound'; projectId: string; sessionId: string }
  | { type: 'unbound'; projectId: string }
  | { type: 'session-unbound'; sessionId: string };

export class BindingService {
  private readonly store: BindingStore;
  private readonly observers: Array<(event: BindingChangeEvent) => void> = [];

  constructor(store: BindingStore) {
    this.store = store;
  }

  onBindingChange(observer: (event: BindingChangeEvent) => void): void {
    this.observers.push(observer);
  }

  private notify(event: BindingChangeEvent): void {
    for (const observer of this.observers) {
      observer(event);
    }
  }

  async bindProjectToSession(projectInstanceId: string, sessionId: string): Promise<void> {
    this.store.setBinding(projectInstanceId, sessionId);
    this.notify({ type: 'bound', projectId: projectInstanceId, sessionId });
  }

  async unbindProject(projectInstanceId: string): Promise<void> {
    this.store.deleteByProject(projectInstanceId);
    this.notify({ type: 'unbound', projectId: projectInstanceId });
  }

  async unbindSession(sessionId: string): Promise<void> {
    this.store.deleteBySession(sessionId);
    this.notify({ type: 'session-unbound', sessionId });
  }

  async getSessionByProject(projectInstanceId: string): Promise<string | null> {
    return this.store.getSessionByProject(projectInstanceId);
  }

  async getProjectBySession(sessionId: string): Promise<string | null> {
    return this.store.getProjectBySession(sessionId);
  }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node --experimental-strip-types --test tests/core/binding/binding-service.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 提交**

```bash
git add src/core/binding/binding-service.ts tests/core/binding/binding-service.test.ts
git commit -m "feat: add binding change observer to BindingService"
```

---

## Task 2: 创建动态 ProjectRegistry

**目标：** 管理项目连接的动态创建和销毁

### 文件
- Create: `src/runtime/project-registry.ts`

### 步骤

- [ ] **Step 1: 编写测试**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectRegistry } from '../../../src/runtime/project-registry.ts';
import type { CodexProjectClient } from '../../../src/runtime/project-registry.ts';

let connectedProjects: string[] = [];
let disconnectedProjects: string[] = [];

function createMockClient(projectId: string): CodexProjectClient {
  return {
    generateReply: async ({ text }) => `reply to ${text}`,
    stop: async () => { disconnectedProjects.push(projectId); },
  };
}

test('creates connection when first binding is created', async () => {
  connectedProjects = [];
  disconnectedProjects = [];
  
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' } : null,
    createClient: createMockClient,
  });
  
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  
  assert.equal(connectedProjects.includes('project-a'), true);
  assert.equal(disconnectedProjects.length, 0);
});

test('does not reconnect if project already connected', async () => {
  connectedProjects = [];
  disconnectedProjects = [];
  
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' } : null,
    createClient: createMockClient,
  });
  
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-2' });
  
  assert.equal(connectedProjects.filter(p => p === 'project-a').length, 1);
});

test('disconnects when last binding for project is removed', async () => {
  connectedProjects = [];
  disconnectedProjects = [];
  
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' } : null,
    createClient: createMockClient,
  });
  
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  await registry.onBindingChanged({ type: 'session-unbound', sessionId: 'chat-1' });
  
  assert.equal(disconnectedProjects.includes('project-a'), true);
});

test('does not disconnect if project still has bindings', async () => {
  connectedProjects = [];
  disconnectedProjects = [];
  
  const registry = createProjectRegistry({
    getProjectConfig: (id) => id === 'project-a' ? { projectInstanceId: 'project-a', websocketUrl: 'ws://localhost:4000' } : null,
    createClient: createMockClient,
  });
  
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-1' });
  await registry.onBindingChanged({ type: 'bound', projectId: 'project-a', sessionId: 'chat-2' });
  await registry.onBindingChanged({ type: 'session-unbound', sessionId: 'chat-1' });
  
  assert.equal(disconnectedProjects.includes('project-a'), false);
});

test('returns null for unbound project', async () => {
  const registry = createProjectRegistry({
    getProjectConfig: () => null,
    createClient: createMockClient,
  });
  
  const handler = registry.getHandler('project-b');
  assert.equal(handler, null);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --experimental-strip-types --test tests/runtime/project-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 project-registry.ts**

```ts
import type { CodexProjectClient } from './codex-project-registry.ts';

export interface ProjectConfig {
  projectInstanceId: string;
  websocketUrl: string;
}

export interface ProjectRegistryOptions {
  getProjectConfig: (projectInstanceId: string) => ProjectConfig | null;
  createClient: (projectId: string, websocketUrl: string) => CodexProjectClient;
}

export interface ProjectRegistry {
  onBindingChanged(event: { type: string; projectId?: string; sessionId?: string }): Promise<void>;
  getHandler(projectInstanceId: string): ((input: { projectInstanceId: string; message: unknown }) => Promise<{ text: string } | null>) | null;
  stop(): Promise<void>;
}

export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  // projectId -> { client, session, bindingCount }
  const activeProjects = new Map<string, { client: CodexProjectClient; session: unknown; bindingCount: number }>();

  // projectId -> [sessionIds]
  const projectSessions = new Map<string, Set<string>>();

  async function connectProject(projectId: string): Promise<void> {
    if (activeProjects.has(projectId)) {
      return;
    }
    const config = options.getProjectConfig(projectId);
    if (!config) {
      return;
    }
    const client = options.createClient(projectId, config.websocketUrl);
    // Note: session creation would be similar to CodexProjectSession
    // For now, we track the client state
    activeProjects.set(projectId, { client, session: null, bindingCount: 0 });
  }

  async function disconnectProject(projectId: string): Promise<void> {
    const entry = activeProjects.get(projectId);
    if (entry) {
      await entry.client.stop();
      activeProjects.delete(projectId);
    }
    projectSessions.delete(projectId);
  }

  return {
    async onBindingChanged(event: { type: string; projectId?: string; sessionId?: string }) {
      if (event.type === 'bound' && event.projectId) {
        const projectId = event.projectId;
        const sessionId = event.sessionId!;

        // Add session to project's session set
        let sessions = projectSessions.get(projectId);
        if (!sessions) {
          sessions = new Set();
          projectSessions.set(projectId, sessions);
        }
        sessions.add(sessionId);

        // Connect if first binding
        if (sessions.size === 1) {
          await connectProject(projectId);
        }

        // Update binding count
        const entry = activeProjects.get(projectId);
        if (entry) {
          entry.bindingCount = sessions.size;
        }
      }

      if ((event.type === 'session-unbound' || event.type === 'unbound') && (event.projectId || event.sessionId)) {
        const projectId = event.projectId ?? '';
        const sessionId = event.sessionId ?? '';

        // Find project by session if needed
        let targetProjectId = projectId;
        if (!targetProjectId && sessionId) {
          for (const [pid, sessions] of projectSessions) {
            if (sessions.has(sessionId)) {
              targetProjectId = pid;
              break;
            }
          }
        }

        if (!targetProjectId) return;

        const sessions = projectSessions.get(targetProjectId);
        if (sessions && sessionId) {
          sessions.delete(sessionId);
        }

        // Disconnect if no more bindings
        if (!sessions || sessions.size === 0) {
          await disconnectProject(targetProjectId);
        } else {
          // Update binding count
          const entry = activeProjects.get(targetProjectId);
          if (entry) {
            entry.bindingCount = sessions?.size ?? 0;
          }
        }
      }
    },

    getHandler(projectInstanceId) {
      const entry = activeProjects.get(projectInstanceId);
      if (!entry) return null;

      return async ({ message }) => {
        const text = await entry.client.generateReply({ text: (message as { text: string }).text });
        return { text };
      };
    },

    async stop() {
      for (const projectId of activeProjects.keys()) {
        await disconnectProject(projectId);
      }
    },
  };
}
```

- [ ] **Step 4: 运行测试验证**

Run: `node --experimental-strip-types --test tests/runtime/project-registry.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/runtime/project-registry.ts tests/runtime/project-registry.test.ts
git commit -m "feat: add dynamic ProjectRegistry for on-demand connections"
```

---

## Task 3: 支持从文件加载项目配置

**目标：** 从 `projects.json` 加载项目列表

### 文件
- Create: `projects.json.example`
- Modify: `src/runtime/codex-config.ts`

### 步骤

- [ ] **Step 1: 添加示例配置**

```json
{
  "projects": [
    {
      "projectInstanceId": "project_a",
      "websocketUrl": "ws://127.0.0.1:4000"
    },
    {
      "projectInstanceId": "project_b",
      "websocketUrl": "ws://127.0.0.1:4001"
    }
  ]
}
```

- [ ] **Step 2: 在 codex-config.ts 添加文件加载函数**

```ts
export interface ProjectConfigEntry {
  projectInstanceId: string;
  websocketUrl?: string;
}

export function loadProjectsFromFile(filePath: string): ProjectConfigEntry[] | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const raw = readFileSync(filePath, 'utf8');
    if (raw.trim() === '') {
      return null;
    }
    const parsed = JSON.parse(raw) as { projects?: ProjectConfigEntry[] };
    if (!Array.isArray(parsed.projects)) {
      return null;
    }
    return parsed.projects.filter((p): p is ProjectConfigEntry =>
      typeof p.projectInstanceId === 'string' && p.projectInstanceId.trim() !== ''
    );
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: 提交**

```bash
git add projects.json.example src/runtime/codex-config.ts
git commit -m "feat: support loading project configs from projects.json file"
```

---

## Task 4: 修改 main.ts 集成动态 Registry

**目标：** 使用新的动态 registry 替代启动时全量连接

### 文件
- Modify: `src/main.ts`

### 步骤

- [ ] **Step 1: 重写 main.ts 中的 registry 部分**

主要改动：
1. 不再调用 `createCodexProjectRegistry().attach()`
2. 改为 `createProjectRegistry()` 挂在 `app` 上
3. `app.bindingService.onBindingChange()` 连接到 registry

```ts
// 删除原来的:
// codexProjectRegistry.attach(app.router);
// console.log(`[codex-bridge] codex app-server attached...`);

// 替换为:
const projectConfigs = loadProjectsFromFile('./projects.json') ?? [];

const registry = createProjectRegistry({
  getProjectConfig: (id) => projectConfigs.find(p => p.projectInstanceId === id) ?? null,
  createClient: (projectId, websocketUrl) => new CodexAppServerClient({
    command: 'codex',
    args: ['app-server'],
    clientInfo: { name: 'codex-bridge', title: 'Codex Bridge', version: '0.1.0' },
    serviceName: 'codex-bridge',
    transport: 'websocket',
    websocketUrl,
  }),
});

// 注册 handler 到 router
registry.onBindingChanged({ type: 'init' }); // no-op trigger to setup

app.bindingService.onBindingChange((event) => {
  void registry.onBindingChanged(event);
});

// 为每个已存在的 binding 建立连接
const bindings = await app.bindingService.getAllBindings?.(); // 需要添加这个方法
// 或者：启动后遍历现有 bindings 触发连接

console.log(`[codex-bridge] project registry ready`);
```

- [ ] **Step 2: 测试**

Run: `npm test` — expect PASS

- [ ] **Step 3: 提交**

```bash
git add src/main.ts
git commit -m "feat: integrate dynamic ProjectRegistry for on-demand Codex connections"
```

---

## Task 5: 更新文档

### 文件
- Modify: `CLAUDE.md`
- Modify: `.env.example`

### 步骤

- [ ] **Step 1: 更新 CLAUDE.md**

添加 projects.json 说明和动态连接机制

- [ ] **Step 2: 更新 .env.example**

```
BRIDGE_PROJECTS_FILE=./projects.json
```

- [ ] **Step 3: 提交**

---

## 自检清单

- [ ] 所有测试通过
- [ ] binding 创建时自动建立 Codex 连接
- [ ] binding 全部解除时自动断开连接
- [ ] 启动时无 Codex 连接，惰性连接
- [ ] 提交信息规范
