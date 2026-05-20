import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createServer } from '../src/server/server.js';
import { initRepository } from '../src/core/repository.js';
import { writeObject } from '../src/core/objects.js';
import { addFiles } from '../src/core/index.js';
import { createCommit } from '../src/core/commit.js';

const exec = promisify(execFile);
const LOGIT_BIN = path.resolve('bin/logit.js');

let serverDir, clientDir, logitDir, server, serverUrl;

async function run(args, cwd) {
  try {
    const { stdout, stderr } = await exec('node', [LOGIT_BIN, ...args], { cwd });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.code || 1 };
  }
}

async function setupServerRepo() {
  serverDir = path.join(os.tmpdir(), `logit-server-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  clientDir = path.join(os.tmpdir(), `logit-client-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(serverDir, { recursive: true });
  await fs.mkdir(clientDir, { recursive: true });

  // Initialize server repo
  process.chdir(serverDir);
  logitDir = await initRepository(serverDir);

  // Add a file and commit
  await fs.writeFile(path.join(serverDir, 'readme.txt'), 'Hello from server!');
  await addFiles(['readme.txt']);
  await createCommit(logitDir, 'Server initial commit');

  // Start the server
  const app = createServer(logitDir, serverDir);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      serverUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function cleanup() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    process.chdir(os.tmpdir());
    await fs.rm(serverDir, { recursive: true, force: true });
    await fs.rm(clientDir, { recursive: true, force: true });
  } catch { }
}

