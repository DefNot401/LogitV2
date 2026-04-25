import path from 'path';
import { createRequire } from 'module';
import { getRepoRoot, getLogitDir } from './repository.js';
import { getIndex } from './index.js';
import { resolveHead } from './refs.js';
import { readCommit } from './commit.js';
import { readTree } from './tree.js';
import { readObject, hashObject } from './objects.js';
import { readFileContent } from '../utils/fs.js';

const require = createRequire(import.meta.url);
const Diff = require('diff');

/**
 * Show diff of working directory changes vs. the last commit.
 */
export async function getDiff(filePaths = []) {
  const root = await getRepoRoot();
  const logitDir = path.join(root, '.logit');
  const headHash = await resolveHead(logitDir);

  // Get the last commit's tree
  let committedFiles = {};
  if (headHash) {
    const commit = await readCommit(logitDir, headHash);
    const treeEntries = await readTree(logitDir, commit.tree);
    for (const entry of treeEntries) {
      committedFiles[entry.name] = entry.hash;
    }
  }

  // Get index entries
  const index = await getIndex(logitDir);

  // Determine which files to diff
  let filesToDiff;
  if (filePaths.length > 0) {
    filesToDiff = filePaths.map(f => f.replace(/\\/g, '/'));
  } else {
    // Diff all tracked files
    filesToDiff = [...new Set([
      ...Object.keys(committedFiles),
      ...Object.keys(index.entries)
    ])];
  }

  const diffs = [];

  for (const file of filesToDiff) {
    // Get the "old" content (from last commit)
    let oldContent = '';
    if (committedFiles[file]) {
      try {
        const obj = await readObject(logitDir, committedFiles[file]);
        oldContent = obj.content.toString();
      } catch {
        oldContent = '';
      }
    }

    // Get the "new" content (from working directory)
    let newContent = '';
    try {
      const content = await readFileContent(path.join(root, file));
      newContent = content.toString();
    } catch {
      newContent = '';
    }

    if (oldContent === newContent) {
      continue; // No changes
    }

    const patch = Diff.createPatch(file, oldContent, newContent, 'committed', 'working');
    diffs.push({ file, patch });
  }

  return diffs;
}
