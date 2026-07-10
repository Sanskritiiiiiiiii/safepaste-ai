import * as path from 'path';
import * as vscode from 'vscode';
import { PythonWorker } from './pythonWorker';
import { PingPayload, PingResult } from './protocol';
import { chunkRepository } from './chunker';

let worker: PythonWorker | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SafePaste AI');
  context.subscriptions.push(output);

  const scriptPath = path.join(context.extensionPath, '..', 'python-worker', 'worker.py');

  // Config value rather than a hardcoded "python3" so this works on
  // Windows (often "python") without code changes — a one-line setting,
  // not a feature, so it doesn't fight the "avoid complexity" goal.
  const pythonExecutable = vscode.workspace
    .getConfiguration('safepaste')
    .get<string>('pythonPath', 'python3');

  worker = new PythonWorker(scriptPath, pythonExecutable, output);

  const pingCommand = vscode.commands.registerCommand('safepaste.ping', async () => {
    output.show(true);
    output.appendLine('Sending ping to Python worker...');
    try {
      const result = await worker!.send<PingResult>('ping', {
        message: 'hello from extension',
      } satisfies PingPayload);
      output.appendLine(`Received: ${JSON.stringify(result)}`);
      vscode.window.showInformationMessage(
        `SafePaste worker replied: ${result.received}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Ping failed: ${message}`);
      vscode.window.showErrorMessage(`SafePaste worker error: ${message}`);
    }
  });

  context.subscriptions.push(pingCommand);

  // Milestone 1 debug command: chunk the open workspace and print results
  // so we can eyeball correctness before wiring chunks into indexing
  // (Milestone 2). Deliberately a separate command from `ping` — this has
  // nothing to do with the Python worker, it's pure TypeScript AST work.
  const chunkCommand = vscode.commands.registerCommand('safepaste.chunkRepo', () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage('SafePaste: open a folder or workspace first.');
      return;
    }

    output.show(true);
    output.appendLine(`Chunking repository at ${folder.uri.fsPath} ...\n`);

    const chunks = chunkRepository(folder.uri.fsPath);
    output.appendLine(`Found ${chunks.length} function-level chunk(s).\n`);

    for (const chunk of chunks) {
      output.appendLine(`— ${chunk.name}  (${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`);
      output.appendLine(chunk.code);
      output.appendLine('');
    }

    vscode.window.showInformationMessage(
      `SafePaste: found ${chunks.length} function-level chunk(s). See output panel.`
    );
  });

  context.subscriptions.push(chunkCommand);
}

export function deactivate(): void {
  worker?.dispose();
}
  