import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildApprovalCard,
  buildApprovalResultCard,
  buildBridgeStatusCard,
  buildCommandResultCard,
  buildHelpCard,
  buildProjectReplyCard,
  buildStartupNotificationCard,
  buildThreadListCard,
  buildUnavailableProjectCard,
} from '../../../src/adapters/lark/cards.ts';

function cardHasButton(card: { body?: { elements?: Array<{ tag?: string; columns?: Array<{ elements?: Array<{ tag?: string }> }> }> } }): boolean {
  for (const element of card.body?.elements ?? []) {
    if (element.tag === 'button') {
      return true;
    }
    if (element.tag === 'column_set') {
      for (const column of element.columns ?? []) {
        if (column.elements?.some((colElement) => colElement.tag === 'button')) {
          return true;
        }
      }
    }
  }

  return false;
}

function countButtons(card: { body?: { elements?: Array<{ tag?: string; columns?: Array<{ elements?: Array<{ tag?: string }> }> }> } }): number {
  let count = 0;
  for (const element of card.body?.elements ?? []) {
    if (element.tag === 'button') {
      count += 1;
    }
    if (element.tag === 'column_set') {
      for (const column of element.columns ?? []) {
        for (const colElement of column.elements ?? []) {
          if (colElement.tag === 'button') {
            count += 1;
          }
        }
      }
    }
  }
  return count;
}

test('renders inline code spans as feishu-safe card markdown', () => {
  const replyCard = JSON.parse(
    buildProjectReplyCard({
      projectTitle: 'cms-fe',
      bodyMarkdown: 'Checked `git status` and linked [docs](https://example.com).',
      footerItems: [{ label: 'PATH', value: '/tmp/cms-fe' }],
    }).content,
  ) as {
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };

  const replyBody = replyCard.body?.elements?.find((element) => element.tag === 'markdown')?.content ?? '';
  assert.match(replyBody, /`git status`/);
  assert.doesNotMatch(replyBody, /<font color="grey">git status<\/font>/);
  assert.match(replyBody, /\[docs\]\(https:\/\/example\.com\)/);
  const footer = replyCard.body?.elements?.find((element) => element.tag === 'markdown' && typeof element.content === 'string' && element.content.includes('PATH:'));
  assert.ok(footer);
  assert.match(footer?.content ?? '', /<font color="grey">/);
});

