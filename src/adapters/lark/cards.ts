type CardTextItem = { tag: 'plain_text'; content?: string; lines?: number } | { tag: 'lark_md'; content?: string };

export interface FeishuInteractiveCardContent {
  schema?: '2.0' | '1.0';
  config?: {
    wide_screen_mode?: boolean;
    enable_forward?: boolean;
    enable_forward_interaction?: boolean;
    update_multi?: boolean;
    width_mode?: 'compact' | 'fill';
  };
  header: {
    template?: 'blue' | 'turquoise' | 'green' | 'yellow' | 'red' | 'grey';
    title: { tag: 'plain_text' | 'lark_md'; content?: string };
    subtitle?: { tag: 'plain_text' | 'lark_md'; content?: string };
  };
  body: {
    elements: Array<Record<string, unknown>>;
  };
}

export interface FeishuInteractiveCardMessage {
  msg_type: 'interactive';
  content: string;
}

export interface CardFooterItem {
  label: string;
  value: string;
}

function plainText(content: string): CardTextItem {
  return { tag: 'plain_text', content };
}

function buildFooterText(items: CardFooterItem[]): string {
  return items
    .map((item) => {
      const label = item.label.trim();
      return label === '' ? item.value : `${label}: ${item.value}`;
    })
    .join(' | ');
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function buildFooterMarkdown(items: CardFooterItem[]): Record<string, unknown> {
  return {
    tag: 'markdown',
    content: `<font color="grey">${escapeHtml(buildFooterText(items))}</font>`,
    text_size: 'notation',
    margin: '8px 0 0 0',
  };
}

function buildCodeBlockMarkdown(lines: string[]): string {
  const sanitizedLines = lines.map((line) => line.replaceAll('```', '``\\`'));
  return ['```text', ...sanitizedLines, '```'].join('\n');
}

export function buildInteractiveCardMessage(card: FeishuInteractiveCardContent): FeishuInteractiveCardMessage {
  return {
    msg_type: 'interactive',
    content: JSON.stringify(card),
  };
}

export function buildProjectReplyCard(input: {
  projectTitle: string;
  bodyMarkdown: string;
  footerItems: CardFooterItem[];
  providerName?: string;
  subtitle?: string;
}): FeishuInteractiveCardMessage {
  const providerDisplayName = input.providerName || 'Claude Code';

  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      wide_screen_mode: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: 'blue',
      title: plainText(`${input.projectTitle} | 🤖 ${providerDisplayName}`),
      subtitle: input.subtitle ? plainText(input.subtitle) : undefined,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: input.bodyMarkdown,
        },
        {
          tag: 'hr',
        },
        buildFooterMarkdown(input.footerItems),
      ],
    },
  });
}

export function buildBridgeStatusCard(input: {
  projectTitle: string;
  statusLabel: string;
  bodyMarkdown: string;
  footerItems?: CardFooterItem[];
  providerName?: string;
  template?: 'blue' | 'turquoise' | 'green' | 'yellow' | 'red' | 'grey';
}): FeishuInteractiveCardMessage {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: input.bodyMarkdown,
    },
  ];

  if (input.footerItems !== undefined && input.footerItems.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push(buildFooterMarkdown(input.footerItems));
  }

  const providerDisplayName = input.providerName || 'Claude Code';

  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      wide_screen_mode: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: input.template ?? 'blue',
      title: plainText(`${input.projectTitle} | 🤖 ${providerDisplayName}`),
      subtitle: plainText(input.statusLabel),
    },
    body: {
      elements,
    },
  });
}

export function getModeIcon(mode: string | null | undefined): string {
  switch (mode) {
    case 'plan':      return '🟡 plan';
    case 'yolo':      return '🔴 yolo';
    case 'auto-edit': return '🟢 auto-edit';
    default:          return '🟢 auto-edit';
  }
}

