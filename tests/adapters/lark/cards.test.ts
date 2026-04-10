import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildApprovalCard,
  buildApprovalResultCard,
  buildBridgeStatusCard,
  buildProjectReplyCard,
  buildStartupNotificationCard,
  buildUnavailableProjectCard,
} from '../../../src/adapters/lark/cards.ts';

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
  assert.ok(approvalCard.body?.elements?.some((element) => element.tag === 'button'));
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
  assert.ok(card.body?.elements?.some((element) => element.tag === 'button'));
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
