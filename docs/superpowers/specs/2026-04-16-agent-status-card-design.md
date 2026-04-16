# Agent Status Card Design

## Overview

Enhance the Lark bridge status card to display richer real-time Agent status information, including model, session, Git state, and rate limits.

## Card Structure

```
┌─────────────────────────────────────────────────────────┐
│ {projectId} | 🤖 Claude Code                    [{status}]│
├─────────────────────────────────────────────────────────┤
│ Rate: [{bar}] {percent}% left                             │
├─────────────────────────────────────────────────────────┤
│ {cwd} | {model} | {sessionId}                          │
│ git: {status} | branch: {branch} | {diffStat}          │
│ {subagent/background line - optional}                   │
└─────────────────────────────────────────────────────────┘
```

### Fields

| Field | Source | Description |
|-------|--------|-------------|
| projectId | Binding config | Project instance ID |
| status | reportProjectStatus | working / waiting_approval / done / failed |
| rate bar/percent | readCodexStatusLines | Parsed from SQLite rate limit data |
| cwd | system/init message (cached) | Current working directory |
| model | system/init message (cached) | Current model name |
| sessionId | system/init message (cached) | Current session ID |
| git status | git status --porcelain | Modified/clean status |
| branch | git branch --show-current | Current branch |
| diffStat | git diff --stat | Files changed stats |
| subagent/background | listThreads | Optional third line |

## Data Flow

### State Sources

| Data | Acquisition Method |
|------|-------------------|
| projectId | Binding config (already available) |
| status | reportProjectStatus callback |
| rate limits | readCodexStatusLines() from SQLite |
| model/session/cwd | Parse system/init JSON message, cache in memory |
| git state | Execute git commands on each message |
| subagent/background | listThreads from project registry |

### Status Sources

1. **system/init message** — Parsed via onNotification, extracts:
   - model
   - session_id
   - cwd
   - permissionMode
   - claude_code_version

2. **reportProjectStatus** — Already implemented, provides:
   - working
   - waiting_approval
   - done
   - failed

3. **readCodexStatusLines** — Already implemented, provides:
   - Rate limit bar and percentage

4. **Git commands** — Executed on each inbound message:
   ```bash
   git status --porcelain
   git branch --show-current
   git diff --stat
   ```

5. **listThreads** — Already implemented in project registry

## Refresh Strategy

### Trigger Points

1. **State transitions** — When status changes between working/waiting_approval/done/failed
2. **Turn completion** — Final refresh to ensure consistency
3. **Git state changes** — On each inbound message (to reflect latest git status)

### Refresh Guard

- Debounce rapid updates using lastSignature (already implemented in existing code)
- Skip if content hasn't actually changed

## New Components

### 1. Agent Status State Manager

**File:** `src/runtime/agent-status.ts`

**Responsibilities:**
- Cache agent state from system/init messages
- Store git state per project
- Provide unified interface for status card data

**Interface:**
```typescript
interface AgentStatusState {
  model: string | null;
  sessionId: string | null;
  cwd: string | null;
  permissionMode: string | null;
  gitStatus: 'modified' | 'clean' | 'unknown';
  gitBranch: string | null;
  gitDiffStat: string | null;
  backgroundTasks: Array<{ id: string; name: string; status: string }>;
}

interface AgentStatusManager {
  updateFromSystemInit(data: SystemInitData): void;
  updateGitState(projectId: string, cwd: string): Promise<void>;
  getStatus(projectId: string): AgentStatusState;
}
```

### 2. Enhanced Status Card Builder

**File:** `src/adapters/lark/cards.ts`

**New Function:**
```typescript
export function buildAgentStatusCard(input: {
  projectId: string;
  statusLabel: string;
  rateBar: string;
  ratePercent: number;
  cwd: string;
  model: string;
  sessionId: string;
  gitStatus: 'modified' | 'clean' | 'unknown';
  gitBranch: string;
  gitDiffStat: string;
  backgroundTasks?: Array<{ id: string; name: string; status: string }>;
  footerItems?: CardFooterItem[];
  template?: 'blue' | 'turquoise' | 'green' | 'yellow' | 'red' | 'grey';
}): FeishuInteractiveCardMessage
```

### 3. System Init Message Parser

**Location:** `ClaudeCodeClient.onNotification` and `CodexAppServerClient`

Parse system/init messages to extract and cache:
```typescript
case 'system':
  if (msg.subtype === 'init') {
    agentStatusManager.updateFromSystemInit({
      model: msg.model,
      sessionId: msg.session_id,
      cwd: msg.cwd,
      permissionMode: msg.permissionMode,
    });
  }
  break;
```

## File Changes

| File | Change |
|------|--------|
| `src/runtime/agent-status.ts` | New - Agent status state manager |
| `src/adapters/lark/cards.ts` | Add buildAgentStatusCard function |
| `src/adapters/claude-code/claude-code-client.ts` | Parse system/init in onNotification |
| `src/adapters/codex/app-server-client.ts` | Parse system/init in onNotification |
| `src/app.ts` | Integrate AgentStatusManager, update status card rendering |
| `tests/runtime/agent-status.test.ts` | New - unit tests |

## Implementation Order

1. Create `AgentStatusManager` class in `src/runtime/agent-status.ts`
2. Add `buildAgentStatusCard` to `src/adapters/lark/cards.ts`
3. Update `ClaudeCodeClient` to parse system/init messages
4. Update `CodexAppServerClient` to parse system/init messages
5. Integrate into `app.ts` BridgeRuntime
6. Add git state fetching
7. Wire up listThreads for background tasks
8. Add unit tests
