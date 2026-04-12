import { buildApprovalCard, buildApprovalResultCard, type FeishuInteractiveCardMessage } from '../adapters/lark/cards.ts';

type ApprovalKind = 'commandExecution' | 'fileChange' | 'permissions';
type ApprovalCommand = 'approve' | 'approve-all' | 'approve-auto' | 'deny' | 'approvals';

export type ApprovalActionKind = 'approve' | 'approve-all' | 'approve-auto' | 'deny';

type ApprovalResponse =
  | { decision: 'accept' | 'acceptForSession' | 'decline' }
  | { permissions: { fileSystem?: { read?: string[]; write?: string[] } | null; network?: { enabled?: boolean | null } | null }; scope: 'turn' | 'session' };

export interface ApprovalRequestInput {
  requestId: number | string;
  projectInstanceId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  kind: ApprovalKind;
  command?: string | null;
  cwd?: string | null;
  grantRoot?: string | null;
  reason?: string | null;
  permissions?: { fileSystem?: { read?: string[]; write?: string[] } | null; network?: { enabled?: boolean | null } | null } | null;
  toolName?: string | null;
  forcePending?: boolean;
  respond: (requestId: number | string, result: ApprovalResponse) => Promise<void>;
}

export interface ApprovalActionInput {
  sessionId: string;
  projectInstanceId: string;
  action: ApprovalActionKind;
  requestId?: string | number;
}

export interface ApprovalActionUpdate {
  requestId: string | number;
  messageId: string | null;
  card: FeishuInteractiveCardMessage;
}

export interface ApprovalActionResult {
  lines: string[];
  updates: ApprovalActionUpdate[];
}

export interface ApprovalService {
  registerRequest(input: ApprovalRequestInput): Promise<{ lines: string[]; card: FeishuInteractiveCardMessage | null }>;
  attachCardMessage(requestId: number | string, messageId: string): Promise<void>;
  getCardMessageId(requestId: number | string): string | null;
  handleAction(input: ApprovalActionInput): Promise<ApprovalActionResult | null>;
  handleCommand(input: { sessionId: string; text: string }): Promise<string[] | null>;
}

export interface ApprovalServiceOptions {
  now?: () => number;
}

type PendingRequest = ApprovalRequestInput & {
  createdAt: number;
  cardMessageId: string | null;
};

function formatYesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function formatPermissions(value: ApprovalRequestInput['permissions']): string[] {
  if (value === null || value === undefined) {
    return ['  permissions: none'];
  }

  const lines: string[] = ['  permissions:'];
  const fileSystem = value.fileSystem ?? null;
  const network = value.network ?? null;

  if (fileSystem !== null && fileSystem !== undefined) {
    lines.push('    fileSystem:');
    if (fileSystem.read !== undefined && fileSystem.read !== null) {
      lines.push(`      read: ${fileSystem.read.length === 0 ? '[]' : fileSystem.read.join(', ')}`);
    }
    if (fileSystem.write !== undefined && fileSystem.write !== null) {
      lines.push(`      write: ${fileSystem.write.length === 0 ? '[]' : fileSystem.write.join(', ')}`);
    }
  }

  if (network !== null && network !== undefined) {
    lines.push('    network:');
    if (network.enabled !== undefined && network.enabled !== null) {
      lines.push(`      enabled: ${formatYesNo(network.enabled)}`);
    }
  }

  if (lines.length === 1) {
    lines.push('    <empty>');
  }

  return lines;
}

function describeRequestKind(kind: ApprovalKind): string {
  switch (kind) {
    case 'commandExecution':
      return 'command execution';
    case 'fileChange':
      return 'file change';
    case 'permissions':
      return 'permissions';
  }
}

function buildAnnouncementLines(request: PendingRequest): string[] {
  const lines = [
    '[lark-agent-bridge] Approval required:',
    `  Request ID: ${request.requestId}`,
    `  kind: ${describeRequestKind(request.kind)}`,
    `  projectId: ${request.projectInstanceId}`,
    `  chatId: ${request.sessionId}`,
    `  threadId: ${request.threadId}`,
    `  turnId: ${request.turnId}`,
    `  itemId: ${request.itemId}`,
  ];

  if (request.command !== undefined && request.command !== null) {
    lines.push(`  command: ${request.command}`);
  }

  if (request.cwd !== undefined && request.cwd !== null) {
    lines.push(`  cwd: ${request.cwd}`);
  }

  if (request.grantRoot !== undefined && request.grantRoot !== null) {
    lines.push(`  grantRoot: ${request.grantRoot}`);
  }

  if (request.kind === 'permissions') {
    lines.push(...formatPermissions(request.permissions));
  }

  if (request.reason !== undefined && request.reason !== null && request.reason.trim() !== '') {
    lines.push(`  reason: ${request.reason}`);
  }

  lines.push('  actions: 授权 | 授权所有 | 自动授权');

  return lines;
}

