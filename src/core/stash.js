import path from 'path';
import fs from 'fs/promises';
import { getIndex, writeIndex } from './index.js';
import { resolveHead } from './refs.js';
import { readCommit } from './commit.js';
import { readTree } from './tree.js';
import { readObject, hashObject, writeObject } from './objects.js';
import { readFileContent, fileExists } from '../utils/fs.js';

const STASH_FILE = 'stash';

/**
 * Read the stash stack from .logit/stash.
 * Returns an array of stash entries (newest first).
 */
async function readStash(logitDir) {
  const stashPath = path.join(logitDir, STASH_FILE);
  try {
    const content = await fs.readFile(stashPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * Write the stash stack to .logit/stash.
 */
async function writeStash(logitDir, entries) {
  const stashPath = path.join(logitDir, STASH_FILE);
  await fs.writeFile(stashPath, JSON.stringify(entries, null, 2));
}

/**
 * Push current changes onto the stash.
 * Saves: modified tracked files, staged index state.
 * Resets working tree and index back to HEAD.
 *
 * @returns {string} A description of what was stashed.
 */
export async function stashPush(logitDir, repoRoot, message) {
  const headHash = await resolveHead(logitDir);
  if (!headHash) {
    throw new Error('Cannot stash: no commits yet. Commit something first.');
  }

  const commit = await readCommit(logitDir, headHash);
  const treeEntries = await readTree(logitDir, commit.tree);

  // Build a map: filepath -> committed hash
  const committedFiles = {};
  for (const entry of treeEntries) {
    committedFiles[entry.name] = entry.hash;
  }

  // Current staging index
  const index = await getIndex(logitDir);

  // Collect snapshot of all modified files (index + working tree changes)
  const snapshot = {}; // filepath -> base64 file content

  // 1. Files staged but different from HEAD
  for (const [filePath, entry] of Object.entries(index.entries)) {
    snapshot[filePath] = {
      hash: entry.hash,
      staged: true
    };
  }

  // 2. Modified working-tree files vs index/head
  for (const [filePath, committedHash] of Object.entries(committedFiles)) {
    const absPath = path.join(repoRoot, filePath);
    if (!(await fileExists(absPath))) continue;
    const content = await readFileContent(absPath);
    const currentHash = hashObject(content, 'blob');
    if (currentHash !== committedHash && !snapshot[filePath]) {
      snapshot[filePath] = { hash: currentHash, staged: false };
      // Store object
      await writeObject(logitDir, content, 'blob');
    }
  }

  if (Object.keys(snapshot).length === 0) {
    throw new Error('No local changes to stash.');
  }

  // Build stash entry — store actual file contents as base64
  const fileContents = {};
  for (const [filePath, info] of Object.entries(snapshot)) {
    try {
      const obj = await readObject(logitDir, info.hash);
      fileContents[filePath] = {
        data: obj.content.toString('base64'),
        staged: info.staged
      };
    } catch {
      // Object might not exist if file was only in working tree
    }
  }

  // Save working-tree files not yet in object store
  for (const [filePath] of Object.entries(committedFiles)) {
    if (fileContents[filePath]) continue;
    const absPath = path.join(repoRoot, filePath);
    if (!(await fileExists(absPath))) continue;
    const content = await readFileContent(absPath);
    const currentHash = hashObject(content, 'blob');
    if (currentHash !== committedFiles[filePath]) {
      await writeObject(logitDir, content, 'blob');
      const obj = await readObject(logitDir, currentHash);
      fileContents[filePath] = {
        data: obj.content.toString('base64'),
        staged: false
      };
    }
  }

  const stashEntry = {
    id: Date.now(),
    message: message || `WIP on HEAD: ${headHash.substring(0, 7)}`,
    headHash,
    files: fileContents,
    timestamp: new Date().toISOString()
  };

  const stack = await readStash(logitDir);
  stack.unshift(stashEntry); // newest first
  await writeStash(logitDir, stack);

  // Reset working tree and index to HEAD
  for (const [filePath, committedHash] of Object.entries(committedFiles)) {
    const absPath = path.join(repoRoot, filePath);
    try {
      const obj = await readObject(logitDir, committedHash);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, obj.content);
    } catch { /* skip */ }
  }

  // Clear the staging index
  await writeIndex(logitDir, { entries: {} });

  return stashEntry.message;
}

/**
 * Pop the most recent stash entry and restore files.
 * @returns {object} The restored stash entry.
 */
export async function stashPop(logitDir, repoRoot) {
  const stack = await readStash(logitDir);
  if (stack.length === 0) {
    throw new Error('No stash entries found. Nothing to pop.');
  }

  const entry = stack.shift(); // Take newest
  await writeStash(logitDir, stack);

  // Restore files to working tree
  const index = await getIndex(logitDir);
  for (const [filePath, { data, staged }] of Object.entries(entry.files)) {
    const absPath = path.join(repoRoot, filePath);
    const content = Buffer.from(data, 'base64');
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);

    if (staged) {
      // Re-stage the file
      const hash = await writeObject(logitDir, content, 'blob');
      index.entries[filePath] = { hash, size: content.length, timestamp: Date.now() };
    }
  }
  await writeIndex(logitDir, index);

  return entry;
}

/**
 * List all stash entries.
 */
export async function stashList(logitDir) {
  return readStash(logitDir);
}

/**
 * Drop a specific stash entry by index (0 = newest).
 */
export async function stashDrop(logitDir, index = 0) {
  const stack = await readStash(logitDir);
  if (index < 0 || index >= stack.length) {
    throw new Error(`No stash entry at index ${index}.`);
  }
  const [dropped] = stack.splice(index, 1);
  await writeStash(logitDir, stack);
  return dropped;
}
