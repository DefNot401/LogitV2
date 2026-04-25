import path from 'path';
import fs from 'fs/promises';
import { readObject } from './objects.js';
import { readTree } from './tree.js';
import { readCommit } from './commit.js';
import { setHeadDetached, setHeadBranch, getBranchCommit } from './refs.js';
import { getRepoRoot } from './repository.js';
import { ensureDir, getAllFiles } from '../utils/fs.js';

/**
 * Checkout a commit or branch — restore the working directory to match that snapshot.
 */
export async function checkout(logitDir, target) {
  const root = await getRepoRoot();

  // Determine if target is a branch name or a commit hash
  const branchCommit = await getBranchCommit(logitDir, target);
  let commitHash;
  let isBranch = false;

  if (branchCommit) {
    commitHash = branchCommit;
    isBranch = true;
  } else {
    commitHash = target;
  }

  // Read the commit
  const commit = await readCommit(logitDir, commitHash);

  // Read the tree
  const treeEntries = await readTree(logitDir, commit.tree);

  // Get current working directory files (to remove files not in the target commit)
  const currentFiles = await getAllFiles(root);

  // Remove files not in the target tree
  const targetFiles = new Set(treeEntries.map(e => e.name));
  for (const file of currentFiles) {
    if (!targetFiles.has(file)) {
      const filePath = path.join(root, file);
      try {
        await fs.unlink(filePath);
      } catch {
        // File might already be gone
      }
    }
  }

  // Restore files from the tree
  for (const entry of treeEntries) {
    const obj = await readObject(logitDir, entry.hash);
    const filePath = path.join(root, entry.name);
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, obj.content);
  }

  // Update HEAD
  if (isBranch) {
    await setHeadBranch(logitDir, target);
  } else {
    await setHeadDetached(logitDir, commitHash);
  }

  return { commitHash, isBranch, target, filesRestored: treeEntries.length };
}
