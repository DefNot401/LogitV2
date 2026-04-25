import { writeObject, readObject } from './objects.js';
import { createTree } from './tree.js';
import { getIndex, clearIndex } from './index.js';
import { resolveHead, updateHead } from './refs.js';
import { getConfig } from './repository.js';
import { runHook } from './hooks.js';

/**
 * Create a new commit from the current staging index.
 */
export async function createCommit(logitDir, message) {
  const index = await getIndex(logitDir);

  if (Object.keys(index.entries).length === 0) {
    throw new Error('Nothing to commit. Use "logit add" to stage files.');
  }

  // Run pre-commit hook — non-zero exit aborts the commit
  await runHook(logitDir, 'pre-commit');

  // Create tree from index
  const treeHash = await createTree(logitDir, index.entries);

  // Get parent commit (current HEAD)
  const parentHash = await resolveHead(logitDir);

  // Get author info from config
  const config = await getConfig(logitDir);

  // Build commit object
  const commitData = {
    tree: treeHash,
    parent: parentHash,
    author: `${config.user.name} <${config.user.email}>`,
    timestamp: Date.now(),
    message: message
  };

  const commitContent = JSON.stringify(commitData);
  const commitHash = await writeObject(logitDir, commitContent, 'commit');

  // Update HEAD to new commit
  await updateHead(logitDir, commitHash);

  // Clear the staging area
  await clearIndex(logitDir);

  return {
    hash: commitHash,
    ...commitData
  };
}

/**
 * Read a commit object.
 */
export async function readCommit(logitDir, hash) {
  const obj = await readObject(logitDir, hash);

  if (obj.type !== 'commit') {
    throw new Error(`Object ${hash} is not a commit (got ${obj.type})`);
  }

  const data = JSON.parse(obj.content.toString());
  return {
    hash,
    ...data
  };
}

/**
 * Walk the commit history starting from a given hash.
 * Returns an array of commit objects in reverse chronological order.
 */
export async function getCommitLog(logitDir, startHash, maxCount = 50) {
  const commits = [];
  let currentHash = startHash;

  while (currentHash && commits.length < maxCount) {
    try {
      const commit = await readCommit(logitDir, currentHash);
      commits.push(commit);
      currentHash = commit.parent;
    } catch {
      break;
    }
  }

  return commits;
}

/**
 * Get all commits reachable from a given hash (for push/pull).
 */
export async function getAllCommits(logitDir, startHash) {
  return getCommitLog(logitDir, startHash, Infinity);
}
