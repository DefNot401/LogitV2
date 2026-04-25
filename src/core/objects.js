import crypto from 'crypto';
import zlib from 'zlib';
import path from 'path';
import fs from 'fs/promises';
import { ensureDir, fileExists } from '../utils/fs.js';
import { promisify } from 'util';

const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

/**
 * Compute the SHA-1 hash of content with a type header (Git-compatible format).
 * Format: "<type> <size>\0<content>"
 */
export function hashObject(content, type = 'blob') {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = `${type} ${buffer.length}\0`;
  const store = Buffer.concat([Buffer.from(header), buffer]);
  return crypto.createHash('sha1').update(store).digest('hex');
}

/**
 * Store an object in the object database.
 * Returns the SHA-1 hash.
 */
export async function writeObject(logitDir, content, type = 'blob') {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = `${type} ${buffer.length}\0`;
  const store = Buffer.concat([Buffer.from(header), buffer]);
  const hash = crypto.createHash('sha1').update(store).digest('hex');

  const objDir = path.join(logitDir, 'objects', hash.substring(0, 2));
  const objPath = path.join(objDir, hash.substring(2));

  if (!(await fileExists(objPath))) {
    await ensureDir(objDir);
    const compressed = await deflate(store);
    await fs.writeFile(objPath, compressed);
  }

  return hash;
}

/**
 * Read an object from the object database.
 * Returns { type, size, content } where content is a Buffer.
 */
export async function readObject(logitDir, hash) {
  const objPath = path.join(logitDir, 'objects', hash.substring(0, 2), hash.substring(2));

  if (!(await fileExists(objPath))) {
    throw new Error(`Object not found: ${hash}`);
  }

  const compressed = await fs.readFile(objPath);
  const store = await inflate(compressed);

  // Parse header: "<type> <size>\0<content>"
  const nullIndex = store.indexOf(0);
  const header = store.slice(0, nullIndex).toString();
  const [type, sizeStr] = header.split(' ');
  const size = parseInt(sizeStr, 10);
  const content = store.slice(nullIndex + 1);

  return { type, size, content };
}

/**
 * Check if an object exists in the store.
 */
export async function objectExists(logitDir, hash) {
  const objPath = path.join(logitDir, 'objects', hash.substring(0, 2), hash.substring(2));
  return fileExists(objPath);
}

/**
 * List all object hashes in the store.
 */
export async function listAllObjects(logitDir) {
  const objectsDir = path.join(logitDir, 'objects');
  const hashes = [];

  try {
    const prefixes = await fs.readdir(objectsDir);
    for (const prefix of prefixes) {
      const prefixPath = path.join(objectsDir, prefix);
      const stat = await fs.stat(prefixPath);
      if (stat.isDirectory() && prefix.length === 2) {
        const suffixes = await fs.readdir(prefixPath);
        for (const suffix of suffixes) {
          hashes.push(prefix + suffix);
        }
      }
    }
  } catch {
    // Empty objects directory
  }

  return hashes;
}
