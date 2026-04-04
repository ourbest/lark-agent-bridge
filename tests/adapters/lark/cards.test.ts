import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApprovalCard, buildProjectReplyCard, buildStartupNotificationCard } from '../../../src/adapters/lark/cards.ts';

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
      footerItems: [{ label: 'Chat', value: 'session-a' }],
      buttons: [{ label: 'Approve', command: '//approve 1' }],
    }).content,
  ) as {
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };

  const approvalBody = approvalCard.body?.elements?.find((element) => element.tag === 'markdown')?.content ?? '';
  assert.match(approvalBody, /```bash/);
  assert.match(approvalBody, /`keep`/);
  assert.match(approvalBody, /Outside `git status`\./);
  assert.ok(approvalCard.body?.elements?.some((element) => element.tag === 'markdown' && element.content?.includes('Chat:')));
});

test('builds startup notification as an interactive markdown card', () => {
  const card = JSON.parse(
    buildStartupNotificationCard({
      title: 'codex-bridge',
      bodyMarkdown: '[codex-bridge] 已上线',
    }).content,
  ) as {
    schema?: string;
    header?: { title?: { content?: string } };
    body?: { elements?: Array<{ tag?: string; content?: string }> };
  };

  assert.equal(card.schema, '2.0');
  assert.equal(card.header?.title?.content, 'codex-bridge');
  assert.equal(card.body?.elements?.[0]?.tag, 'markdown');
  assert.equal(card.body?.elements?.[0]?.content, '[codex-bridge] 已上线');
});