function buildPendingSummaryLines(request: PendingRequest): string[] {
  const toolInfo = request.toolName !== undefined && request.toolName !== null ? ` (${request.toolName})` : '';
  return [`  ${request.requestId} | ${describeRequestKind(request.kind)}${toolInfo} | ${request.projectInstanceId}`];
}

function buildApprovalCardBody(request: PendingRequest): string {
  const lines: string[] = [`**Request ID:** ${request.requestId}`];

  if (request.toolName !== undefined && request.toolName !== null) {
    lines.push(`**Tool:** ${request.toolName}`);
  }

  if (request.command !== undefined && request.command !== null) {
    lines.push(`**Command:** \`${request.command}\``);
  }

  if (request.reason !== undefined && request.reason !== null && request.reason.trim() !== '') {
    lines.push(`**Reason:** ${request.reason}`);
  }

  if (request.kind === 'permissions') {
    lines.push('');
    lines.push(`**Kind:** ${describeRequestKind(request.kind)}`);
    const permissions = request.permissions ?? {};
    const fileSystem = permissions.fileSystem ?? null;
    const network = permissions.network ?? null;
    if (fileSystem !== null) {
      if (fileSystem.read !== undefined && fileSystem.read !== null) {
        lines.push(`**FS Read:** ${fileSystem.read.length === 0 ? '[]' : fileSystem.read.join(', ')}`);
      }
      if (fileSystem.write !== undefined && fileSystem.write !== null) {
        lines.push(`**FS Write:** ${fileSystem.write.length === 0 ? '[]' : fileSystem.write.join(', ')}`);
      }
    }
    if (network !== null && network.enabled !== undefined && network.enabled !== null) {
      lines.push(`**Network:** ${formatYesNo(network.enabled)}`);
    }
  }

  return lines.join('\n');
}

function buildResultCardForRequest(request: PendingRequest, status: 'approved' | 'approved-all' | 'auto-approved' | 'denied'): FeishuInteractiveCardMessage {
  return buildApprovalResultCard({
    title: 'Approval resolved',
    subtitle: `${describeRequestKind(request.kind)} | ${request.projectInstanceId}`,
    status,
    footerItems: [
      { label: '授权ID', value: String(request.requestId) },
      { label: '注', value: '自动授权有效期 1 小时' },
    ],
  });
}

function buildResultLines(input: { status: 'approved' | 'approved-all' | 'auto-approved' | 'denied'; requestIds: Array<string | number> }): string[] {
  if (input.requestIds.length === 0) {
    return ['[lark-agent-bridge] no matching approval requests found'];
  }

  const statusLabel =
    input.status === 'approved'
      ? 'approved request'
      : input.status === 'approved-all'
        ? 'approved request(s) for the session'
        : input.status === 'auto-approved'
          ? 'auto-approved approval request(s) for this chat'
          : 'denied request';

  if (input.status === 'approved' || input.status === 'denied') {
    return [`[lark-agent-bridge] ${statusLabel} ${String(input.requestIds[0])}`];
  }

  return [`[lark-agent-bridge] ${statusLabel}: ${input.requestIds.map(String).join(', ')}`];
}

function buildResolvedResult(request: PendingRequest, command: Exclude<ApprovalCommand, 'approvals'>): ApprovalResponse | null {
  if (request.kind === 'permissions') {
    const permissions = command === 'deny' ? {} : (request.permissions ?? {});
    return {
      permissions,
      scope: command === 'approve-all' ? 'session' : 'turn',
    };
  }

  if (command === 'approve') {
    return { decision: 'accept' };
  }

  if (command === 'approve-all') {
    return { decision: 'acceptForSession' };
  }

  if (command === 'deny') {
    return { decision: 'decline' };
  }

  return null;
}

