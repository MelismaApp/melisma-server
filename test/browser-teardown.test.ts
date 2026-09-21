import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';

import { killTree } from '../src/browser/cdp.ts';

/**
 * Tearing down a browser has to reach the processes the browser started.
 *
 * Chromium is a family — a crashpad handler, a zygote, a GPU process, a renderer per page — and none
 * of them are Node's children. Signalling only the top one leaves the rest running, orphaned onto
 * PID 1, where `node` adopts them and never reaps them because Node reaps only what it spawned. Each
 * renewal then left a few permanent zombies holding PID slots, and about a day and a half later the
 * cgroup had no PIDs left to give: `posix_spawn ... Resource temporarily unavailable`, reported as a
 * FATAL from the crashpad handler purely because the handler is forked first.
 *
 * A shell with a background child stands in for that shape. No Chromium needed, which is the point —
 * this has to run on a machine that has never installed one.
 */

const alive = (pid: number): boolean => {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(predicate: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test('tearing down a browser takes the processes it started, not only the top one', async () => {
  // Prints the grandchild's pid, then stays up so both are running when the kill lands.
  const child = spawn('/bin/sh', ['-c', 'sleep 60 & echo $!; wait'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // The same option the real launch uses, and the reason a group kill has a group to aim at.
    detached: true,
  });

  const pid = await new Promise<number>((resolve, reject) => {
    child.stdout!.setEncoding('utf8');
    child.stdout!.once('data', (chunk: string) => resolve(Number(chunk.trim().split('\n')[0])));
    child.once('error', reject);
    setTimeout(() => reject(new Error('the shell never reported its child')), 5_000).unref?.();
  });

  assert.ok(Number.isInteger(pid) && pid > 0, `expected a pid, got ${pid}`);
  assert.ok(alive(pid), 'the grandchild should be running before the teardown');

  killTree(child);

  assert.ok(
    await until(() => !alive(pid)),
    'the grandchild outlived the teardown — this is the leak that exhausts the container’s PIDs',
  );
  assert.ok(await until(() => child.killed || child.exitCode !== null || child.signalCode !== null));
});