describe('Network Sharing', () => {
  beforeEach(setupServerRepo);
  afterEach(cleanup);

  it('server /info endpoint should return repo metadata', async () => {
    const res = await fetch(`${serverUrl}/info`);
    const data = await res.json();
    assert.ok(data.name, 'Should have repo name');
    assert.ok(data.head, 'Should have HEAD hash');
    assert.ok(data.refs, 'Should have refs');
  });

  it('server /refs endpoint should return branch refs', async () => {
    const res = await fetch(`${serverUrl}/refs`);
    const data = await res.json();
    assert.ok(data['refs/heads/main'], 'Should have main branch ref');
  });

  it('server /objects/list should return all object hashes', async () => {
    const res = await fetch(`${serverUrl}/objects/list`);
    const data = await res.json();
    assert.ok(Array.isArray(data), 'Should be an array');
    assert.ok(data.length > 0, 'Should have at least one object');
  });

  it('server /objects/:hash should return an object', async () => {
    const listRes = await fetch(`${serverUrl}/objects/list`);
    const hashes = await listRes.json();
    const firstHash = hashes[0];

    const objRes = await fetch(`${serverUrl}/objects/${firstHash}`);
    assert.strictEqual(objRes.status, 200, 'Should return 200');
    const data = await objRes.arrayBuffer();
    assert.ok(data.byteLength > 0, 'Object should have content');
  });

  it('clone should download repository', async () => {
    const cloneDir = path.join(clientDir, 'cloned');
    const result = await run(['clone', serverUrl, cloneDir], clientDir);
    assert.ok(result.stdout.includes('Cloned'), `Expected "Cloned" in: ${result.stdout}`);

    // Check that readme.txt was checked out
    const content = await fs.readFile(path.join(cloneDir, 'readme.txt'), 'utf-8');
    assert.ok(content.includes('Hello from server'), `Expected server content, got: ${content}`);

    // Check that .logit exists in clone
    const logitExists = await fs.access(path.join(cloneDir, '.logit')).then(() => true).catch(() => false);
    assert.strictEqual(logitExists, true);

    // Check log in clone
    const logResult = await run(['log'], cloneDir);
    assert.ok(logResult.stdout.includes('Server initial commit'), `Expected commit in log: ${logResult.stdout}`);
  });

  it('push should send new objects to server', async () => {
    // Clone first
    const cloneDir = path.join(clientDir, 'push-test');
    await run(['clone', serverUrl, cloneDir], clientDir);

    // Make changes in clone
    await fs.writeFile(path.join(cloneDir, 'new-file.txt'), 'New content from client');
    await run(['add', 'new-file.txt'], cloneDir);
    await run(['commit', '-m', 'Client commit'], cloneDir);

    // Push changes
    const pushResult = await run(['push'], cloneDir);
    assert.ok(
      pushResult.stdout.includes('Pushed') || pushResult.stdout.includes('up to date'),
      `Expected push result: ${pushResult.stdout}`
    );

    // Verify server has the new objects
    const listRes = await fetch(`${serverUrl}/objects/list`);
    const serverObjects = await listRes.json();
    assert.ok(serverObjects.length > 3, 'Server should have more objects after push');
  });

  it('pull should fetch updates from server', async () => {
    // Clone first
    const cloneDir = path.join(clientDir, 'pull-test');
    await run(['clone', serverUrl, cloneDir], clientDir);

    // Make a new commit on the server
    process.chdir(serverDir);
    await fs.writeFile(path.join(serverDir, 'update.txt'), 'Server update');
    await addFiles(['update.txt']);
    await createCommit(logitDir, 'Server update commit');

    // Pull from the clone
    const pullResult = await run(['pull'], cloneDir);
    assert.ok(
      pullResult.stdout.includes('Updated') ||
      pullResult.stdout.includes('up to date') ||
      pullResult.stdout.includes('Fast-forwarded') ||
      pullResult.stdout.includes('Merged'),
      `Expected pull result: ${pullResult.stdout}`
    );
  });

  it('pull when local is ahead should not revert refs', async () => {
    // Clone first
    const cloneDir = path.join(clientDir, 'pull-ahead-test');
    await run(['clone', serverUrl, cloneDir], clientDir);

    // Make a new commit on the client only (local is ahead)
    await fs.writeFile(path.join(cloneDir, 'client-only.txt'), 'Client local changes');
    await run(['add', 'client-only.txt'], cloneDir);
    const commitRes = await run(['commit', '-m', 'Client local commit'], cloneDir);

    // Get client's HEAD commit hash
    const clientHeadRes = await run(['log'], cloneDir);
    const clientHeadHashMatch = clientHeadRes.stdout.match(/commit ([0-9a-f]{40})/);
    const clientHeadHash = clientHeadHashMatch ? clientHeadHashMatch[1] : null;
    assert.ok(clientHeadHash, 'Should have local client commit hash');

    // Run pull on the client
    const pullResult = await run(['pull'], cloneDir);

    // It should report already up to date/ahead
    assert.ok(
      pullResult.stdout.includes('Already up to date. (Local is ahead of remote)'),
      `Expected pull to report local is ahead, got: ${pullResult.stdout}`
    );

    // Check that our client commit was NOT reverted
    const postPullRes = await run(['log'], cloneDir);
    assert.ok(
      postPullRes.stdout.includes(clientHeadHash),
      'Client commit should still be at the top of the log and not reverted'
    );
  });

  it('pull when local and remote have diverged should perform a three-way merge', async () => {
    // Clone first
    const cloneDir = path.join(clientDir, 'pull-diverge-test');
    await run(['clone', serverUrl, cloneDir], clientDir);

    // Make a new commit on the server (remote is ahead in one direction)
    process.chdir(serverDir);
    await fs.writeFile(path.join(serverDir, 'server-only.txt'), 'Server unique content');
    await addFiles(['server-only.txt']);
    await createCommit(logitDir, 'Server unique commit');

    // Make a new commit on the client (local is ahead in another direction)
    await fs.writeFile(path.join(cloneDir, 'client-only.txt'), 'Client unique content');
    await run(['add', 'client-only.txt'], cloneDir);
    await run(['commit', '-m', 'Client unique commit'], cloneDir);

    // Pull from the client (should trigger three-way merge)
    const pullResult = await run(['pull'], cloneDir);
    assert.ok(
      pullResult.stdout.includes('Merged remote') || pullResult.stdout.includes('Merged'),
      `Expected successful three-way merge message, got: ${pullResult.stdout}`
    );

    // Both files should exist in the client working directory now
    const clientFiles = await fs.readdir(cloneDir);
    assert.ok(clientFiles.includes('server-only.txt'), 'Should contain server-only.txt');
    assert.ok(clientFiles.includes('client-only.txt'), 'Should contain client-only.txt');
  });

  it('sync when local and remote have diverged with conflict should pause sync and report conflict', async () => {
    // Clone first
    const cloneDir = path.join(clientDir, 'sync-conflict-test');
    await run(['clone', serverUrl, cloneDir], clientDir);

    // Make a conflicting change on the server
    process.chdir(serverDir);
    await fs.writeFile(path.join(serverDir, 'shared.txt'), 'Server content');
    await addFiles(['shared.txt']);
    await createCommit(logitDir, 'Server conflict commit');

    // Make a conflicting change on the client
    await fs.writeFile(path.join(cloneDir, 'shared.txt'), 'Client conflicting content');
    await run(['add', 'shared.txt'], cloneDir);
    await run(['commit', '-m', 'Client conflict commit'], cloneDir);

    // Run sync on the client with the server URL directly
    // This will pull (triggering conflict) and should exit with code 1 and pause sync
    const syncResult = await run(['sync', '--url', serverUrl, '--yes'], cloneDir);

    // It should report the conflicts and return non-zero exit code
    assert.strictEqual(syncResult.code, 1, 'Sync should exit with non-zero code on conflict');
    assert.ok(
      syncResult.stdout.includes('conflict') || syncResult.stdout.includes('paused'),
      `Expected sync to report conflict/pause, got: ${syncResult.stdout}`
    );

    // Verify conflict markers are in shared.txt
    const content = await fs.readFile(path.join(cloneDir, 'shared.txt'), 'utf-8');
    assert.ok(content.includes('<<<<<<<'), 'Should contain conflict markers');
    assert.ok(content.includes('Server content'), 'Should contain server content');
    assert.ok(content.includes('Client conflicting content'), 'Should contain client content');
  });
});