export function buildAgentStatusCard(input: {
  projectId: string;
  statusLabel: string;
  bodyMarkdown: string;
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
  permissionMode?: string;
  providerName?: string;
  template?: 'blue' | 'turquoise' | 'green' | 'yellow' | 'red' | 'grey';
}): FeishuInteractiveCardMessage {
  console.log(`[cards] buildAgentStatusCard: projectId=${input.projectId} rateBar=${input.rateBar} ratePercent=${input.ratePercent} cwd=${input.cwd} model=${input.model} sessionId=${input.sessionId} gitBranch=${input.gitBranch}`);

  // Build agent status info for footer
  const agentFooterItems: CardFooterItem[] = [];

  // Only show git info if we have valid data (not unknown and have branch)
  const showGitInfo = input.gitStatus !== 'unknown' && input.gitBranch;
  if (showGitInfo) {
    const gitStatusIcon = input.gitStatus === 'modified' ? '✗' : '✓';
    const gitLine = `git: ${gitStatusIcon} | branch: ${input.gitBranch} | ${input.gitDiffStat || ''}`;
    agentFooterItems.push({ label: '', value: gitLine });
  }

  if (input.cwd) agentFooterItems.push({ label: '', value: input.cwd });
  if (input.model) agentFooterItems.push({ label: '', value: input.model });
  if (input.sessionId) agentFooterItems.push({ label: '', value: input.sessionId });

  if (input.permissionMode) {
    agentFooterItems.push({ label: '', value: getModeIcon(input.permissionMode) });
  }

  if (input.backgroundTasks && input.backgroundTasks.length > 0) {
    const taskSummary = input.backgroundTasks
      .map(t => `${t.name} [${t.status}]`)
      .join(' | ');
    agentFooterItems.push({ label: '', value: taskSummary });
  }

  // Combine statusLabel with rate info in subtitle (only if rate data is valid)
  const hasValidRate = input.rateBar !== '[????????????????????]' && Number.isFinite(input.ratePercent);
  const subtitle = hasValidRate
    ? `${input.statusLabel} | ${input.rateBar} ${input.ratePercent}% left`
    : input.statusLabel;

  // Body shows what's being processed
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: input.bodyMarkdown },
  ];

  // Merge footerItems and agentFooterItems
  const allFooterItems = [
    ...(input.footerItems ?? []),
    ...agentFooterItems,
  ];

  if (allFooterItems.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push(buildFooterMarkdown(allFooterItems));
  }

  const providerDisplayName = input.providerName || 'Claude Code';

  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      wide_screen_mode: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: input.template ?? 'blue',
      title: plainText(`${input.projectId} | 🤖 ${providerDisplayName}`),
      subtitle: plainText(subtitle),
    },
    body: {
      elements,
    },
  });
}

export function buildMarkdownContentCard(input: {
  title: string;
  bodyMarkdown: string;
  footerItems?: CardFooterItem[];
  subtitle?: string;
  template?: 'blue' | 'turquoise' | 'green' | 'yellow' | 'red' | 'grey';
}): FeishuInteractiveCardMessage {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: input.bodyMarkdown,
    },
  ];

  if (input.footerItems !== undefined && input.footerItems.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push(buildFooterMarkdown(input.footerItems));
  }

  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      wide_screen_mode: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: input.template ?? 'blue',
      title: plainText(input.title),
      subtitle: input.subtitle ? plainText(input.subtitle) : undefined,
    },
    body: {
      elements,
    },
  });
}

export function buildCommandResultCard(input: {
  title: string;
  lines: string[];
  footerItems?: CardFooterItem[];
  subtitle?: string;
}): FeishuInteractiveCardMessage {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: input.lines.join('\n'),
    },
  ];

  if (input.footerItems !== undefined && input.footerItems.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push(buildFooterMarkdown(input.footerItems));
  }

  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: 'grey',
      title: plainText(input.title),
      subtitle: input.subtitle ? plainText(input.subtitle) : undefined,
    },
    body: {
      elements,
    },
  });
}

function buildApprovalButton(action: string, requestId: string, content: string, primary = false): Record<string, unknown> {
  return {
    tag: 'button',
    type: primary ? 'primary' : 'default',
    text: { tag: 'plain_text', content },
    value: { action, requestId },
  };
}