function parseApprovalCommand(text: string): { command: ApprovalCommand; requestId: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('//')) {
    return null;
  }

  const parts = trimmed.slice(2).trim().split(/\s+/).filter(Boolean);
  const command = parts[0]?.toLowerCase() ?? '';
  if (command !== 'approve' && command !== 'approve-all' && command !== 'approve-auto' && command !== 'deny' && command !== 'approvals') {
    return null;
  }

  if (command === 'approvals') {
    return { command, requestId: '' };
  }

  return {
    command,
    requestId: parts[1] ?? '',
  };
}

function normalizeActionStatus(action: ApprovalActionKind): 'approved' | 'approved-all' | 'auto-approved' | 'denied' {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'approve-all':
      return 'approved-all';
    case 'approve-auto':
      return 'auto-approved';
    case 'deny':
      return 'denied';
  }
}

export function createApprovalService(options: ApprovalServiceOptions = {}): ApprovalService {
  const pendingRequests = new Map<string, PendingRequest>();
  const autoApprovalExpiryBySession = new Map<string, number>();
  const now = options.now ?? Date.now;

  function isAutoApprovalActive(sessionId: string): boolean {
    const expiry = autoApprovalExpiryBySession.get(sessionId);
    if (expiry === undefined) {
      return false;
    }

    if (now() > expiry) {
      autoApprovalExpiryBySession.delete(sessionId);
      return false;
    }

    return true;
  }

  function getPendingRequestsForSession(sessionId: string): PendingRequest[] {
    return Array.from(pendingRequests.values()).filter((request) => request.sessionId === sessionId);
  }

  function getPendingRequestsForSessionAndProject(sessionId: string, projectInstanceId: string): PendingRequest[] {
    return Array.from(pendingRequests.values()).filter(
      (request) => request.sessionId === sessionId && request.projectInstanceId === projectInstanceId,
    );
  }

  function getRequestById(requestId: string | number): PendingRequest | null {
    return pendingRequests.get(String(requestId)) ?? null;
  }

  function removeRequest(request: PendingRequest): void {
    pendingRequests.delete(String(request.requestId));
  }

  async function resolveRequests(requests: PendingRequest[], command: Exclude<ApprovalCommand, 'approvals'>): Promise<void> {
    for (const request of requests) {
      const result = buildResolvedResult(request, command);
      if (result === null) {
        continue;
      }

      await request.respond(request.requestId, result);
      removeRequest(request);
    }
  }

  function buildActionUpdates(requests: PendingRequest[], status: 'approved' | 'approved-all' | 'auto-approved' | 'denied'): ApprovalActionUpdate[] {
    return requests
      .filter((request) => request.cardMessageId !== null && request.cardMessageId !== '')
      .map((request) => ({
        requestId: request.requestId,
        messageId: request.cardMessageId,
        card: buildResultCardForRequest(request, status),
      }));
  }

  return {
    async registerRequest(input: ApprovalRequestInput): Promise<{ lines: string[]; card: FeishuInteractiveCardMessage | null }> {
      const request: PendingRequest = {
        ...input,
        createdAt: now(),
        cardMessageId: null,
      };

      if (!input.forcePending && isAutoApprovalActive(request.sessionId)) {
        const result = buildResolvedResult(request, 'approve-all');
        if (result !== null) {
          await request.respond(request.requestId, result);
          return {
            lines: [
              '[lark-agent-bridge] auto-approved approval request for this chat',
              `  Request ID: ${request.requestId}`,
              `  kind: ${describeRequestKind(request.kind)}`,
            ],
            card: null,
          };
        }
      }

      pendingRequests.set(String(input.requestId), request);
      return {
        lines: buildAnnouncementLines(request),
        card: buildApprovalCard({
          title: 'Approval required',
          subtitle: `${describeRequestKind(request.kind)} | ${request.projectInstanceId}`,
          bodyMarkdown: buildApprovalCardBody(request),
          footerItems: [
            { label: '授权ID', value: String(request.requestId) },
            { label: '注', value: '自动授权有效期 1 小时' },
          ],
          requestId: request.requestId,
        }),
      };
    },

    async attachCardMessage(requestId: number | string, messageId: string): Promise<void> {
      const request = getRequestById(requestId);
      if (request !== null) {
        request.cardMessageId = messageId;
      }
    },

    getCardMessageId(requestId: number | string): string | null {
      return getRequestById(requestId)?.cardMessageId ?? null;
    },

    async handleAction(input: ApprovalActionInput): Promise<ApprovalActionResult | null> {
      const status = normalizeActionStatus(input.action);

      if (input.action === 'approve-auto') {
        autoApprovalExpiryBySession.set(input.sessionId, now() + 60 * 60 * 1000);
      }

      let requests: PendingRequest[] = [];
      if (input.action === 'approve' || input.action === 'deny') {
        if (input.requestId === undefined) {
          return {
            lines: [`Usage: //${input.action} <id>`],
            updates: [],
          };
        }

        const request = getRequestById(input.requestId);
        if (
          request === null ||
          request.sessionId !== input.sessionId ||
          request.projectInstanceId !== input.projectInstanceId
        ) {
          return {
            lines: [`[lark-agent-bridge] approval request not found: ${String(input.requestId)}`],
            updates: [],
          };
        }

        requests = [request];
      } else {
        requests = getPendingRequestsForSessionAndProject(input.sessionId, input.projectInstanceId);
      }

      if (requests.length === 0) {
        return {
          lines: ['[lark-agent-bridge] no matching approval requests found'],
          updates: [],
        };
      }

      const command = input.action === 'approve-auto' ? 'approve-all' : input.action;
      await resolveRequests(requests, command);

      return {
        lines: buildResultLines({
          status,
          requestIds: requests.map((request) => request.requestId),
        }),
        updates: buildActionUpdates(requests, status),
      };
    },

    async handleCommand(input: { sessionId: string; text: string }): Promise<string[] | null> {
      const parsed = parseApprovalCommand(input.text);
      if (parsed === null) {
        return null;
      }

      if (parsed.command === 'approvals') {
        const requests = getPendingRequestsForSession(input.sessionId);
        if (requests.length === 0) {
          return ['[lark-agent-bridge] no pending approvals for this chat'];
        }

        return ['[lark-agent-bridge] pending approvals:', ...requests.flatMap(buildPendingSummaryLines)];
      }

      if (parsed.command === 'approve-auto') {
        const minutes = Number.parseInt(parsed.requestId, 10);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          return ['Usage: //approve-auto <minutes>'];
        }

        autoApprovalExpiryBySession.set(input.sessionId, now() + minutes * 60 * 1000);

        const sessionRequests = getPendingRequestsForSession(input.sessionId);
        await resolveRequests(sessionRequests, 'approve-all');

        const lines = [`[lark-agent-bridge] enabled auto-approval for this chat for ${minutes} minutes`];
        if (sessionRequests.length > 0) {
          lines.push(`[lark-agent-bridge] auto-approved ${sessionRequests.length} pending request(s): ${sessionRequests.map((request) => request.requestId).join(', ')}`);
        }
        return lines;
      }

      if (parsed.command === 'approve-all' && parsed.requestId.trim() === '') {
        const sessionRequests = getPendingRequestsForSession(input.sessionId);
        if (sessionRequests.length === 0) {
          return ['[lark-agent-bridge] no pending approvals for this chat'];
        }

        await resolveRequests(sessionRequests, 'approve-all');
        return [`[lark-agent-bridge] approved ${sessionRequests.length} request(s) for the session: ${sessionRequests.map((request) => request.requestId).join(', ')}`];
      }

      if (parsed.requestId.trim() === '') {
        return [`Usage: //${parsed.command} <id>`];
      }

      const request = getRequestById(parsed.requestId);
      if (request === null) {
        return [`[lark-agent-bridge] approval request not found: ${parsed.requestId}`];
      }

      if (request.sessionId !== input.sessionId) {
        return [`[lark-agent-bridge] approval request ${parsed.requestId} does not belong to this chat`];
      }

      const result = buildResolvedResult(request, parsed.command);
      if (result === null) {
        return [`[lark-agent-bridge] approval request ${parsed.requestId} cannot be resolved with //${parsed.command}`];
      }

      await request.respond(request.requestId, result);
      removeRequest(request);

      if (request.kind === 'permissions' && parsed.command === 'deny') {
        return [`[lark-agent-bridge] denied permissions request ${parsed.requestId} by withholding additional permissions`];
      }

      if (parsed.command === 'approve-all') {
        return [`[lark-agent-bridge] approved request ${parsed.requestId} for the session`];
      }

      return [`[lark-agent-bridge] approved request ${parsed.requestId}`];
    },
  };
}
