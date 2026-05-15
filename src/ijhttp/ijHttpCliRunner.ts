import { spawn } from 'child_process';
import { promises as fileSystem } from 'fs';
import * as path from 'path';
import {
    Disposable,
    Memento,
    OutputChannel,
    QuickPickItem,
    Range,
    StatusBarAlignment,
    StatusBarItem,
    TextDocument,
    window,
    workspace
} from 'vscode';
import * as Constants from '../common/constants';
import { Selector } from '../utils/selector';

interface IjHttpRuntimeSettings {
    executablePath: string;
    environmentName: string;
    publicEnvironmentFile?: string;
    privateEnvironmentFile?: string;
    logLevel: string;
}

interface EnvironmentContext {
    configuredEnvironmentName: string;
    rememberedEnvironmentName?: string;
    effectiveEnvironmentName?: string;
    publicEnvironmentFile?: string;
    privateEnvironmentFile?: string;
    availableEnvironmentNames: string[];
    environmentStorageKey: string;
}

export class IjHttpCliRunner implements Disposable {
    private static readonly rememberedEnvironmentPrefix = 'ijhttp-client.rememberedEnvironment';
    private readonly statusItem: StatusBarItem;
    private readonly validatedExecutables = new Set<string>();
    private lastRunState = 'idle';

    public constructor(private readonly outputChannel: OutputChannel, private readonly globalState: Memento) {
        this.statusItem = window.createStatusBarItem(StatusBarAlignment.Left, 100);
        this.statusItem.name = 'ijhttp Client';
        this.statusItem.command = 'ijhttp-client.selectEnvironment';
    }

    public async runCurrentRequest(document?: TextDocument, range?: Range): Promise<void> {
        const activeEditor = window.activeTextEditor;
        const targetDocument = document ?? activeEditor?.document;
        if (!targetDocument || targetDocument.languageId !== 'http') {
            window.showWarningMessage('Open an HTTP file to run a request with ijhttp.');
            return;
        }

        if (targetDocument.uri.scheme !== 'file') {
            window.showWarningMessage('ijhttp execution is only available for files stored on disk.');
            return;
        }

        const selectionRange = range ?? this.createActiveLineRange(targetDocument);
        if (!selectionRange) {
            window.showWarningMessage('Place the cursor inside a request block to run it.');
            return;
        }

        const requestBlock = Selector.getRequestBlock(targetDocument, selectionRange);
        if (!requestBlock) {
            window.showWarningMessage('No request block found at the current cursor position.');
            return;
        }

        let runtimeSettings: IjHttpRuntimeSettings;
        try {
            runtimeSettings = await this.getRuntimeSettings(targetDocument);
            await this.ensureExecutable(runtimeSettings.executablePath, path.dirname(targetDocument.fileName));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === 'Environment selection was cancelled.') {
                this.outputChannel.appendLine('ijhttp run cancelled: environment selection was dismissed.');
                return;
            }

            throw error;
        }

        const temporaryFile = this.buildTemporaryFilePath(targetDocument.fileName);
        await fileSystem.writeFile(temporaryFile, this.normalizeBlockText(requestBlock.text), 'utf8');