export function buildApprovalCard(input: {
  title: string;
  subtitle?: string;
  bodyMarkdown: string;
  footerItems: CardFooterItem[];
  requestId: string | number;
}): FeishuInteractiveCardMessage {
  const requestIdStr = String(input.requestId);
  const buttons = [
    buildApprovalButton('approve', requestIdStr, '授权', true),
    buildApprovalButton('approve-all', requestIdStr, '授权所有'),
    buildApprovalButton('approve-auto', requestIdStr, '自动授权'),
  ];

  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: input.bodyMarkdown },
    {
      tag: 'column_set',
      columns: buttons.map((btn) => ({
        tag: 'column',
        width: 'stretch',
        elements: [btn],
      })),
    },
    { tag: 'hr' },
    buildFooterMarkdown(input.footerItems),
  ];

  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      update_multi: true,
      wide_screen_mode: true,
      width_mode: 'fill',
    },
    header: {
      template: 'yellow',
      title: plainText(input.title),
      subtitle: input.subtitle ? plainText(input.subtitle) : undefined,
    },
    body: {
      elements,
    },
  });
}

export function buildApprovalResultCard(input: {
  title: string;
  subtitle?: string;
  status: 'approved' | 'approved-all' | 'auto-approved' | 'denied';
  footerItems: CardFooterItem[];
}): FeishuInteractiveCardMessage {
  const bodyMarkdown = (() => {
    switch (input.status) {
      case 'approved':
        return '✅ 已授权。';
      case 'approved-all':
        return '✅ 已授权所有待处理请求。';
      case 'auto-approved':
        return '✅ 已开启自动授权并处理了当前待处理请求。';
      case 'denied':
        return '⛔ 已拒绝。';
    }
  })();

  return buildMarkdownContentCard({
    title: input.title,
    subtitle: input.subtitle,
    bodyMarkdown,
    footerItems: input.footerItems,
    template: input.status === 'denied' ? 'red' : input.status === 'auto-approved' ? 'turquoise' : 'green',
  });
}

export function buildFileReceivedCard(input: {
  files: Array<{
    originalName: string;
    savedPath: string;
    fileSize: number;
    attachmentType: 'image' | 'file';
  }>;
  footerItems?: CardFooterItem[];
}): FeishuInteractiveCardMessage {
  const fileLines = input.files.map((f) => {
    const sizeKB = (f.fileSize / 1024).toFixed(1);
    // 只显示文件名，不泄露服务器绝对路径
    const displayName = f.originalName;
    return `📄 ${displayName} (${sizeKB} KB)`;
  });

  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: ['✅ **已收到以下文件：**', '', ...fileLines].join('\n'),
    },
  ];

  if (input.footerItems !== undefined && input.footerItems.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push(buildFooterMarkdown(input.footerItems));
  }

  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: 'green',
      title: plainText('文件上传'),
    },
    body: {
      elements,
    },
  });
}

export function buildStartupNotificationCard(input: { title: string; bodyMarkdown: string }): FeishuInteractiveCardMessage {
  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: 'green',
      title: plainText(input.title),
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: input.bodyMarkdown,
        },
      ],
    },
  });
}

