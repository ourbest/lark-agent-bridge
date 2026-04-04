import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const runRealCodexTests = process.env.BRIDGE_RUN_REAL_CODEX_TESTS === '1';
const codexTest = runRealCodexTests ? test : test.skip;

codexTest('spawns a real codex app-server process', async () => {
  const command = process.env.BRIDGE_CODEX_COMMAND?.trim() || 'codex';
  const child = spawn(command, ['app-server'], {
    env: {
      ...process.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => reject(error));
    });

    assert.ok(child.pid !== undefined);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      setImmediate(resolve);
    });
  }
});

