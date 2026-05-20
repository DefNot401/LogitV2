import path from 'path';
import fs from 'fs/promises';
import { getLogitDir } from '../core/repository.js';
import { listAllObjects } from '../core/objects.js';
import { resolveHead, getAllRefs, getCurrentBranch } from '../core/refs.js';
import { getCommitLog } from '../core/commit.js';
import { createPackfile } from '../core/packfile.js';
import { runHook } from '../core/hooks.js';
import { success, info, error } from '../utils/display.js';
import chalk from 'chalk';

/**
 * Check if localHash is a descendant of remoteHash.
 * Returns true if the push is a fast-forward (safe).
 */
async function isFastForward(logitDir, localHash, remoteHash) {
  if (!remoteHash) return true; // Remote branch doesn't exist yet — always safe
  if (localHash === remoteHash) return true; // Same commit

  // Walk local history; if we find remoteHash, it's an ancestor → fast-forward
  const history = await getCommitLog(logitDir, localHash, 1000);
  return history.some((c) => c.hash === remoteHash);
}

export function registerPush(program) {
  program
    .command('push')
    .description('Push commits to a remote server')
    .option('-r, --remote <name>', 'Remote name', 'origin')
    .option('-f, --force', 'Force push, skipping fast-forward check (dangerous)')
    .action(async (options) => {
      try {
        const logitDir = await getLogitDir();

        // Run pre-push hook
        await runHook(logitDir, 'pre-push');

        // Read remote config
        const remotesPath = path.join(logitDir, 'remotes');
        const remotesContent = await fs.readFile(remotesPath, 'utf-8');
        const remotes = JSON.parse(remotesContent);
        const remoteEntry = remotes[options.remote];

        if (!remoteEntry) {
          throw new Error(`Remote '${options.remote}' not found. Use 'logit remote add <name> <url>'.`);
        }

        const serverUrl = typeof remoteEntry === 'string' ? remoteEntry : remoteEntry.url;
        const headers   = { 'Content-Type': 'application/json' };

        // ── Non-fast-forward protection ───────────────────────────────────
        if (!options.force) {
          const currentBranch = await getCurrentBranch(logitDir);
          const localHash     = await resolveHead(logitDir);

          // Fetch the remote's current HEAD for this branch
          let remoteHash = null;
          try {
            const refsRes = await fetch(`${serverUrl}/refs`);
            if (refsRes.ok) {
              const remoteRefs = await refsRes.json();
              remoteHash = currentBranch
                ? remoteRefs[`refs/heads/${currentBranch}`]
                : null;
            }
          } catch {
            // If we can't fetch refs, let the push proceed (server will validate)
          }

          if (remoteHash && !(await isFastForward(logitDir, localHash, remoteHash))) {
            console.log('');
            console.log(chalk.red('  ✗ Push rejected: non-fast-forward'));
            console.log('');
            console.log(
              chalk.gray('  The remote has commits that your local branch does not.')
            );
            console.log(
              chalk.gray('  This means someone else pushed while you were working.')
            );
            console.log('');
            console.log('  To fix this, pull first:');
            console.log(chalk.cyan('    logit pull'));
            console.log('');
            console.log('  Or force-push (WARNING: this will overwrite remote history):');
            console.log(chalk.yellow('    logit push --force'));
            console.log('');
            process.exit(1);
          }
        }

        info(`Pushing to ${serverUrl}...`);

        // Get local and remote object lists
        const localObjects  = await listAllObjects(logitDir);
        const remoteObjRes  = await fetch(`${serverUrl}/objects/list`);
        if (!remoteObjRes.ok) throw new Error(`Cannot connect to ${serverUrl}`);
        const remoteObjects = new Set(await remoteObjRes.json());

        const toPush = localObjects.filter((h) => !remoteObjects.has(h));

        if (toPush.length === 0) {
          success('Everything up to date.');
          return;
        }

        info(`Pushing ${toPush.length} object(s) as packfile...`);

        const packBuffer = await createPackfile(logitDir, toPush);

        const packRes = await fetch(`${serverUrl}/packfile`, {
          method:  'POST',
          headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          body:    packBuffer,
          duplex:  'half'
        });

        if (!packRes.ok) {
          // Fallback: object-by-object
          info('Packfile endpoint not available, falling back to object-by-object...');
          const objects = [];
          for (const hash of toPush) {
            const objPath = path.join(logitDir, 'objects', hash.substring(0, 2), hash.substring(2));
            const data = await fs.readFile(objPath);
            objects.push({ hash, data: data.toString('base64') });
          }
          const fallbackRes = await fetch(`${serverUrl}/objects`, {
            method: 'POST', headers, body: JSON.stringify({ objects })
          });
          if (!fallbackRes.ok) {
            const errBody = await fallbackRes.json().catch(() => ({}));
            throw new Error(errBody.error || `Push failed (${fallbackRes.status})`);
          }
        } else {
          const result = await packRes.json();
          info(`Server stored ${result.stored} new object(s).`);
        }

        // Update remote refs
        const localRefs = await getAllRefs(logitDir);
        const refsRes = await fetch(`${serverUrl}/update-refs`, {
          method: 'POST', headers, body: JSON.stringify({ refs: localRefs })
        });

        if (!refsRes.ok) {
          const errBody = await refsRes.json().catch(() => ({}));
          throw new Error(errBody.error || `Failed to update refs (${refsRes.status})`);
        }

        success(`Pushed ${toPush.length} object(s) to '${options.remote}'.`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
