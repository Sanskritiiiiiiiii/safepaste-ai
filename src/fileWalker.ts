import * as fs from 'fs';
import * as path from 'path';

/**
 * Directories whose contents are never source code we care about.
 * Hidden directories (name starts with '.', which also covers .git) are
 * skipped via a separate check below rather than listed here — no reason
 * to enumerate every possible hidden-folder name.
 */
const IGNORED_DIR_NAMES = new Set(['node_modules', 'dist', 'out', 'build']);

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/**
 * Walks `rootDir` recursively and returns absolute paths to every
 * .ts/.tsx/.js/.jsx file, excluding ignored and hidden directories.
 */
export function findSourceFiles(rootDir: string): string[] {
  const results: string[] = [];
  walk(rootDir, results);
  return results;
}

function walk(dir: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Unreadable directory (permissions, broken symlink, etc) — skip it
    // rather than aborting the entire repo scan over one bad folder.
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) {
        continue;
      }
      walk(path.join(dir, entry.name), results);
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name))) {
      results.push(path.join(dir, entry.name));
    }
  }
}

function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIR_NAMES.has(name);
}
