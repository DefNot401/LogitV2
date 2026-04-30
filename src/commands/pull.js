import path from 'path';
import fs from 'fs/promises';
import { getLogitDir, getRepoRoot } from '../core/repository.js';
import { listAllObjects, readObject } from '../core/objects.js';
import { resolveHead, getCurrentBranch, updateHead } from '../core/refs.js';
import { readCommit } from '../core/commit.js';
import { readTree } from '../core/tree.js';
import { unpackPackfile } from '../core/packfile.js';
import { ensureDir } from '../utils/fs.js';
import { success, info, error } from '../utils/display.js';

export function registerPull(program) {
  program
    .command('pull')
    .description('Pull updates from a remote server')
    .option('-r, --remote <name>', 'Remote name', 'origin')
    .action(async (options) => {
      try {
        const logitDir = await getLogitDir();
        const repoRoot = await getRepoRoot();

        // Read remote config
        const remotesPath = path.join(logitDir, 'remotes');
        const remotesContent = await fs.readFile(remotesPath, 'utf-8');
        const remotes = JSON.parse(remotesContent);
        const remoteEntry = remotes[options.remote];

        if (!remoteEntry) {
          throw new Error(`Remote '${options.remote}' not found. Use 'logit remote add <name> <url>'.`);
        }

        const serverUrl = typeof remoteEntry === 'string' ? remoteEntry : remoteEntry.url;

        const headers = {};

        info(`Pulling from ${serverUrl}...`);

        // Get remote object list
        const remoteObjRes = await fetch(`${serverUrl}/objects/list`);
        if (!remoteObjRes.ok) throw new Error(`Cannot connect to ${serverUrl}`);
        const remoteObjects = await remoteObjRes.json();

        // Find missing objects
        const localObjects = new Set(await listAllObjects(logitDir));
        const toFetch = remoteObjects.filter((h) => !localObjects.has(h));

        if (toFetch.length > 0) {
          info(`Fetching ${toFetch.length} object(s)...`);

          // Try packfile endpoint first
          const hashList = toFetch.join(',');
          const packRes = await fetch(`${serverUrl}/packfile?hashes=${hashList}`, { headers });

          if (packRes.ok && packRes.headers.get('content-type') === 'application/octet-stream') {
            const packBuffer = Buffer.from(await packRes.arrayBuffer());
            const stored = await unpackPackfile(logitDir, packBuffer);
            info(`Unpacked ${stored} object(s) from packfile.`);
          } else {
            // Fallback: object-by-object
            for (const hash of toFetch) {
              const objRes = await fetch(`${serverUrl}/objects/${hash}`, { headers });
              if (objRes.ok) {
                const data = Buffer.from(await objRes.arrayBuffer());
                const objDir = path.join(logitDir, 'objects', hash.substring(0, 2));
                const objPath = path.join(objDir, hash.substring(2));
                await ensureDir(objDir);
                await fs.writeFile(objPath, data);
              }
            }
          }
        }

        // Fetch remote refs
        const refsRes = await fetch(`${serverUrl}/refs`, { headers });
        const remoteRefs = await refsRes.json();

        const currentBranch = await getCurrentBranch(logitDir);
        const currentRef = currentBranch ? `refs/heads/${currentBranch}` : null;
        const remoteHeadHash = currentRef ? remoteRefs[currentRef] : null;
        const localHeadHash = await resolveHead(logitDir);

        if (remoteHeadHash && remoteHeadHash !== localHeadHash) {
          // Update local refs
          for (const [refName, hash] of Object.entries(remoteRefs)) {
            const refPath = path.join(logitDir, refName);
            const refDir = path.dirname(refPath);
            await fs.mkdir(refDir, { recursive: true });
            await fs.writeFile(refPath, hash + '\n');
          }

          // Checkout updated HEAD
          const commit = await readCommit(logitDir, remoteHeadHash);
          const treeEntries = await readTree(logitDir, commit.tree);
          for (const entry of treeEntries) {
            const obj = await readObject(logitDir, entry.hash);
            const filePath = path.join(repoRoot, entry.name);
            await ensureDir(path.dirname(filePath));
            await fs.writeFile(filePath, obj.content);
          }

          success(`Updated to ${remoteHeadHash.substring(0, 7)}`);
          info(`${toFetch.length} new object(s), ${Object.keys(remoteRefs).length} ref(s) updated.`);
        } else {
          success('Already up to date.');
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
