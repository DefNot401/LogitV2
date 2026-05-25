import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);
const LOGIT_BIN = path.resolve('bin/logit.js');

let testDir;

async function run(args, cwd = testDir) {
  try {
    const { stdout, stderr } = await exec('node', [LOGIT_BIN, ...args], { cwd });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.code || 1 };
  }
}

async function setupTestDir() {
  testDir = path.join(os.tmpdir(), `logit-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(testDir, { recursive: true });
}

async function cleanupTestDir() {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch { }
}

describe('CLI Integration', () => {
  beforeEach(setupTestDir);
  afterEach(cleanupTestDir);

  it('should initialize a repository', async () => {
    const result = await run(['init']);
    assert.ok(result.stdout.includes('Initialized'), `Expected "Initialized" in: ${result.stdout}`);

    const logitExists = await fs.access(path.join(testDir, '.logit')).then(() => true).catch(() => false);
    assert.strictEqual(logitExists, true);
  });

  it('should add and commit files', async () => {
    await run(['init']);

    await fs.writeFile(path.join(testDir, 'hello.txt'), 'Hello, Logit!');
    const addResult = await run(['add', 'hello.txt']);
    assert.ok(addResult.stdout.includes('Added'), `Expected "Added" in: ${addResult.stdout}`);

    const commitResult = await run(['commit', '-m', 'First commit']);
    assert.ok(commitResult.stdout.includes('First commit'), `Expected commit message in: ${commitResult.stdout}`);
  });

  it('should show commit log', async () => {
    await run(['init']);
    await fs.writeFile(path.join(testDir, 'file.txt'), 'content');
    await run(['add', 'file.txt']);
    await run(['commit', '-m', 'Initial commit']);

    const logResult = await run(['log']);
    assert.ok(logResult.stdout.includes('Initial commit'), `Expected "Initial commit" in log: ${logResult.stdout}`);
    assert.ok(logResult.stdout.includes('commit'), `Expected "commit" hash header in: ${logResult.stdout}`);
  });

  it('should show status: clean tree after commit', async () => {
    await run(['init']);
    await fs.writeFile(path.join(testDir, 'file.txt'), 'content');
    await run(['add', 'file.txt']);
    await run(['commit', '-m', 'Commit']);

    const statusResult = await run(['status']);
    assert.ok(
      statusResult.stdout.includes('nothing to commit') || statusResult.stdout.includes('clean'),
      `Expected clean status, got: ${statusResult.stdout}`
    );
  });

  it('should detect untracked files in status', async () => {
    await run(['init']);
    await fs.writeFile(path.join(testDir, 'newfile.txt'), 'new content');

    const statusResult = await run(['status']);
    assert.ok(statusResult.stdout.includes('newfile.txt'), `Expected "newfile.txt" in status: ${statusResult.stdout}`);
  });

  it('should add all with "."', async () => {
    await run(['init']);
    await fs.writeFile(path.join(testDir, 'a.txt'), 'aaa');
    await fs.writeFile(path.join(testDir, 'b.txt'), 'bbb');

    const addResult = await run(['add', '.']);
    assert.ok(addResult.stdout.includes('a.txt'), `Expected a.txt in: ${addResult.stdout}`);
    assert.ok(addResult.stdout.includes('b.txt'), `Expected b.txt in: ${addResult.stdout}`);
  });

  it('full workflow: init → add → commit → modify → diff → commit → log', async () => {
    // Init
    await run(['init']);

    // Create and commit a file
    await fs.writeFile(path.join(testDir, 'story.txt'), 'Once upon a time...');
    await run(['add', 'story.txt']);
    await run(['commit', '-m', 'Chapter 1']);

    // Modify the file
    await fs.writeFile(path.join(testDir, 'story.txt'), 'Once upon a time...\nThe end.');

    // Check diff
    const diffResult = await run(['diff']);
    assert.ok(diffResult.stdout.includes('The end'), `Expected diff content, got: ${diffResult.stdout}`);

    // Add and commit modification
    await run(['add', 'story.txt']);
    await run(['commit', '-m', 'Chapter 2']);

    // Check log has both commits
    const logResult = await run(['log']);
    assert.ok(logResult.stdout.includes('Chapter 1'), `Expected "Chapter 1" in log`);
    assert.ok(logResult.stdout.includes('Chapter 2'), `Expected "Chapter 2" in log`);
  });

  it('branching workflow: create branch → switch → commit → switch back', async () => {
    await run(['init']);
    await fs.writeFile(path.join(testDir, 'main.txt'), 'main content');
    await run(['add', 'main.txt']);
    await run(['commit', '-m', 'Main commit']);

    // Create branch
    const branchResult = await run(['branch', 'feature']);
    assert.ok(branchResult.stdout.includes('Created'), `Expected branch creation: ${branchResult.stdout}`);

    // List branches
    const listResult = await run(['branch']);
    assert.ok(listResult.stdout.includes('main'), `Expected main in branches`);
    assert.ok(listResult.stdout.includes('feature'), `Expected feature in branches`);

    // Switch to feature
    await run(['switch', 'feature']);
    await fs.writeFile(path.join(testDir, 'feature.txt'), 'feature work');
    await run(['add', 'feature.txt']);
    await run(['commit', '-m', 'Feature commit']);

    // Switch back to main
    await run(['switch', 'main']);

    // feature.txt should not exist on main
    const featureExists = await fs.access(path.join(testDir, 'feature.txt')).then(() => true).catch(() => false);
    assert.strictEqual(featureExists, false, 'feature.txt should not exist on main branch');
  });

  it('branching workflow: untracked files should not be deleted during switch/checkout', async () => {
    await run(['init']);
    await fs.writeFile(path.join(testDir, 'main.txt'), 'main content');
    await run(['add', 'main.txt']);
    await run(['commit', '-m', 'Main commit']);

    await run(['branch', 'feature']);
    await run(['switch', 'feature']);

    // Create untracked file
    const untrackedPath = path.join(testDir, 'untracked.txt');
    await fs.writeFile(untrackedPath, 'some untracked data');

    // Switch back to main
    await run(['switch', 'main']);

    // The untracked file should still exist!
    let untrackedExists = await fs.access(untrackedPath).then(() => true).catch(() => false);
    assert.strictEqual(untrackedExists, true, 'Untracked file should not be deleted when switching to main');

    // Switch back to feature
    await run(['switch', 'feature']);

    // The untracked file should still exist!
    untrackedExists = await fs.access(untrackedPath).then(() => true).catch(() => false);
    assert.strictEqual(untrackedExists, true, 'Untracked file should not be deleted when switching to feature');
  });

  it('checkout by commit hash', async () => {
    await run(['init']);
    await fs.writeFile(path.join(testDir, 'data.txt'), 'version 1');
    await run(['add', 'data.txt']);
    await run(['commit', '-m', 'v1']);

    // Get the commit hash from log
    const logResult = await run(['log']);
    const hashMatch = logResult.stdout.match(/commit ([a-f0-9]{40})/);
    assert.ok(hashMatch, 'Should find commit hash in log');
    const firstHash = hashMatch[1];

    // Make a second commit
    await fs.writeFile(path.join(testDir, 'data.txt'), 'version 2');
    await run(['add', 'data.txt']);
    await run(['commit', '-m', 'v2']);

    // Checkout back to first commit
    const checkoutResult = await run(['checkout', firstHash]);
    assert.ok(checkoutResult.stdout.includes('detached') || checkoutResult.stdout.includes('Restored'),
      `Expected checkout feedback: ${checkoutResult.stdout}`);

    // File should have old content
    const content = await fs.readFile(path.join(testDir, 'data.txt'), 'utf-8');
    assert.ok(content.includes('version 1'), `Expected "version 1", got: ${content}`);
  });

  it('remote management: add, list, remove', async () => {
    await run(['init']);

    // Add remote
    const addResult = await run(['remote', 'add', 'origin', 'http://localhost:5000']);
    assert.ok(addResult.stdout.includes('Added'), `Expected "Added" in: ${addResult.stdout}`);

    // List remotes
    const listResult = await run(['remote', 'list']);
    assert.ok(listResult.stdout.includes('origin'), `Expected "origin" in list: ${listResult.stdout}`);
    assert.ok(listResult.stdout.includes('localhost'), `Expected URL in list: ${listResult.stdout}`);

    // Remove remote
    const removeResult = await run(['remote', 'remove', 'origin']);
    assert.ok(removeResult.stdout.includes('Removed'), `Expected "Removed" in: ${removeResult.stdout}`);
  });
});
