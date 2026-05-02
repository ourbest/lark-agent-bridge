import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileWatcherService } from '../../src/runtime/file-watcher.ts';

const TempDir = path.join(os.tmpdir(), 'file-watcher-test-' + Date.now());

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('FileWatcherService', () => {
  beforeEach(async () => {
    await fs.mkdir(TempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(TempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should detect new file, send it, and delete it', async () => {
    const sentFiles: string[] = [];
    const sendFileFn = mock.fn(async ({ filePath }: { receiveId: string; filePath: string }) => {
      sentFiles.push(filePath);
    });

    const watcher = new FileWatcherService(
      {
        enabled: true,
        watchDir: TempDir,
        openId: 'test-open-id',
        pollIntervalMs: 100,
        maxWaitMs: 1000,
      },
      { sendFileFn },
    );

    watcher.start();
    await sleep(200);

    // create a file
    const testFile = path.join(TempDir, 'test.txt');
    await fs.writeFile(testFile, 'hello');
    await sleep(1500);

    assert.strictEqual(sentFiles.length, 1, 'file should be sent');
    assert.strictEqual(await fileExists(testFile), false, 'file should be deleted');

    watcher.stop();
  });
});