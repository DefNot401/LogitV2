import path from 'path';
import fs from 'fs/promises';
import { initRepository, getLogitDir } from '../core/repository.js';
import { readObject } from '../core/objects.js';
import { readCommit } from '../core/commit.js';
import { readTree } from '../core/tree.js';
import { unpackPackfile } from '../core/packfile.js';
import { ensureDir } from '../utils/fs.js';
import { success, info, error } from '../utils/display.js';
import chalk from 'chalk';

// ─── Simple inline progress bar ──────────────────────────────────────────────

function renderProgress(current, total, label = '') {
  const width   = 30;
  const pct     = total === 0 ? 100 : Math.floor((current / total) * 100);
  const filled  = Math.floor((current / Math.max(total, 1)) * width);
  const empty   = width - filled;
  const bar     = chalk.green('█').repeat(filled) + chalk.gray('░').repeat(empty);
  process.stdout.write(
    `\r  ${bar} ${chalk.bold(`${pct}%`)}  ${chalk.gray(`${current}/${total}`)}  ${label}  `
  );
}

function clearLine() {
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerClone(program) {
  program
    .command('clone')
    .description('Clone a repository from a remote server')
    .argument('<url>', 'Server URL (e.g., http://192.168.1.10:5000)')
    .argument('[directory]', 'Directory to clone into')
    .action(async (url, directory) => {
      try {
        const serverUrl = url.endsWith('/') ? url.slice(0, -1) : url;

        info(`Cloning from ${chalk.cyan(serverUrl)}...`);

        const infoRes = await fetch(`${serverUrl}/info`);
        if (!infoRes.ok) throw new Error(`Cannot connect to ${serverUrl}`);
        const repoInfo = await infoRes.json();

        const targetDir  = directory || repoInfo.name || 'logit-repo';
        const targetPath = path.resolve(targetDir);

        await fs.mkdir(targetPath, { recursive: true });
        const logitDir = await initRepository(targetPath);
        info(`Initialized repository in ${chalk.white(targetPath)}`);

        // ── Fetch object list ─────────────────────────────────────────────
        const objectsRes   = await fetch(`${serverUrl}/objects/list`);
        const objectHashes = await objectsRes.json();
        const totalObjects = objectHashes.length;

        if (totalObjects > 0) {
          console.log('');
          info(`Fetching ${totalObjects} object(s)...`);

          // Try packfile first (fast path)
          const hashList = objectHashes.join(',');
          const packRes  = await fetch(`${serverUrl}/packfile?hashes=${hashList}`);

          if (packRes.ok && packRes.headers.get('content-type') === 'application/octet-stream') {
            renderProgress(0, totalObjects, 'downloading packfile');
            const packBuffer = Buffer.from(await packRes.arrayBuffer());
            renderProgress(totalObjects, totalObjects, 'unpacking...');
            const stored = await unpackPackfile(logitDir, packBuffer);
            clearLine();
            success(`Unpacked ${stored} object(s) from packfile.`);
          } else {
            // Fallback: object-by-object with progress bar
            let fetched = 0;
            for (const hash of objectHashes) {
              renderProgress(fetched, totalObjects, hash.substring(0, 7));
              const objRes = await fetch(`${serverUrl}/objects/${hash}`);
              if (objRes.ok) {
                const data   = Buffer.from(await objRes.arrayBuffer());
                const objDir = path.join(logitDir, 'objects', hash.substring(0, 2));
                const objPath = path.join(objDir, hash.substring(2));
                await ensureDir(objDir);
                await fs.writeFile(objPath, data);
                fetched++;
              }
            }
            clearLine();
            info(`Fetched ${fetched} object(s).`);
          }
          console.log('');
        }

        // ── Fetch refs ────────────────────────────────────────────────────
        info('Updating references...');
        const refsRes = await fetch(`${serverUrl}/refs`);
        const refs    = await refsRes.json();

        for (const [refName, hash] of Object.entries(refs)) {
          const refPath = path.join(logitDir, refName);
          await fs.mkdir(path.dirname(refPath), { recursive: true });
          await fs.writeFile(refPath, hash + '\n');
        }

        // ── Checkout HEAD ─────────────────────────────────────────────────
        if (repoInfo.head) {
          info('Checking out files...');
          const commit      = await readCommit(logitDir, repoInfo.head);
          const treeEntries = await readTree(logitDir, commit.tree);
          let written = 0;
          for (const entry of treeEntries) {
            renderProgress(written, treeEntries.length, entry.name);
            const obj      = await readObject(logitDir, entry.hash);
            const filePath = path.join(targetPath, entry.name);
            await ensureDir(path.dirname(filePath));
            await fs.writeFile(filePath, obj.content);
            written++;
          }
          clearLine();
        }

        // ── Save remote config ────────────────────────────────────────────
        await fs.writeFile(
          path.join(logitDir, 'remotes'),
          JSON.stringify({ origin: serverUrl }, null, 2)
        );

        console.log('');
        success(`Cloned '${chalk.cyan(repoInfo.name || targetDir)}' into '${targetDir}'`);
        info(`${totalObjects} objects, ${Object.keys(refs).length} refs`);
        info(`Remote 'origin' set to ${chalk.cyan(serverUrl)}`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
