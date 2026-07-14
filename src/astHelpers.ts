import * as ts from 'typescript';

/**
 * Shared AST utilities used by both safetyAnalyzer.ts (Milestone 4) and
 * architectureAnalyzer.ts (Milestone 5). Extracted here now that a second
 * consumer genuinely needs them — not created speculatively ahead of that
 * need. Every function here is a pure relocation from safetyAnalyzer.ts;
 * none of the logic itself changed.
 */

export function parseSnippet(code: string, languageId: string): ts.SourceFile {
  return ts.createSourceFile(
    'pasted-snippet.tsx', // scriptKind below takes precedence over this extension
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindForLanguage(languageId)
  );
}

export function lineAt(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Handles both `eval(...)` (identifier callee) and `obj.method(...)` (property access callee) uniformly. */
export function getCalleeName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
    return node.expression.name.text;
  }
  return undefined;
}

export function scriptKindForLanguage(languageId: string): ts.ScriptKind {
  switch (languageId) {
    case 'typescript':
      return ts.ScriptKind.TS;
    case 'typescriptreact':
      return ts.ScriptKind.TSX;
    case 'javascript':
      return ts.ScriptKind.JS;
    case 'javascriptreact':
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JSX; // most permissive parse for an unrecognized languageId
  }
}
