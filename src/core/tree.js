import { writeObject, readObject } from './objects.js';

/**
 * Create a tree object from the staging index.
 * A tree maps filenames to blob hashes.
 * 
 * Tree format (stored as JSON for simplicity):
 * [{ name: "file.txt", hash: "abc123...", type: "blob" }, ...]
 */
export async function createTree(logitDir, indexEntries) {
  const entries = [];

  for (const [filePath, entry] of Object.entries(indexEntries)) {
    entries.push({
      name: filePath,
      hash: entry.hash,
      type: 'blob'
    });
  }

  // Sort entries for consistent hashing
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const treeContent = JSON.stringify(entries);
  const hash = await writeObject(logitDir, treeContent, 'tree');

  return hash;
}

/**
 * Read a tree object and return its entries.
 * @returns {Array<{name: string, hash: string, type: string}>}
 */
export async function readTree(logitDir, hash) {
  const obj = await readObject(logitDir, hash);

  if (obj.type !== 'tree') {
    throw new Error(`Object ${hash} is not a tree (got ${obj.type})`);
  }

  return JSON.parse(obj.content.toString());
}