export function buildThreadListCard(input: {
  threads: Array<{
    id: string;
    name: string;
    description: string;
    status: 'running' | 'paused' | 'completed' | 'failed';
    createdAt: Date;
    duration?: string;
  }>;
  refresh?: boolean;
}): FeishuInteractiveCardMessage {
  const statusIcon = (status: string) => {
    switch (status) {
      case 'running':  return '●';
      case 'paused':   return '○';
      case 'completed': return '✅';
      case 'failed':   return '❌';
      default:         return '○';
    }
  };

  const statusText = (status: string) => {
    switch (status) {
      case 'running':  return '运行中';
      case 'paused':   return '已暂停';
      case 'completed': return '已完成';
      case 'failed':   return '失败';
      default:         return status;
    }
  };

  const buildThreadBlock = (thread: typeof input.threads[number]) => {
    const lines = [
      `${statusIcon(thread.status)} **${thread.name}**`,
      `   描述：${thread.description}`,
      `   状态：${statusText(thread.status)}  时长：${thread.duration ?? '—'}`,
    ];

    const elements: Array<Record<string, unknown>> = [
      { tag: 'markdown', content: lines.join('\n'), margin: '8px 0' },
    ];

    if (thread.status === 'running' || thread.status === 'paused') {
      const actions: Array<Record<string, unknown>> = [
        { tag: 'button', text: { tag: 'plain_text', content: '取消' }, type: 'default', value: { action: 'thread-cancel', threadId: thread.id } },
      ];
      if (thread.status === 'running') {
        actions.push({ tag: 'button', text: { tag: 'plain_text', content: '暂停' }, type: 'default', value: { action: 'thread-pause', threadId: thread.id } });
      } else {
        actions.push({ tag: 'button', text: { tag: 'plain_text', content: '恢复' }, type: 'primary', value: { action: 'thread-resume', threadId: thread.id } });
      }
      elements.push({
        tag: 'column_set',
        columns: actions.map((btn) => ({
          tag: 'column',
          width: 'stretch',
          elements: [btn],
        })),
        margin: '4px 0',
      });
    }

    elements.push({ tag: 'hr', margin: '4px 0' });
    return elements;
  };

  const allElements: Array<Record<string, unknown>> = [];
  for (const thread of input.threads) {
    allElements.push(...buildThreadBlock(thread));
  }

  if (input.refresh) {
    allElements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '🔄 刷新' }, type: 'default', value: { action: 'thread-refresh' } },
      ],
    });
  }

  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: 'blue',
      title: plainText('🧵 后台任务'),
    },
    body: { elements: allElements },
  });
}

export function buildUnknownCommandCard(input: {
  unknownCommand: string;
  bridgeCommands: Array<{ command: string; description: string }>;
  codexCommands: Array<{ command: string; description: string }>;
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
}): FeishuInteractiveCardMessage {
  const bridgeMarkdown = [
    '## 桥接命令',
    ...input.bridgeCommands.map((item) => `- \`${item.command}\`  \n  ${item.description}`),
  ].join('\n');

  const codexMarkdown = [
    '## Codex 命令',
    ...input.codexCommands.map((item) => `- \`${item.command}\`  \n  ${item.description}`),
  ].join('\n');

  const hasValidRate = input.rateBar !== '[????????????????????]' && Number.isFinite(input.ratePercent);
  const subtitle = hasValidRate
    ? `${input.statusLabel} | ${input.rateBar} ${input.ratePercent}% left`
    : input.statusLabel;

  // Only show git info if we have valid data (not unknown and have branch)
  const agentFooterItems: CardFooterItem[] = [];
  const showGitInfo = input.gitStatus !== 'unknown' && input.gitBranch;
  if (showGitInfo) {
    const gitStatusIcon = input.gitStatus === 'modified' ? '✗' : '✓';
    const gitLine = `git: ${gitStatusIcon} | branch: ${input.gitBranch} | ${input.gitDiffStat || ''}`;
    agentFooterItems.push({ label: '', value: gitLine });
  }

  if (input.cwd) agentFooterItems.push({ label: '', value: input.cwd });
  if (input.model) agentFooterItems.push({ label: '', value: input.model });
  if (input.sessionId) agentFooterItems.push({ label: '', value: input.sessionId });

  if (input.backgroundTasks && input.backgroundTasks.length > 0) {
    const taskSummary = input.backgroundTasks
      .map(t => `${t.name} [${t.status}]`)
      .join(' | ');
    agentFooterItems.push({ label: '', value: taskSummary });
  }

  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: bridgeMarkdown },
    { tag: 'hr' },
    { tag: 'markdown', content: codexMarkdown },
  ];

  if (agentFooterItems.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push(buildFooterMarkdown(agentFooterItems));
  }

  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: 'red',
      title: plainText(`unknown command | ${input.projectId}`),
      subtitle: plainText(subtitle),
    },
    body: {
      elements,
    },
  });
}

