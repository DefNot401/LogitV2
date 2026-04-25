import path from 'path';
import { getRepoRoot, getLogitDir } from './repository.js';
import { getIndex } from './index.js';
import { resolveHead } from './refs.js';
import { readCommit } from './commit.js';
import { readTree } from './tree.js';
import { readObject, hashObject } from './objects.js';
import { getAllFiles, readFileContent } from '../utils/fs.js';

/**
 * Get the current status of the working directory.
 * Compares working dir vs index vs last commit.
 * 
 * Returns { staged, modified, untracked, deleted }
 */
export async function getStatus() {
  const root = await getRepoRoot();
  const logitDir = path.join(root, '.logit');
  const index = await getIndex(logitDir);
  const headHash = await resolveHead(logitDir);

  // Get last commit's tree files
  let committedFiles = {};
  if (headHash) {
    const commit = await readCommit(logitDir, headHash);
    const treeEntries = await readTree(logitDir, commit.tree);
    for (const entry of treeEntries) {
      committedFiles[entry.name] = entry.hash;
    }
  }

  // Get all working directory files
  const workingFiles = await getAllFiles(root);

  // Determine staged files (in index but different from last commit, or new)
  const staged = [];
  const stagedModified = [];
  const stagedDeleted = [];

  for (const [filePath, entry] of Object.entries(index.entries)) {
    if (!committedFiles[filePath]) {
      staged.push(filePath); // New file staged
    } else if (committedFiles[filePath] !== entry.hash) {
      stagedModified.push(filePath); // Modified file staged
    }
  }

  // Check for files committed but not in index (staged deletion)
  for (const filePath of Object.keys(committedFiles)) {
    if (!index.entries[filePath] && Object.keys(index.entries).length > 0) {
      // Only count as staged deletion if there's something in the index
    }
  }

  // Determine modified files (in working dir, different from index or last commit)
  const modified = [];
  const untracked = [];
  const deleted = [];

  // Check for tracked files (in commit or index)
  const trackedFiles = new Set([
    ...Object.keys(committedFiles),
    ...Object.keys(index.entries)
  ]);

  for (const file of workingFiles) {
    if (trackedFiles.has(file)) {
      // File is tracked — check if modified
      const content = await readFileContent(path.join(root, file));
      const currentHash = hashObject(content, 'blob');

      const referenceHash = index.entries[file]?.hash || committedFiles[file];
      if (referenceHash && currentHash !== referenceHash) {
        modified.push(file);
      }
    } else {
      // File is untracked
      untracked.push(file);
    }
  }

  // Check for deleted files (tracked but not in working dir)
  const workingSet = new Set(workingFiles);
  for (const file of trackedFiles) {
    if (!workingSet.has(file)) {
      deleted.push(file);
    }
  }

  return {
    staged: [...staged, ...stagedModified],
    modified,
    untracked,
    deleted
  };
}
