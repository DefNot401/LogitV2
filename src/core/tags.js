import path from 'path';
import fs from 'fs/promises';
import { fileExists } from '../utils/fs.js';

/**
 * Create a lightweight tag pointing at the given commit hash.
 */
export async function createTag(logitDir, name, commitHash) {
  if (!name || !/^[\w.\-/]+$/.test(name)) {
    throw new Error(`Invalid tag name: '${name}'`);
  }

  const tagsDir = path.join(logitDir, 'refs', 'tags');
  await fs.mkdir(tagsDir, { recursive: true });

  const tagPath = path.join(tagsDir, name);
  if (await fileExists(tagPath)) {
    throw new Error(`Tag '${name}' already exists. Use -d to delete it first.`);
  }

  await fs.writeFile(tagPath, commitHash + '\n');
  return { name, hash: commitHash };
}

/**
 * List all tags with their commit hashes.
 */
export async function listTags(logitDir) {
  const tagsDir = path.join(logitDir, 'refs', 'tags');
  try {
    const entries = await fs.readdir(tagsDir, { withFileTypes: true });
    const tags = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        const tagPath = path.join(tagsDir, entry.name);
        const hash = (await fs.readFile(tagPath, 'utf-8')).trim();
        tags.push({ name: entry.name, hash });
      }
    }
    return tags.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Resolve a tag name to its commit hash.
 */
export async function resolveTag(logitDir, name) {
  const tagPath = path.join(logitDir, 'refs', 'tags', name);
  try {
    return (await fs.readFile(tagPath, 'utf-8')).trim();
  } catch {
    return null;
  }
}

/**
 * Delete a tag by name.
 */
export async function deleteTag(logitDir, name) {
  const tagPath = path.join(logitDir, 'refs', 'tags', name);
  if (!(await fileExists(tagPath))) {
    throw new Error(`Tag '${name}' not found.`);
  }
  await fs.unlink(tagPath);
}
