import * as fs from 'fs';
import * as path from 'path';
import { findSourceFiles } from './fileWalker';
import { extractFunctionChunks } from './astChunker';
import { FunctionChunk } from './types';

export { FunctionChunk } from './types';

/**
 * Walks `rootDir`, parses every JS/TS file found, and returns all
 * function-level chunks across the whole repository.
 *
 * This is the one function the rest of the extension should import from
 * this module — fileWalker.ts and astChunker.ts are implementation
 * details of "how", this is "what": give me a repo path, get chunks back.
 */
export function chunkRepository(rootDir: string): FunctionChunk[] {
  const files = findSourceFiles(rootDir);
  const chunks: FunctionChunk[] = [];

  for (const absolutePath of files) {
    let sourceText: string;
    try {
      sourceText = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      // Unreadable file — skip it rather than aborting the whole scan.
      continue;
    }

    const relativePath = path
      .relative(rootDir, absolutePath)
      .split(path.sep)
      .join('/'); // normalize to forward slashes regardless of OS

    chunks.push(...extractFunctionChunks(sourceText, absolutePath, relativePath));
  }

  return chunks;
}
