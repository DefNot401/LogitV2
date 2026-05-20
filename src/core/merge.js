import path from 'path';
import fs from 'fs/promises';
import { readCommit, getCommitLog } from './commit.js';
import { readTree } from './tree.js';
import { readObject, writeObject } from './objects.js';
import { resolveHead, getCurrentBranch, updateHead, getBranchCommit } from './refs.js';
import { getRepoRoot } from './repository.js';
import { ensureDir } from '../utils/fs.js';

/**
 * Merge a branch into the current branch.
 * Supports fast-forward merge and three-way merge with conflict detection.
 */
export async function merge(logitDir, branchName) {
  const targetHash = await getBranchCommit(logitDir, branchName);

  if (!targetHash) {
    throw new Error(`Branch '${branchName}' not found.`);
  }

  return mergeToCommitHash(logitDir, targetHash, branchName);
}

/**
 * Merge a commit hash directly into the current branch.
 * Supports fast-forward merge and three-way merge with conflict detection.
 */
export async function mergeToCommitHash(logitDir, targetHash, targetLabel) {
  const root = await getRepoRoot();
  const currentBranch = await getCurrentBranch(logitDir);

  if (!currentBranch) {
    throw new Error('Cannot merge in detached HEAD state. Switch to a branch first.');
  }

  const currentHash = await resolveHead(logitDir);

  if (currentHash === targetHash) {
    return { type: 'up-to-date', message: 'Already up to date.' };
  }

  // Check if we can fast-forward
  const canFF = await isAncestor(logitDir, currentHash, targetHash);
  if (canFF) {
    // Fast-forward merge
    await updateHead(logitDir, targetHash);

    // Update working directory
    const commit = await readCommit(logitDir, targetHash);
    const treeEntries = await readTree(logitDir, commit.tree);

    for (const entry of treeEntries) {
      const obj = await readObject(logitDir, entry.hash);
      const filePath = path.join(root, entry.name);
      await ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, obj.content);
    }

    return {
      type: 'fast-forward',
      message: `Fast-forward merge to ${targetHash.substring(0, 7)}`,
      commitHash: targetHash
    };
  }

  // Three-way merge
  const mergeBase = await findMergeBase(logitDir, currentHash, targetHash);
  if (!mergeBase) {
    throw new Error('Cannot find merge base. Repositories may have unrelated histories.');
  }

  // Get trees for base, current, and target
  const baseCommit = await readCommit(logitDir, mergeBase);
  const currentCommit = await readCommit(logitDir, currentHash);
  const targetCommit = await readCommit(logitDir, targetHash);

  const baseTree = await getTreeMap(logitDir, baseCommit.tree);
  const currentTree = await getTreeMap(logitDir, currentCommit.tree);
  const targetTree = await getTreeMap(logitDir, targetCommit.tree);

  // Perform merge
  const allFiles = new Set([
    ...Object.keys(baseTree),
    ...Object.keys(currentTree),
    ...Object.keys(targetTree)
  ]);

  const conflicts = [];
  const mergedEntries = {};

  for (const file of allFiles) {
    const baseHash = baseTree[file] || null;
    const currentFileHash = currentTree[file] || null;
    const targetFileHash = targetTree[file] || null;

    if (currentFileHash === targetFileHash) {
      // No conflict — same change or no change
      if (currentFileHash) {
        mergedEntries[file] = currentFileHash;
      }
    } else if (currentFileHash === baseHash) {
      // Only target changed
      if (targetFileHash) {
        mergedEntries[file] = targetFileHash;
      }
    } else if (targetFileHash === baseHash) {
      // Only current changed
      if (currentFileHash) {
        mergedEntries[file] = currentFileHash;
      }
    } else {
      // Both changed — conflict
      conflicts.push(file);

      // Write conflict markers
      const currentContent = currentFileHash
        ? (await readObject(logitDir, currentFileHash)).content.toString()
        : '';
      const targetContent = targetFileHash
        ? (await readObject(logitDir, targetFileHash)).content.toString()
        : '';

      const conflictContent =
        `<<<<<<< ${currentBranch}\n` +
        currentContent +
        (currentContent.endsWith('\n') ? '' : '\n') +
        `=======\n` +
        targetContent +
        (targetContent.endsWith('\n') ? '' : '\n') +
        `>>>>>>> ${targetLabel}\n`;

      const conflictHash = await writeObject(logitDir, conflictContent, 'blob');
      mergedEntries[file] = conflictHash;
    }
  }

  // Write merged files to working directory
  for (const [file, hash] of Object.entries(mergedEntries)) {
    const obj = await readObject(logitDir, hash);
    const filePath = path.join(root, file);
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, obj.content);
  }

  if (conflicts.length > 0) {
    return {
      type: 'conflict',
      message: `Merge conflicts in: ${conflicts.join(', ')}. Resolve conflicts and commit.`,
      conflicts
    };
  }

  return {
    type: 'merge',
    message: `Merged ${targetLabel} into '${currentBranch}'.`,
    mergedEntries
  };
}

/**
 * Check if 'ancestor' is an ancestor of 'descendant'.
 */
export async function isAncestor(logitDir, ancestor, descendant) {
  if (!ancestor) return true; // null is ancestor of everything (first commit)
  const commits = await getCommitLog(logitDir, descendant, 1000);
  return commits.some(c => c.hash === ancestor);
}

/**
 * Find the merge base (common ancestor) of two commits.
 */
async function findMergeBase(logitDir, hash1, hash2) {
  const ancestors1 = new Set();
  const log1 = await getCommitLog(logitDir, hash1, 1000);
  for (const commit of log1) {
    ancestors1.add(commit.hash);
  }

  const log2 = await getCommitLog(logitDir, hash2, 1000);
  for (const commit of log2) {
    if (ancestors1.has(commit.hash)) {
      return commit.hash;
    }
  }

  return null;
}

/**
 * Get a map of filename -> blob hash from a tree.
 */
async function getTreeMap(logitDir, treeHash) {
  const entries = await readTree(logitDir, treeHash);
  const map = {};
  for (const entry of entries) {
    map[entry.name] = entry.hash;
  }
  return map;
}
