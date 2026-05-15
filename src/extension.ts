'use strict';
import { commands, ExtensionContext, languages, Range, TextDocument, window } from 'vscode';
import { IjHttpCliRunner } from './ijhttp/ijHttpCliRunner';
import { IjHttpDiagnosticsProvider } from './providers/customVariableDiagnosticsProvider';
import { HttpCodeLensProvider } from './providers/httpCodeLensProvider';

export async function activate(context: ExtensionContext) {
    const outputChannel = window.createOutputChannel('ijhttp Client');
    const cliRunner = new IjHttpCliRunner(outputChannel, context.globalState);
    const diagnosticsProvider = new IjHttpDiagnosticsProvider();
    const documentSelector = [{ language: 'http', scheme: '*' }];

    context.subscriptions.push(outputChannel);
    context.subscriptions.push(cliRunner);
    context.subscriptions.push(diagnosticsProvider);
    context.subscriptions.push(commands.registerCommand('ijhttp-client.runCurrentRequest', async (document?: TextDocument, range?: Range) => {
        await cliRunner.runCurrentRequest(document, range);
    }));
    context.subscriptions.push(commands.registerCommand('ijhttp-client.checkSyntax', async () => {
        const activeDocument = window.activeTextEditor?.document;
        if (!activeDocument) {
            window.showWarningMessage('Open an HTTP or environment file to run syntax checks.');
            return;
        }

        const diagnostics = await diagnosticsProvider.checkDocument(activeDocument);
        if (diagnostics.length === 0) {
            window.showInformationMessage('No syntax issues found.');
            return;
        }

        window.showWarningMessage(`Found ${diagnostics.length} syntax issue(s). Open Problems for details.`);
    }));
    context.subscriptions.push(commands.registerCommand('ijhttp-client.showOutput', () => outputChannel.show(true)));
    context.subscriptions.push(commands.registerCommand('ijhttp-client.selectEnvironment', async (document?: TextDocument) => {
        await cliRunner.selectEnvironment(document);
    }));
    context.subscriptions.push(languages.registerCodeLensProvider(documentSelector, new HttpCodeLensProvider()));
    context.subscriptions.push(window.onDidChangeActiveTextEditor(editor => {
        void cliRunner.refreshStatus(editor?.document);
    }));
    void cliRunner.refreshStatus(window.activeTextEditor?.document);
}

export function deactivate() {
}
