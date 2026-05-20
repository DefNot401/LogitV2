import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import chalk from 'chalk';
import mdns from 'multicast-dns';
import readline from 'readline';

import { getLogitDir, getRepoRoot } from '../core/repository.js';
import { listAllObjects, readObject } from '../core/objects.js';
import { resolveHead, getCurrentBranch, getAllRefs, updateHead } from '../core/refs.js';
import { readCommit } from '../core/commit.js';
import { readTree } from '../core/tree.js';
import { unpackPackfile, createPackfile } from '../core/packfile.js';
import { getAllFiles, ensureDir } from '../utils/fs.js';
import { success, info, error, warn } from '../utils/display.js';
import { isAncestor, mergeToCommitHash } from '../core/merge.js';

// ─── Conflict marker scanner ──────────────────────────────────────────────────

async function findConflictedFiles(repoRoot) {
  const conflicted = [];
  try {
    const { getAllFiles, readFileContent } = await import('../utils/fs.js');
    const files = await getAllFiles(repoRoot);
    for (const file of files) {
      const content = await readFileContent(path.join(repoRoot, file));
      if (content.toString().includes('<<<<<<<')) {
        conflicted.push(file);
      }
    }
  } catch { /* ignore read errors */ }
  return conflicted;
}

// ─── mDNS Peer Discovery ─────────────────────────────────────────────────────

const SERVICE_TYPE = '_logit._tcp.local';

async function discoverPeers(timeout = 4000) {
  return new Promise((resolve) => {
    const discovered = new Map();
    const instance = mdns();

    instance.on('response', (response) => {
      const ptrs = response.answers.filter(
        (a) => a.type === 'PTR' && a.name === SERVICE_TYPE
      );

      for (const ptr of ptrs) {
        const instanceName = ptr.data;

        const srv =
          response.additionals.find((a) => a.type === 'SRV' && a.name === instanceName) ||
          response.answers.find((a) => a.type === 'SRV' && a.name === instanceName);

        const aRecord = response.additionals.find(
          (a) => (a.type === 'A' || a.type === 'AAAA') && a.name === srv?.data?.target
        );

        if (srv && !discovered.has(instanceName)) {
          const port = srv.data.port;
          const host = aRecord ? aRecord.data : srv.data.target.replace(/\.$/, '');
          const friendly = instanceName
            .replace(`._logit._tcp.local`, '')
            .replace(`.${SERVICE_TYPE}`, '');

          discovered.set(instanceName, { name: friendly, host, port, url: `http://${host}:${port}` });
        }
      }
    });

    instance.query({ questions: [{ name: SERVICE_TYPE, type: 'PTR' }] });

    setTimeout(() => {
      instance.destroy();
      resolve([...discovered.values()]);
    }, timeout);
  });
}

// ─── Prompt Helper ────────────────────────────────────────────────────────────

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Pull Logic (direct URL, no remote config needed) ────────────────────────

async function pullFromUrl(serverUrl, logitDir, repoRoot) {
  info(`  ↓ Pulling from ${chalk.cyan(serverUrl)}...`);

  const remoteObjRes = await fetch(`${serverUrl}/objects/list`);
  if (!remoteObjRes.ok) throw new Error(`Cannot connect to ${serverUrl}`);
  const remoteObjects = await remoteObjRes.json();

  const localObjects = new Set(await listAllObjects(logitDir));
  const toFetch = remoteObjects.filter((h) => !localObjects.has(h));

  if (toFetch.length > 0) {
    info(`    Fetching ${toFetch.length} object(s)...`);

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
      info(`    Unpacked ${storedCount} object(s).`);
    }
  }

  // Fetch and apply refs
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

      success(`    Updated to ${remoteHeadHash.substring(0, 7)} — ${toFetch.length} new object(s).`);
      return true;
    } else if (localHeadHash === remoteHeadHash) {
      success('    Already up to date.');
      return false;
    } else {
      // Check relationship
      const isRemoteBehind = await isAncestor(logitDir, remoteHeadHash, localHeadHash);
      const isLocalBehind = await isAncestor(logitDir, localHeadHash, remoteHeadHash);

      if (isRemoteBehind) {
        success('    Already up to date. (Local is ahead of remote)');
        return false;
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

        success(`    Fast-forwarded to ${remoteHeadHash.substring(0, 7)} — ${toFetch.length} new object(s).`);
        return true;
      } else {
        // Diverged history! Run a three-way merge
        info('    Histories have diverged. Performing a three-way merge...');
        const result = await mergeToCommitHash(logitDir, remoteHeadHash, `remote/${currentBranch || 'origin'}`);

        if (result.type === 'conflict') {
          warn(`    ${result.message}`);
        } else if (result.type === 'merge' || result.type === 'fast-forward') {
          success(`    ${result.message}`);
        }
        return true;
      }
    }
  } else {
    success('    Already up to date.');
    return false;
  }
}

// ─── Push Logic (direct URL, no remote config needed) ────────────────────────

