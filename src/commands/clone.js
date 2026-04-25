import path from 'path';
import fs from 'fs/promises';
import { initRepository, getLogitDir } from '../core/repository.js';
import { readObject } from '../core/objects.js';
import { readCommit } from '../core/commit.js';
import { readTree } from '../core/tree.js';
import { unpackPackfile } from '../core/packfile.js';
import { ensureDir } from '../utils/fs.js';
import { success, info, error } from '../utils/display.js';

export function registerClone(program) {
  program
    .command('clone')
    .description('Clone a repository from a remote server')
    .argument('<url>', 'Server URL (e.g., http://192.168.1.10:5000)')
    .argument('[directory]', 'Directory to clone into')
    .option('--token <token>', 'Auth token for private repositories')
    .action(async (url, directory, options) => {
      try {
        const serverUrl = url.endsWith('/') ? url.slice(0, -1) : url;

        const headers = {};
        const token = options.token || process.env.LOGIT_TOKEN;
        if (token) headers['Authorization'] = `Bearer ${token}`;

        info(`Cloning from ${serverUrl}...`);

        const infoRes = await fetch(`${serverUrl}/info`);
        if (!infoRes.ok) throw new Error(`Cannot connect to ${serverUrl}`);
        const repoInfo = await infoRes.json();

        const targetDir = directory || repoInfo.name || 'logit-repo';
        const targetPath = path.resolve(targetDir);

        await fs.mkdir(targetPath, { recursive: true });
        const logitDir = await initRepository(targetPath);
        info(`Initialized repository in ${targetPath}`);

        // Fetch all objects via packfile
        info('Fetching objects...');
        const objectsRes = await fetch(`${serverUrl}/objects/list`);
        const objectHashes = await objectsRes.json();

        if (objectHashes.length > 0) {
          const hashList = objectHashes.join(',');
          const packRes = await fetch(`${serverUrl}/packfile?hashes=${hashList}`, { headers });

          if (packRes.ok && packRes.headers.get('content-type') === 'application/octet-stream') {
            const packBuffer = Buffer.from(await packRes.arrayBuffer());
            const stored = await unpackPackfile(logitDir, packBuffer);
            info(`Unpacked ${stored} object(s) from packfile.`);
          } else {
            // Fallback: object-by-object
            let fetched = 0;
            for (const hash of objectHashes) {
              const objRes = await fetch(`${serverUrl}/objects/${hash}`, { headers });
              if (objRes.ok) {
                const data = Buffer.from(await objRes.arrayBuffer());
                const objDir = path.join(logitDir, 'objects', hash.substring(0, 2));
                const objPath = path.join(objDir, hash.substring(2));
                await ensureDir(objDir);
                await fs.writeFile(objPath, data);
                fetched++;
              }
            }
            info(`Fetched ${fetched} object(s).`);
          }
        }

        // Fetch refs
        info('Updating references...');
        const refsRes = await fetch(`${serverUrl}/refs`);
        const refs = await refsRes.json();

        for (const [refName, hash] of Object.entries(refs)) {
          const refPath = path.join(logitDir, refName);
          const refDir = path.dirname(refPath);
          await fs.mkdir(refDir, { recursive: true });
          await fs.writeFile(refPath, hash + '\n');
        }

        // Checkout HEAD
        if (repoInfo.head) {
          const commit = await readCommit(logitDir, repoInfo.head);
          const treeEntries = await readTree(logitDir, commit.tree);
          for (const entry of treeEntries) {
            const obj = await readObject(logitDir, entry.hash);
            const filePath = path.join(targetPath, entry.name);
            await ensureDir(path.dirname(filePath));
            await fs.writeFile(filePath, obj.content);
          }
        }

        // Save remote config (with token if provided)
        const remoteEntry = token ? { url: serverUrl, token } : serverUrl;
        const remotes = { origin: remoteEntry };
        await fs.writeFile(path.join(logitDir, 'remotes'), JSON.stringify(remotes, null, 2));

        success(`Cloned repository into '${targetDir}'`);
        info(`${objectHashes.length} objects, ${Object.keys(refs).length} refs`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
