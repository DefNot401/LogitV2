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
      pullResult.stdout.includes('Updated') || pullResult.stdout.includes('up to date'),
      `Expected pull result: ${pullResult.stdout}`
    );
  });
});
