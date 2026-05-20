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
