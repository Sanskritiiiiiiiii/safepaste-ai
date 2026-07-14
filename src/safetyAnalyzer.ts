import * as ts from 'typescript';
import { parseSnippet, lineAt, getCalleeName } from './astHelpers';

/**
 * Safety analysis for a single pasted code snippet. Deliberately separate
 * from chunker/ (which walks a whole repository to build searchable
 * FunctionChunks) — this operates on one piece of text at paste time and
 * has nothing to do with indexing. No Python worker involvement: every
 * rule here is either a regex over raw text or a synchronous AST walk,
 * so this entire module runs locally and instantly.
 *
 * Milestone 5 note: parseSnippet/lineAt/getCalleeName now live in
 * astHelpers.ts (architectureAnalyzer.ts needs them too). Nothing in this
 * file's logic changed — only where those four functions are defined.
 */

export interface SafetyFinding {
  ruleId: 'hardcoded-secret' | 'sql-injection' | 'dangerous-fs-exec' | 'deprecated-api';
  message: string;
  /** 1-indexed line number within the pasted snippet (not the file). */
  line: number;
}

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
      // One rule failing to parse/analyze shouldn't take down the others.
    }
  }
  return findings;
}

// ---------------------------------------------------------------------
// Rule: hardcoded secrets — regex over raw text, not AST.
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
    pattern.lastIndex = 0;
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
// Rule: SQL injection.
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

function isDynamicStringConstruction(node: ts.Expression): boolean {
  if (ts.isTemplateExpression(node)) {
    return true;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return true;
  }
  return false;
}
