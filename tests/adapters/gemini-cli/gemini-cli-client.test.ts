import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { GeminiCliClient } from '../../../src/adapters/gemini-cli/gemini-cli-client.ts';

test('runs gemini with a prompt and returns stdout text', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lark-agent-bridge-gemini-'));
  const scriptPath = join(tempDir, 'gemini-mock.sh');

  writeFileSync(
    scriptPath,
    '#!/bin/sh\nprintf "gemini:%s" "$*"\n',
    'utf8',
  );
  chmodSync(scriptPath, 0o755);

  const client = new GeminiCliClient({
    command: scriptPath,
  });

  const reply = await client.generateReply({ text: 'hello world' });

  assert.equal(reply, 'gemini:-p hello world');
  await client.stop();

  rmSync(tempDir, { recursive: true, force: true });
});

test('surfaces exit errors', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'lark-agent-bridge-gemini-'));
  const scriptPath = join(tempDir, 'gemini-mock.sh');

  writeFileSync(
    scriptPath,
    '#!/bin/sh\nexit 1\n',
    'utf8',
  );
  chmodSync(scriptPath, 0o755);

  const client = new GeminiCliClient({
    command: scriptPath,
  });

  await assert.rejects(
    client.generateReply({ text: 'hello world' }),
    /exited with code 1/,
  );

  rmSync(tempDir, { recursive: true, force: true });
});