async function pushToUrl(serverUrl, logitDir) {
  info(`  ↑ Pushing to   ${chalk.cyan(serverUrl)}...`);

  const localObjects = await listAllObjects(logitDir);
  const remoteObjRes = await fetch(`${serverUrl}/objects/list`);
  if (!remoteObjRes.ok) throw new Error(`Cannot connect to ${serverUrl}`);
  const remoteObjects = new Set(await remoteObjRes.json());

  const toPush = localObjects.filter((h) => !remoteObjects.has(h));

  if (toPush.length === 0) {
    success('    Nothing new to push.');
    return;
  }

  info(`    Pushing ${toPush.length} object(s)...`);

  const packBuffer = await createPackfile(logitDir, toPush);
  const packRes = await fetch(`${serverUrl}/packfile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: packBuffer,
    duplex: 'half',
  });

  if (!packRes.ok) {
    // Fallback: object-by-object
    const objects = [];
    for (const hash of toPush) {
      const objPath = path.join(logitDir, 'objects', hash.substring(0, 2), hash.substring(2));
      const data = await fs.readFile(objPath);
      objects.push({ hash, data: data.toString('base64') });
    }
    await fetch(`${serverUrl}/objects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objects }),
    });
  } else {
    const result = await packRes.json();
    info(`    Server stored ${result.stored} new object(s).`);
  }

  // Update remote refs
  const localRefs = await getAllRefs(logitDir);
  const refsRes = await fetch(`${serverUrl}/update-refs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs: localRefs }),
  });

  if (!refsRes.ok) {
    const errBody = await refsRes.json().catch(() => ({}));
    throw new Error(errBody.error || `Failed to update refs (${refsRes.status})`);
  }

  success(`    Pushed ${toPush.length} object(s).`);
}

// ─── Command Registration ─────────────────────────────────────────────────────

export function registerSync(program) {
  program
    .command('sync')
    .description('Auto-discover a peer on the LAN and perform a bidirectional sync (pull + push)')
    .option('-t, --timeout <ms>', 'mDNS scan duration in milliseconds', '4000')
    .option('-u, --url <url>', 'Skip discovery and sync directly with this URL')
    .option('-y, --yes', 'Skip confirmation prompt and sync immediately')
    .action(async (options) => {
      try {
        const logitDir = await getLogitDir();
        const repoRoot = await getRepoRoot();

        console.log('');
        console.log(chalk.bold.hex('#7C3AED')('  ◆ Logit Sync'));
        console.log(chalk.gray('  ─────────────────────────────────────'));
        console.log('');

        let targetUrl = options.url;

        // ── Step 1: Discover peer if no URL was given ──────────────────────
        if (!targetUrl) {
          info('Scanning the local network for Logit servers...');
          const timeout = parseInt(options.timeout, 10);
          const peers = await discoverPeers(timeout);
          console.log('');

          if (peers.length === 0) {
            error('No Logit servers found on the local network.');
            info('Make sure your peer is running:  logit serve');
            process.exit(1);
          }

          if (peers.length === 1) {
            // Only one peer — optionally prompt before syncing
            const peer = peers[0];
            if (!options.yes) {
              const repoLabel = chalk.cyan(peer.name || 'unknown');
              const urlLabel = chalk.yellow(peer.url);
              const answer = await prompt(
                `  Found ${repoLabel} at ${urlLabel}. Sync now? (Y/n) `
              );
              if (answer.toLowerCase() === 'n') {
                info('Sync cancelled.');
                process.exit(0);
              }
            }
            targetUrl = peer.url;
          } else {
            // Multiple peers — let the user pick
            console.log(chalk.bold('  Found multiple peers:\n'));
            peers.forEach((peer, i) => {
              console.log(
                `  ${chalk.bold(`[${i + 1}]`)} ${chalk.cyan((peer.name || 'unknown').padEnd(28))} ${chalk.yellow(peer.url)}`
              );
            });
            console.log('');
            const answer = await prompt(`  Choose a peer [1-${peers.length}]: `);
            const idx = parseInt(answer, 10) - 1;
            if (isNaN(idx) || idx < 0 || idx >= peers.length) {
              error('Invalid selection.');
              process.exit(1);
            }
            targetUrl = peers[idx].url;
          }
        }

        const currentBranch = await getCurrentBranch(logitDir) || 'main';
        console.log('');
        info(`Syncing branch ${chalk.bold(currentBranch)} with ${chalk.cyan(targetUrl)}`);
        console.log('');

        // ── Step 2: Pull (get what the peer has) ───────────────────────────
        await pullFromUrl(targetUrl, logitDir, repoRoot);
        console.log('');

        // ── Step 3: Conflict check before pushing ──────────────────────────
        const conflicted = await findConflictedFiles(repoRoot);
        if (conflicted.length > 0) {
          console.log(chalk.red('  ✗ Sync paused: unresolved merge conflicts detected'));
          console.log('');
          console.log(chalk.gray('  The following files have conflict markers (<<<<<<):'));
          for (const f of conflicted) {
            console.log(`    ${chalk.yellow(f)}`);
          }
          console.log('');
          console.log('  Resolve the conflicts, then push manually:');
          console.log(chalk.cyan(`    logit push --remote ${targetUrl}`));
          console.log('');
          process.exit(1);
        }

        // ── Step 4: Push (give the peer what we have) ──────────────────────
        await pushToUrl(targetUrl, logitDir);
        console.log('');

        // ── Done ───────────────────────────────────────────────────────────
        console.log(
          chalk.bold.green('  ✔ Sync complete!') +
          chalk.gray(`  Both sides are now up to date on branch '${currentBranch}'.`)
        );
        console.log('');
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
