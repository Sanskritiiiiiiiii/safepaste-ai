import * as ts from 'typescript';
import * as path from 'path';
import { parseSnippet, lineAt, getCalleeName } from './astHelpers';
import { loadArchitectureConfig, LayerConfig } from './architectureConfig';

/**
 * Architecture Compatibility analysis (Milestone 5): checks whether
 * pasted code violates the layering convention the repo itself declares
 * in safepaste.config.json. Convention-based, not inference-based — see
 * the Milestone 5 design discussion for why general architecture
 * inference was ruled out.
 *
 * Fully encapsulates config loading: extension.ts calls only
 * analyzeArchitecture() below and never touches architectureConfig.ts
 * itself, per the approved design change.
 */

export interface ArchitectureFinding {
  ruleId: string; // pattern id from the catalog below, e.g. "direct-db-access"
  message: string;
  line: number;
}

/**
 * Fixed catalog of forbidden-pattern checkers a layer's config can
 * reference by id. Deliberately not a general rule-authoring DSL — see
 * "alternatives considered" in the Milestone 5 plan.
 */
const PATTERN_CATALOG: Record<string, (code: string, languageId: string) => ArchitectureFinding[]> = {
  'direct-db-access': detectDirectDbAccess,
};

export function analyzeArchitecture(
  code: string,
  languageId: string,
  targetFilePath: string,
  workspaceRoot: string
): ArchitectureFinding[] {
  const config = loadArchitectureConfig(workspaceRoot);
  if (!config) {
    return []; // no config declared for this repo — opt-in feature, silent no-op
  }

  const layer = findLayerForFile(targetFilePath, workspaceRoot, config.layers);
  if (!layer || layer.forbiddenPatterns.length === 0) {
    return [];
  }

  const findings: ArchitectureFinding[] = [];
  for (const patternId of layer.forbiddenPatterns) {
    const checker = PATTERN_CATALOG[patternId];
    if (!checker) {
      // Config references a pattern id we don't implement — skip it
      // rather than throwing, so one typo in one layer's pattern list
      // doesn't break checking for every other layer.
      continue;
    }
    findings.push(...checker(code, languageId).map((f) => withLayerContext(f, layer.name)));
  }
  return findings;
}

function withLayerContext(finding: ArchitectureFinding, layerName: string): ArchitectureFinding {
  return { ...finding, message: `[${layerName} layer] ${finding.message}` };
}

/**
 * Determines which declared layer `targetFilePath` belongs to, via
 * relative-path folder-prefix matching — the same relative-path,
 * forward-slash-normalization technique already used by the chunker
 * (fileWalker.ts / astChunker.ts) when computing chunk file paths.
 */
function findLayerForFile(
  targetFilePath: string,
  workspaceRoot: string,
  layers: LayerConfig[]
): LayerConfig | undefined {
  const relativePath = path.relative(workspaceRoot, targetFilePath).split(path.sep).join('/');

  return layers.find((layer) =>
    layer.folders.some((folder) => relativePath.startsWith(folder.replace(/\/$/, '') + '/'))
  );
}

// ---------------------------------------------------------------------
// Pattern: direct-db-access. Flags calls that look like direct database
// access (query/execute/raw-shaped calls) — the exact example from the
// original Milestone 5 spec (a controller calling the DB directly instead
// of going through a service layer).
//
// Deliberately a separate, independently-owned constant from
// safetyAnalyzer.ts's QUERY_METHOD_NAMES, even though the values
// overlap — this list is "what counts as DB access" for architecture
// purposes, safetyAnalyzer's is "what counts as unsafe query
// construction" for safety purposes. Different questions, coincidentally
// similar answers today; conflating them would couple two rule catalogs
// that should be free to evolve independently.
// ---------------------------------------------------------------------

const DB_ACCESS_METHOD_NAMES = new Set(['query', 'execute', 'raw', 'find', 'findOne', 'insert', 'update', 'delete']);

function detectDirectDbAccess(code: string, languageId: string): ArchitectureFinding[] {
  const sourceFile = parseSnippet(code, languageId);
  const findings: ArchitectureFinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const calleeName = getCalleeName(node);
      if (calleeName && DB_ACCESS_METHOD_NAMES.has(calleeName)) {
        findings.push({
          ruleId: 'direct-db-access',
          message: `Direct database call '${calleeName}(...)' found — this layer's convention says database access should go through a service/repository instead.`,
          line: lineAt(sourceFile, node),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}
