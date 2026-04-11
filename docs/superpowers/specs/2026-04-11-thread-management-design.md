# Thread Management Design

> **Goal:** Allow users to list, cancel, pause, and resume background threads running in agent providers (Codex, CC, Qwen) via chat commands and interactive cards.

## Overview

Threads are independent background tasks managed by the agent provider, separate from the IM session. The bridge acts as a command forwarder, translating user commands into provider-specific thread management calls and rendering results as interactive cards.

## Interface

### Unified Thread Data Model

```typescript
interface Thread {
  id: string;
  name: string;
  description: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  createdAt: Date;
  duration?: string;
}
```

### ThreadManager Interface

Each provider adapter implements this interface:

```typescript
interface ThreadManager {
  listThreads(): Promise<Thread[]>;
  cancelThread(id: string): Promise<void>;
  pauseThread(id: string): Promise<void>;
  resumeThread(id: string): Promise<void>;
}
```

## Commands

| Command | Description |
|---------|-------------|
| `//thread` | Show help |
| `//thread list` | List all threads for the bound project (interactive card) |
| `//thread cancel <id>` | Cancel a thread |
| `//thread pause <id>` | Pause a thread |
| `//thread resume <id>` | Resume a paused thread |

## Card Format

`//thread list` renders an interactive card:

```
┌─────────────────────────────────┐
│ 🧵 后台任务            [刷新]    │
├─────────────────────────────────┤
│ ● thread-abc123                 │
│   描述：分析日志                │
│   状态：运行中  时长：5分12秒   │
│   [取消] [暂停]                 │
├─────────────────────────────────┤
│ ○ thread-def456                 │
│   描述：生成报告                │
│   状态：已暂停  时长：2分03秒   │
│   [取消] [恢复]                 │
└─────────────────────────────────┘
```

### Card Button Actions

Buttons send structured card actions containing `{ action: 'cancel'|'pause'|'resume', threadId: string }`. The bridge routes these to `ThreadManager.{cancel|pause|resume}Thread()`.

## Architecture

```
src/
├── adapters/
│   ├── codex/app-server-client.ts   → implements ThreadManager
│   ├── cc/...                       → implements ThreadManager
│   └── qwen/...                     → implements ThreadManager
├── runtime/
│   └── thread-manager.ts            → Unified entry point; routes to the correct provider's ThreadManager based on current binding
└── commands/
    └── chat-command-service.ts      → routes //thread commands
```

`ThreadManager` is resolved per current binding (same pattern as existing provider resolution).

## Key Design Decisions

1. **Separate from session**: threads exist independently of IM sessions
2. **Scoped to bound project**: `//thread list` only shows threads for the currently bound project
3. **Card-first**: results shown as interactive cards with action buttons; text commands still work
4. **Unified interface, per-provider implementation**: the `ThreadManager` interface is the same, but each provider implements it differently based on their actual thread API
