"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = require("path");
const vscode = require("vscode");
const pythonWorker_1 = require("./pythonWorker");
let worker;
function activate(context) {
    const output = vscode.window.createOutputChannel('SafePaste AI');
    context.subscriptions.push(output);
    const scriptPath = path.join(context.extensionPath, '..', 'python-worker', 'worker.py');
    // Config value rather than a hardcoded "python3" so this works on
    // Windows (often "python") without code changes — a one-line setting,
    // not a feature, so it doesn't fight the "avoid complexity" goal.
    const pythonExecutable = vscode.workspace
        .getConfiguration('safepaste')
        .get('pythonPath', 'python3');
    worker = new pythonWorker_1.PythonWorker(scriptPath, pythonExecutable, output);
    const pingCommand = vscode.commands.registerCommand('safepaste.ping', async () => {
        output.show(true);
        output.appendLine('Sending ping to Python worker...');
        try {
            const result = await worker.send('ping', {
                message: 'hello from extension',
            });
            output.appendLine(`Received: ${JSON.stringify(result)}`);
            vscode.window.showInformationMessage(`SafePaste worker replied: ${result.received}`);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            output.appendLine(`Ping failed: ${message}`);
            vscode.window.showErrorMessage(`SafePaste worker error: ${message}`);
        }
    });
    context.subscriptions.push(pingCommand);
}
function deactivate() {
    worker?.dispose();
}
//# sourceMappingURL=extension.js.map