export function buildHelpCard(input: {
  title?: string;
  subtitle?: string;
  bridgeCommands: Array<{ command: string; description: string }>;
  codexCommands: Array<{ command: string; description: string }>;
}): FeishuInteractiveCardMessage {
  const bridgeMarkdown = [
    '## 桥接命令',
    ...input.bridgeCommands.map((item) => `- \`${item.command}\`  \n  ${item.description}`),
  ].join('\n');

  const codexMarkdown = [
    '## Codex 命令',
    ...input.codexCommands.map((item) => `- \`${item.command}\`  \n  ${item.description}`),
  ].join('\n');

  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: 'turquoise',
      title: plainText(input.title ?? 'lark-agent-bridge help'),
      subtitle: input.subtitle ? plainText(input.subtitle) : undefined,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: bridgeMarkdown,
        },
        {
          tag: 'hr',
        },
        {
          tag: 'markdown',
          content: codexMarkdown,
        },
      ],
    },
  });
}

export function buildUnboundCard(input: {
  sessionId: string;
  senderId: string;
  bridgeCommands: Array<{ command: string; description: string }>;
  codexCommands: Array<{ command: string; description: string }>;
}): FeishuInteractiveCardMessage {
  const guidanceMarkdown = [
    '当前聊天**尚未绑定**到 Codex 项目。',
    '',
    `- Chat: \`${input.sessionId}\``,
    `- Sender: \`${input.senderId}\``,
    '',
    '先绑定项目，再发送普通消息和 Codex 对话。',
  ].join('\n');

  const bridgeMarkdown = [
    '### 桥接命令',
    ...input.bridgeCommands.map((item) => `- \`${item.command}\`  \n  ${item.description}`),
  ].join('\n');

  const codexMarkdown = [
    '### Codex 命令',
    ...input.codexCommands.map((item) => `- \`${item.command}\`  \n  ${item.description}`),
  ].join('\n');

  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: 'grey',
      title: plainText('lark-agent-bridge'),
      subtitle: plainText('绑定项目后开始使用'),
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: guidanceMarkdown,
        },
        {
          tag: 'hr',
        },
        {
          tag: 'markdown',
          content: bridgeMarkdown,
        },
        {
          tag: 'hr',
        },
        {
          tag: 'markdown',
          content: codexMarkdown,
        },
      ],
    },
  });
}

export function buildUnavailableProjectCard(input: {
  projectId: string;
  lines: string[];
  footerItems?: CardFooterItem[];
}): FeishuInteractiveCardMessage {
  return buildBridgeStatusCard({
    projectTitle: input.projectId,
    statusLabel: '不可用',
    bodyMarkdown: buildCodeBlockMarkdown(input.lines),
    footerItems: input.footerItems,
    template: 'red',
  });
}

