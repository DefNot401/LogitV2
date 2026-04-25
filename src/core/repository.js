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
