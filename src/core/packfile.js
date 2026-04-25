import zlib from 'zlib';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { fileExists } from '../utils/fs.js';

const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

// Magic bytes identifying a Logit packfile
const PACK_MAGIC = Buffer.from('LGPK');
const VERSION = 1;

/**
 * Build a packfile buffer from a list of object hashes.
 *
 * Binary format (big-endian):
 *   [4 bytes] Magic "LGPK"
 *   [2 bytes] Version (1)
 *   [4 bytes] Number of objects
 *   For each object:
 *     [1  byte ] Type string length
 *     [N  bytes] Type string (e.g. "blob", "commit", "tree")
 *     [1  byte ] Hash length (always 40)
 *     [40 bytes] Hex SHA-1 hash
 *     [4  bytes] Compressed data length
 *     [N  bytes] zlib-compressed raw object data (header + content)
 *
 * @param {string} logitDir
 * @param {string[]} hashes - SHA-1 hashes to include
 * @returns {Promise<Buffer>}
 */
export async function createPackfile(logitDir, hashes) {
  const chunks = [PACK_MAGIC];

  // Version (2 bytes)
  const verBuf = Buffer.alloc(2);
  verBuf.writeUInt16BE(VERSION, 0);
  chunks.push(verBuf);

  // Count (4 bytes)
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32BE(hashes.length, 0);
  chunks.push(countBuf);

  for (const hash of hashes) {
    // Read raw compressed file from object store
    const objPath = path.join(logitDir, 'objects', hash.substring(0, 2), hash.substring(2));
    if (!(await fileExists(objPath))) {
      throw new Error(`Cannot pack: object ${hash} not found`);
    }

    const rawCompressed = await fs.readFile(objPath);

    // Decompress to determine type
    const raw = await inflate(rawCompressed);
    const nullIdx = raw.indexOf(0);
    const header = raw.slice(0, nullIdx).toString();
    const type = header.split(' ')[0];

    // Re-compress (same data, just reading what's stored)
    const typeBytes = Buffer.from(type);
    const hashBytes = Buffer.from(hash);

    // Type length + type
    const typeLenBuf = Buffer.alloc(1);
    typeLenBuf.writeUInt8(typeBytes.length, 0);
    chunks.push(typeLenBuf, typeBytes);

    // Hash length + hash
    const hashLenBuf = Buffer.alloc(1);
    hashLenBuf.writeUInt8(hashBytes.length, 0);
    chunks.push(hashLenBuf, hashBytes);

    // Compressed data length + data
    const dataLenBuf = Buffer.alloc(4);
    dataLenBuf.writeUInt32BE(rawCompressed.length, 0);
    chunks.push(dataLenBuf, rawCompressed);
  }

  return Buffer.concat(chunks);
}

/**
 * Parse a packfile buffer into an array of objects.
 * @returns {Array<{ type: string, hash: string, data: Buffer }>} raw compressed data per object
 */
export async function parsePackfile(buffer) {
  let offset = 0;

  // Validate magic
  const magic = buffer.slice(0, 4);
  if (!magic.equals(PACK_MAGIC)) {
    throw new Error('Invalid packfile: bad magic bytes');
  }
  offset += 4;

  // Version
  const version = buffer.readUInt16BE(offset);
  offset += 2;
  if (version !== VERSION) {
    throw new Error(`Unsupported packfile version: ${version}`);
  }

  // Count
  const count = buffer.readUInt32BE(offset);
  offset += 4;

  const objects = [];

  for (let i = 0; i < count; i++) {
    // Type
    const typeLen = buffer.readUInt8(offset); offset += 1;
    const type = buffer.slice(offset, offset + typeLen).toString(); offset += typeLen;

    // Hash
    const hashLen = buffer.readUInt8(offset); offset += 1;
    const hash = buffer.slice(offset, offset + hashLen).toString(); offset += hashLen;

    // Compressed data
    const dataLen = buffer.readUInt32BE(offset); offset += 4;
    const data = buffer.slice(offset, offset + dataLen); offset += dataLen;

    objects.push({ type, hash, data });
  }

  return objects;
}

/**
 * Unpack objects from a packfile buffer into the object store.
 * Returns the number of new objects written.
 */
export async function unpackPackfile(logitDir, buffer) {
  const objects = await parsePackfile(buffer);
  let stored = 0;

  for (const { hash, data } of objects) {
    const objDir = path.join(logitDir, 'objects', hash.substring(0, 2));
    const objPath = path.join(objDir, hash.substring(2));
    if (!(await fileExists(objPath))) {
      await fs.mkdir(objDir, { recursive: true });
      await fs.writeFile(objPath, data);
      stored++;
    }
  }

  return stored;
}
