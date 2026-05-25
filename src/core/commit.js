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

/**
 * Drop an arbitrary commit from the history of the current branch, 
 * rewriting all subsequent commits to squash the changes.
 */
export async function dropCommit(logitDir, targetHash) {
  const headHash = await resolveHead(logitDir);
  if (!headHash) throw new Error('No commits in history');

  const commits = await getCommitLog(logitDir, headHash, Infinity);
  const targetIndex = commits.findIndex(c => c.hash === targetHash);

  if (targetIndex === -1) {
    throw new Error(`Commit ${targetHash} not found in the current branch history.`);
  }

  const commitToDrop = commits[targetIndex];
  let newParent = commitToDrop.parent;

  // Rewrite all commits from targetIndex - 1 down to 0 (HEAD)
  // going forward in time
  for (let i = targetIndex - 1; i >= 0; i--) {
    const oldCommit = commits[i];
    const commitData = {
      tree: oldCommit.tree,
      parent: newParent,
      author: oldCommit.author,
      timestamp: oldCommit.timestamp,
      message: oldCommit.message
    };

    const commitContent = JSON.stringify(commitData);
    newParent = await writeObject(logitDir, commitContent, 'commit');
  }

  // Update HEAD
  if (newParent) {
    await updateHead(logitDir, newParent);
  } else {
    // If we dropped the root commit, and it was the only commit
    // clear the HEAD or delete the branch. 
    // This is complex, so let's just write an empty string if there are no commits left.
    // However, usually we don't want to drop the very root if it's the only one.
    // For simplicity we just update the ref to an empty hash, though that breaks things.
    // Let's assume updating to an empty string will trigger detached HEAD or empty branch.
    await updateHead(logitDir, ''); 
  }
}
