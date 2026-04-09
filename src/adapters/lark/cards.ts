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
  return items.map((item) => `${item.label}: ${item.value}`).join(' | ');
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
  subtitle?: string;
}): FeishuInteractiveCardMessage {
  return buildInteractiveCardMessage({
    schema: '2.0',
    config: {
      enable_forward: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: 'blue',
      title: plainText(input.projectTitle),
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
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      template: input.template ?? 'blue',
      title: plainText(input.projectTitle),
      subtitle: plainText(input.statusLabel),
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

function buildCodeBlockMarkdown(lines: string[]): string {
  const sanitizedLines = lines.map((line) => line.replaceAll('```', '``\\`'));
  return ['```text', ...sanitizedLines, '```'].join('\n');
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
      content: buildCodeBlockMarkdown(input.lines),
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

export function buildApprovalCard(input: {
  title: string;
  subtitle?: string;
  bodyMarkdown: string;
  footerItems: CardFooterItem[];
}): FeishuInteractiveCardMessage {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: input.bodyMarkdown,
    },
    {
      tag: 'hr',
    },
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

export function buildHelpCard(input: {
  title?: string;
  subtitle?: string;
  bridgeCommands: Array<{ command: string; description: string }>;
  codexCommands: Array<{ command: string; description: string }>;
}): FeishuInteractiveCardMessage {
  const bridgeMarkdown = [
    '### Bridge commands',
    ...input.bridgeCommands.map((item) => `- \`${item.command}\`  \n  ${item.description}`),
  ].join('\n');

  const codexMarkdown = [
    '### Codex commands',
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
    'This chat is **not bound** to a Codex project yet.',
    '',
    `- Chat: \`${input.sessionId}\``,
    `- Sender: \`${input.senderId}\``,
    '',
    'Bind a project first, then send normal messages to talk to Codex.',
  ].join('\n');

  const bridgeMarkdown = [
    '### Bridge commands',
    ...input.bridgeCommands.map((item) => `- \`${item.command}\`  \n  ${item.description}`),
  ].join('\n');

  const codexMarkdown = [
    '### Codex commands',
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
      subtitle: plainText('Bind a project to get started'),
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
    statusLabel: 'Unavailable',
    bodyMarkdown: buildCodeBlockMarkdown(input.lines),
    footerItems: input.footerItems,
    template: 'red',
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
