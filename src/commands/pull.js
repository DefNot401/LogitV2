import path from 'path';
import fs from 'fs/promises';
import { getLogitDir, getRepoRoot } from '../core/repository.js';
import { listAllObjects, readObject } from '../core/objects.js';
import { resolveHead, getCurrentBranch, updateHead } from '../core/refs.js';
import { readCommit } from '../core/commit.js';
import { readTree } from '../core/tree.js';
import { unpackPackfile } from '../core/packfile.js';
import { getStatus } from '../core/status.js';
import { ensureDir } from '../utils/fs.js';
import { isAncestor, mergeToCommitHash } from '../core/merge.js';
import { success, info, error, warn } from '../utils/display.js';
import chalk from 'chalk';
import readline from 'readline';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

export function registerPull(program) {
  program
    .command('pull')
    .description('Pull updates from a remote server')
    .option('-r, --remote <name>', 'Remote name', 'origin')
    .option('-f, --force', 'Overwrite local changes without prompting')
    .action(async (options) => {
      try {
        const logitDir = await getLogitDir();
        const repoRoot = await getRepoRoot();

        // ── Dirty working directory check ─────────────────────────────────
        if (!options.force) {
          const status = await getStatus();
          const isDirty = status.staged.length > 0 || status.modified.length > 0 || status.deleted.length > 0;

          if (isDirty) {
            console.log('');
            console.log(chalk.yellow('  ⚠  Your working directory has uncommitted changes:'));
            [...status.staged.map(f => `     ${chalk.green('staged:   ')} ${f}`),
             ...status.modified.map(f => `     ${chalk.yellow('modified: ')} ${f}`),
             ...status.deleted.map(f => `     ${chalk.red('deleted:  ')} ${f}`)
            ].forEach(l => console.log(l));
            console.log('');

            const answer = await prompt(
              chalk.bold('  Pulling will overwrite these files. Continue? (y/N) ')
            );
            if (answer.toLowerCase() !== 'y') {
              info('Pull cancelled. Stash or commit your changes first:');
              info('  logit stash   — to save changes temporarily');
              info('  logit commit  — to commit your changes');
              process.exit(0);
            }
          }
        }

        // Read remote config
        const remotesPath = path.join(logitDir, 'remotes');
        const remotesContent = await fs.readFile(remotesPath, 'utf-8');
        const remotes = JSON.parse(remotesContent);
        const remoteEntry = remotes[options.remote];

        if (!remoteEntry) {
          throw new Error(`Remote '${options.remote}' not found. Use 'logit remote add <name> <url>'.`);
        }

        const serverUrl = typeof remoteEntry === 'string' ? remoteEntry : remoteEntry.url;

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

          const chunkSize = 100;
          let storedCount = 0;
          let useFallback = false;

          for (let i = 0; i < toFetch.length; i += chunkSize) {
            const chunk = toFetch.slice(i, i + chunkSize);
            const hashList = chunk.join(',');
            try {
              const packRes = await fetch(`${serverUrl}/packfile?hashes=${hashList}`);
              if (packRes.ok && packRes.headers.get('content-type') === 'application/octet-stream') {
                const packBuffer = Buffer.from(await packRes.arrayBuffer());
                const stored = await unpackPackfile(logitDir, packBuffer);
                storedCount += stored;
              } else {
                useFallback = true;
                break;
              }
            } catch (err) {
              useFallback = true;
              break;
            }
          }

          if (useFallback) {
            for (const hash of toFetch) {
              const objRes = await fetch(`${serverUrl}/objects/${hash}`);
              if (objRes.ok) {
                const data = Buffer.from(await objRes.arrayBuffer());
                const objDir = path.join(logitDir, 'objects', hash.substring(0, 2));
                const objPath = path.join(objDir, hash.substring(2));
                await ensureDir(objDir);
                await fs.writeFile(objPath, data);
              }
            }
          } else if (storedCount > 0) {
            info(`Unpacked ${storedCount} object(s) from packfile.`);
          }
        }

        // Fetch remote refs
        const refsRes = await fetch(`${serverUrl}/refs`);
        const remoteRefs = await refsRes.json();

        const currentBranch = await getCurrentBranch(logitDir);
        const currentRef = currentBranch ? `refs/heads/${currentBranch}` : null;
        const remoteHeadHash = currentRef ? remoteRefs[currentRef] : null;
        const localHeadHash = await resolveHead(logitDir);

        // 1. Update other refs safely (not the current branch)
        for (const [refName, remoteHash] of Object.entries(remoteRefs)) {
          if (refName === currentRef) continue; // Skip current branch, handled below

          const refPath = path.join(logitDir, refName);
          let localHash = null;
          try {
            localHash = (await fs.readFile(refPath, 'utf-8')).trim();
          } catch {
            // Does not exist locally
          }

          if (!localHash) {
            // Create the new branch
            await fs.mkdir(path.dirname(refPath), { recursive: true });
            await fs.writeFile(refPath, remoteHash + '\n');
          } else if (localHash !== remoteHash) {
            // Only update if it is a safe fast-forward
            const isAhead = await isAncestor(logitDir, localHash, remoteHash);
            if (isAhead) {
              await fs.writeFile(refPath, remoteHash + '\n');
            }
          }
        }

        // 2. Handle current branch merge/fast-forward/up-to-date
        if (remoteHeadHash) {
          if (!localHeadHash) {
            // Fresh repo - clean checkout of remote HEAD
            for (const [refName, hash] of Object.entries(remoteRefs)) {
              const refPath = path.join(logitDir, refName);
              await fs.mkdir(path.dirname(refPath), { recursive: true });
              await fs.writeFile(refPath, hash + '\n');
            }

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
          } else if (localHeadHash === remoteHeadHash) {
            success('Already up to date.');
          } else {
            // Check relationship
            const isRemoteBehind = await isAncestor(logitDir, remoteHeadHash, localHeadHash);
            const isLocalBehind = await isAncestor(logitDir, localHeadHash, remoteHeadHash);

            if (isRemoteBehind) {
              success('Already up to date. (Local is ahead of remote)');
            } else if (isLocalBehind) {
              // Safe fast-forward pull
              const refPath = path.join(logitDir, currentRef);
              await fs.writeFile(refPath, remoteHeadHash + '\n');

              const commit = await readCommit(logitDir, remoteHeadHash);
              const treeEntries = await readTree(logitDir, commit.tree);
              for (const entry of treeEntries) {
                const obj = await readObject(logitDir, entry.hash);
                const filePath = path.join(repoRoot, entry.name);
                await ensureDir(path.dirname(filePath));
                await fs.writeFile(filePath, obj.content);
              }

              success(`Fast-forwarded to ${remoteHeadHash.substring(0, 7)}`);
              info(`${toFetch.length} new object(s) fetched.`);
            } else {
              // Diverged history! Run a three-way merge
              info('Histories have diverged. Performing a three-way merge...');
              const result = await mergeToCommitHash(logitDir, remoteHeadHash, `remote/${currentBranch || 'origin'}`);
              
              if (result.type === 'conflict') {
                warn(result.message);
              } else if (result.type === 'merge' || result.type === 'fast-forward') {
                success(result.message);
              }
            }
          }
        } else {
          success('Already up to date.');
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
