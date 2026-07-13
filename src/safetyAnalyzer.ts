import * as ts from 'typescript';

/**
 * Safety analysis for a single pasted code snippet. Deliberately separate
 * from chunker/ (which walks a whole repository to build searchable
 * FunctionChunks) — this operates on one piece of text at paste time and
 * has nothing to do with indexing. No Python worker involvement: every
 * rule here is either a regex over raw text or a synchronous AST walk,
 * so this entire module runs locally and instantly.
 */

export interface SafetyFinding {
  ruleId: 'hardcoded-secret' | 'sql-injection' | 'dangerous-fs-exec' | 'deprecated-api';
  message: string;
  /** 1-indexed line number within the pasted snippet (not the file). */
  line: number;
}

/**
 * A safety rule: given a pasted snippet's text and its VS Code languageId,
 * return zero or more findings. Every rule shares this exact signature so
 * they can all live in the RULES array below and be run uniformly.
 * Extending this module is: write one function matching this shape, add
 * it to RULES — nothing else changes.
 */
type SafetyRule = (code: string, languageId: string) => SafetyFinding[];

const RULES: SafetyRule[] = [
  detectHardcodedSecrets,
  detectSqlInjection,
  detectDangerousCalls,
  detectDeprecatedApis,
];

export function analyzeSafety(code: string, languageId: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const rule of RULES) {
    try {
      findings.push(...rule(code, languageId));
    } catch {
      // One rule failing to parse/analyze shouldn't take down the others
      // — the same defensive principle used elsewhere in this project
      // (e.g. the Python embedder isolating one bad chunk from the rest
      // rather than letting it fail the whole batch).
    }
  }
  return findings;
}

// ---------------------------------------------------------------------
// Rule: hardcoded secrets — regex over raw text, not AST, since secrets
// live inside string literals regardless of surrounding syntax.
// languageId is unused here but kept in the signature to match SafetyRule.
// ---------------------------------------------------------------------

const SECRET_PATTERNS: { pattern: RegExp; message: string }[] = [
  {
    pattern: /(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"][^'"\n]{8,}['"]/gi,
    message: 'Possible hardcoded secret (API key, token, or password) in a string literal.',
  },
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    message: 'Looks like a hardcoded AWS access key ID.',
  },
  {
    pattern: /-----BEGIN (RSA |EC |)PRIVATE KEY-----/g,
    message: 'Hardcoded private key material.',
  },
];

function detectHardcodedSecrets(code: string, _languageId: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const { pattern, message } of SECRET_PATTERNS) {
    pattern.lastIndex = 0; // these are module-level regexes reused across calls
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      findings.push({ ruleId: 'hardcoded-secret', message, line: lineOf(code, match.index) });
    }
  }
  return findings;
}

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (code.charCodeAt(i) === 10 /* \n */) {
      line++;
    }
  }
  return line;
}

// ---------------------------------------------------------------------
// Rule: SQL injection — a query-like call whose first argument is a
// dynamically-built string instead of a parameterized query.
// ---------------------------------------------------------------------

const QUERY_METHOD_NAMES = new Set(['query', 'execute', 'raw']);

function detectSqlInjection(code: string, languageId: string): SafetyFinding[] {
  const sourceFile = parseSnippet(code, languageId);
  const findings: SafetyFinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const calleeName = getCalleeName(node);
      const firstArg = node.arguments[0];
      if (
        calleeName &&
        QUERY_METHOD_NAMES.has(calleeName) &&
        firstArg &&
        isDynamicStringConstruction(firstArg)
      ) {
        findings.push({
          ruleId: 'sql-injection',
          message: `Possible SQL injection: '${calleeName}(...)' is called with a dynamically-built string instead of a parameterized query.`,
          line: lineAt(sourceFile, node),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------
// Rule: dangerous filesystem/exec calls.
// ---------------------------------------------------------------------

const DANGEROUS_CALL_NAMES = new Set(['unlinkSync', 'rmSync', 'exec', 'execSync', 'eval', 'Function']);

function detectDangerousCalls(code: string, languageId: string): SafetyFinding[] {
  const sourceFile = parseSnippet(code, languageId);
  const findings: SafetyFinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const calleeName = getCalleeName(node);
      if (calleeName && DANGEROUS_CALL_NAMES.has(calleeName)) {
        findings.push({
          ruleId: 'dangerous-fs-exec',
          message: `Potentially dangerous call to '${calleeName}(...)'. Review carefully before accepting this code.`,
          line: lineAt(sourceFile, node),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------
// Rule: deprecated APIs.
// ---------------------------------------------------------------------

function detectDeprecatedApis(code: string, languageId: string): SafetyFinding[] {
  const sourceFile = parseSnippet(code, languageId);
  const findings: SafetyFinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const calleeName = getCalleeName(node);
      if (calleeName === 'createCipher' || calleeName === 'createDecipher') {
        findings.push({
          ruleId: 'deprecated-api',
          message: `crypto.${calleeName} is deprecated and insecure — use ${calleeName}iv instead.`,
          line: lineAt(sourceFile, node),
        });
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Buffer') {
      findings.push({
        ruleId: 'deprecated-api',
        message: 'new Buffer() is deprecated and unsafe — use Buffer.from() instead.',
        line: lineAt(sourceFile, node),
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

// ---------------------------------------------------------------------
// Shared parsing helpers used by the three AST-based rules above. Kept
// small and generic on purpose — each rule still does its own tree walk
// (three walks over a tiny pasted snippet costs nothing measurable), but
// there's no reason to repeat the same 6-line parse call three times.
// ---------------------------------------------------------------------

function parseSnippet(code: string, languageId: string): ts.SourceFile {
  return ts.createSourceFile(
    'pasted-snippet.tsx', // scriptKind below takes precedence over this extension
    code,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindForLanguage(languageId)
  );
}

function lineAt(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Handles both `eval(...)` (identifier callee) and `obj.method(...)` (property access callee) uniformly. */
function getCalleeName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text;
  }
  if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)) {
    return node.expression.name.text;
  }
  return undefined;
}

function isDynamicStringConstruction(node: ts.Expression): boolean {
  // Template literal WITH interpolation, e.g. `SELECT * FROM users WHERE id = ${id}`.
  // NoSubstitutionTemplateLiteral (no ${}) is intentionally not flagged — it's static text.
  if (ts.isTemplateExpression(node)) {
    return true;
  }
  // String concatenation, e.g. "SELECT * FROM users WHERE id = " + id
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return true;
  }
  return false;
}

function scriptKindForLanguage(languageId: string): ts.ScriptKind {
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
