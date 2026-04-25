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