test('keeps fenced code blocks intact while rewriting inline code spans', () => {
  const approvalCard = JSON.parse(
    buildApprovalCard({
      title: 'Approval required',
      bodyMarkdown: '```bash\nprintf "`keep`"\n```\nOutside `git status`.',
      footerItems: [
        { label: '授权ID', value: 'session-a' },
        { label: '注', value: '自动授权有效期 1 小时' },
      ],
      requestId: 'req-1',
    }).content,
  ) as {
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };

  const approvalBody = approvalCard.body?.elements?.find((element) => element.tag === 'markdown')?.content ?? '';
  assert.match(approvalBody, /```bash/);
  assert.match(approvalBody, /`keep`/);
  assert.match(approvalBody, /Outside `git status`\./);
  assert.ok(cardHasButton(approvalCard));
  assert.ok(approvalCard.body?.elements?.some((element) => element.tag === 'markdown' && element.content?.includes('授权ID: session-a')));
  assert.ok(approvalCard.body?.elements?.some((element) => element.tag === 'markdown' && element.content?.includes('注: 自动授权有效期 1 小时')));
});

test('renders approval result cards without buttons', () => {
  const card = JSON.parse(
    buildApprovalResultCard({
      title: 'Approval resolved',
      subtitle: 'command execution | project-a',
      status: 'approved',
      footerItems: [{ label: '授权ID', value: '42' }],
    }).content,
  ) as {
    schema?: string;
    config?: { wide_screen_mode?: boolean };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };

  assert.equal(card.schema, '2.0');
  assert.equal(card.config?.wide_screen_mode, true);
  assert.equal(card.body?.elements?.some((element) => element.tag === 'action' || element.tag === 'button'), false);
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('已授权')));
});

test('renders approval cards with buttons and compact footer content', () => {
  const card = JSON.parse(
    buildApprovalCard({
      title: 'Approval required',
      bodyMarkdown: 'Need approval',
      footerItems: [
        { label: '授权ID', value: '42' },
        { label: '注', value: '自动授权有效期 1 小时' },
      ],
      requestId: 42,
    }).content,
  ) as {
    schema?: string;
    config?: { wide_screen_mode?: boolean };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };

  assert.equal(card.schema, '2.0');
  assert.equal(card.config?.wide_screen_mode, true);
  assert.ok(cardHasButton(card));
  assert.equal(countButtons(card), 3);
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('Need approval')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('授权ID: 42')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('注: 自动授权有效期 1 小时')));
});

test('builds startup notification as an interactive markdown card', () => {
  const card = JSON.parse(
    buildStartupNotificationCard({
      title: 'lark-agent-bridge',
      bodyMarkdown: '[lark-agent-bridge] 已上线',
    }).content,
  ) as {
    schema?: string;
    header?: { title?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };

  assert.equal(card.schema, '2.0');
  assert.equal(card.header?.title?.content, 'lark-agent-bridge');
  assert.equal(card.body?.elements?.[0]?.tag, 'markdown');
  assert.equal(card.body?.elements?.[0]?.content, '[lark-agent-bridge] 已上线');
});

test('buildThreadListCard renders threads with action buttons', () => {
  const card = JSON.parse(
    buildThreadListCard({
      threads: [
        { id: 't1', name: '分析日志', description: '分析今天日志', status: 'running', createdAt: new Date('2026-04-11T10:00:00Z'), duration: '5分12秒' },
        { id: 't2', name: '生成报告', description: '生成周报', status: 'paused', createdAt: new Date('2026-04-11T09:00:00Z'), duration: '2分03秒' },
      ],
      refresh: true,
    }).content,
  ) as {
    body?: { elements?: Array<Record<string, unknown>> };
  };

  const elements = card.body?.elements ?? [];
  // Should have markdown elements with thread names
  assert.ok(elements.some((el) => el.tag === 'markdown' && String(el.content).includes('分析日志')));
  assert.ok(elements.some((el) => el.tag === 'markdown' && String(el.content).includes('生成报告')));
  // Should have action buttons
  assert.ok(elements.some((el) => el.tag === 'action'));
  // Should have a refresh button
  assert.ok(elements.some((el) => el.tag === 'action' && JSON.stringify(el.actions).includes('刷新')));
});

test('buildThreadListCard shows cancel and pause for running threads, cancel and resume for paused', () => {
  const card = JSON.parse(
    buildThreadListCard({
      threads: [
        { id: 't1', name: '运行中任务', description: 'desc', status: 'running', createdAt: new Date() },
        { id: 't2', name: '已暂停任务', description: 'desc', status: 'paused', createdAt: new Date() },
      ],
    }).content,
  ) as {
    body?: { elements?: Array<Record<string, unknown>> };
  };

  const elements = card.body?.elements ?? [];
  const actionsStr = JSON.stringify(elements);
  // Running thread should have cancel and pause buttons
  assert.ok(actionsStr.includes('取消'));
  assert.ok(actionsStr.includes('暂停'));
  // Paused thread should have cancel and resume buttons
  assert.ok(actionsStr.includes('恢复'));
});

test('builds a processing bridge status card', () => {
  const card = JSON.parse(
    buildBridgeStatusCard({
      projectTitle: 'cms-fe',
      statusLabel: 'Processing',
      bodyMarkdown: 'Handling `hello`.',
      footerItems: [{ label: 'Transport', value: 'websocket' }],
      template: 'blue',
    }).content,
  ) as {
    header?: { title?: { content?: string }; subtitle?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };

  assert.equal(card.header?.title?.content, 'cms-fe');
  assert.equal(card.header?.subtitle?.content, 'Processing');
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('Handling `hello`')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('Transport: websocket')));
});

test('renders command result cards as markdown content instead of a fenced code block', () => {
  const card = JSON.parse(
    buildCommandResultCard({
      title: 'thread/list',
      lines: ['1. thr_123', '2. thr_456'],
      footerItems: [{ label: 'Project', value: 'cms-fe' }],
    }).content,
  ) as {
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };

  const markdown = card.body?.elements?.find((element) => element.tag === 'markdown')?.content ?? '';
  assert.equal(markdown, '1. thr_123\n2. thr_456');
  assert.doesNotMatch(markdown, /```text/);
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('Project: cms-fe')));
});

test('renders help cards with consistent markdown heading levels', () => {
  const card = JSON.parse(
    buildHelpCard({
      bridgeCommands: [
        { command: '//bind <projectId>', description: 'Bind this chat to a project.' },
      ],
      codexCommands: [
        { command: '//app/list', description: 'List supported Codex apps.' },
      ],
    }).content,
  ) as {
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };

  const bodyText = JSON.stringify(card.body?.elements ?? []);
  assert.match(bodyText, /## Bridge commands/);
  assert.match(bodyText, /## Codex commands/);
  assert.doesNotMatch(bodyText, /### Bridge commands/);
  assert.doesNotMatch(bodyText, /### Codex commands/);
});

test('builds an unavailable-project card with detailed diagnostics', () => {
  const card = JSON.parse(
    buildUnavailableProjectCard({
      projectId: 'cms-fe',
      lines: [
        '[lark-agent-bridge] bound project is unavailable: cms-fe',
        'status: failed',
        'reason: Reconnecting... 2/5',
        'source: generateReply',
      ],
      footerItems: [{ label: 'Transport', value: 'websocket' }],
    }).content,
  ) as {
    header?: { title?: { content?: string }; subtitle?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };

  assert.equal(card.header?.title?.content, 'cms-fe');
  assert.equal(card.header?.subtitle?.content, 'Unavailable');
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('Reconnecting... 2/5')));
  assert.ok(card.body?.elements?.some((element) => element.tag === 'markdown' && String(element.content).includes('Transport: websocket')));
});
