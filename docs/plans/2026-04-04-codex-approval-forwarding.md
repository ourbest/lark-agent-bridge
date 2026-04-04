# Codex Approval Forwarding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Forward Codex app-server approval requests to Feishu and let the user approve or reject them from chat.

**Architecture:** Add a bridge-owned approval state service that records pending app-server requests, formats Feishu messages, and resolves user commands back into JSON-RPC responses. Extend the Codex client to surface server requests and send responses by request id. Keep the chat command layer as the only user-facing entry point for listing and resolving approvals.

**Tech Stack:** TypeScript, Node.js test runner, existing bridge runtime, Feishu Lark transport, Codex app-server protocol.

### Task 1: Codex server request transport

**Files:**
- Modify: `src/adapters/codex/app-server-client.ts`
- Test: `tests/adapters/codex/app-server-client.test.ts`

**Step 1: Write the failing test**

Add a test that sends `item/commandExecution/requestApproval` from the app-server and expects the client to surface it as a structured callback, then send a JSON-RPC response back by request id.

**Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/adapters/codex/app-server-client.test.ts`
Expected: FAIL because the callback and response API do not exist yet.

**Step 3: Write minimal implementation**

Add `onServerRequest` and `respondToServerRequest` support to the Codex client, and route approval request methods through it.

**Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/adapters/codex/app-server-client.test.ts`
Expected: PASS.

### Task 2: Pending approval state

**Files:**
- Create: `src/runtime/approval-service.ts`
- Test: `tests/runtime/approval-service.test.ts`

**Step 1: Write the failing test**

Add a test that registers a pending approval, lists it for `//approvals`, and resolves `//approve` or `//approve-all` into the right Codex response.

**Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/runtime/approval-service.test.ts`
Expected: FAIL because the service does not exist yet.

**Step 3: Write minimal implementation**

Implement request tracking, Feishu-facing summaries, and response conversion.

**Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/runtime/approval-service.test.ts`
Expected: PASS.

### Task 3: Chat command integration

**Files:**
- Modify: `src/commands/chat-command-service.ts`
- Test: `tests/commands/chat-command-service.test.ts`

**Step 1: Write the failing test**

Add tests for `//approvals`, `//approve <id>`, `//deny <id>`, and `//approve-all <id>`.

**Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/commands/chat-command-service.test.ts`
Expected: FAIL until the commands are wired.

**Step 3: Write minimal implementation**

Delegate approval commands to the new approval service while keeping existing bridge commands intact.

**Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/commands/chat-command-service.test.ts`
Expected: PASS.

### Task 4: Bridge wiring

**Files:**
- Modify: `src/app.ts`
- Modify: `src/main.ts`
- Test: `tests/smoke/app.test.ts`

**Step 1: Write the failing test**

Add a smoke test that sends a mock approval request, observes the Feishu message, and resolves it through chat.

**Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test tests/smoke/app.test.ts`
Expected: FAIL until the runtime wiring exists.

**Step 3: Write minimal implementation**

Wire the Codex request callback to the approval service and use the existing Lark transport to deliver the message back to the bound chat.

**Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test tests/smoke/app.test.ts`
Expected: PASS.

### Task 5: Full verification

**Files:**
- Modify: `tests/all.test.ts` if needed

**Step 1: Run the full suite**

Run: `npm test`

**Step 2: Fix any regressions**

Keep the change set minimal and preserve existing bridge and Codex command behavior.

