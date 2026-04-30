import path from 'path';
import fs from 'fs/promises';
import { getLogitDir } from '../core/repository.js';
import { listAllObjects } from '../core/objects.js';
import { getAllRefs } from '../core/refs.js';
import { createPackfile } from '../core/packfile.js';
import { runHook } from '../core/hooks.js';
import { success, info, error } from '../utils/display.js';

export function registerPush(program) {
  program
    .command('push')
    .description('Push commits to a remote server')
    .option('-r, --remote <name>', 'Remote name', 'origin')
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

        // Support both plain URL string and { url } object
        const serverUrl = typeof remoteEntry === 'string' ? remoteEntry : remoteEntry.url;

        const headers = { 'Content-Type': 'application/json' };

        info(`Pushing to ${serverUrl}...`);

        // Get local and remote object lists
        const localObjects = await listAllObjects(logitDir);
        const remoteObjRes = await fetch(`${serverUrl}/objects/list`);
        if (!remoteObjRes.ok) throw new Error(`Cannot connect to ${serverUrl}`);
        const remoteObjects = new Set(await remoteObjRes.json());

        const toPush = localObjects.filter((h) => !remoteObjects.has(h));

        if (toPush.length === 0) {
          success('Everything up to date.');
          return;
        }

        info(`Pushing ${toPush.length} object(s) as packfile...`);

        // Bundle into a single packfile
        const packBuffer = await createPackfile(logitDir, toPush);

        const packRes = await fetch(`${serverUrl}/packfile`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          body: packBuffer,
          duplex: 'half'
        });

        if (!packRes.ok) {
          // Fallback: try legacy JSON endpoint
          info('Packfile endpoint not available, falling back to object-by-object...');
          const objects = [];
          for (const hash of toPush) {
            const objPath = path.join(logitDir, 'objects', hash.substring(0, 2), hash.substring(2));
            const data = await fs.readFile(objPath);
            objects.push({ hash, data: data.toString('base64') });
          }
          const fallbackRes = await fetch(`${serverUrl}/objects`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ objects })
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
          method: 'POST',
          headers,
          body: JSON.stringify({ refs: localRefs })
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
