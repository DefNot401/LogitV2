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
