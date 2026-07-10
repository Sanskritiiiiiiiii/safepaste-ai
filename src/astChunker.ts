import * as ts from 'typescript';
import { FunctionChunk } from './types';

/**
 * Extracts function-level chunks from one file's source text.
 *
 * Scope decisions (documented here since they're not obvious from the code):
 *
 * 1. We capture three kinds of nodes: function declarations, class methods,
 *    and variable declarations initialized with an arrow/function expression
 *    (e.g. `const foo = () => {...}`). These cover the vast majority of
 *    reusable, named logic in real JS/TS codebases.
 *
 * 2. We deliberately do NOT descend into a node's body once it's captured
 *    as a chunk. Without this, a helper function nested inside another
 *    function would become its own separate chunk whose code is also
 *    contained inside its parent's chunk — duplicate detection would then
 *    match the same code against itself. Stopping descent avoids that noise.
 *    (A nested *named* helper is still visible as part of its parent's code,
 *    just not indexed as an independent unit.)
 *
 * 3. We skip anonymous functions (e.g. inline callbacks passed to
 *    `array.map(...)`) — they have no name to reuse or reference, so they
 *    aren't meaningful units for "does this logic already exist elsewhere".
 */
export function extractFunctionChunks(
  sourceText: string,
  absoluteFilePath: string,
  relativeFilePath: string
): FunctionChunk[] {
  const sourceFile = ts.createSourceFile(
    absoluteFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindForFile(absoluteFilePath)
  );

  const chunks: FunctionChunk[] = [];
  const classNameStack: string[] = [];

  function addChunk(node: ts.Node, name: string): void {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    const startLine = start.line + 1; // compiler API lines are 0-indexed
    chunks.push({
      id: `${relativeFilePath}:${startLine}:${name}`,
      name,
      filePath: relativeFilePath,
      startLine,
      endLine: end.line + 1,
      code: node.getText(sourceFile),
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name) {
      // Track the enclosing class so methods can be named `Class.method` —
      // makes chunk names unambiguous when the same method name appears in
      // multiple classes (e.g. two different `Service.create`).
      classNameStack.push(node.name.text);
      ts.forEachChild(node, visit);
      classNameStack.pop();
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      addChunk(node, node.name.text);
      return;
    }

    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const owner = classNameStack[classNameStack.length - 1];
      addChunk(node, owner ? `${owner}.${node.name.text}` : node.name.text);
      return;
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      addChunk(node, node.name.text);
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return chunks;
}

function scriptKindForFile(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}
