import * as fs from 'fs';
import * as path from 'path';

/**
 * Loads and caches safepaste.config.json — the user-authored file that
 * declares a repo's layering convention (e.g. Controller -> Service ->
 * Repository) for architectureAnalyzer.ts to check pasted code against.
 *
 * Deliberately the only file that touches this config. extension.ts and
 * architectureAnalyzer.ts never read or parse it directly — they only
 * ever get an ArchitectureConfig back from loadArchitectureConfig().
 */

export interface LayerConfig {
  name: string;
  /** Repo-relative folder prefixes, forward-slash separated, e.g. "src/controllers". */
  folders: string[];
  /** Pattern IDs from architectureAnalyzer.ts's fixed catalog, e.g. "direct-db-access". */
  forbiddenPatterns: string[];
}

export interface ArchitectureConfig {
  layers: LayerConfig[];
}

const CONFIG_FILENAME = 'safepaste.config.json';

interface CacheEntry {
  mtimeMs: number;
  config: ArchitectureConfig;
}

// Keyed by absolute config file path, so multiple workspace folders (if
// VS Code ever has more than one open) don't collide.
const cache = new Map<string, CacheEntry>();

/**
 * Returns the parsed config for `workspaceRoot`, or `undefined` if no
 * safepaste.config.json exists there — that's a valid, expected state
 * (the architecture check is opt-in), not an error.
 *
 * Throws if the file exists but is malformed (invalid JSON or fails
 * schema validation) — that IS worth surfacing, since it means the user
 * tried to configure this and got something wrong. Callers decide how to
 * report that; this module has no opinion on logging or UI.
 *
 * Cached per config file path, invalidated by comparing the file's
 * mtime on each call (one cheap fs.statSync, not a full read+parse) —
 * so editing the config while VS Code is open takes effect on the next
 * paste, without re-parsing on every paste when nothing changed.
 */
export function loadArchitectureConfig(workspaceRoot: string): ArchitectureConfig | undefined {
  const configPath = path.join(workspaceRoot, CONFIG_FILENAME);

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(configPath).mtimeMs;
  } catch {
    // No config file — not an error. Also clears any stale cache entry
    // in case the file existed earlier in this session and was deleted.
    cache.delete(configPath);
    return undefined;
  }

  const cached = cache.get(configPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.config;
  }

  const config = parseAndValidate(configPath);
  cache.set(configPath, { mtimeMs, config });
  return config;
}

function parseAndValidate(configPath: string): ArchitectureConfig {
  const raw = fs.readFileSync(configPath, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${message}`);
  }

  const validationError = validate(parsed);
  if (validationError) {
    throw new Error(`${CONFIG_FILENAME} is invalid: ${validationError}`);
  }

  return parsed as ArchitectureConfig;
}

/** Returns an error message describing the first problem found, or undefined if valid. */
function validate(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return "root value must be an object with a 'layers' array";
  }
  const layers = (value as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) {
    return "'layers' must be an array";
  }

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (typeof layer !== 'object' || layer === null) {
      return `layers[${i}] must be an object`;
    }
    const l = layer as { name?: unknown; folders?: unknown; forbiddenPatterns?: unknown };

    if (typeof l.name !== 'string' || l.name.length === 0) {
      return `layers[${i}].name must be a non-empty string`;
    }
    if (!Array.isArray(l.folders) || !l.folders.every((f) => typeof f === 'string')) {
      return `layers[${i}].folders must be an array of strings`;
    }
    if (
      !Array.isArray(l.forbiddenPatterns) ||
      !l.forbiddenPatterns.every((p) => typeof p === 'string')
    ) {
      return `layers[${i}].forbiddenPatterns must be an array of strings`;
    }
  }

  return undefined;
}
