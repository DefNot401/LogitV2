import path from 'path';
import fs from 'fs/promises';
import { getLogitDir, getRepoRoot } from './repository.js';
import { hashObject, writeObject } from './objects.js';
import { readFileContent } from '../utils/fs.js';

/**
 * Read the staging index from .logit/index.
 */
export async function getIndex(logitDir) {
  const indexPath = path.join(logitDir, 'index');
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { entries: {} };
  }
}

/**
 * Write the staging index to .logit/index.
 */
export async function writeIndex(logitDir, index) {
  const indexPath = path.join(logitDir, 'index');
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Add files to the staging area.
 * @param {string[]} filePaths - paths relative to repo root
 */
export async function addFiles(filePaths) {
  const root = await getRepoRoot();
  const logitDir = path.join(root, '.logit');
  const index = await getIndex(logitDir);
  const added = [];

  for (const filePath of filePaths) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const absolutePath = path.join(root, normalizedPath);

    try {
      const content = await readFileContent(absolutePath);
      const hash = await writeObject(logitDir, content, 'blob');

      index.entries[normalizedPath] = {
        hash,
        size: content.length,
        timestamp: Date.now()
      };

      added.push(normalizedPath);
    } catch (err) {
      throw new Error(`Cannot add '${normalizedPath}': ${err.message}`);
    }
  }

  await writeIndex(logitDir, index);
  return added;
}

/**
 * Clear the staging area after a commit.
 */
export async function clearIndex(logitDir) {
  await writeIndex(logitDir, { entries: {} });
}
