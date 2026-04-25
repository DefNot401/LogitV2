import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { initRepository, findRepoRoot, getLogitDir, getConfig } from '../src/core/repository.js';
import { hashObject, writeObject, readObject, objectExists, listAllObjects } from '../src/core/objects.js';
import { getIndex, writeIndex, addFiles, clearIndex } from '../src/core/index.js';
import { createTree, readTree } from '../src/core/tree.js';
import { createCommit, readCommit, getCommitLog } from '../src/core/commit.js';
import { resolveHead, getCurrentBranch, updateHead, createBranch, listBranches, getBranchCommit, setHeadBranch } from '../src/core/refs.js';

let testDir;
let logitDir;

async function setupTestRepo() {
  testDir = path.join(os.tmpdir(), `logit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(testDir, { recursive: true });
  // Change cwd to testDir
  process.chdir(testDir);
  logitDir = await initRepository(testDir);
}

async function cleanupTestRepo() {
  try {
    process.chdir(os.tmpdir());
    await fs.rm(testDir, { recursive: true, force: true });
  } catch { }
}

// ===== Repository Tests =====
describe('Repository', () => {
  beforeEach(setupTestRepo);
  afterEach(cleanupTestRepo);

  it('should initialize a .logit directory', async () => {
    const exists = await fs.access(logitDir).then(() => true).catch(() => false);
    assert.strictEqual(exists, true);

    // Check subdirectories
    const objectsExists = await fs.access(path.join(logitDir, 'objects')).then(() => true).catch(() => false);
    assert.strictEqual(objectsExists, true);

    const refsExists = await fs.access(path.join(logitDir, 'refs', 'heads')).then(() => true).catch(() => false);
    assert.strictEqual(refsExists, true);
  });

  it('should create HEAD pointing to main', async () => {
    const head = await fs.readFile(path.join(logitDir, 'HEAD'), 'utf-8');
    assert.strictEqual(head.trim(), 'ref: refs/heads/main');
  });

  it('should create config file', async () => {
    const config = await getConfig(logitDir);
    assert.ok(config.user);
    assert.ok(config.user.name);
  });

  it('should find repo root from subdirectory', async () => {
    const subDir = path.join(testDir, 'sub', 'deep');
    await fs.mkdir(subDir, { recursive: true });
    const root = await findRepoRoot(subDir);
    assert.strictEqual(root, testDir);
  });

  it('should throw on double init', async () => {
    await assert.rejects(() => initRepository(testDir), /already exists/);
  });
});

// ===== Objects Tests =====
describe('Objects', () => {
  beforeEach(setupTestRepo);
  afterEach(cleanupTestRepo);

  it('should hash content deterministically', () => {
    const hash1 = hashObject('hello world', 'blob');
    const hash2 = hashObject('hello world', 'blob');
    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 40); // SHA-1 hex length
  });

  it('should produce different hashes for different content', () => {
    const hash1 = hashObject('hello', 'blob');
    const hash2 = hashObject('world', 'blob');
    assert.notStrictEqual(hash1, hash2);
  });

  it('should write and read objects', async () => {
    const content = 'test file content';
    const hash = await writeObject(logitDir, content, 'blob');

    const obj = await readObject(logitDir, hash);
    assert.strictEqual(obj.type, 'blob');
    assert.strictEqual(obj.content.toString(), content);
  });

  it('should detect existing objects', async () => {
    const hash = await writeObject(logitDir, 'some content', 'blob');
    assert.strictEqual(await objectExists(logitDir, hash), true);
    assert.strictEqual(await objectExists(logitDir, 'nonexistent1234567890abcdef12345678'), false);
  });

  it('should list all objects', async () => {
    await writeObject(logitDir, 'file1', 'blob');
    await writeObject(logitDir, 'file2', 'blob');
    const all = await listAllObjects(logitDir);
    assert.strictEqual(all.length, 2);
  });
});

// ===== Index (Staging) Tests =====
describe('Index', () => {
  beforeEach(setupTestRepo);
  afterEach(cleanupTestRepo);

  it('should start with empty index', async () => {
    const index = await getIndex(logitDir);
    assert.deepStrictEqual(index.entries, {});
  });

  it('should add files to the index', async () => {
    await fs.writeFile(path.join(testDir, 'test.txt'), 'hello');
    const added = await addFiles(['test.txt']);
    assert.deepStrictEqual(added, ['test.txt']);

    const index = await getIndex(logitDir);
    assert.ok(index.entries['test.txt']);
    assert.ok(index.entries['test.txt'].hash);
  });

  it('should clear index', async () => {
    await fs.writeFile(path.join(testDir, 'test.txt'), 'hello');
    await addFiles(['test.txt']);
    await clearIndex(logitDir);

    const index = await getIndex(logitDir);
    assert.deepStrictEqual(index.entries, {});
  });
});

// ===== Tree Tests =====
describe('Tree', () => {
  beforeEach(setupTestRepo);
  afterEach(cleanupTestRepo);

  it('should create and read a tree', async () => {
    const hash1 = await writeObject(logitDir, 'content1', 'blob');
    const hash2 = await writeObject(logitDir, 'content2', 'blob');

    const entries = {
      'file1.txt': { hash: hash1 },
      'file2.txt': { hash: hash2 }
    };

    const treeHash = await createTree(logitDir, entries);
    assert.ok(treeHash);

    const treeEntries = await readTree(logitDir, treeHash);
    assert.strictEqual(treeEntries.length, 2);
    assert.strictEqual(treeEntries[0].name, 'file1.txt');
    assert.strictEqual(treeEntries[1].name, 'file2.txt');
  });
});

// ===== Commit Tests =====
describe('Commit', () => {
  beforeEach(setupTestRepo);
  afterEach(cleanupTestRepo);

  it('should create a commit', async () => {
    await fs.writeFile(path.join(testDir, 'test.txt'), 'hello');
    await addFiles(['test.txt']);

    const commit = await createCommit(logitDir, 'Test commit');
    assert.ok(commit.hash);
    assert.strictEqual(commit.message, 'Test commit');
    assert.ok(commit.tree);
    assert.strictEqual(commit.parent, null); // first commit
  });

  it('should read a commit back', async () => {
    await fs.writeFile(path.join(testDir, 'test.txt'), 'hello');
    await addFiles(['test.txt']);
    const created = await createCommit(logitDir, 'My commit');

    const read = await readCommit(logitDir, created.hash);
    assert.strictEqual(read.message, 'My commit');
    assert.strictEqual(read.tree, created.tree);
  });

  it('should chain commits with parent references', async () => {
    await fs.writeFile(path.join(testDir, 'test.txt'), 'v1');
    await addFiles(['test.txt']);
    const first = await createCommit(logitDir, 'First');

    await fs.writeFile(path.join(testDir, 'test.txt'), 'v2');
    await addFiles(['test.txt']);
    const second = await createCommit(logitDir, 'Second');

    assert.strictEqual(second.parent, first.hash);
  });

  it('should walk commit log', async () => {
    await fs.writeFile(path.join(testDir, 'test.txt'), 'v1');
    await addFiles(['test.txt']);
    await createCommit(logitDir, 'First');

    await fs.writeFile(path.join(testDir, 'test.txt'), 'v2');
    await addFiles(['test.txt']);
    await createCommit(logitDir, 'Second');

    await fs.writeFile(path.join(testDir, 'test.txt'), 'v3');
    await addFiles(['test.txt']);
    const third = await createCommit(logitDir, 'Third');

    const log = await getCommitLog(logitDir, third.hash);
    assert.strictEqual(log.length, 3);
    assert.strictEqual(log[0].message, 'Third');
    assert.strictEqual(log[1].message, 'Second');
    assert.strictEqual(log[2].message, 'First');
  });

  it('should throw when nothing to commit', async () => {
    await assert.rejects(() => createCommit(logitDir, 'Empty'), /Nothing to commit/);
  });
});

// ===== Refs Tests =====
describe('Refs', () => {
  beforeEach(setupTestRepo);
  afterEach(cleanupTestRepo);

  it('should resolve HEAD to null before first commit', async () => {
    const head = await resolveHead(logitDir);
    assert.strictEqual(head, null);
  });

  it('should resolve HEAD after commit', async () => {
    await fs.writeFile(path.join(testDir, 'test.txt'), 'hello');
    await addFiles(['test.txt']);
    const commit = await createCommit(logitDir, 'First');

    const head = await resolveHead(logitDir);
    assert.strictEqual(head, commit.hash);
  });

  it('should get current branch name', async () => {
    const branch = await getCurrentBranch(logitDir);
    assert.strictEqual(branch, 'main');
  });

  it('should create and list branches', async () => {
    await fs.writeFile(path.join(testDir, 'test.txt'), 'hello');
    await addFiles(['test.txt']);
    const commit = await createCommit(logitDir, 'First');

    await createBranch(logitDir, 'feature', commit.hash);
    const branches = await listBranches(logitDir);
    assert.ok(branches.includes('main'));
    assert.ok(branches.includes('feature'));
  });

  it('should get branch commit hash', async () => {
    await fs.writeFile(path.join(testDir, 'test.txt'), 'hello');
    await addFiles(['test.txt']);
    const commit = await createCommit(logitDir, 'First');

    const mainHash = await getBranchCommit(logitDir, 'main');
    assert.strictEqual(mainHash, commit.hash);
  });
});