        const argumentList = this.buildArgumentList(runtimeSettings, temporaryFile);
        const workingDirectory = path.dirname(targetDocument.fileName);
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`$ ${runtimeSettings.executablePath} ${argumentList.map(item => this.quoteArgument(item)).join(' ')}`);
        this.lastRunState = 'running';
        await this.refreshStatus(targetDocument);

        try {
            const exitCode = await this.runProcess(runtimeSettings.executablePath, argumentList, workingDirectory);
            if (exitCode === 0) {
                this.lastRunState = 'success';
                await this.refreshStatus(targetDocument);
                window.showInformationMessage('ijhttp finished successfully.');
            } else {
                this.lastRunState = `failed (${exitCode})`;
                await this.refreshStatus(targetDocument);
                window.showErrorMessage(`ijhttp finished with exit code ${exitCode}.`);
            }
        } finally {
            await this.removeTemporaryFile(temporaryFile);
        }
    }

    public async selectEnvironment(document?: TextDocument): Promise<void> {
        const targetDocument = document ?? window.activeTextEditor?.document;
        if (!targetDocument || targetDocument.languageId !== 'http' || targetDocument.uri.scheme !== 'file') {
            window.showWarningMessage('Open an HTTP file to select an ijhttp environment.');
            return;
        }

        const environmentContext = await this.getEnvironmentContext(targetDocument);
        if (environmentContext.configuredEnvironmentName) {
            window.showInformationMessage(
                `Environment is controlled by setting: ${environmentContext.configuredEnvironmentName}. Clear ijhttp-client.environment to use interactive selection.`
            );
            await this.refreshStatus(targetDocument);
            return;
        }

        if (environmentContext.availableEnvironmentNames.length === 0) {
            window.showInformationMessage('No environments were found for this HTTP file.');
            await this.refreshStatus(targetDocument);
            return;
        }

        const selectedEnvironmentName = await this.promptForEnvironment(
            environmentContext,
            environmentContext.effectiveEnvironmentName
        );
        if (!selectedEnvironmentName) {
            await this.refreshStatus(targetDocument);
            return;
        }

        await this.rememberEnvironment(environmentContext.environmentStorageKey, selectedEnvironmentName);
        await this.refreshStatus(targetDocument);
    }

    public async refreshStatus(document?: TextDocument): Promise<void> {
        const targetDocument = document ?? window.activeTextEditor?.document;
        if (!targetDocument || targetDocument.languageId !== 'http' || targetDocument.uri.scheme !== 'file') {
            this.statusItem.hide();
            return;
        }

        const environmentContext = await this.getEnvironmentContext(targetDocument);
        const environmentLabel = environmentContext.effectiveEnvironmentName
            ? environmentContext.effectiveEnvironmentName
            : environmentContext.availableEnvironmentNames.length > 0
                ? 'select env'
                : 'no env';
        const statusText = `ijhttp: ${environmentLabel} - ${this.lastRunState}`;
        this.statusItem.text = this.lastRunState === 'running' ? `$(sync~spin) ${statusText}` : statusText;
        this.statusItem.tooltip = this.buildStatusTooltip(environmentContext);
        this.statusItem.show();
    }

    public dispose(): void {
        this.statusItem.dispose();
    }

    private createActiveLineRange(targetDocument: TextDocument): Range | undefined {
        const activeEditor = window.activeTextEditor;
        if (!activeEditor || activeEditor.document.uri.toString() !== targetDocument.uri.toString()) {
            return undefined;
        }

        const activeLine = activeEditor.selection.active.line;
        return new Range(activeLine, 0, activeLine, activeEditor.document.lineAt(activeLine).text.length);
    }

    private async getRuntimeSettings(targetDocument: TextDocument): Promise<IjHttpRuntimeSettings> {
        const configuration = workspace.getConfiguration('ijhttp-client', targetDocument.uri);
        const executablePath = configuration.get<string>('ijhttpPath', 'ijhttp').trim() || 'ijhttp';
        const logLevel = configuration.get<string>('logLevel', 'BASIC').trim() || 'BASIC';
        const environmentContext = await this.getEnvironmentContext(targetDocument);
        const environmentName = await this.resolveEnvironmentName(environmentContext);

        return {
            executablePath,
            environmentName,
            publicEnvironmentFile: environmentContext.publicEnvironmentFile,
            privateEnvironmentFile: environmentContext.privateEnvironmentFile,
            logLevel,
        };
    }

    private async resolveEnvironmentName(environmentContext: EnvironmentContext): Promise<string> {
        if (environmentContext.configuredEnvironmentName) {
            return environmentContext.configuredEnvironmentName;
        }

        if (environmentContext.rememberedEnvironmentName) {
            return environmentContext.rememberedEnvironmentName;
        }

        if (environmentContext.availableEnvironmentNames.length === 0) {
            return '';
        }

        const selectedEnvironmentName = await this.promptForEnvironment(environmentContext);
        if (!selectedEnvironmentName) {
            throw new Error('Environment selection was cancelled.');
        }

        await this.rememberEnvironment(environmentContext.environmentStorageKey, selectedEnvironmentName);
        return selectedEnvironmentName;
    }

    private async getEnvironmentContext(targetDocument: TextDocument): Promise<EnvironmentContext> {
        const configuration = workspace.getConfiguration('ijhttp-client', targetDocument.uri);
        const configuredEnvironmentName = configuration.get<string>('environment', '').trim();
        const publicEnvironmentFile = await this.resolveEnvironmentFile(
            configuration.get<string>('envFile', '').trim(),
            Constants.PublicEnvironmentFileName,
            targetDocument
        );
        const privateEnvironmentFile = await this.resolveEnvironmentFile(
            configuration.get<string>('privateEnvFile', '').trim(),
            Constants.PrivateEnvironmentFileName,
            targetDocument
        );
        const environmentStorageKey = this.getEnvironmentStorageKey(publicEnvironmentFile, privateEnvironmentFile);
        const availableEnvironmentNames = await this.readAvailableEnvironmentNames(publicEnvironmentFile, privateEnvironmentFile);
        const rememberedEnvironmentName = this.getRememberedEnvironment(environmentStorageKey, availableEnvironmentNames);
        const effectiveEnvironmentName = configuredEnvironmentName || rememberedEnvironmentName;

        return {
            configuredEnvironmentName,
            rememberedEnvironmentName,
            effectiveEnvironmentName,
            publicEnvironmentFile,
            privateEnvironmentFile,
            availableEnvironmentNames,
            environmentStorageKey,
        };
    }

    private async resolveEnvironmentFile(configuredPath: string, defaultFileName: string, targetDocument: TextDocument): Promise<string | undefined> {
        if (configuredPath) {
            const resolvedPath = await this.resolveConfiguredPath(configuredPath, targetDocument);
            if (resolvedPath) {
                return resolvedPath;
            }

            this.outputChannel.appendLine(`Configured file was not found: ${configuredPath}`);
            return undefined;
        }

        return this.autoDiscoverEnvironmentFile(defaultFileName, targetDocument);
    }

    private async resolveConfiguredPath(configuredPath: string, targetDocument: TextDocument): Promise<string | undefined> {
        if (path.isAbsolute(configuredPath)) {
            return await this.fileExists(configuredPath) ? configuredPath : undefined;
        }

        const documentDirectory = path.dirname(targetDocument.fileName);
        const localCandidate = path.resolve(documentDirectory, configuredPath);
        if (await this.fileExists(localCandidate)) {
            return localCandidate;
        }

        const workspaceFolder = workspace.getWorkspaceFolder(targetDocument.uri);
        if (!workspaceFolder) {
            return undefined;
        }

        const workspaceCandidate = path.resolve(workspaceFolder.uri.fsPath, configuredPath);
        return await this.fileExists(workspaceCandidate) ? workspaceCandidate : undefined;
    }

    private async autoDiscoverEnvironmentFile(fileName: string, targetDocument: TextDocument): Promise<string | undefined> {
        const workspaceFolder = workspace.getWorkspaceFolder(targetDocument.uri);
        const workspaceRoot = workspaceFolder?.uri.fsPath;
        let currentDirectory = path.dirname(targetDocument.fileName);

        while (true) {
            const candidatePath = path.join(currentDirectory, fileName);
            if (await this.fileExists(candidatePath)) {
                return candidatePath;
            }

            if (!workspaceRoot || currentDirectory === workspaceRoot) {
                break;
            }

            const parentDirectory = path.dirname(currentDirectory);
            if (parentDirectory === currentDirectory) {
                break;
            }

            currentDirectory = parentDirectory;
        }

        if (!workspaceRoot) {
            return undefined;
        }

        const workspaceCandidate = path.join(workspaceRoot, fileName);
        return await this.fileExists(workspaceCandidate) ? workspaceCandidate : undefined;
    }

    private async ensureExecutable(executablePath: string, workingDirectory: string): Promise<void> {
        if (this.validatedExecutables.has(executablePath)) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const processHandle = spawn(executablePath, ['--version'], { cwd: workingDirectory });
            let errorOutput = '';

            processHandle.stderr.on('data', chunk => {
                errorOutput += chunk.toString();
            });

            processHandle.on('error', error => {
                reject(new Error(`Unable to start ijhttp executable "${executablePath}": ${error.message}`));
            });

            processHandle.on('close', exitCode => {
                if (exitCode === 0) {
                    this.validatedExecutables.add(executablePath);
                    resolve();
                    return;
                }

                reject(new Error(errorOutput.trim() || `ijhttp --version exited with code ${exitCode}`));
            });
        }).catch(error => {
            window.showErrorMessage(error.message);
            throw error;
        });
    }

    private async readEnvironmentNames(environmentFilePath: string): Promise<string[]> {
        try {
            const fileContent = await fileSystem.readFile(environmentFilePath, 'utf8');
            const parsedContent = JSON.parse(fileContent) as Record<string, unknown>;
            if (!parsedContent || Array.isArray(parsedContent) || typeof parsedContent !== 'object') {
                return [];
            }

            return Object.keys(parsedContent).filter(environmentName =>
                environmentName.trim().length > 0 && !environmentName.startsWith('$')
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Unable to read environments from ${environmentFilePath}: ${message}`);
            window.showWarningMessage(`Unable to read environments from ${path.basename(environmentFilePath)}.`);
            return [];
        }
    }

    private async readAvailableEnvironmentNames(
        publicEnvironmentFile: string | undefined,
        privateEnvironmentFile: string | undefined
    ): Promise<string[]> {
        const environmentNames = new Set<string>();
        if (publicEnvironmentFile) {
            for (const environmentName of await this.readEnvironmentNames(publicEnvironmentFile)) {
                environmentNames.add(environmentName);
            }
        }

        if (privateEnvironmentFile) {
            for (const environmentName of await this.readEnvironmentNames(privateEnvironmentFile)) {
                environmentNames.add(environmentName);
            }
        }

        return [...environmentNames].sort((leftName, rightName) => leftName.localeCompare(rightName));
    }

    private async promptForEnvironment(
        environmentContext: EnvironmentContext,
        currentEnvironmentName?: string
    ): Promise<string | undefined> {
        const quickPickItems: QuickPickItem[] = environmentContext.availableEnvironmentNames.map(environmentName => ({
            label: environmentName,
            description: environmentName === currentEnvironmentName ? 'current' : undefined,
        }));

        const selectedItem = await window.showQuickPick(quickPickItems, {
            title: 'Select ijhttp environment',
            placeHolder: this.buildEnvironmentPlaceHolder(environmentContext),
            ignoreFocusOut: true,
        });

        return selectedItem?.label;
    }

    private getRememberedEnvironment(environmentStorageKey: string, availableEnvironmentNames: string[]): string | undefined {
        const rememberedEnvironmentName = this.globalState.get<string>(environmentStorageKey);
        if (!rememberedEnvironmentName) {
            return undefined;
        }

        return availableEnvironmentNames.includes(rememberedEnvironmentName) ? rememberedEnvironmentName : undefined;
    }

    private async rememberEnvironment(environmentStorageKey: string, environmentName: string): Promise<void> {
        await this.globalState.update(environmentStorageKey, environmentName);
    }

    private getEnvironmentStorageKey(
        publicEnvironmentFile: string | undefined,
        privateEnvironmentFile: string | undefined
    ): string {
        return `${IjHttpCliRunner.rememberedEnvironmentPrefix}:${publicEnvironmentFile ?? ''}:${privateEnvironmentFile ?? ''}`;
    }

    private buildTemporaryFilePath(sourceFilePath: string): string {
        const sourceDirectory = path.dirname(sourceFilePath);
        const sourceName = path.basename(sourceFilePath, path.extname(sourceFilePath));
        return path.join(sourceDirectory, `.${sourceName}.ijhttp-current-request.${process.pid}.${Date.now()}.http`);
    }

    private normalizeBlockText(blockText: string): string {
        return blockText.endsWith('\n') ? blockText : `${blockText}\n`;
    }

    private buildArgumentList(runtimeSettings: IjHttpRuntimeSettings, temporaryFile: string): string[] {
        const argumentList: string[] = [];
        if (runtimeSettings.publicEnvironmentFile) {
            argumentList.push('--env-file', runtimeSettings.publicEnvironmentFile);
        }

        if (runtimeSettings.privateEnvironmentFile) {
            argumentList.push('--private-env-file', runtimeSettings.privateEnvironmentFile);
        }

        if (runtimeSettings.environmentName) {
            argumentList.push('--env', runtimeSettings.environmentName);
        }

        argumentList.push('-L', runtimeSettings.logLevel, temporaryFile);
        return argumentList;
    }

    private async runProcess(executablePath: string, argumentList: string[], workingDirectory: string): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const processHandle = spawn(executablePath, argumentList, { cwd: workingDirectory });

            processHandle.stdout.on('data', chunk => {
                this.outputChannel.append(chunk.toString());
            });

            processHandle.stderr.on('data', chunk => {
                this.outputChannel.append(chunk.toString());
            });

            processHandle.on('error', error => {
                reject(new Error(`Unable to start ijhttp: ${error.message}`));
            });

            processHandle.on('close', exitCode => {
                resolve(exitCode ?? 1);
            });
        });
    }

    private async removeTemporaryFile(temporaryFile: string): Promise<void> {
        try {
            await fileSystem.unlink(temporaryFile);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Warning: failed to remove temporary file ${temporaryFile}: ${message}`);
        }
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fileSystem.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    private quoteArgument(argumentValue: string): string {
        if (!argumentValue.includes(' ')) {
            return argumentValue;
        }

        return `"${argumentValue.replace(/"/g, '\\"')}"`;
    }

    private buildEnvironmentPlaceHolder(environmentContext: EnvironmentContext): string {
        const sourceLabels = [environmentContext.publicEnvironmentFile, environmentContext.privateEnvironmentFile]
            .filter((filePath): filePath is string => !!filePath)
            .map(filePath => path.basename(filePath));
        if (sourceLabels.length === 0) {
            return 'Choose an environment';
        }

        return `Choose an environment from ${sourceLabels.join(', ')}`;
    }

    private buildStatusTooltip(environmentContext: EnvironmentContext): string {
        const lines = [
            `Environment: ${environmentContext.effectiveEnvironmentName ?? 'not selected'}`,
            `Last result: ${this.lastRunState}`,
        ];
        if (environmentContext.publicEnvironmentFile) {
            lines.push(`Public env file: ${environmentContext.publicEnvironmentFile}`);
        }
        if (environmentContext.privateEnvironmentFile) {
            lines.push(`Private env file: ${environmentContext.privateEnvironmentFile}`);
        }
        if (!environmentContext.configuredEnvironmentName && environmentContext.availableEnvironmentNames.length > 0) {
            lines.push('Click to choose environment.');
        }

        return lines.join('\n');
    }
}
