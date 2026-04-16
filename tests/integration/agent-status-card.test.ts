import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { buildAgentStatusCard } from '../../src/adapters/lark/cards.ts';

describe('Agent Status Card Integration', () => {
  it('should render card with all fields populated', () => {
    const card = buildAgentStatusCard({
      projectId: 'test-project',
      statusLabel: 'working',
      rateBar: '[████████░░]',
      ratePercent: 80,
      cwd: '/workspace/test',
      model: 'opus-4-6',
      sessionId: 'sess_test123',
      gitStatus: 'modified',
      gitBranch: 'main',
      gitDiffStat: '+10 -5',
      backgroundTasks: [
        { id: '1', name: 'analysis', status: 'running' },
        { id: '2', name: 'backup', status: 'paused' },
      ],
      template: 'blue',
    });

    const content = JSON.parse(card.content);

    // Verify header
    assert.strictEqual(content.header.title.content, 'test-project | 🤖 Claude Code');
    assert.strictEqual(content.header.subtitle.content, 'working');

    // Verify body contains all expected fields
    const bodyContent = content.body.elements[0].content;
    assert.ok(bodyContent.includes('Rate: [████████░░] 80% left'));
    assert.ok(bodyContent.includes('/workspace/test | opus-4-6 | sess_test123'));
    assert.ok(bodyContent.includes('git: ✗ | branch: main | +10 -5'));
    assert.ok(bodyContent.includes('analysis [running]'));
    assert.ok(bodyContent.includes('backup [paused]'));
  });

  it('should render card with minimal fields', () => {
    const card = buildAgentStatusCard({
      projectId: 'minimal-project',
      statusLabel: 'done',
      rateBar: '[██████████]',
      ratePercent: 100,
      cwd: '/workspace/minimal',
      model: 'sonnet-4',
      sessionId: 'sess_minimal',
      gitStatus: 'clean',
      gitBranch: 'develop',
      gitDiffStat: '',
    });

    const content = JSON.parse(card.content);

    assert.strictEqual(content.header.title.content, 'minimal-project | 🤖 Claude Code');
    assert.strictEqual(content.header.subtitle.content, 'done');

    const bodyContent = content.body.elements[0].content;
    assert.ok(bodyContent.includes('Rate: [██████████] 100% left'));
    assert.ok(bodyContent.includes('/workspace/minimal | sonnet-4 | sess_minimal'));
    assert.ok(bodyContent.includes('git: ✓ | branch: develop |'));
  });
});