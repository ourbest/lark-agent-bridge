import { buildApprovalCard, type FeishuInteractiveCardMessage } from '../adapters/lark/cards.ts';

type ApprovalKind = 'commandExecution' | 'fileChange' | 'permissions';

type ApprovalCommand = 'approve' | 'approve-all' | 'approve-auto' | 'deny' | 'approvals';

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
  respond: (requestId: number | string, result: ApprovalResponse) => Promise<void>;
}

export interface ApprovalService {
  registerRequest(input: ApprovalRequestInput): Promise<{ lines: string[]; card: FeishuInteractiveCardMessage | null }>;
  handleCommand(input: { sessionId: string; text: string }): Promise<string[] | null>;
}

export interface ApprovalServiceOptions {
  now?: () => number;
}

type PendingRequest = ApprovalRequestInput & {
  createdAt: number;
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
    '[codex-bridge] Approval required:',
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

  lines.push(`  approve: //approve ${request.requestId}`);
  lines.push(`  approve all: //approve-all ${request.requestId}`);
  lines.push(`  deny: //deny ${request.requestId}`);

  return lines;
}

function buildPendingSummaryLines(request: PendingRequest): string[] {
  const toolInfo = request.toolName !== undefined && request.toolName !== null ? ` (${request.toolName})` : '';
  return [
    `  ${request.requestId} | ${describeRequestKind(request.kind)}${toolInfo} | ${request.projectInstanceId}`,
  ];
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

  return {
    async registerRequest(input: ApprovalRequestInput): Promise<{ lines: string[]; card: FeishuInteractiveCardMessage | null }> {
      const request: PendingRequest = {
        ...input,
        createdAt: now(),
      };

      if (isAutoApprovalActive(request.sessionId)) {
        const result = buildResolvedResult(request, 'approve-all');
        if (result !== null) {
          await request.respond(request.requestId, result);
          return {
            lines: [
              '[codex-bridge] auto-approved approval request for this chat',
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
            { label: 'Chat', value: request.sessionId },
            { label: 'Thread', value: request.threadId },
            { label: 'Turn', value: request.turnId },
            { label: 'Request', value: String(request.requestId) },
          ],
        }),
      };
    },

    async handleCommand(input: { sessionId: string; text: string }): Promise<string[] | null> {
      const parsed = parseApprovalCommand(input.text);
      if (parsed === null) {
        return null;
      }

      if (parsed.command === 'approvals') {
        const requests = Array.from(pendingRequests.values()).filter((request) => request.sessionId === input.sessionId);
        if (requests.length === 0) {
          return ['[codex-bridge] no pending approvals for this chat'];
        }

        return ['[codex-bridge] pending approvals:', ...requests.flatMap(buildPendingSummaryLines)];
      }

      if (parsed.command === 'approve-auto') {
        const minutes = Number.parseInt(parsed.requestId, 10);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          return ['Usage: //approve-auto <minutes>'];
        }

        autoApprovalExpiryBySession.set(input.sessionId, now() + minutes * 60 * 1000);

        const sessionRequests = Array.from(pendingRequests.values()).filter((request) => request.sessionId === input.sessionId);
        const approvedRequestIds: string[] = [];
        for (const request of sessionRequests) {
          const result = buildResolvedResult(request, 'approve-all');
          if (result === null) {
            continue;
          }

          await request.respond(request.requestId, result);
          pendingRequests.delete(String(request.requestId));
          approvedRequestIds.push(String(request.requestId));
        }

        const lines = [`[codex-bridge] enabled auto-approval for this chat for ${minutes} minutes`];
        if (approvedRequestIds.length > 0) {
          lines.push(`[codex-bridge] auto-approved ${approvedRequestIds.length} pending request(s): ${approvedRequestIds.join(', ')}`);
        }
        return lines;
      }

      // For approve-all without ID, approve all pending requests for this session
      if (parsed.command === 'approve-all' && parsed.requestId.trim() === '') {
        const sessionRequests = Array.from(pendingRequests.values()).filter((request) => request.sessionId === input.sessionId);
        if (sessionRequests.length === 0) {
          return ['[codex-bridge] no pending approvals for this chat'];
        }

        const results: string[] = [];
        for (const request of sessionRequests) {
          const result = buildResolvedResult(request, 'approve-all');
          if (result !== null) {
            await request.respond(request.requestId, result);
            pendingRequests.delete(String(request.requestId));
            results.push(String(request.requestId));
          }
        }
        return [`[codex-bridge] approved ${results.length} request(s) for the session: ${results.join(', ')}`];
      }

      if (parsed.requestId.trim() === '') {
        return [`Usage: //${parsed.command} <id>`];
      }

      const request = pendingRequests.get(parsed.requestId);
      if (request === undefined) {
        return [`[codex-bridge] approval request not found: ${parsed.requestId}`];
      }

      if (request.sessionId !== input.sessionId) {
        return [`[codex-bridge] approval request ${parsed.requestId} does not belong to this chat`];
      }

      const result = buildResolvedResult(request, parsed.command);
      if (result === null) {
        return [`[codex-bridge] approval request ${parsed.requestId} cannot be resolved with //${parsed.command}`];
      }

      await request.respond(request.requestId, result);
      pendingRequests.delete(parsed.requestId);

      if (request.kind === 'permissions' && parsed.command === 'deny') {
        return [`[codex-bridge] denied permissions request ${parsed.requestId} by withholding additional permissions`];
      }

      if (parsed.command === 'approve-all') {
        return [`[codex-bridge] approved request ${parsed.requestId} for the session`];
      }

      return [`[codex-bridge] approved request ${parsed.requestId}`];
    },
  };
}

function buildApprovalCardBody(request: PendingRequest): string {
  const lines: string[] = [];

  // Show Request ID at the top
  lines.push(`**Request ID:** ${request.requestId}`);

  // Show the most useful info first
  if (request.toolName !== undefined && request.toolName !== null) {
    lines.push(`**Tool:** ${request.toolName}`);
  }

  if (request.command !== undefined && request.command !== null) {
    lines.push(`**Command:** \`${request.command}\``);
  }

  if (request.reason !== undefined && request.reason !== null && request.reason.trim() !== '') {
    lines.push(`**Reason:** ${request.reason}`);
  }

  lines.push(''); // blank line separator

  if (request.kind === 'permissions') {
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

  lines.push('');
  lines.push(`Respond: //approve ${request.requestId} | //approve-all ${request.requestId} | //deny ${request.requestId}`);

  return lines.join('\n');
}
