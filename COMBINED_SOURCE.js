/**
 * LogitV2 - Combined Source Code
 * This file contains all core, command, server, and utility functions for the Logit distributed VCS.
 */

// ===========================================================================
// src/commands/add.js
// ===========================================================================
import path from 'path';
import { addFiles } from '../core/index.js';
import { getRepoRoot } from '../core/repository.js';
import { getAllFiles } from '../utils/fs.js';
import { success, error, info } from '../utils/display.js';

export function registerAdd(program) {
  program
    .command('add')
    .description('Add file(s) to the staging area')
    .argument('<files...>', 'Files to add (use "." for all files)')
    .action(async (files) => {
      try {
        const root = await getRepoRoot();
        let filesToAdd = [];

        if (files.includes('.')) {
          // Add all files in the repo
          filesToAdd = await getAllFiles(root);
        } else {
          // Normalize paths to be relative to repo root
          filesToAdd = files.map(f => {
            const absPath = path.resolve(f);
            return path.relative(root, absPath).replace(/\\/g, '/');
          });
        }

        if (filesToAdd.length === 0) {
          info('No files to add.');
          return;
        }

        const added = await addFiles(filesToAdd);
        for (const file of added) {
          success(`Added: ${file}`);
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/branch.js
// ===========================================================================
import { listBranches, createBranch, resolveHead, getCurrentBranch, deleteBranch } from '../core/refs.js';
import { getLogitDir } from '../core/repository.js';
import { formatBranches, success, error } from '../utils/display.js';

export function registerBranch(program) {
  program
    .command('branch')
    .description('List, create, or delete branches')
    .argument('[name]', 'Branch name to create')
    .option('-d, --delete <name>', 'Delete a branch')
    .action(async (name, options) => {
      try {
        const logitDir = await getLogitDir();

        if (options.delete) {
          const current = await getCurrentBranch(logitDir);
          if (options.delete === current) {
            throw new Error(`Cannot delete the current branch '${options.delete}'.`);
          }
          await deleteBranch(logitDir, options.delete);
          success(`Deleted branch '${options.delete}'.`);
          return;
        }

        if (name) {
          // Create a new branch
          const headHash = await resolveHead(logitDir);
          if (!headHash) {
            throw new Error('Cannot create branch: no commits yet.');
          }
          await createBranch(logitDir, name, headHash);
          success(`Created branch '${name}' at ${headHash.substring(0, 7)}.`);
        } else {
          // List branches
          const branches = await listBranches(logitDir);
          const current = await getCurrentBranch(logitDir);

          if (branches.length === 0) {
            console.log('No branches yet. Make a commit first.');
          } else {
            console.log(formatBranches(branches, current));
          }
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/checkout.js
// ===========================================================================
import { checkout } from '../core/checkout.js';
import { getLogitDir } from '../core/repository.js';
import { success, warn, error } from '../utils/display.js';

export function registerCheckout(program) {
  program
    .command('checkout')
    .description('Restore working directory to a specific commit or branch')
    .argument('<ref>', 'Commit hash or branch name')
    .action(async (ref) => {
      try {
        const logitDir = await getLogitDir();
        const result = await checkout(logitDir, ref);

        if (result.isBranch) {
          success(`Switched to branch '${result.target}'`);
        } else {
          warn(`HEAD is now at ${result.commitHash.substring(0, 7)} (detached HEAD state)`);
        }
        success(`Restored ${result.filesRestored} file(s).`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/clone.js
// ===========================================================================
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

          const chunkSize = 100;
          let storedCount = 0;
          let useFallback = false;

          for (let i = 0; i < totalObjects; i += chunkSize) {
            const chunk = objectHashes.slice(i, i + chunkSize);
            const hashList = chunk.join(',');
            try {
              renderProgress(i, totalObjects, 'downloading packfile');
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
          } else {
            renderProgress(totalObjects, totalObjects, 'unpacking...');
            clearLine();
            success(`Unpacked ${storedCount} object(s) from packfile.`);
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


// ===========================================================================
// src/commands/commit.js
// ===========================================================================
import { createCommit } from '../core/commit.js';
import { getLogitDir } from '../core/repository.js';
import { success, error } from '../utils/display.js';

export function registerCommit(program) {
  program
    .command('commit')
    .description('Record changes to the repository')
    .requiredOption('-m, --message <message>', 'Commit message')
    .option('-a, --author <author>', 'Override author (format: "Name <email>")')
    .action(async (options) => {
      try {
        const logitDir = await getLogitDir();
        const commit = await createCommit(logitDir, options.message, options.author);
        success(`[${commit.hash.substring(0, 7)}] ${commit.message}`);
        if (options.author) {
          success(`Author: ${options.author}`);
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/config.js
// ===========================================================================
import path from 'path';
import fs from 'fs/promises';
import { getLogitDir } from '../core/repository.js';
import { success, info, error } from '../utils/display.js';
import chalk from 'chalk';

/**
 * Reads config from .logit/config, writes back with updated key.
 * Supports dot-notation keys like "user.name" or "user.email".
 */
async function readConfig(logitDir) {
  const configPath = path.join(logitDir, 'config');
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf-8'));
  } catch {
    return { user: { name: 'Unknown', email: 'user@logit.local' } };
  }
}

async function writeConfig(logitDir, config) {
  const configPath = path.join(logitDir, 'config');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

function getNestedValue(obj, keys) {
  return keys.reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function setNestedValue(obj, keys, value) {
  const last = keys.pop();
  const target = keys.reduce((o, k) => {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}

function flattenConfig(obj, prefix = '') {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null) {
      lines.push(...flattenConfig(v, fullKey));
    } else {
      lines.push({ key: fullKey, value: v });
    }
  }
  return lines;
}

export function registerConfig(program) {
  program
    .command('config')
    .description('Get or set repository configuration values')
    .argument('[key]', 'Config key in dot notation (e.g. user.name)')
    .argument('[value]', 'Value to set (omit to read the current value)')
    .option('-l, --list', 'List all configuration values')
    .action(async (key, value, options) => {
      try {
        const logitDir = await getLogitDir();
        const config = await readConfig(logitDir);

        // ── List all config ───────────────────────────────────────────────
        if (options.list || (!key && !value)) {
          console.log('');
          console.log(chalk.bold('  Repository Configuration'));
          console.log(chalk.gray('  ─────────────────────────────────────'));
          const pairs = flattenConfig(config);
          for (const { key: k, value: v } of pairs) {
            console.log(`  ${chalk.cyan(k.padEnd(24))} ${chalk.white(v)}`);
          }
          console.log('');
          return;
        }

        const keys = key.split('.');

        // ── Read a single key ─────────────────────────────────────────────
        if (value === undefined) {
          const result = getNestedValue(config, [...keys]);
          if (result === undefined) {
            error(`Config key '${key}' not found.`);
            process.exit(1);
          }
          console.log(result);
          return;
        }

        // ── Set a key ─────────────────────────────────────────────────────
        setNestedValue(config, keys, value);
        await writeConfig(logitDir, config);
        success(`Set ${chalk.cyan(key)} = ${chalk.white(value)}`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/diff.js
// ===========================================================================
import path from 'path';
import { createRequire } from 'module';
import chalk from 'chalk';
import { getRepoRoot, getLogitDir } from '../core/repository.js';
import { getIndex } from '../core/index.js';
import { resolveHead } from '../core/refs.js';
import { readCommit } from '../core/commit.js';
import { readTree } from '../core/tree.js';
import { readObject, hashObject } from '../core/objects.js';
import { readFileContent } from '../utils/fs.js';
import { error, info } from '../utils/display.js';

const require = createRequire(import.meta.url);
const Diff    = require('diff');

// ─── Colorised patch printer ──────────────────────────────────────────────────

function printPatch(patch) {
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++'))      console.log(chalk.green(line));
    else if (line.startsWith('-') && !line.startsWith('---')) console.log(chalk.red(line));
    else if (line.startsWith('@@'))                            console.log(chalk.cyan(line));
    else                                                       console.log(line);
  }
}

// ─── Working dir vs last commit (original behaviour) ─────────────────────────

async function getDiff(filePaths = []) {
  const root     = await getRepoRoot();
  const logitDir = path.join(root, '.logit');
  const headHash = await resolveHead(logitDir);

  let committedFiles = {};
  if (headHash) {
    const commit     = await readCommit(logitDir, headHash);
    const treeEntries = await readTree(logitDir, commit.tree);
    for (const e of treeEntries) committedFiles[e.name] = e.hash;
  }

  const index = await getIndex(logitDir);
  let filesToDiff = filePaths.length > 0
    ? filePaths.map(f => f.replace(/\\/g, '/'))
    : [...new Set([...Object.keys(committedFiles), ...Object.keys(index.entries)])];

  const diffs = [];
  for (const file of filesToDiff) {
    let oldContent = '';
    if (committedFiles[file]) {
      try { oldContent = (await readObject(logitDir, committedFiles[file])).content.toString(); }
      catch { oldContent = ''; }
    }
    let newContent = '';
    try { newContent = (await readFileContent(path.join(root, file))).toString(); }
    catch { newContent = ''; }

    if (oldContent === newContent) continue;
    diffs.push({ file, patch: Diff.createPatch(file, oldContent, newContent, 'committed', 'working') });
  }
  return diffs;
}

// ─── Commit vs commit (two hashes, or hash..HEAD) ────────────────────────────

async function getCommitDiff(logitDir, hashA, hashB, filePaths = []) {
  async function getTree(hash) {
    const commit     = await readCommit(logitDir, hash);
    const entries    = await readTree(logitDir, commit.tree);
    const map = {};
    for (const e of entries) map[e.name] = e.hash;
    return map;
  }

  const treeA = await getTree(hashA);
  const treeB = await getTree(hashB);
  const allFiles = [...new Set([...Object.keys(treeA), ...Object.keys(treeB)])];
  const filesToDiff = filePaths.length > 0 ? filePaths : allFiles;

  const diffs = [];
  for (const file of filesToDiff) {
    let oldContent = '';
    let newContent = '';
    if (treeA[file]) {
      try { oldContent = (await readObject(logitDir, treeA[file])).content.toString(); } catch { oldContent = ''; }
    }
    if (treeB[file]) {
      try { newContent = (await readObject(logitDir, treeB[file])).content.toString(); } catch { newContent = ''; }
    }
    if (oldContent === newContent) continue;
    diffs.push({
      file,
      patch: Diff.createPatch(file, oldContent, newContent, hashA.substring(0, 7), hashB.substring(0, 7))
    });
  }
  return diffs;
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerDiff(program) {
  program
    .command('diff')
    .description('Show changes between commits, or between a commit and the working tree')
    .argument('[ref]', '"HEAD", a commit hash, or "hash1..hash2"')
    .argument('[files...]', 'Specific files to diff')
    .action(async (ref, files) => {
      try {
        const root     = await getRepoRoot();
        const logitDir = path.join(root, '.logit');

        // ── No ref: working dir vs last commit ────────────────────────────
        if (!ref) {
          const diffs = await getDiff(files);
          if (diffs.length === 0) { info('No changes detected.'); return; }
          for (const { patch } of diffs) printPatch(patch);
          return;
        }

        // ── "hash1..hash2" syntax ─────────────────────────────────────────
        if (ref.includes('..')) {
          const [rawA, rawB] = ref.split('..');
          const headHash = await resolveHead(logitDir);

          const resolveRef = async (r) => {
            if (!r || r.toUpperCase() === 'HEAD') return headHash;
            return r; // treat as a direct hash
          };

          const hashA = await resolveRef(rawA);
          const hashB = await resolveRef(rawB);

          if (!hashA || !hashB) throw new Error('Could not resolve one or both refs.');

          console.log('');
          console.log(chalk.bold(`  Diff: ${chalk.yellow(hashA.substring(0,7))} → ${chalk.yellow(hashB.substring(0,7))}`));
          console.log('');

          const diffs = await getCommitDiff(logitDir, hashA, hashB, files);
          if (diffs.length === 0) { info('No differences between those commits.'); return; }
          for (const { patch } of diffs) printPatch(patch);
          return;
        }

        // ── "HEAD" or single hash: that commit vs working dir ─────────────
        const headHash = await resolveHead(logitDir);
        const targetHash = ref.toUpperCase() === 'HEAD'
          ? headHash
          : ref; // direct hash

        if (!targetHash) throw new Error(`Could not resolve ref '${ref}'.`);

        // Diff the commit's tree against the working directory
        const commit     = await readCommit(logitDir, targetHash);
        const treeEntries = await readTree(logitDir, commit.tree);
        const committedFiles = {};
        for (const e of treeEntries) committedFiles[e.name] = e.hash;

        const filesToDiff = files.length > 0
          ? files.map(f => f.replace(/\\/g, '/'))
          : Object.keys(committedFiles);

        const diffs = [];
        for (const file of filesToDiff) {
          let oldContent = '';
          try { oldContent = (await readObject(logitDir, committedFiles[file])).content.toString(); } catch {}
          let newContent = '';
          try { newContent = (await readFileContent(path.join(root, file))).toString(); } catch {}
          if (oldContent === newContent) continue;
          diffs.push({
            file,
            patch: Diff.createPatch(file, oldContent, newContent, targetHash.substring(0, 7), 'working')
          });
        }

        console.log('');
        console.log(chalk.bold(`  Diff: ${chalk.yellow(targetHash.substring(0,7))} → working directory`));
        console.log('');

        if (diffs.length === 0) { info('No changes.'); return; }
        for (const { patch } of diffs) printPatch(patch);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/discover.js
// ===========================================================================
import mdns from 'multicast-dns';
import { info, success, error } from '../utils/display.js';
import chalk from 'chalk';

const SERVICE_TYPE = '_logit._tcp.local';
const SCAN_TIMEOUT = 4000;

export function registerDiscover(program) {
  program
    .command('discover')
    .description('Find active Logit servers on the local network')
    .option('-t, --timeout <ms>', 'Scan duration in milliseconds', '4000')
    .action(async (options) => {
      const timeout = parseInt(options.timeout, 10);
      const discovered = new Map(); // name -> { host, port, addresses }

      info('Scanning for Logit servers on the local network...');
      console.log('');

      const mdnsInstance = mdns();

      // Listen for query responses (PTR, SRV, A records)
      mdnsInstance.on('response', (response) => {
        // Look for PTR records pointing to our service
        const ptrs = response.answers.filter(
          (a) => a.type === 'PTR' && a.name === SERVICE_TYPE
        );

        for (const ptr of ptrs) {
          const instanceName = ptr.data; // e.g. "My-Repo._logit._tcp.local"

          // Find matching SRV record
          const srv = response.additionals.find(
            (a) => a.type === 'SRV' && a.name === instanceName
          ) || response.answers.find(
            (a) => a.type === 'SRV' && a.name === instanceName
          );

          // Find matching A/AAAA record
          const aRecord = response.additionals.find(
            (a) => (a.type === 'A' || a.type === 'AAAA') && a.name === srv?.data?.target
          );

          if (srv) {
            const port = srv.data.port;
            const host = aRecord ? aRecord.data : srv.data.target.replace(/\.$/, '');
            // Extract a friendly name — strip the service suffix
            const friendly = instanceName
              .replace(`.${SERVICE_TYPE}`, '')
              .replace(`._logit._tcp.local`, '');

            if (!discovered.has(instanceName)) {
              discovered.set(instanceName, { name: friendly, host, port });
            }
          }
        }
      });

      // Send PTR query for our service type
      mdnsInstance.query({
        questions: [{ name: SERVICE_TYPE, type: 'PTR' }]
      });

      // Wait for responses then print results
      await new Promise((resolve) => setTimeout(resolve, timeout));
      mdnsInstance.destroy();

      console.log('');
      if (discovered.size === 0) {
        info('No Logit servers found on the local network.');
        info('Make sure the remote machine is running  logit serve');
      } else {
        success(`Found ${discovered.size} server(s):\n`);

        const header = `  ${'REPOSITORY'.padEnd(30)} ${'ADDRESS'.padEnd(22)} COMMANDS`;
        console.log(chalk.bold.underline(header));

        for (const { name, host, port } of discovered.values()) {
          const url = `http://${host}:${port}`;
          const repoName = name || '(unknown)';
          console.log(
            `  ${chalk.cyan(repoName.padEnd(30))} ${chalk.yellow(url.padEnd(22))} ` +
            chalk.gray(`logit clone ${url}`)
          );
        }

        console.log('');
        info('Copy any clone command above, or use:');
        console.log(
          chalk.white('  logit remote add <name> ') +
          chalk.yellow('<url above>')
        );
      }
    });
}


// ===========================================================================
// src/commands/init.js
// ===========================================================================
import { initRepository } from '../core/repository.js';
import { installSampleHooks } from '../core/hooks.js';
import { success, error, info } from '../utils/display.js';

export function registerInit(program) {
  program
    .command('init')
    .description('Initialize a new Logit repository')
    .action(async () => {
      try {
        const logitDir = await initRepository();
        success(`Initialized empty Logit repository in ${logitDir}`);

        // Install sample hooks
        const installed = await installSampleHooks(logitDir);
        if (installed.length > 0) {
          info(`Installed sample hooks: ${installed.join(', ')}`);
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/log.js
// ===========================================================================
import chalk from 'chalk';
import { getCommitLog } from '../core/commit.js';
import { resolveHead, getCurrentBranch, getAllRefs } from '../core/refs.js';
import { getLogitDir } from '../core/repository.js';
import { formatCommit, error, info } from '../utils/display.js';

// ─── ASCII Graph helpers ──────────────────────────────────────────────────────

/**
 * Builds a simple linear/merge ASCII graph for the commit list.
 * Each commit shows: * <hash> (<branch>) <message> — <author> — <date>
 */
function buildGraph(commits, currentBranch, allRefs) {
  // Build a reverse map: hash -> branch names
  const hashToBranches = new Map();
  for (const [ref, hash] of Object.entries(allRefs)) {
    const branch = ref.replace('refs/heads/', '');
    if (!hashToBranches.has(hash)) hashToBranches.set(hash, []);
    hashToBranches.get(hash).push(branch);
  }

  const lines = [];

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const isLast = i === commits.length - 1;

    // Branch label(s) for this commit
    const branches = hashToBranches.get(commit.hash) || [];
    const branchLabels = branches.map((b) => {
      const isHead = b === currentBranch;
      return isHead
        ? chalk.bold.cyan(`HEAD → ${b}`)
        : chalk.yellow(b);
    });

    const label = branchLabels.length > 0 ? ` (${branchLabels.join(', ')})` : '';
    const hash  = chalk.yellow(commit.hash.substring(0, 7));
    const msg   = chalk.white(commit.message);
    const author = chalk.gray(commit.author?.split('<')[0].trim() || 'Unknown');
    const date  = commit.timestamp
      ? chalk.gray(new Date(commit.timestamp).toLocaleDateString())
      : '';

    // Graph column
    const connector = isLast ? ' ' : chalk.gray('│');
    const node      = chalk.bold.magenta('*');

    lines.push(`${node} ${hash}${label} ${msg}`);
    lines.push(`${connector}   ${chalk.gray('└─')} ${author} ${date}`);
    if (!isLast) lines.push(chalk.gray('│'));
  }

  return lines;
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerLog(program) {
  program
    .command('log')
    .description('Show commit history')
    .option('-n, --number <count>', 'Number of commits to show', '10')
    .option('--graph', 'Show an ASCII graph of the commit history')
    .action(async (options) => {
      try {
        const logitDir   = await getLogitDir();
        const headHash   = await resolveHead(logitDir);

        if (!headHash) {
          info('No commits yet.');
          return;
        }

        const currentBranch = await getCurrentBranch(logitDir);
        const maxCount      = parseInt(options.number, 10);
        const commits       = await getCommitLog(logitDir, headHash, maxCount);

        if (options.graph) {
          const allRefs = await getAllRefs(logitDir);
          console.log('');
          const graphLines = buildGraph(commits, currentBranch, allRefs);
          for (const line of graphLines) {
            console.log('  ' + line);
          }
          console.log('');
        } else {
          for (let i = 0; i < commits.length; i++) {
            const commit = commits[i];
            if (i === 0 && currentBranch) {
              commit.branch = currentBranch;
            }
            console.log(formatCommit(commit));
          }
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/merge.js
// ===========================================================================
import { merge } from '../core/merge.js';
import { getLogitDir } from '../core/repository.js';
import { success, warn, error } from '../utils/display.js';

export function registerMerge(program) {
  program
    .command('merge')
    .description('Merge a branch into the current branch')
    .argument('<branch>', 'Branch to merge')
    .action(async (branch) => {
      try {
        const logitDir = await getLogitDir();
        const result = await merge(logitDir, branch);

        switch (result.type) {
          case 'up-to-date':
            success(result.message);
            break;
          case 'fast-forward':
            success(result.message);
            break;
          case 'merge':
            success(result.message);
            break;
          case 'conflict':
            warn(result.message);
            break;
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/pull.js
// ===========================================================================
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
import { success, info, error } from '../utils/display.js';
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

        if (remoteHeadHash && remoteHeadHash !== localHeadHash) {
          for (const [refName, hash] of Object.entries(remoteRefs)) {
            const refPath = path.join(logitDir, refName);
            const refDir = path.dirname(refPath);
            await fs.mkdir(refDir, { recursive: true });
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
        } else {
          success('Already up to date.');
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/push.js
// ===========================================================================
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


// ===========================================================================
// src/commands/remote.js
// ===========================================================================
import path from 'path';
import fs from 'fs/promises';
import { getLogitDir } from '../core/repository.js';
import { success, error, info } from '../utils/display.js';
import chalk from 'chalk';

/**
 * Helper — read remotes file.
 */
async function readRemotes(logitDir) {
  const remotesPath = path.join(logitDir, 'remotes');
  try {
    const content = await fs.readFile(remotesPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeRemotes(logitDir, remotes) {
  const remotesPath = path.join(logitDir, 'remotes');
  await fs.writeFile(remotesPath, JSON.stringify(remotes, null, 2));
}

export function registerRemote(program) {
  const remote = program
    .command('remote')
    .description('Manage remote server connections');

  // ── add ──────────────────────────────────────────────────────────────────
  remote
    .command('add')
    .description('Add a new remote')
    .argument('<name>', 'Remote name (e.g., origin)')
    .argument('<url>', 'Server URL (e.g., http://192.168.1.10:5000)')
    .action(async (name, url) => {
      try {
        const logitDir = await getLogitDir();
        const remotes = await readRemotes(logitDir);

        if (remotes[name]) {
          throw new Error(`Remote '${name}' already exists. Use 'logit remote remove ${name}' first.`);
        }

        const cleanUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        remotes[name] = cleanUrl;

        await writeRemotes(logitDir, remotes);
        success(`Added remote '${name}' → ${cleanUrl}`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

  // ── remove ────────────────────────────────────────────────────────────────
  remote
    .command('remove')
    .description('Remove a remote')
    .argument('<name>', 'Remote name to remove')
    .action(async (name) => {
      try {
        const logitDir = await getLogitDir();
        const remotes = await readRemotes(logitDir);

        if (!remotes[name]) throw new Error(`Remote '${name}' not found.`);

        delete remotes[name];
        await writeRemotes(logitDir, remotes);
        success(`Removed remote '${name}'.`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

  // ── list ──────────────────────────────────────────────────────────────────
  remote
    .command('list')
    .description('List all configured remotes')
    .action(async () => {
      try {
        const logitDir = await getLogitDir();
        const remotes = await readRemotes(logitDir);
        const entries = Object.entries(remotes);

        if (entries.length === 0) {
          info('No remotes configured.');
          return;
        }

        console.log(chalk.bold('\nRemotes:\n'));
        for (const [name, entry] of entries) {
          const url = typeof entry === 'string' ? entry : entry.url;
          console.log(`  ${chalk.cyan(name.padEnd(16))} ${chalk.yellow(url)}`);
        }
        console.log('');
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

}


// ===========================================================================
// src/commands/reset.js
// ===========================================================================
import path from 'path';
import fs from 'fs/promises';
import { getLogitDir, getRepoRoot } from '../core/repository.js';
import { resolveHead, updateHead, getCurrentBranch } from '../core/refs.js';
import { readCommit } from '../core/commit.js';
import { readTree } from '../core/tree.js';
import { readObject } from '../core/objects.js';
import { getIndex, clearIndex } from '../core/index.js';
import { ensureDir } from '../utils/fs.js';
import { success, info, error } from '../utils/display.js';
import chalk from 'chalk';

export function registerReset(program) {
  program
    .command('reset')
    .description('Undo the last commit or unstage files')
    .argument('[files...]', 'Files to unstage (leave empty to undo last commit)')
    .option('--soft', 'Undo last commit but keep changes staged')
    .option('--hard', 'Undo last commit AND discard all working directory changes')
    .option('--head', 'Reset to HEAD (unstage all staged changes)')
    .action(async (files, options) => {
      try {
        const logitDir = await getLogitDir();
        const repoRoot = await getRepoRoot();

        // ── Unstage specific files ────────────────────────────────────────
        if (files && files.length > 0) {
          const indexPath = path.join(logitDir, 'index');
          const index = JSON.parse(await fs.readFile(indexPath, 'utf-8'));

          let unstaged = 0;
          for (const file of files) {
            const normalized = file.replace(/\\/g, '/');
            if (index.entries[normalized]) {
              delete index.entries[normalized];
              unstaged++;
              info(`Unstaged: ${chalk.yellow(normalized)}`);
            } else {
              info(`Not staged: ${chalk.gray(normalized)}`);
            }
          }
          await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
          if (unstaged > 0) success(`Unstaged ${unstaged} file(s).`);
          return;
        }

        // ── Reset HEAD (unstage everything) ───────────────────────────────
        if (options.head) {
          await clearIndex(logitDir);
          success('Unstaged all changes (index cleared to match HEAD).');
          return;
        }

        // ── Undo last commit (--soft or --hard) ───────────────────────────
        const headHash = await resolveHead(logitDir);
        if (!headHash) {
          throw new Error('No commits to reset. The repository has no history.');
        }

        const headCommit = await readCommit(logitDir, headHash);
        const parentHash = headCommit.parent;

        if (!parentHash) {
          throw new Error(
            'Cannot reset: this is the very first commit. ' +
            'Use "logit reset --head" to just unstage files.'
          );
        }

        // Move HEAD back to parent
        await updateHead(logitDir, parentHash);
        info(`HEAD moved back to ${chalk.yellow(parentHash.substring(0, 7))}`);

        if (options.hard) {
          // Restore working directory to the parent commit's tree
          const parentCommit = await readCommit(logitDir, parentHash);
          const treeEntries = await readTree(logitDir, parentCommit.tree);

          for (const entry of treeEntries) {
            const obj = await readObject(logitDir, entry.hash);
            const filePath = path.join(repoRoot, entry.name);
            await ensureDir(path.dirname(filePath));
            await fs.writeFile(filePath, obj.content);
          }

          // Clear index too
          await clearIndex(logitDir);
          success(
            `Hard reset to ${chalk.yellow(parentHash.substring(0, 7))}: ` +
            chalk.gray('working directory and staging area restored.')
          );
        } else {
          // --soft (default): keep changes staged
          // Re-stage the files from the undone commit so they appear staged
          const undoneTree = await readTree(logitDir, headCommit.tree);
          const indexPath = path.join(logitDir, 'index');
          const index = JSON.parse(await fs.readFile(indexPath, 'utf-8'));

          for (const entry of undoneTree) {
            index.entries[entry.name] = { hash: entry.hash };
          }
          await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

          success(
            `Soft reset to ${chalk.yellow(parentHash.substring(0, 7))}: ` +
            chalk.gray(`changes from the undone commit are now staged.`)
          );
          info(`Tip: use ${chalk.cyan('logit status')} to see what is staged.`);
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/serve.js
// ===========================================================================
import { createServer } from '../server/server.js';
import { getLogitDir, getRepoRoot } from '../core/repository.js';
import { installSampleHooks } from '../core/hooks.js';
import { success, info, error } from '../utils/display.js';
import chalk from 'chalk';
import os from 'os';

export function registerServe(program) {
  program
    .command('serve')
    .description('Start a server to share this repository on the local network')
    .option('-p, --port <port>', 'Port to listen on', '5000')
    .option('--no-mdns', 'Disable mDNS/Bonjour advertisement')
    .action(async (options) => {
      try {
        const logitDir = await getLogitDir();
        const repoRoot = await getRepoRoot();
        const port = parseInt(options.port, 10);

        const app = createServer(logitDir, repoRoot);

        app.listen(port, '0.0.0.0', async () => {
          const repoName = repoRoot.split(/[\\/]/).pop();

          console.log('');
          console.log(
            chalk.bold.hex('#7C3AED')('  ◆ Logit Server') +
            chalk.gray(` — ${repoName}`)
          );
          console.log(chalk.gray('  ─────────────────────────────────────'));

          console.log(`  ${chalk.gray('○')}  Mode: ${chalk.white('open')} — anyone on the network can clone & push`);

          console.log('');
          console.log(`  ${chalk.bold('Web UI')}      ${chalk.cyan(`http://localhost:${port}`)}`);
          console.log(`  ${chalk.bold('Repository')} ${repoRoot}`);
          console.log('');
          console.log(chalk.bold('  Clone commands:'));

          // Show all network interfaces
          const interfaces = os.networkInterfaces();
          for (const [, addrs] of Object.entries(interfaces)) {
            for (const addr of addrs) {
              if (addr.family === 'IPv4' && !addr.internal) {
                console.log(chalk.gray(`    logit clone http://${addr.address}:${port}`));
              }
            }
          }
          console.log(chalk.gray(`    logit clone http://localhost:${port}`));
          console.log('');

          // Ensure sample hooks exist
          const installed = await installSampleHooks(logitDir);
          if (installed.length > 0) {
            info(`Installed sample hooks: ${installed.join(', ')}`);
          }

          // mDNS advertisement
          if (options.mdns !== false) {
            try {
              const { default: mdns } = await import('multicast-dns');
              const mdnsInstance = mdns();

              mdnsInstance.on('query', (query) => {
                const questions = query.questions || [];
                const isOurs = questions.some(
                  (q) => q.name === '_logit._tcp.local' && (q.type === 'PTR' || q.type === 'ANY')
                );
                if (!isOurs) return;

                const instanceName = `${repoName}._logit._tcp.local`;
                const hostname = `${os.hostname().replace(/\.$/, '')}.local`;

                mdnsInstance.respond({
                  answers: [
                    { name: '_logit._tcp.local', type: 'PTR', data: instanceName },
                    {
                      name: instanceName,
                      type: 'SRV',
                      data: { port, target: hostname, priority: 0, weight: 0 }
                    },
                    { name: instanceName, type: 'TXT', data: [`repo=${repoName}`, `v=1`] }
                  ],
                  additionals: (() => {
                    const ips = [];
                    for (const [, addrs] of Object.entries(os.networkInterfaces())) {
                      for (const addr of addrs) {
                        if (addr.family === 'IPv4' && !addr.internal) {
                          ips.push({ name: hostname, type: 'A', data: addr.address, ttl: 30 });
                        }
                      }
                    }
                    return ips;
                  })()
                });
              });

              process.on('SIGINT', () => {
                mdnsInstance.destroy();
                process.exit(0);
              });
              process.on('SIGTERM', () => {
                mdnsInstance.destroy();
                process.exit(0);
              });

              info('mDNS advertisement active — discoverable via  logit discover');
            } catch (e) {
              // mDNS optional — don't crash if it fails
              info(`mDNS unavailable: ${e.message}`);
            }
          }

          info('Press Ctrl+C to stop the server.');
        });
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/stash.js
// ===========================================================================
import { stashPush, stashPop, stashList, stashDrop } from '../core/stash.js';
import { getLogitDir, getRepoRoot } from '../core/repository.js';
import { success, error, info } from '../utils/display.js';
import chalk from 'chalk';

export function registerStash(program) {
  const stash = program
    .command('stash')
    .description('Stash uncommitted changes and restore them later')
    .option('-m, --message <msg>', 'Custom stash message')
    .action(async (options) => {
      // Default: push (save) current changes
      try {
        const logitDir = await getLogitDir();
        const repoRoot = await getRepoRoot();
        const msg = await stashPush(logitDir, repoRoot, options.message);
        success(`Saved working directory state: "${msg}"`);
        info('Use  logit stash pop  to restore.');
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

  stash
    .command('pop')
    .description('Restore the most recently stashed changes')
    .action(async () => {
      try {
        const logitDir = await getLogitDir();
        const repoRoot = await getRepoRoot();
        const entry = await stashPop(logitDir, repoRoot);
        success(`Restored stash: "${entry.message}"`);

        const stagedFiles = Object.entries(entry.files)
          .filter(([, v]) => v.staged)
          .map(([k]) => k);
        const wtFiles = Object.entries(entry.files)
          .filter(([, v]) => !v.staged)
          .map(([k]) => k);

        if (stagedFiles.length > 0) {
          console.log(chalk.green('\nRestored to index (staged):'));
          stagedFiles.forEach((f) => console.log(`  ${chalk.green('+')} ${f}`));
        }
        if (wtFiles.length > 0) {
          console.log(chalk.yellow('\nRestored to working tree:'));
          wtFiles.forEach((f) => console.log(`  ${chalk.yellow('~')} ${f}`));
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

  stash
    .command('list')
    .description('Show all stashed entries')
    .action(async () => {
      try {
        const logitDir = await getLogitDir();
        const entries = await stashList(logitDir);
        if (entries.length === 0) {
          info('No stash entries.');
          return;
        }
        entries.forEach((entry, i) => {
          const date = new Date(entry.timestamp).toLocaleString();
          console.log(
            `${chalk.yellow(`stash@{${i}}`)}  ${chalk.gray(date)}  ${entry.message}`
          );
        });
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

  stash
    .command('drop [index]')
    .description('Remove a stash entry (default: newest)')
    .action(async (indexStr) => {
      try {
        const logitDir = await getLogitDir();
        const idx = indexStr !== undefined ? parseInt(indexStr, 10) : 0;
        const dropped = await stashDrop(logitDir, idx);
        success(`Dropped stash@{${idx}}: "${dropped.message}"`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/status.js
// ===========================================================================
import { getStatus } from '../core/status.js';
import { getCurrentBranch } from '../core/refs.js';
import { getLogitDir } from '../core/repository.js';
import { formatStatus, heading, info, error } from '../utils/display.js';

export function registerStatus(program) {
  program
    .command('status')
    .description('Show the working tree status')
    .action(async () => {
      try {
        const logitDir = await getLogitDir();
        const branch = await getCurrentBranch(logitDir);

        if (branch) {
          heading(`On branch ${branch}`);
        } else {
          heading('HEAD detached');
        }

        console.log('');
        const status = await getStatus();
        console.log(formatStatus(status.staged, status.modified, status.untracked));

        if (status.deleted.length > 0) {
          console.log('Deleted files:');
          for (const file of status.deleted) {
            info(`  deleted: ${file}`);
          }
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/switch.js
// ===========================================================================
import { checkout } from '../core/checkout.js';
import { getLogitDir } from '../core/repository.js';
import { success, error } from '../utils/display.js';

export function registerSwitch(program) {
  program
    .command('switch')
    .description('Switch to a different branch')
    .argument('<branch>', 'Branch name to switch to')
    .action(async (branch) => {
      try {
        const logitDir = await getLogitDir();
        const result = await checkout(logitDir, branch);

        if (result.isBranch) {
          success(`Switched to branch '${result.target}'`);
        } else {
          error(`'${branch}' is not a branch name. Use 'logit checkout' for commit hashes.`);
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/commands/sync.js
// ===========================================================================
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
import { success, info, error } from '../utils/display.js';

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

  if (remoteHeadHash && remoteHeadHash !== localHeadHash) {
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

    success(`    Pulled to ${remoteHeadHash.substring(0, 7)} — ${toFetch.length} new object(s).`);
    return true;
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
              const urlLabel  = chalk.yellow(peer.url);
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


// ===========================================================================
// src/commands/tag.js
// ===========================================================================
import { createTag, listTags, deleteTag } from '../core/tags.js';
import { getLogitDir } from '../core/repository.js';
import { resolveHead } from '../core/refs.js';
import { readCommit } from '../core/commit.js';
import { success, error, info } from '../utils/display.js';
import chalk from 'chalk';

export function registerTag(program) {
  program
    .command('tag [name]')
    .description('Create, list, or delete tags')
    .option('-d, --delete <name>', 'Delete a tag')
    .option('-c, --commit <hash>', 'Tag a specific commit instead of HEAD')
    .action(async (name, options) => {
      try {
        const logitDir = await getLogitDir();

        // Delete mode
        if (options.delete) {
          await deleteTag(logitDir, options.delete);
          success(`Deleted tag '${options.delete}'.`);
          return;
        }

        // List mode (no name given)
        if (!name) {
          const tags = await listTags(logitDir);
          if (tags.length === 0) {
            info('No tags found. Create one with:  logit tag <name>');
            return;
          }
          console.log(chalk.bold('\nTags:\n'));
          for (const tag of tags) {
            let commitInfo = '';
            try {
              const commit = await readCommit(logitDir, tag.hash);
              const date = new Date(commit.timestamp).toLocaleDateString();
              commitInfo = chalk.gray(` → ${tag.hash.substring(0, 7)}  ${commit.message}  (${date})`);
            } catch { /* ignore */ }
            console.log(`  ${chalk.yellow('⬡')} ${chalk.bold.cyan(tag.name)}${commitInfo}`);
          }
          console.log('');
          return;
        }

        // Create mode
        let commitHash = options.commit;
        if (!commitHash) {
          commitHash = await resolveHead(logitDir);
          if (!commitHash) {
            throw new Error('Cannot tag: no commits yet.');
          }
        }

        const tag = await createTag(logitDir, name, commitHash);
        success(`Created tag '${tag.name}' → ${tag.hash.substring(0, 7)}`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}


// ===========================================================================
// src/core/checkout.js
// ===========================================================================
import path from 'path';
import fs from 'fs/promises';
import { readObject } from './objects.js';
import { readTree } from './tree.js';
import { readCommit } from './commit.js';
import { setHeadDetached, setHeadBranch, getBranchCommit } from './refs.js';
import { getRepoRoot } from './repository.js';
import { ensureDir, getAllFiles } from '../utils/fs.js';

/**
 * Checkout a commit or branch — restore the working directory to match that snapshot.
 */
export async function checkout(logitDir, target) {
  const root = await getRepoRoot();

  // Determine if target is a branch name or a commit hash
  const branchCommit = await getBranchCommit(logitDir, target);
  let commitHash;
  let isBranch = false;

  if (branchCommit) {
    commitHash = branchCommit;
    isBranch = true;
  } else {
    commitHash = target;
  }

  // Read the commit
  const commit = await readCommit(logitDir, commitHash);

  // Read the tree
  const treeEntries = await readTree(logitDir, commit.tree);

  // Get current working directory files (to remove files not in the target commit)
  const currentFiles = await getAllFiles(root);

  // Remove files not in the target tree
  const targetFiles = new Set(treeEntries.map(e => e.name));
  for (const file of currentFiles) {
    if (!targetFiles.has(file)) {
      const filePath = path.join(root, file);
      try {
        await fs.unlink(filePath);
      } catch {
        // File might already be gone
      }
    }
  }

  // Restore files from the tree
  for (const entry of treeEntries) {
    const obj = await readObject(logitDir, entry.hash);
    const filePath = path.join(root, entry.name);
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, obj.content);
  }

  // Update HEAD
  if (isBranch) {
    await setHeadBranch(logitDir, target);
  } else {
    await setHeadDetached(logitDir, commitHash);
  }

  return { commitHash, isBranch, target, filesRestored: treeEntries.length };
}


// ===========================================================================
// src/core/commit.js
// ===========================================================================
import { writeObject, readObject } from './objects.js';
import { createTree } from './tree.js';
import { getIndex, clearIndex } from './index.js';
import { resolveHead, updateHead } from './refs.js';
import { getConfig } from './repository.js';
import { runHook } from './hooks.js';

/**
 * Create a new commit from the current staging index.
 */
export async function createCommit(logitDir, message, authorOverride = null) {
  const index = await getIndex(logitDir);

  if (Object.keys(index.entries).length === 0) {
    throw new Error('Nothing to commit. Use "logit add" to stage files.');
  }

  // Run pre-commit hook — non-zero exit aborts the commit
  await runHook(logitDir, 'pre-commit');

  // Create tree from index
  const treeHash = await createTree(logitDir, index.entries);

  // Get parent commit (current HEAD)
  const parentHash = await resolveHead(logitDir);

  // Get author info from config
  const config = await getConfig(logitDir);

  // Build commit object
  const commitData = {
    tree: treeHash,
    parent: parentHash,
    author: authorOverride || `${config.user.name} <${config.user.email}>`,  // --author flag or config
    timestamp: Date.now(),
    message: message
  };

  const commitContent = JSON.stringify(commitData);
  const commitHash = await writeObject(logitDir, commitContent, 'commit');

  // Update HEAD to new commit
  await updateHead(logitDir, commitHash);

  // Clear the staging area
  await clearIndex(logitDir);

  return {
    hash: commitHash,
    ...commitData
  };
}

/**
 * Read a commit object.
 */
export async function readCommit(logitDir, hash) {
  const obj = await readObject(logitDir, hash);

  if (obj.type !== 'commit') {
    throw new Error(`Object ${hash} is not a commit (got ${obj.type})`);
  }

  const data = JSON.parse(obj.content.toString());
  return {
    hash,
    ...data
  };
}

/**
 * Walk the commit history starting from a given hash.
 * Returns an array of commit objects in reverse chronological order.
 */
export async function getCommitLog(logitDir, startHash, maxCount = 50) {
  const commits = [];
  let currentHash = startHash;

  while (currentHash && commits.length < maxCount) {
    try {
      const commit = await readCommit(logitDir, currentHash);
      commits.push(commit);
      currentHash = commit.parent;
    } catch {
      break;
    }
  }

  return commits;
}

/**
 * Get all commits reachable from a given hash (for push/pull).
 */
export async function getAllCommits(logitDir, startHash) {
  return getCommitLog(logitDir, startHash, Infinity);
}


// ===========================================================================
// src/core/diff.js
// ===========================================================================
import path from 'path';
import { createRequire } from 'module';
import { getRepoRoot, getLogitDir } from './repository.js';
import { getIndex } from './index.js';
import { resolveHead } from './refs.js';
import { readCommit } from './commit.js';
import { readTree } from './tree.js';
import { readObject, hashObject } from './objects.js';
import { readFileContent } from '../utils/fs.js';

const require = createRequire(import.meta.url);
const Diff = require('diff');

/**
 * Show diff of working directory changes vs. the last commit.
 */
export async function getDiff(filePaths = []) {
  const root = await getRepoRoot();
  const logitDir = path.join(root, '.logit');
  const headHash = await resolveHead(logitDir);

  // Get the last commit's tree
  let committedFiles = {};
  if (headHash) {
    const commit = await readCommit(logitDir, headHash);
    const treeEntries = await readTree(logitDir, commit.tree);
    for (const entry of treeEntries) {
      committedFiles[entry.name] = entry.hash;
    }
  }

  // Get index entries
  const index = await getIndex(logitDir);

  // Determine which files to diff
  let filesToDiff;
  if (filePaths.length > 0) {
    filesToDiff = filePaths.map(f => f.replace(/\\/g, '/'));
  } else {
    // Diff all tracked files
    filesToDiff = [...new Set([
      ...Object.keys(committedFiles),
      ...Object.keys(index.entries)
    ])];
  }

  const diffs = [];

  for (const file of filesToDiff) {
    // Get the "old" content (from last commit)
    let oldContent = '';
    if (committedFiles[file]) {
      try {
        const obj = await readObject(logitDir, committedFiles[file]);
        oldContent = obj.content.toString();
      } catch {
        oldContent = '';
      }
    }

    // Get the "new" content (from working directory)
    let newContent = '';
    try {
      const content = await readFileContent(path.join(root, file));
      newContent = content.toString();
    } catch {
      newContent = '';
    }

    if (oldContent === newContent) {
      continue; // No changes
    }

    const patch = Diff.createPatch(file, oldContent, newContent, 'committed', 'working');
    diffs.push({ file, patch });
  }

  return diffs;
}


// ===========================================================================
// src/core/hooks.js
// ===========================================================================
import path from 'path';
import fs from 'fs/promises';
import { spawn, execSync } from 'child_process';
import { fileExists } from '../utils/fs.js';
import { warn } from '../utils/display.js';

const HOOKS_DIR = 'hooks';

/**
 * Run a hook script if it exists.
 * @param {string} logitDir - Path to .logit directory
 * @param {string} hookName - e.g. 'pre-commit', 'pre-push'
 * @param {string[]} args   - Arguments to pass to the hook script
 * @returns {Promise<{ ran: boolean, exitCode: number }>}
 * @throws Error if hook exits with non-zero (includes stdout/stderr in message)
 */
export async function runHook(logitDir, hookName, args = []) {
  const hookPath = path.join(logitDir, HOOKS_DIR, hookName);

  if (!(await fileExists(hookPath))) {
    return { ran: false, exitCode: 0 };
  }

  // Ensure the hook is executable on Unix systems
  try {
    await fs.chmod(hookPath, 0o755);
  } catch { /* ignore on Windows */ }

  const isWindows = process.platform === 'win32';
  const ext = path.extname(hookPath).toLowerCase();
  let isShellScript = false;
  let isNodeScript = ext === '.js' || ext === '.mjs' || ext === '.cjs';

  if (!isNodeScript) {
    try {
      const content = await fs.readFile(hookPath, 'utf-8');
      if (content.startsWith('#!/bin/sh') || content.startsWith('#!/bin/bash')) {
        isShellScript = true;
      } else if (content.startsWith('#!') && content.includes('node')) {
        isNodeScript = true;
      }
    } catch {
      // Ignore read errors
    }
  }

  return new Promise((resolve, reject) => {
    let proc;
    const spawnOptions = {
      cwd: path.dirname(logitDir),
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env }
    };

    if (isNodeScript) {
      proc = spawn(process.execPath, [hookPath, ...args], spawnOptions);
    } else if (isWindows) {
      if (isShellScript) {
        // Try to find 'sh' or 'bash' on Windows
        let shellCmd = 'sh';
        try {
          execSync('where sh', { stdio: 'ignore' });
        } catch {
          try {
            execSync('where bash', { stdio: 'ignore' });
            shellCmd = 'bash';
          } catch {
            shellCmd = null;
          }
        }

        if (shellCmd) {
          proc = spawn(shellCmd, [hookPath, ...args], { ...spawnOptions, shell: true });
        } else {
          warn(`Hook '${hookName}' is a shell script but 'sh' or 'bash' was not found. Skipping hook.`);
          return resolve({ ran: false, exitCode: 0 });
        }
      } else {
        // For other files (e.g. .bat, .exe, or no shebang), use cmd /c with extra quoting trick
        const command = `"${hookPath}" ${args.join(' ')}`.trim();
        proc = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
          ...spawnOptions,
          windowsVerbatimArguments: true
        });
      }
    } else {
      proc = spawn(hookPath, args, {
        cwd: path.dirname(logitDir),
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env }
      });
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    proc.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });

    proc.on('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(
          new Error(
            `Hook '${hookName}' exited with code ${exitCode}. Aborting.\n` +
            (stderr ? stderr.trim() : stdout.trim())
          )
        );
      } else {
        resolve({ ran: true, exitCode: 0 });
      }
    });

    proc.on('error', (err) => {
      // If the script can't be executed, warn but don't block
      reject(new Error(`Failed to run hook '${hookName}': ${err.message}`));
    });
  });
}

/**
 * Install sample hook scripts in .logit/hooks/.
 */
export async function installSampleHooks(logitDir) {
  const hooksDir = path.join(logitDir, HOOKS_DIR);
  await fs.mkdir(hooksDir, { recursive: true });

  const samples = {
    'pre-commit': [
      '#!/usr/bin/env node',
      '// pre-commit hook — runs before every commit.',
      '// Exit with non-zero to abort the commit.',
      '// To use a shell script, rename this or start with #!/bin/sh',
      '',
      '// Example: reject commits with TODO in staged files',
      '/*',
      'const { execSync } = require("child_process");',
      'try {',
      '  const output = execSync("logit status").toString();',
      '  if (output.includes("TODO")) {',
      '    console.error("Error: Fix TODOs first!");',
      '    process.exit(1);',
      '  }',
      '} catch (e) {}',
      '*/',
      '',
      'process.exit(0);',
    ].join('\n'),

    'pre-push': [
      '#!/usr/bin/env node',
      '// pre-push hook — runs before pushing to a remote.',
      '// Exit with non-zero to abort the push.',
      '',
      '// Example: run tests before pushing',
      '/*',
      'const { execSync } = require("child_process");',
      'try {',
      '  execSync("npm test", { stdio: "inherit" });',
      '} catch (e) {',
      '  process.exit(1);',
      '}',
      '*/',
      '',
      'process.exit(0);',
    ].join('\n'),
  };

  const installed = [];
  for (const [name, content] of Object.entries(samples)) {
    const hookPath = path.join(hooksDir, name);
    if (!(await fileExists(hookPath))) {
      await fs.writeFile(hookPath, content);
      try { await fs.chmod(hookPath, 0o755); } catch { /* Windows */ }
      installed.push(name);
    }
  }
  return installed;
}

/**
 * List existing hooks.
 */
export async function listHooks(logitDir) {
  const hooksDir = path.join(logitDir, HOOKS_DIR);
  try {
    return await fs.readdir(hooksDir);
  } catch {
    return [];
  }
}


// ===========================================================================
// src/core/index.js
// ===========================================================================
import path from 'path';
import fs from 'fs/promises';
import { getLogitDir, getRepoRoot } from './repository.js';
import { hashObject, writeObject } from './objects.js';
import { readFileContent } from '../utils/fs.js';

/**
 * Read the staging index from .logit/index.
 */
export async function getIndex(logitDir) {
  const indexPath = path.join(logitDir, 'index');
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { entries: {} };
  }
}

/**
 * Write the staging index to .logit/index.
 */
export async function writeIndex(logitDir, index) {
  const indexPath = path.join(logitDir, 'index');
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Add files to the staging area.
 * @param {string[]} filePaths - paths relative to repo root
 */
export async function addFiles(filePaths) {
  const root = await getRepoRoot();
  const logitDir = path.join(root, '.logit');
  const index = await getIndex(logitDir);
  const added = [];

  for (const filePath of filePaths) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const absolutePath = path.join(root, normalizedPath);

    try {
      const content = await readFileContent(absolutePath);
      const hash = await writeObject(logitDir, content, 'blob');

      index.entries[normalizedPath] = {
        hash,
        size: content.length,
        timestamp: Date.now()
      };

      added.push(normalizedPath);
    } catch (err) {
      throw new Error(`Cannot add '${normalizedPath}': ${err.message}`);
    }
  }

  await writeIndex(logitDir, index);
  return added;
}

/**
 * Clear the staging area after a commit.
 */
export async function clearIndex(logitDir) {
  await writeIndex(logitDir, { entries: {} });
}


// ===========================================================================
// src/core/merge.js
// ===========================================================================
import path from 'path';
import fs from 'fs/promises';
import { readCommit, getCommitLog } from './commit.js';
import { readTree } from './tree.js';
import { readObject, writeObject } from './objects.js';
import { resolveHead, getCurrentBranch, updateHead, getBranchCommit } from './refs.js';
import { getRepoRoot } from './repository.js';
import { ensureDir } from '../utils/fs.js';

/**
 * Merge a branch into the current branch.
 * Supports fast-forward merge and three-way merge with conflict detection.
 */
export async function merge(logitDir, branchName) {
  const root = await getRepoRoot();
  const currentBranch = await getCurrentBranch(logitDir);

  if (!currentBranch) {
    throw new Error('Cannot merge in detached HEAD state. Switch to a branch first.');
  }

  if (currentBranch === branchName) {
    throw new Error(`Cannot merge branch '${branchName}' into itself.`);
  }

  const currentHash = await resolveHead(logitDir);
  const targetHash = await getBranchCommit(logitDir, branchName);

  if (!targetHash) {
    throw new Error(`Branch '${branchName}' not found.`);
  }

  if (currentHash === targetHash) {
    return { type: 'up-to-date', message: 'Already up to date.' };
  }

  // Check if we can fast-forward
  const canFF = await isAncestor(logitDir, currentHash, targetHash);
  if (canFF) {
    // Fast-forward merge
    await updateHead(logitDir, targetHash);

    // Update working directory
    const commit = await readCommit(logitDir, targetHash);
    const treeEntries = await readTree(logitDir, commit.tree);

    for (const entry of treeEntries) {
      const obj = await readObject(logitDir, entry.hash);
      const filePath = path.join(root, entry.name);
      await ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, obj.content);
    }

    return {
      type: 'fast-forward',
      message: `Fast-forward merge to ${targetHash.substring(0, 7)}`,
      commitHash: targetHash
    };
  }

  // Three-way merge
  const mergeBase = await findMergeBase(logitDir, currentHash, targetHash);
  if (!mergeBase) {
    throw new Error('Cannot find merge base. Repositories may have unrelated histories.');
  }

  // Get trees for base, current, and target
  const baseCommit = await readCommit(logitDir, mergeBase);
  const currentCommit = await readCommit(logitDir, currentHash);
  const targetCommit = await readCommit(logitDir, targetHash);

  const baseTree = await getTreeMap(logitDir, baseCommit.tree);
  const currentTree = await getTreeMap(logitDir, currentCommit.tree);
  const targetTree = await getTreeMap(logitDir, targetCommit.tree);

  // Perform merge
  const allFiles = new Set([
    ...Object.keys(baseTree),
    ...Object.keys(currentTree),
    ...Object.keys(targetTree)
  ]);

  const conflicts = [];
  const mergedEntries = {};

  for (const file of allFiles) {
    const baseHash = baseTree[file] || null;
    const currentFileHash = currentTree[file] || null;
    const targetFileHash = targetTree[file] || null;

    if (currentFileHash === targetFileHash) {
      // No conflict — same change or no change
      if (currentFileHash) {
        mergedEntries[file] = currentFileHash;
      }
    } else if (currentFileHash === baseHash) {
      // Only target changed
      if (targetFileHash) {
        mergedEntries[file] = targetFileHash;
      }
    } else if (targetFileHash === baseHash) {
      // Only current changed
      if (currentFileHash) {
        mergedEntries[file] = currentFileHash;
      }
    } else {
      // Both changed — conflict
      conflicts.push(file);

      // Write conflict markers
      const currentContent = currentFileHash
        ? (await readObject(logitDir, currentFileHash)).content.toString()
        : '';
      const targetContent = targetFileHash
        ? (await readObject(logitDir, targetFileHash)).content.toString()
        : '';

      const conflictContent =
        `<<<<<<< ${currentBranch}\n` +
        currentContent +
        (currentContent.endsWith('\n') ? '' : '\n') +
        `=======\n` +
        targetContent +
        (targetContent.endsWith('\n') ? '' : '\n') +
        `>>>>>>> ${branchName}\n`;

      const conflictHash = await writeObject(logitDir, conflictContent, 'blob');
      mergedEntries[file] = conflictHash;
    }
  }

  // Write merged files to working directory
  for (const [file, hash] of Object.entries(mergedEntries)) {
    const obj = await readObject(logitDir, hash);
    const filePath = path.join(root, file);
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, obj.content);
  }

  if (conflicts.length > 0) {
    return {
      type: 'conflict',
      message: `Merge conflicts in: ${conflicts.join(', ')}. Resolve conflicts and commit.`,
      conflicts
    };
  }

  return {
    type: 'merge',
    message: `Merged branch '${branchName}' into '${currentBranch}'.`,
    mergedEntries
  };
}

/**
 * Check if 'ancestor' is an ancestor of 'descendant'.
 */
async function isAncestor(logitDir, ancestor, descendant) {
  if (!ancestor) return true; // null is ancestor of everything (first commit)
  const commits = await getCommitLog(logitDir, descendant, 1000);
  return commits.some(c => c.hash === ancestor);
}

/**
 * Find the merge base (common ancestor) of two commits.
 */
async function findMergeBase(logitDir, hash1, hash2) {
  const ancestors1 = new Set();
  const log1 = await getCommitLog(logitDir, hash1, 1000);
  for (const commit of log1) {
    ancestors1.add(commit.hash);
  }

  const log2 = await getCommitLog(logitDir, hash2, 1000);
  for (const commit of log2) {
    if (ancestors1.has(commit.hash)) {
      return commit.hash;
    }
  }

  return null;
}

/**
 * Get a map of filename -> blob hash from a tree.
 */
async function getTreeMap(logitDir, treeHash) {
  const entries = await readTree(logitDir, treeHash);
  const map = {};
  for (const entry of entries) {
    map[entry.name] = entry.hash;
  }
  return map;
}


// ===========================================================================
// src/core/objects.js
// ===========================================================================
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


// ===========================================================================
// src/core/packfile.js
// ===========================================================================
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


// ===========================================================================
// src/core/refs.js
// ===========================================================================
import path from 'path';
import fs from 'fs/promises';

/**
 * Resolve HEAD to a commit hash.
 * HEAD can be either a ref (e.g., "ref: refs/heads/main") or a direct hash (detached HEAD).
 */
export async function resolveHead(logitDir) {
  const headPath = path.join(logitDir, 'HEAD');
  const headContent = (await fs.readFile(headPath, 'utf-8')).trim();

  if (headContent.startsWith('ref: ')) {
    // Symbolic reference
    const refPath = path.join(logitDir, headContent.substring(5));
    try {
      return (await fs.readFile(refPath, 'utf-8')).trim();
    } catch {
      return null; // Branch exists but no commits yet
    }
  }

  // Direct hash (detached HEAD)
  return headContent || null;
}

/**
 * Get the current branch name, or null if in detached HEAD state.
 */
export async function getCurrentBranch(logitDir) {
  const headPath = path.join(logitDir, 'HEAD');
  const headContent = (await fs.readFile(headPath, 'utf-8')).trim();

  if (headContent.startsWith('ref: refs/heads/')) {
    return headContent.substring('ref: refs/heads/'.length);
  }

  return null; // Detached HEAD
}

/**
 * Update HEAD — either the branch ref it points to, or the direct hash.
 */
export async function updateHead(logitDir, commitHash) {
  const headPath = path.join(logitDir, 'HEAD');
  const headContent = (await fs.readFile(headPath, 'utf-8')).trim();

  if (headContent.startsWith('ref: ')) {
    // Update the branch ref
    const refPath = path.join(logitDir, headContent.substring(5));
    const refDir = path.dirname(refPath);
    await fs.mkdir(refDir, { recursive: true });
    await fs.writeFile(refPath, commitHash + '\n');
  } else {
    // Detached HEAD — update HEAD directly
    await fs.writeFile(headPath, commitHash + '\n');
  }
}

/**
 * Set HEAD to point to a branch.
 */
export async function setHeadBranch(logitDir, branchName) {
  const headPath = path.join(logitDir, 'HEAD');
  await fs.writeFile(headPath, `ref: refs/heads/${branchName}\n`);
}

/**
 * Set HEAD to a detached commit hash.
 */
export async function setHeadDetached(logitDir, commitHash) {
  const headPath = path.join(logitDir, 'HEAD');
  await fs.writeFile(headPath, commitHash + '\n');
}

/**
 * List all branch names.
 */
export async function listBranches(logitDir) {
  const headsDir = path.join(logitDir, 'refs', 'heads');
  try {
    const entries = await fs.readdir(headsDir);
    return entries;
  } catch {
    return [];
  }
}

/**
 * Create a new branch pointing at the given commit hash.
 */
export async function createBranch(logitDir, name, commitHash) {
  const refPath = path.join(logitDir, 'refs', 'heads', name);

  try {
    await fs.access(refPath);
    throw new Error(`Branch '${name}' already exists.`);
  } catch (err) {
    if (err.message.includes('already exists')) throw err;
  }

  await fs.writeFile(refPath, commitHash + '\n');
}

/**
 * Get the commit hash a branch points to.
 */
export async function getBranchCommit(logitDir, branchName) {
  const refPath = path.join(logitDir, 'refs', 'heads', branchName);
  try {
    return (await fs.readFile(refPath, 'utf-8')).trim();
  } catch {
    return null;
  }
}

/**
 * Delete a branch.
 */
export async function deleteBranch(logitDir, name) {
  const refPath = path.join(logitDir, 'refs', 'heads', name);
  try {
    await fs.unlink(refPath);
  } catch {
    throw new Error(`Branch '${name}' not found.`);
  }
}

/**
 * Get all refs (branches) with their commit hashes.
 */
export async function getAllRefs(logitDir) {
  const branches = await listBranches(logitDir);
  const refs = {};
  for (const branch of branches) {
    const hash = await getBranchCommit(logitDir, branch);
    if (hash) {
      refs[`refs/heads/${branch}`] = hash;
    }
  }
  return refs;
}


// ===========================================================================
// src/core/repository.js
// ===========================================================================
import path from 'path';
import fs from 'fs/promises';
import { ensureDir, fileExists } from '../utils/fs.js';

const LOGIT_DIR = '.logit';

/**
 * Initialize a new Logit repository in the given directory.
 */
export async function initRepository(dir = process.cwd()) {
  const logitPath = path.join(dir, LOGIT_DIR);

  if (await fileExists(logitPath)) {
    throw new Error(`Logit repository already exists in ${dir}`);
  }

  // Create directory structure
  await ensureDir(path.join(logitPath, 'objects'));
  await ensureDir(path.join(logitPath, 'refs', 'heads'));

  // Create HEAD pointing to main branch
  await fs.writeFile(path.join(logitPath, 'HEAD'), 'ref: refs/heads/main\n');

  // Create empty index (staging area)
  await fs.writeFile(path.join(logitPath, 'index'), JSON.stringify({ entries: {} }));

  // Create config
  const config = {
    user: {
      name: process.env.USERNAME || process.env.USER || 'Unknown',
      email: 'user@logit.local'
    }
  };
  await fs.writeFile(path.join(logitPath, 'config'), JSON.stringify(config, null, 2));

  // Create remotes file
  await fs.writeFile(path.join(logitPath, 'remotes'), JSON.stringify({}));

  return logitPath;
}

/**
 * Find the root of the Logit repository by walking up directories.
 * Returns the path to the directory containing .logit, or null.
 */
export async function findRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);

  while (true) {
    const logitPath = path.join(current, LOGIT_DIR);
    if (await fileExists(logitPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null; // Reached filesystem root
    }
    current = parent;
  }
}

/**
 * Get the .logit directory path for the repository.
 */
export async function getLogitDir(startDir = process.cwd()) {
  const root = await findRepoRoot(startDir);
  if (!root) {
    throw new Error('Not a Logit repository (or any parent directory). Run "logit init" first.');
  }
  return path.join(root, LOGIT_DIR);
}

/**
 * Get the repo root, throwing if not in a repo.
 */
export async function getRepoRoot(startDir = process.cwd()) {
  const root = await findRepoRoot(startDir);
  if (!root) {
    throw new Error('Not a Logit repository (or any parent directory). Run "logit init" first.');
  }
  return root;
}

/**
 * Read the repository config.
 */
export async function getConfig(logitDir) {
  const configPath = path.join(logitDir, 'config');
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { user: { name: 'Unknown', email: 'user@logit.local' } };
  }
}


// ===========================================================================
// src/core/stash.js
// ===========================================================================
import path from 'path';
import fs from 'fs/promises';
import { getIndex, writeIndex } from './index.js';
import { resolveHead } from './refs.js';
import { readCommit } from './commit.js';
import { readTree } from './tree.js';
import { readObject, hashObject, writeObject } from './objects.js';
import { readFileContent, fileExists } from '../utils/fs.js';

const STASH_FILE = 'stash';

/**
 * Read the stash stack from .logit/stash.
 * Returns an array of stash entries (newest first).
 */
async function readStash(logitDir) {
  const stashPath = path.join(logitDir, STASH_FILE);
  try {
    const content = await fs.readFile(stashPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * Write the stash stack to .logit/stash.
 */
async function writeStash(logitDir, entries) {
  const stashPath = path.join(logitDir, STASH_FILE);
  await fs.writeFile(stashPath, JSON.stringify(entries, null, 2));
}

/**
 * Push current changes onto the stash.
 * Saves: modified tracked files, staged index state.
 * Resets working tree and index back to HEAD.
 *
 * @returns {string} A description of what was stashed.
 */
export async function stashPush(logitDir, repoRoot, message) {
  const headHash = await resolveHead(logitDir);
  if (!headHash) {
    throw new Error('Cannot stash: no commits yet. Commit something first.');
  }

  const commit = await readCommit(logitDir, headHash);
  const treeEntries = await readTree(logitDir, commit.tree);

  // Build a map: filepath -> committed hash
  const committedFiles = {};
  for (const entry of treeEntries) {
    committedFiles[entry.name] = entry.hash;
  }

  // Current staging index
  const index = await getIndex(logitDir);

  // Collect snapshot of all modified files (index + working tree changes)
  const snapshot = {}; // filepath -> base64 file content

  // 1. Files staged but different from HEAD
  for (const [filePath, entry] of Object.entries(index.entries)) {
    snapshot[filePath] = {
      hash: entry.hash,
      staged: true
    };
  }

  // 2. Modified working-tree files vs index/head
  for (const [filePath, committedHash] of Object.entries(committedFiles)) {
    const absPath = path.join(repoRoot, filePath);
    if (!(await fileExists(absPath))) continue;
    const content = await readFileContent(absPath);
    const currentHash = hashObject(content, 'blob');
    if (currentHash !== committedHash && !snapshot[filePath]) {
      snapshot[filePath] = { hash: currentHash, staged: false };
      // Store object
      await writeObject(logitDir, content, 'blob');
    }
  }

  if (Object.keys(snapshot).length === 0) {
    throw new Error('No local changes to stash.');
  }

  // Build stash entry — store actual file contents as base64
  const fileContents = {};
  for (const [filePath, info] of Object.entries(snapshot)) {
    try {
      const obj = await readObject(logitDir, info.hash);
      fileContents[filePath] = {
        data: obj.content.toString('base64'),
        staged: info.staged
      };
    } catch {
      // Object might not exist if file was only in working tree
    }
  }

  // Save working-tree files not yet in object store
  for (const [filePath] of Object.entries(committedFiles)) {
    if (fileContents[filePath]) continue;
    const absPath = path.join(repoRoot, filePath);
    if (!(await fileExists(absPath))) continue;
    const content = await readFileContent(absPath);
    const currentHash = hashObject(content, 'blob');
    if (currentHash !== committedFiles[filePath]) {
      await writeObject(logitDir, content, 'blob');
      const obj = await readObject(logitDir, currentHash);
      fileContents[filePath] = {
        data: obj.content.toString('base64'),
        staged: false
      };
    }
  }

  const stashEntry = {
    id: Date.now(),
    message: message || `WIP on HEAD: ${headHash.substring(0, 7)}`,
    headHash,
    files: fileContents,
    timestamp: new Date().toISOString()
  };

  const stack = await readStash(logitDir);
  stack.unshift(stashEntry); // newest first
  await writeStash(logitDir, stack);

  // Reset working tree and index to HEAD
  for (const [filePath, committedHash] of Object.entries(committedFiles)) {
    const absPath = path.join(repoRoot, filePath);
    try {
      const obj = await readObject(logitDir, committedHash);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, obj.content);
    } catch { /* skip */ }
  }

  // Clear the staging index
  await writeIndex(logitDir, { entries: {} });

  return stashEntry.message;
}

/**
 * Pop the most recent stash entry and restore files.
 * @returns {object} The restored stash entry.
 */
export async function stashPop(logitDir, repoRoot) {
  const stack = await readStash(logitDir);
  if (stack.length === 0) {
    throw new Error('No stash entries found. Nothing to pop.');
  }

  const entry = stack.shift(); // Take newest
  await writeStash(logitDir, stack);

  // Restore files to working tree
  const index = await getIndex(logitDir);
  for (const [filePath, { data, staged }] of Object.entries(entry.files)) {
    const absPath = path.join(repoRoot, filePath);
    const content = Buffer.from(data, 'base64');
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);

    if (staged) {
      // Re-stage the file
      const hash = await writeObject(logitDir, content, 'blob');
      index.entries[filePath] = { hash, size: content.length, timestamp: Date.now() };
    }
  }
  await writeIndex(logitDir, index);

  return entry;
}

/**
 * List all stash entries.
 */
export async function stashList(logitDir) {
  return readStash(logitDir);
}

/**
 * Drop a specific stash entry by index (0 = newest).
 */
export async function stashDrop(logitDir, index = 0) {
  const stack = await readStash(logitDir);
  if (index < 0 || index >= stack.length) {
    throw new Error(`No stash entry at index ${index}.`);
  }
  const [dropped] = stack.splice(index, 1);
  await writeStash(logitDir, stack);
  return dropped;
}


// ===========================================================================
// src/core/status.js
// ===========================================================================
import path from 'path';
import { getRepoRoot, getLogitDir } from './repository.js';
import { getIndex } from './index.js';
import { resolveHead } from './refs.js';
import { readCommit } from './commit.js';
import { readTree } from './tree.js';
import { readObject, hashObject } from './objects.js';
import { getAllFiles, readFileContent } from '../utils/fs.js';

/**
 * Get the current status of the working directory.
 * Compares working dir vs index vs last commit.
 * 
 * Returns { staged, modified, untracked, deleted }
 */
export async function getStatus() {
  const root = await getRepoRoot();
  const logitDir = path.join(root, '.logit');
  const index = await getIndex(logitDir);
  const headHash = await resolveHead(logitDir);

  // Get last commit's tree files
  let committedFiles = {};
  if (headHash) {
    const commit = await readCommit(logitDir, headHash);
    const treeEntries = await readTree(logitDir, commit.tree);
    for (const entry of treeEntries) {
      committedFiles[entry.name] = entry.hash;
    }
  }

  // Get all working directory files
  const workingFiles = await getAllFiles(root);

  // Determine staged files (in index but different from last commit, or new)
  const staged = [];
  const stagedModified = [];
  const stagedDeleted = [];

  for (const [filePath, entry] of Object.entries(index.entries)) {
    if (!committedFiles[filePath]) {
      staged.push(filePath); // New file staged
    } else if (committedFiles[filePath] !== entry.hash) {
      stagedModified.push(filePath); // Modified file staged
    }
  }

  // Check for files committed but not in index (staged deletion)
  for (const filePath of Object.keys(committedFiles)) {
    if (!index.entries[filePath] && Object.keys(index.entries).length > 0) {
      // Only count as staged deletion if there's something in the index
    }
  }

  // Determine modified files (in working dir, different from index or last commit)
  const modified = [];
  const untracked = [];
  const deleted = [];

  // Check for tracked files (in commit or index)
  const trackedFiles = new Set([
    ...Object.keys(committedFiles),
    ...Object.keys(index.entries)
  ]);

  for (const file of workingFiles) {
    if (trackedFiles.has(file)) {
      // File is tracked — check if modified
      const content = await readFileContent(path.join(root, file));
      const currentHash = hashObject(content, 'blob');

      const referenceHash = index.entries[file]?.hash || committedFiles[file];
      if (referenceHash && currentHash !== referenceHash) {
        modified.push(file);
      }
    } else {
      // File is untracked
      untracked.push(file);
    }
  }

  // Check for deleted files (tracked but not in working dir)
  const workingSet = new Set(workingFiles);
  for (const file of trackedFiles) {
    if (!workingSet.has(file)) {
      deleted.push(file);
    }
  }

  return {
    staged: [...staged, ...stagedModified],
    modified,
    untracked,
    deleted
  };
}


// ===========================================================================
// src/core/tags.js
// ===========================================================================
import path from 'path';
import fs from 'fs/promises';
import { fileExists } from '../utils/fs.js';

/**
 * Create a lightweight tag pointing at the given commit hash.
 */
export async function createTag(logitDir, name, commitHash) {
  if (!name || !/^[\w.\-/]+$/.test(name)) {
    throw new Error(`Invalid tag name: '${name}'`);
  }

  const tagsDir = path.join(logitDir, 'refs', 'tags');
  await fs.mkdir(tagsDir, { recursive: true });

  const tagPath = path.join(tagsDir, name);
  if (await fileExists(tagPath)) {
    throw new Error(`Tag '${name}' already exists. Use -d to delete it first.`);
  }

  await fs.writeFile(tagPath, commitHash + '\n');
  return { name, hash: commitHash };
}

/**
 * List all tags with their commit hashes.
 */
export async function listTags(logitDir) {
  const tagsDir = path.join(logitDir, 'refs', 'tags');
  try {
    const entries = await fs.readdir(tagsDir, { withFileTypes: true });
    const tags = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        const tagPath = path.join(tagsDir, entry.name);
        const hash = (await fs.readFile(tagPath, 'utf-8')).trim();
        tags.push({ name: entry.name, hash });
      }
    }
    return tags.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Resolve a tag name to its commit hash.
 */
export async function resolveTag(logitDir, name) {
  const tagPath = path.join(logitDir, 'refs', 'tags', name);
  try {
    return (await fs.readFile(tagPath, 'utf-8')).trim();
  } catch {
    return null;
  }
}

/**
 * Delete a tag by name.
 */
export async function deleteTag(logitDir, name) {
  const tagPath = path.join(logitDir, 'refs', 'tags', name);
  if (!(await fileExists(tagPath))) {
    throw new Error(`Tag '${name}' not found.`);
  }
  await fs.unlink(tagPath);
}


// ===========================================================================
// src/core/tree.js
// ===========================================================================
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


// ===========================================================================
// src/server/server.js
// ===========================================================================
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { getLogitDir, getRepoRoot } from '../core/repository.js';
import { readObject, objectExists, listAllObjects, writeObject } from '../core/objects.js';
import { getAllRefs, getBranchCommit, resolveHead } from '../core/refs.js';
import { getCommitLog, readCommit } from '../core/commit.js';
import { readTree } from '../core/tree.js';
import { createPackfile, unpackPackfile } from '../core/packfile.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Diff = require('diff');



// ---------------------------------------------------------------------------
// Web Explorer UI (self-contained HTML/CSS/JS)
// ---------------------------------------------------------------------------
function buildWebUI(repoName) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${repoName} — Logit Explorer</title>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet" />
  <style>
    :root {
      --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
      --border: #30363d; --text: #e6edf3; --muted: #8b949e;
      --accent: #7c3aed; --accent2: #a78bfa; --green: #3fb950;
      --yellow: #d29922; --red: #f85149; --blue: #58a6ff;
      --orange: #f0883e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 14px; min-height: 100vh; }

    header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 16px; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(10px); }
    .logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 16px; color: var(--accent2); text-decoration: none; }
    .logo svg { width: 22px; height: 22px; }
    .repo-name { color: var(--text); font-size: 15px; font-weight: 600; }
    
    .header-actions { margin-left: auto; display: flex; gap: 12px; align-items: center; }
    select#branch-select { background: var(--bg3); color: var(--text); border: 1px solid var(--border); padding: 4px 8px; border-radius: 6px; font-size: 13px; outline: none; cursor: pointer; }

    .layout { display: grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 57px); }
    .sidebar { background: var(--bg2); border-right: 1px solid var(--border); padding: 16px; overflow-y: auto; }
    .main { padding: 24px; overflow: auto; }

    /* File Tree */
    .sidebar-section { margin-bottom: 24px; }
    .sidebar-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 8px; padding: 0 4px; }
    .file-tree, .folder-children { list-style: none; }
    .folder-children { margin-left: 14px; border-left: 1px solid var(--border); padding-left: 4px; display: none; }
    .folder-children.open { display: block; }
    .file-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 6px; cursor: pointer; transition: background .15s; font-size: 13px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .file-item:hover { background: var(--bg3); }
    .file-item.active { background: rgba(124,58,237,.2); color: var(--accent2); }
    .file-icon { flex-shrink: 0; font-size: 12px; }

    /* Commits */
    .commits-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .commits-header h2 { font-size: 16px; font-weight: 600; }
    .commit-count { background: var(--bg3); border: 1px solid var(--border); border-radius: 20px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
    .commit-search { padding: 6px 12px; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; color: var(--text); width: 200px; font-size: 13px; }

    .commit-graph { position: relative; }
    .commit-card { display: grid; grid-template-columns: 40px 1fr; gap: 0; position: relative; }
    .commit-line { display: flex; flex-direction: column; align-items: center; }
    .commit-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg2); flex-shrink: 0; margin-top: 14px; z-index: 1; position: relative; box-shadow: 0 0 0 3px rgba(124,58,237,.25); }
    .commit-connector { width: 2px; flex: 1; background: var(--border); margin-top: 0; }
    .commit-card:last-child .commit-connector { display: none; }

    .commit-body { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin: 8px 0 8px 0; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
    .commit-body:hover { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,58,237,.1); }
    .commit-msg { font-weight: 600; font-size: 14px; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .commit-meta { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    .commit-hash-wrapper { display: inline-flex; align-items: center; background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 1px 2px 1px 6px; }
    .commit-hash { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; color: var(--accent2); }
    .copy-btn { background: transparent; border: none; color: var(--muted); cursor: pointer; padding: 2px 4px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; transition: all 0.15s; margin-left: 4px; }
    .copy-btn:hover { background: var(--bg); color: var(--text); }
    .copy-btn:active { transform: scale(0.85); color: var(--accent2); }
    .copy-btn svg { width: 12px; height: 12px; }
    .commit-author { color: var(--muted); font-size: 12px; }
    .commit-date { color: var(--muted); font-size: 12px; }
    .tag-badge { background: rgba(240,136,62,.15); border: 1px solid var(--orange); color: var(--orange); border-radius: 4px; padding: 1px 6px; font-size: 11px; }

    /* Toast */
    .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px); background: var(--accent); color: white; padding: 8px 16px; border-radius: 20px; font-weight: 600; font-size: 13px; opacity: 0; pointer-events: none; transition: opacity 0.2s, transform 0.2s; z-index: 1000; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    /* Diffs */
    .commit-diff-container { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); display: none; }
    .commit-diff-container.open { display: block; }
    .diff-file { margin-bottom: 8px; }
    .diff-filename { font-size: 12px; font-family: monospace; font-weight: bold; margin-bottom: 4px; color: var(--accent2); }
    .diff-patch { background: var(--bg); padding: 8px; border-radius: 4px; font-family: monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; overflow-x: auto; }
    .diff-add { color: var(--green); }
    .diff-del { color: var(--red); }

    /* File viewer */
    .file-viewer { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .file-viewer-header { padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg3); }
    .file-path { font-family: monospace; font-size: 13px; color: var(--accent2); }
    .file-size { color: var(--muted); font-size: 12px; }
    pre { padding: 16px; overflow: auto; font-size: 13px; line-height: 1.6; max-height: 600px; margin: 0; }

    /* Stats bar */
    .stats-bar { display: flex; gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; flex: 1; display: flex; flex-direction: column; gap: 4px; transition: border-color .15s; }
    .stat-card:hover { border-color: var(--accent); }
    .stat-value { font-size: 24px; font-weight: 700; color: var(--accent2); }
    .stat-label { font-size: 12px; color: var(--muted); }

    /* Tabs */
    .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
    .tab { padding: 8px 16px; cursor: pointer; color: var(--muted); font-size: 14px; border-bottom: 2px solid transparent; transition: color .15s, border-color .15s; margin-bottom: -1px; }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--accent2); border-bottom-color: var(--accent); }

    .loading { text-align: center; padding: 48px; color: var(--muted); }
    .spinner { display: inline-block; width: 24px; height: 24px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; margin-bottom: 12px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .empty { text-align: center; padding: 48px; color: var(--muted); }
    
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>
  <header>
    <a class="logo" href="#">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
      </svg>
      Logit
    </a>
    <span class="repo-name">${repoName}</span>
    
    <div class="header-actions">
      <select id="branch-select" onchange="switchRef(this.value)">
        <option value="">Loading...</option>
      </select>
    </div>
  </header>

  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-section">
        <div class="sidebar-title">Files</div>
        <ul class="file-tree" id="file-tree">
          <li class="loading"><div class="spinner"></div></li>
        </ul>
      </div>
    </aside>

    <main class="main">
      <div class="stats-bar" id="stats-bar"></div>

      <div class="tabs">
        <div class="tab active" data-tab="commits" id="tab-commits">Commits</div>
        <div class="tab" data-tab="file" id="tab-file">File Viewer</div>
      </div>

      <div id="view-commits">
        <div class="commits-header">
          <h2>Commit History</h2>
          <div style="display:flex; gap:12px; align-items:center;">
            <input type="text" id="commit-search" class="commit-search" placeholder="Search commits..." oninput="handleSearch()" />
            <span class="commit-count" id="commit-count">—</span>
          </div>
        </div>
        <div class="commit-graph" id="commit-graph">
          <div class="loading"><div class="spinner"></div><br>Loading commits…</div>
        </div>
      </div>

      <div id="view-file" style="display:none">
        <div id="file-content-area">
          <div class="empty">← Select a file from the sidebar to view its contents.</div>
        </div>
      </div>
    </main>
  </div>

  <div id="toast" class="toast">Copied!</div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-markdown.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js"></script>

  <script>
    const API = '';
    let allCommits = [];
    let tags = {};
    let currentRef = '';

    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('view-commits').style.display = tab.dataset.tab === 'commits' ? '' : 'none';
        document.getElementById('view-file').style.display = tab.dataset.tab === 'file' ? '' : 'none';
      });
    });

    // Load info
    async function loadInfo(ref = '') {
      currentRef = ref;
      document.getElementById('commit-graph').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      document.getElementById('file-tree').innerHTML = '<li class="loading"><div class="spinner"></div></li>';

      const qs = ref ? '?ref=' + encodeURIComponent(ref) : '';

      const [infoRes, commitsRes, tagsRes, fileRes] = await Promise.all([
        fetch(API + '/info'),
        fetch(API + '/ui/commits' + qs),
        fetch(API + '/ui/tags'),
        fetch(API + '/ui/tree' + qs)
      ]);

      const info = await infoRes.json();
      allCommits = await commitsRes.json();
      tags = await tagsRes.json();
      const files = await fileRes.json();

      // Populate Branch/Tag dropdown
      const select = document.getElementById('branch-select');
      if (select.options.length <= 1) { // Only populate once
        select.innerHTML = '';
        const branchesOptGroup = document.createElement('optgroup');
        branchesOptGroup.label = "Branches";
        for (const r of Object.keys(info.refs || {})) {
          if (r.startsWith('refs/heads/')) {
            const b = r.replace('refs/heads/', '');
            const opt = new Option(b, r);
            if (!ref && info.refs[r] === info.head) opt.selected = true;
            branchesOptGroup.appendChild(opt);
          }
        }
        select.appendChild(branchesOptGroup);
        
        const tagsOptGroup = document.createElement('optgroup');
        tagsOptGroup.label = "Tags";
        for (const t of Object.keys(tags)) {
          tagsOptGroup.appendChild(new Option(t, 'refs/tags/'+t));
        }
        select.appendChild(tagsOptGroup);

        if (!ref && info.head) {
          // Default selection to whatever matches head if nothing specified
          for(const r of Object.keys(info.refs || {})) {
            if (info.refs[r] === info.head) {
               currentRef = r;
               select.value = r;
               break;
            }
          }
        }
      }

      // Stats
      const branchCount = Object.keys(info.refs || {}).length;
      const tagCount = Object.keys(tags).length;
      document.getElementById('stats-bar').innerHTML = [
        { label: 'Commits', value: allCommits.length, icon: '●' },
        { label: 'Branches', value: branchCount, icon: '⑂' },
        { label: 'Tags', value: tagCount, icon: '⬡' },
        { label: 'Files', value: files.length, icon: '◻' }
      ].map(s => \`
        <div class="stat-card">
          <div class="stat-value">\${s.value}</div>
          <div class="stat-label">\${s.label}</div>
        </div>
      \`).join('');

      renderCommits(allCommits, tags);
      renderFileTree(files);
    }

    function switchRef(newRef) {
      loadInfo(newRef);
    }

    function handleSearch() {
      const q = document.getElementById('commit-search').value.toLowerCase();
      const filtered = allCommits.filter(c => 
        (c.message && c.message.toLowerCase().includes(q)) || 
        (c.author && c.author.toLowerCase().includes(q)) || 
        (c.hash && c.hash.toLowerCase().includes(q))
      );
      renderCommits(filtered, tags);
    }

    // Commits
    function timeAgo(ts) {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.floor(hours / 24) + 'd ago';
    }

    function renderCommits(commits, tags) {
      document.getElementById('commit-count').textContent = commits.length + ' commit' + (commits.length !== 1 ? 's' : '');

      if (commits.length === 0) {
        document.getElementById('commit-graph').innerHTML = '<div class="empty">No commits found.</div>';
        return;
      }

      const tagsByHash = {};
      for (const [name, hash] of Object.entries(tags)) {
        if (!tagsByHash[hash]) tagsByHash[hash] = [];
        tagsByHash[hash].push(name);
      }

      document.getElementById('commit-graph').innerHTML = commits.map((c, i) => {
        const tagBadges = (tagsByHash[c.hash] || []).map(t => \`<span class="tag-badge">⬡ \${t}</span>\`).join(' ');
        return \`
          <div class="commit-card">
            <div class="commit-line">
              <div class="commit-dot"></div>
              \${i < commits.length - 1 ? '<div class="commit-connector"></div>' : ''}
            </div>
            <div class="commit-body" onclick="toggleCommitDiff('\${c.hash}')">
              <div class="commit-msg">\${escHtml(c.message)} \${tagBadges}</div>
              <div class="commit-meta">
                <div class="commit-hash-wrapper" onclick="event.stopPropagation()">
                  <span class="commit-hash">\${c.hash.substring(0,7)}</span>
                  <button class="copy-btn" onclick="copyHash('\${c.hash}')" title="Copy full hash">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  </button>
                </div>
                <span class="commit-author">\${escHtml(c.author)}</span>
                <span class="commit-date">\${timeAgo(c.timestamp)}</span>
              </div>
              <div id="diff-\${c.hash}" class="commit-diff-container">
                 <div class="loading"><div class="spinner"></div></div>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    function copyHash(hash) {
      navigator.clipboard?.writeText(hash);
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }

    async function toggleCommitDiff(hash) {
      const container = document.getElementById('diff-' + hash);
      if (container.classList.contains('open')) {
        container.classList.remove('open');
        return;
      }
      
      container.classList.add('open');
      if (container.dataset.loaded) return; 
      
      try {
        const res = await fetch(API + '/ui/commit/' + hash + '/diff');
        if (!res.ok) throw new Error('Failed to load diff');
        const diffs = await res.json();
        
        if (diffs.length === 0) {
          container.innerHTML = '<div style="color:var(--muted); font-size:12px;">No file changes in this commit.</div>';
        } else {
          container.innerHTML = diffs.map(d => {
            const htmlPatch = escHtml(d.patch).replace(/^(\\+.*)$/gm, '<span class="diff-add">$1</span>')
                                               .replace(/^(-.*)$/gm, '<span class="diff-del">$1</span>');
            return \`
              <div class="diff-file">
                <div class="diff-filename">\${escHtml(d.file)}</div>
                <div class="diff-patch">\${htmlPatch}</div>
              </div>
            \`;
          }).join('');
        }
        container.dataset.loaded = 'true';
      } catch (e) {
        container.innerHTML = '<div style="color:var(--red); font-size:12px;">Error loading diff</div>';
      }
    }

    // File tree
    function renderFileTree(files) {
      if (files.length === 0) {
        document.getElementById('file-tree').innerHTML = '<li style="color:var(--muted);padding:8px 4px;font-size:12px">No files</li>';
        return;
      }
      
      const root = {};
      for (const f of files) {
        const parts = f.split('/');
        let curr = root;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (!curr[p]) curr[p] = i === parts.length - 1 ? f : {};
          curr = curr[p];
        }
      }

      function buildHtml(node) {
        let html = '';
        const keys = Object.keys(node).sort((a,b) => {
          const aIsDir = typeof node[a] === 'object';
          const bIsDir = typeof node[b] === 'object';
          if (aIsDir && !bIsDir) return -1;
          if (!aIsDir && bIsDir) return 1;
          return a.localeCompare(b);
        });

        for (const k of keys) {
          if (typeof node[k] === 'object') {
            html += \`
              <li>
                <div class="file-item" onclick="this.nextElementSibling.classList.toggle('open')">
                  <span class="file-icon">📁</span>
                  <span>\${escHtml(k)}</span>
                </div>
                <ul class="folder-children open">\${buildHtml(node[k])}</ul>
              </li>
            \`;
          } else {
            html += \`
              <li class="file-item" onclick="viewFile('\${escHtml(node[k])}')">
                <span class="file-icon">\${getIcon(k)}</span>
                <span title="\${escHtml(node[k])}">\${escHtml(k)}</span>
              </li>
            \`;
          }
        }
        return html;
      }

      document.getElementById('file-tree').innerHTML = buildHtml(root);
    }

    function getIcon(name) {
      const ext = name.split('.').pop().toLowerCase();
      const map = { js:'🟨', ts:'🔷', json:'📋', md:'📝', txt:'📄', css:'🎨', html:'🌐', sh:'⚙', env:'🔑', py:'🐍', yml:'⚙', yaml:'⚙' };
      return map[ext] || '📄';
    }

    // View file
    async function viewFile(filePath) {
      document.querySelectorAll('.file-item').forEach(el => {
        el.classList.toggle('active', el.querySelector('span:last-child').textContent === filePath.split('/').pop());
      });

      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-file').classList.add('active');
      document.getElementById('view-commits').style.display = 'none';
      document.getElementById('view-file').style.display = '';

      document.getElementById('file-content-area').innerHTML = '<div class="loading"><div class="spinner"></div><br>Loading…</div>';

      try {
        const qs = currentRef ? '&ref=' + encodeURIComponent(currentRef) : '';
        const res = await fetch(API + '/ui/blob?path=' + encodeURIComponent(filePath) + qs);
        if (!res.ok) throw new Error('File not found');
        const data = await res.json();
        
        let lang = 'javascript';
        if (filePath.endsWith('.md')) lang = 'markdown';
        else if (filePath.endsWith('.json')) lang = 'json';
        else if (filePath.endsWith('.css')) lang = 'css';
        else if (filePath.endsWith('.html')) lang = 'html';
        else if (filePath.endsWith('.sh')) lang = 'bash';

        document.getElementById('file-content-area').innerHTML = \`
          <div class="file-viewer">
            <div class="file-viewer-header">
              <span class="file-path">\${escHtml(filePath)}</span>
              <span class="file-size">\${data.size} bytes · \${data.lines} lines</span>
            </div>
            <pre><code id="file-code" class="language-\${lang}"></code></pre>
          </div>
        \`;
        
        const codeEl = document.getElementById('file-code');
        codeEl.textContent = data.content;
        if (window.Prism) Prism.highlightElement(codeEl);
      } catch (e) {
        document.getElementById('file-content-area').innerHTML = \`<div class="empty">Could not load file: \${e.message}</div>\`;
      }
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    loadInfo().catch(e => {
      document.getElementById('commit-graph').innerHTML = '<div class="empty">Error loading repository: ' + e.message + '</div>';
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------
/**
 * Create and return an Express server for sharing the repository over LAN.
 * @param {string} logitDir
 * @param {string} repoRoot
 */
export function createServer(logitDir, repoRoot) {
  const app = express();

  // Raw body for packfile uploads (must come before json middleware)
  app.use('/packfile', (req, res, next) => {
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { req.rawBody = Buffer.concat(chunks); next(); });
    } else {
      next();
    }
  });

  app.use(express.json({ limit: '50mb' }));

  // ── Web UI ──────────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    const repoName = path.basename(repoRoot);
    res.set('Content-Type', 'text/html');
    res.send(buildWebUI(repoName));
  });



  // ── Repository info ──────────────────────────────────────────────────────
  app.get('/info', async (req, res) => {
    try {
      const refs = await getAllRefs(logitDir);
      const head = await resolveHead(logitDir);
      res.json({ name: path.basename(repoRoot), head, refs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Refs ─────────────────────────────────────────────────────────────────
  app.get('/refs', async (req, res) => {
    try {
      res.json(await getAllRefs(logitDir));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Objects list ──────────────────────────────────────────────────────────
  app.get('/objects/list', async (req, res) => {
    try {
      res.json(await listAllObjects(logitDir));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Single object ─────────────────────────────────────────────────────────
  app.get('/objects/:hash', async (req, res) => {
    try {
      const { hash } = req.params;
      if (!(await objectExists(logitDir, hash))) {
        return res.status(404).json({ error: `Object ${hash} not found` });
      }
      const objPath = path.join(logitDir, 'objects', hash.substring(0, 2), hash.substring(2));
      const data = await fs.readFile(objPath);
      res.set('Content-Type', 'application/octet-stream');
      res.send(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Legacy JSON push ──────────────────────────────────────────────────────
  app.post('/objects', async (req, res) => {
    try {
      const { objects } = req.body;
      if (!objects || !Array.isArray(objects)) {
        return res.status(400).json({ error: 'Expected { objects: [...] }' });
      }
      let stored = 0;
      for (const obj of objects) {
        if (!(await objectExists(logitDir, obj.hash))) {
          const data = Buffer.from(obj.data, 'base64');
          const objDir = path.join(logitDir, 'objects', obj.hash.substring(0, 2));
          const objPath = path.join(objDir, obj.hash.substring(2));
          await fs.mkdir(objDir, { recursive: true });
          await fs.writeFile(objPath, data);
          stored++;
        }
      }
      res.json({ stored, message: `Stored ${stored} new object(s).` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Packfile GET (for pull/clone) ─────────────────────────────────────────
  app.get('/packfile', async (req, res) => {
    try {
      const hashParam = req.query.hashes;
      if (!hashParam) return res.status(400).json({ error: 'Missing hashes query param' });
      const hashes = hashParam.split(',').filter(Boolean);
      if (hashes.length === 0) return res.status(400).json({ error: 'No hashes provided' });

      const packBuffer = await createPackfile(logitDir, hashes);
      res.set('Content-Type', 'application/octet-stream');
      res.send(packBuffer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Packfile POST (for push) ───────────────────────────────────────────────
  app.post('/packfile', async (req, res) => {
    try {
      if (!req.rawBody || req.rawBody.length === 0) {
        return res.status(400).json({ error: 'Empty packfile body' });
      }
      const stored = await unpackPackfile(logitDir, req.rawBody);
      res.json({ stored, message: `Stored ${stored} new object(s) from packfile.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Update refs ───────────────────────────────────────────────────────────
  app.post('/update-refs', async (req, res) => {
    try {
      const { refs } = req.body;
      if (!refs || typeof refs !== 'object') {
        return res.status(400).json({ error: 'Expected { refs: { ... } }' });
      }
      for (const [refName, hash] of Object.entries(refs)) {
        const refPath = path.join(logitDir, refName);
        await fs.mkdir(path.dirname(refPath), { recursive: true });
        await fs.writeFile(refPath, hash + '\n');
      }
      res.json({ message: 'Refs updated.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── UI: commits ──────────────────────────────────────────────────────────
  app.get('/ui/commits', async (req, res) => {
    try {
      const ref = req.query.ref;
      let head;
      if (ref) {
        if (ref.startsWith('refs/')) {
          const refPath = path.join(logitDir, ref);
          try {
            head = (await fs.readFile(refPath, 'utf-8')).trim();
          } catch(e) {}
        } else {
          head = ref; // assume it's a hash
        }
      } else {
        head = await resolveHead(logitDir);
      }
      
      if (!head) return res.json([]);
      const commits = await getCommitLog(logitDir, head, 100);
      res.json(commits);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── UI: tags ──────────────────────────────────────────────────────────────
  app.get('/ui/tags', async (req, res) => {
    try {
      const tagsDir = path.join(logitDir, 'refs', 'tags');
      const result = {};
      try {
        const entries = await fs.readdir(tagsDir);
        for (const name of entries) {
          const hash = (await fs.readFile(path.join(tagsDir, name), 'utf-8')).trim();
          result[name] = hash;
        }
      } catch { /* no tags */ }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── UI: file tree from HEAD ───────────────────────────────────────────────
  app.get('/ui/tree', async (req, res) => {
    try {
      const ref = req.query.ref;
      let commitHash;

      if (ref) {
        if (ref.startsWith('refs/')) {
          try {
            commitHash = (await fs.readFile(path.join(logitDir, ref), 'utf-8')).trim();
          } catch(e) {}
        } else {
          commitHash = ref;
        }
      } else {
        commitHash = await resolveHead(logitDir);
      }

      if (!commitHash) return res.json([]);

      const commit = await readCommit(logitDir, commitHash);
      const entries = await readTree(logitDir, commit.tree);
      res.json(entries.map((e) => e.name));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── UI: blob content ──────────────────────────────────────────────────────
  app.get('/ui/blob', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: 'Missing path param' });

      const ref = req.query.ref;
      let commitHash;
      if (ref) {
        if (ref.startsWith('refs/')) {
          try {
            commitHash = (await fs.readFile(path.join(logitDir, ref), 'utf-8')).trim();
          } catch(e) {}
        } else {
          commitHash = ref;
        }
      } else {
        commitHash = await resolveHead(logitDir);
      }

      if (!commitHash) return res.status(404).json({ error: 'No commits' });

      const commit = await readCommit(logitDir, commitHash);
      const entries = await readTree(logitDir, commit.tree);
      const entry = entries.find((e) => e.name === filePath);

      if (!entry) return res.status(404).json({ error: `File '${filePath}' not found in HEAD` });

      const obj = await readObject(logitDir, entry.hash);
      const content = obj.content.toString('utf-8');
      const lines = content.split('\n').length;

      res.json({
        path: filePath,
        hash: entry.hash,
        size: obj.content.length,
        lines,
        content
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── UI: commit diff ───────────────────────────────────────────────────────
  app.get('/ui/commit/:hash/diff', async (req, res) => {
    try {
      const { hash } = req.params;
      const commit = await readCommit(logitDir, hash);
      
      let parentTreeEntries = [];
      if (commit.parent) {
        const parentCommit = await readCommit(logitDir, commit.parent);
        parentTreeEntries = await readTree(logitDir, parentCommit.tree);
      }
      
      const currentTreeEntries = await readTree(logitDir, commit.tree);
      
      // Build maps
      const parentFiles = {};
      for (const e of parentTreeEntries) parentFiles[e.name] = e.hash;
      
      const currentFiles = {};
      for (const e of currentTreeEntries) currentFiles[e.name] = e.hash;
      
      const allFiles = [...new Set([...Object.keys(parentFiles), ...Object.keys(currentFiles)])];
      const diffs = [];
      
      for (const file of allFiles) {
        const oldHash = parentFiles[file];
        const newHash = currentFiles[file];
        
        if (oldHash === newHash) continue; // no change
        
        let oldContent = '';
        if (oldHash) {
          try {
            const obj = await readObject(logitDir, oldHash);
            oldContent = obj.content.toString('utf-8');
          } catch(e) {}
        }
        
        let newContent = '';
        if (newHash) {
          try {
            const obj = await readObject(logitDir, newHash);
            newContent = obj.content.toString('utf-8');
          } catch(e) {}
        }
        
        const patch = Diff.createPatch(file, oldContent, newContent, commit.parent ? commit.parent.substring(0,7) : 'empty', hash.substring(0,7));
        diffs.push({ file, patch });
      }
      
      res.json(diffs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}


// ===========================================================================
// src/utils/display.js
// ===========================================================================
import chalk from 'chalk';

/**
 * Display utilities for formatted terminal output.
 */

export function success(message) {
  console.log(chalk.green('✓ ') + message);
}

export function error(message) {
  console.error(chalk.red('✗ ') + message);
}

export function warn(message) {
  console.log(chalk.yellow('⚠ ') + message);
}

export function info(message) {
  console.log(chalk.blue('ℹ ') + message);
}

export function heading(message) {
  console.log(chalk.bold.cyan(message));
}

/**
 * Format a commit for display in logit log.
 */
export function formatCommit(commit) {
  const lines = [];
  lines.push(chalk.yellow(`commit ${commit.hash}`));
  if (commit.branch) {
    lines.push(chalk.cyan(` (${commit.branch})`));
  }
  lines.push(`Author:  ${commit.author || 'Unknown'}`);
  lines.push(`Date:    ${new Date(commit.timestamp).toLocaleString()}`);
  lines.push('');
  lines.push(`    ${commit.message}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Format a branch list for display.
 */
export function formatBranches(branches, currentBranch) {
  return branches.map(b => {
    if (b === currentBranch) {
      return chalk.green(`* ${b}`);
    }
    return `  ${b}`;
  }).join('\n');
}

/**
 * Format file status for display.
 */
export function formatStatus(staged, modified, untracked) {
  const lines = [];

  if (staged.length > 0) {
    lines.push(chalk.bold('Changes to be committed:'));
    lines.push(chalk.gray('  (use "logit checkout" to unstage)'));
    lines.push('');
    for (const file of staged) {
      lines.push(chalk.green(`\tnew file:   ${file}`));
    }
    lines.push('');
  }

  if (modified.length > 0) {
    lines.push(chalk.bold('Changes not staged for commit:'));
    lines.push(chalk.gray('  (use "logit add" to update what will be committed)'));
    lines.push('');
    for (const file of modified) {
      lines.push(chalk.red(`\tmodified:   ${file}`));
    }
    lines.push('');
  }

  if (untracked.length > 0) {
    lines.push(chalk.bold('Untracked files:'));
    lines.push(chalk.gray('  (use "logit add <file>..." to include in what will be committed)'));
    lines.push('');
    for (const file of untracked) {
      lines.push(chalk.red(`\t${file}`));
    }
    lines.push('');
  }

  if (staged.length === 0 && modified.length === 0 && untracked.length === 0) {
    lines.push('nothing to commit, working tree clean');
  }

  return lines.join('\n');
}


// ===========================================================================
// src/utils/fs.js
// ===========================================================================
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

/**
 * Recursively get all files in a directory, respecting .logitignore.
 * Returns paths relative to the given root.
 */
export async function getAllFiles(dir, root = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const ignorePatterns = await getIgnorePatterns(root);
  let files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');

    // Always skip .logit directory and node_modules
    if (entry.name === '.logit' || entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }

    // Skip ignored patterns
    if (shouldIgnore(relativePath, ignorePatterns)) {
      continue;
    }

    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath, root);
      files = files.concat(subFiles);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

/**
 * Read .logitignore patterns from repo root.
 */
async function getIgnorePatterns(root) {
  const ignorePath = path.join(root, '.logitignore');
  try {
    const content = await fs.readFile(ignorePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Check if a relative path matches any ignore pattern (simple glob matching).
 */
function shouldIgnore(relativePath, patterns) {
  for (const pattern of patterns) {
    // Simple wildcard matching
    if (pattern.endsWith('/')) {
      // Directory pattern
      if (relativePath.startsWith(pattern) || relativePath.startsWith(pattern.slice(0, -1))) {
        return true;
      }
    } else if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      if (regex.test(relativePath) || regex.test(path.basename(relativePath))) {
        return true;
      }
    } else {
      if (relativePath === pattern || path.basename(relativePath) === pattern) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Read file content as a Buffer.
 */
export async function readFileContent(filePath) {
  return fs.readFile(filePath);
}

/**
 * Write content to a file, creating parent directories if needed.
 */
export async function writeFileContent(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, data);
}

/**
 * Check if a file or directory exists.
 */
export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a file exists (synchronous).
 */
export function fileExistsSync(filePath) {
  return fsSync.existsSync(filePath);
}