export function buildRateLimitCard(input: {
  projectId: string;
  providerName?: string;
  retryAfterSeconds?: number;
  footerItems?: CardFooterItem[];
}): FeishuInteractiveCardMessage {
  const retryHint = input.retryAfterSeconds !== undefined
    ? `\n\n> 可在 **${input.retryAfterSeconds} 秒** 后重试`
    : '\n\n> 请稍后重试';

  const bodyMarkdown = [
    '## ⚠️ Rate Limit Exceeded',
    '',
    `Provider: **${input.providerName ?? '当前 Provider'}**`,
    '',
    `${input.providerName ?? '当前 Provider'} 请求频率超限，请稍后再试。`,
    retryHint,
    '',
    '常见解决方法：',
    '- 切换到其他 Provider（`//provider codex`、`//provider cc`、`//provider qwen` 或 `//provider gemini`）',
    '- 等待几分钟后再发送消息',
  ].join('\n');

  return buildBridgeStatusCard({
    projectTitle: input.projectId,
    providerName: input.providerName,
    statusLabel: 'Rate Limited',
    bodyMarkdown,
    footerItems: input.footerItems,
    template: 'yellow',
  });
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readCommandCandidate(value: unknown): string | null {
  if (typeof value === 'string') {
    return readString(value);
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidates = [
    record.command,
    record.text,
    record.value,
    record.content,
    record.action,
  ];

  for (const candidate of candidates) {
    const extracted = readCommandCandidate(candidate);
    if (extracted !== null) {
      return extracted;
    }
  }

  return null;
}

function readNestedRecord(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return record[key];
}

function readActionKind(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidates = [record.action, record.type, record.command, record.name];
  for (const candidate of candidates) {
    const action = readActionKind(candidate);
    if (action !== null) {
      return action;
    }
  }

  return null;
}

function readActionRequestId(value: unknown): string | null {
  if (typeof value === 'string') {
    return readString(value);
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidates = [record.requestId, record.request_id, record.id, record.value];
  for (const candidate of candidates) {
    const requestId = readActionRequestId(candidate);
    if (requestId !== null) {
      return requestId;
    }
  }

  return null;
}

export function extractCardActionCommand(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const candidates = [
    record.action,
    record.value,
    record.card_action,
    record.event,
  ];

  for (const candidate of candidates) {
    const extracted = readCommandCandidate(candidate);
    if (extracted !== null) {
      return extracted;
    }
  }

  return null;
}

export function extractCardActionDetails(payload: unknown): {
  action: 'approve' | 'approve-all' | 'approve-auto' | 'deny';
  requestId: string | null;
  threadId?: never;
} | {
  action: 'thread-cancel' | 'thread-pause' | 'thread-resume' | 'thread-refresh';
  threadId: string | null;
  requestId?: never;
} | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const candidates = [
    record.action,
    record.value,
    record.card_action,
    record.event,
    readNestedRecord(record.action, 'value'),
    readNestedRecord(record.value, 'value'),
    readNestedRecord(record.card_action, 'value'),
    readNestedRecord(record.event, 'value'),
    readNestedRecord(record.message, 'action'),
    readNestedRecord(record.message, 'value'),
    readNestedRecord(record.message, 'card_action'),
    readNestedRecord(readNestedRecord(record.message, 'action'), 'value'),
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) {
      continue;
    }

    const action = readActionKind(candidate);

    // Handle approval actions
    if (action === 'approve' || action === 'approve-all' || action === 'approve-auto' || action === 'deny') {
      const requestId =
        readActionRequestId(readNestedRecord(candidate, 'requestId')) ??
        readActionRequestId(readNestedRecord(candidate, 'request_id')) ??
        readActionRequestId(readNestedRecord(candidate, 'id')) ??
        readActionRequestId(candidate);

      return {
        action,
        requestId,
      };
    }

    // Handle thread actions
    if (action === 'thread-cancel' || action === 'thread-pause' || action === 'thread-resume' || action === 'thread-refresh') {
      const threadId = readThreadId(candidate);
      return {
        action,
        threadId,
      };
    }
  }

  return null;
}

function readThreadId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidates = [record.threadId, record.thread_id, record.id, record.value];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }

  return null;
}

export function extractCardActionSessionId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const candidates = [
    record.chat_id,
    record.session_id,
    record.sessionId,
    readNestedRecord(record.message, 'chat_id'),
    readNestedRecord(record.message, 'session_id'),
    readNestedRecord(record.message, 'chatId'),
    readNestedRecord(record.event, 'chat_id'),
    readNestedRecord(record.event, 'session_id'),
    readNestedRecord(record.context, 'open_chat_id'),
    readNestedRecord(record.context, 'chat_id'),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }

  return null;
}

export function extractCardActionMessageId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const candidates = [
    record.message_id,
    record.messageId,
    record.action_id,
    record.card_action_id,
    readNestedRecord(record.message, 'message_id'),
    readNestedRecord(record.message, 'messageId'),
    readNestedRecord(record.event, 'message_id'),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }

  return null;
}

export function extractCardActionSenderId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const sender = record.sender ?? record.user ?? record.operator;
  if (typeof sender === 'object' && sender !== null) {
    const senderRecord = sender as Record<string, unknown>;
    const candidates = [
      senderRecord.open_id,
      senderRecord.user_id,
      senderRecord.union_id,
      senderRecord.sender_id,
      readNestedRecord(senderRecord.sender_id, 'open_id'),
      readNestedRecord(senderRecord.sender_id, 'user_id'),
      readNestedRecord(senderRecord.sender_id, 'union_id'),
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim() !== '') {
        return candidate;
      }
    }
  }

  const directCandidates = [record.open_id, record.user_id, record.sender_id];
  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate;
    }
  }

  return null;
}
