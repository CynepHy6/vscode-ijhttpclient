import { spawn } from 'child_process';
import { promises as fileSystem } from 'fs';
import * as path from 'path';
import {
    Disposable,
    Memento,
    OutputChannel,
    Position,
    QuickPickItem,
    Range,
    StatusBarAlignment,
    StatusBarItem,
    TextDocument,
    WorkspaceEdit,
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

interface ResponseCaptureContext {
    captureFilePath: string;
    captureRelativePath: string;
}

interface ResponseMetadata {
    responseStatusCode?: number;
    responseContentType?: string;
}

interface ResponseHistoryPlan {
    requestRange: Range;
    responseCaptureContext?: ResponseCaptureContext;
}

interface IjHttpRunResult extends ResponseMetadata {
    exitCode: number;
    responseMetadatas: ResponseMetadata[];
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
        const targetDocument = this.getRunnableDocument(document, 'Open an HTTP file to run a request with ijhttp.');
        if (!targetDocument) {
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

        const runtimeSettings = await this.getValidatedRuntimeSettings(targetDocument);
        if (!runtimeSettings) {
            return;
        }

        const temporaryFile = this.buildTemporaryFilePath(targetDocument.fileName, 'current-request');
        const responseCaptureContext = await this.prepareResponseCapture(targetDocument, requestBlock.text);
        const temporaryRequestText = this.buildTemporaryRequestText(requestBlock.text, responseCaptureContext?.captureRelativePath);
        await fileSystem.writeFile(temporaryFile, temporaryRequestText, 'utf8');

        const argumentList = this.buildArgumentList(runtimeSettings, temporaryFile, !!responseCaptureContext);
        const workingDirectory = path.dirname(targetDocument.fileName);
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`$ ${runtimeSettings.executablePath} ${argumentList.map(item => this.quoteArgument(item)).join(' ')}`);
        this.lastRunState = 'running';
        await this.refreshStatus(targetDocument);

        try {
            const runResult = await this.runProcess(runtimeSettings.executablePath, argumentList, workingDirectory);
            if (runResult.exitCode === 0) {
                await this.persistResponseHistory(targetDocument, requestBlock.range, responseCaptureContext, runResult);
                this.lastRunState = 'success';
                await this.refreshStatus(targetDocument);
                window.showInformationMessage('ijhttp finished successfully.');
            } else {
                this.lastRunState = `failed (${runResult.exitCode})`;
                await this.refreshStatus(targetDocument);
                window.showErrorMessage(`ijhttp finished with exit code ${runResult.exitCode}.`);
            }
        } finally {
            await this.cleanupResponseCapture(responseCaptureContext);
            await this.removeTemporaryFile(temporaryFile);
        }
    }

    public async runAllRequests(document?: TextDocument): Promise<void> {
        const targetDocument = this.getRunnableDocument(document, 'Open an HTTP file to run all requests with ijhttp.');
        if (!targetDocument) {
            return;
        }

        const documentLines = targetDocument.getText().split(Constants.LineSplitterRegex);
        const requestRanges = Selector.getRequestRanges(documentLines);
        if (requestRanges.length === 0) {
            window.showWarningMessage('No runnable request blocks were found in the current HTTP file.');
            return;
        }

        const runtimeSettings = await this.getValidatedRuntimeSettings(targetDocument);
        if (!runtimeSettings) {
            return;
        }

        const responseHistoryPlans = await this.prepareResponseHistoryPlans(targetDocument, requestRanges);
        const temporaryFile = this.buildTemporaryFilePath(targetDocument.fileName, 'all-requests');
        await fileSystem.writeFile(temporaryFile, this.buildTemporaryDocumentText(targetDocument, responseHistoryPlans), 'utf8');

        const needsResponseMetadata = responseHistoryPlans.some(plan => !!plan.responseCaptureContext);
        const argumentList = this.buildArgumentList(runtimeSettings, temporaryFile, needsResponseMetadata);
        const workingDirectory = path.dirname(targetDocument.fileName);
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`$ ${runtimeSettings.executablePath} ${argumentList.map(item => this.quoteArgument(item)).join(' ')}`);
        this.lastRunState = 'running';
        await this.refreshStatus(targetDocument);

        try {
            const runResult = await this.runProcess(runtimeSettings.executablePath, argumentList, workingDirectory);
            if (runResult.exitCode === 0) {
                await this.persistResponseHistories(targetDocument, responseHistoryPlans, runResult);
                this.lastRunState = 'success';
                await this.refreshStatus(targetDocument);
                window.showInformationMessage(`ijhttp finished successfully for ${requestRanges.length} request block(s).`);
            } else {
                this.lastRunState = `failed (${runResult.exitCode})`;
                await this.refreshStatus(targetDocument);
                window.showErrorMessage(`ijhttp finished with exit code ${runResult.exitCode}.`);
            }
        } finally {
            await this.cleanupResponseHistories(responseHistoryPlans);
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

    private getRunnableDocument(document: TextDocument | undefined, warningMessage: string): TextDocument | undefined {
        const activeEditor = window.activeTextEditor;
        const targetDocument = document ?? activeEditor?.document;
        if (!targetDocument || targetDocument.languageId !== 'http') {
            window.showWarningMessage(warningMessage);
            return undefined;
        }

        if (targetDocument.uri.scheme !== 'file') {
            window.showWarningMessage('ijhttp execution is only available for files stored on disk.');
            return undefined;
        }

        return targetDocument;
    }

    private async getValidatedRuntimeSettings(targetDocument: TextDocument): Promise<IjHttpRuntimeSettings | undefined> {
        try {
            const runtimeSettings = await this.getRuntimeSettings(targetDocument);
            await this.ensureExecutable(runtimeSettings.executablePath, path.dirname(targetDocument.fileName));
            return runtimeSettings;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === 'Environment selection was cancelled.') {
                this.outputChannel.appendLine('ijhttp run cancelled: environment selection was dismissed.');
                return undefined;
            }

            throw error;
        }
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

    private buildTemporaryFilePath(sourceFilePath: string, suffixLabel: string): string {
        const sourceDirectory = path.dirname(sourceFilePath);
        const sourceName = path.basename(sourceFilePath, path.extname(sourceFilePath));
        return path.join(sourceDirectory, `.${sourceName}.ijhttp-${suffixLabel}.${process.pid}.${Date.now()}.http`);
    }

    private normalizeBlockText(blockText: string): string {
        return blockText.endsWith('\n') ? blockText : `${blockText}\n`;
    }

    private buildArgumentList(runtimeSettings: IjHttpRuntimeSettings, temporaryFile: string, needsResponseMetadata: boolean): string[] {
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

        argumentList.push('-L', this.getEffectiveLogLevel(runtimeSettings.logLevel, needsResponseMetadata), temporaryFile);
        return argumentList;
    }

    private async runProcess(executablePath: string, argumentList: string[], workingDirectory: string): Promise<IjHttpRunResult> {
        return new Promise<IjHttpRunResult>((resolve, reject) => {
            const processHandle = spawn(executablePath, argumentList, { cwd: workingDirectory });
            let stdoutRemainder = '';
            let stderrRemainder = '';
            const runResult: IjHttpRunResult = { exitCode: 1, responseMetadatas: [] };

            processHandle.stdout.on('data', chunk => {
                stdoutRemainder = this.consumeProcessOutput(chunk.toString(), stdoutRemainder, runResult);
            });

            processHandle.stderr.on('data', chunk => {
                stderrRemainder = this.consumeProcessOutput(chunk.toString(), stderrRemainder, runResult);
            });

            processHandle.on('error', error => {
                reject(new Error(`Unable to start ijhttp: ${error.message}`));
            });

            processHandle.on('close', exitCode => {
                this.flushProcessOutput(stdoutRemainder, runResult);
                this.flushProcessOutput(stderrRemainder, runResult);
                runResult.exitCode = exitCode ?? 1;
                resolve(runResult);
            });
        });
    }

    private consumeProcessOutput(chunkText: string, previousRemainder: string, runResult: IjHttpRunResult): string {
        const cleanedText = this.stripAnsiSequences(chunkText)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n');
        const combinedText = `${previousRemainder}${cleanedText}`;
        const outputLines = combinedText.split('\n');
        const nextRemainder = outputLines.pop() ?? '';

        for (const outputLine of outputLines) {
            this.consumeOutputLine(outputLine, runResult);
        }

        return nextRemainder;
    }

    private flushProcessOutput(outputRemainder: string, runResult: IjHttpRunResult): void {
        if (outputRemainder.trim().length === 0) {
            return;
        }

        this.consumeOutputLine(outputRemainder, runResult);
    }

    private consumeOutputLine(outputLine: string, runResult: IjHttpRunResult): void {
        this.captureResponseMetadata(outputLine, runResult);
        this.appendOutputLine(outputLine);
    }

    private captureResponseMetadata(outputLine: string, runResult: IjHttpRunResult): void {
        const trimmedLine = outputLine.trim();
        const statusMatch = /^HTTP\/\S+\s+(\d{3})\b/i.exec(trimmedLine);
        if (statusMatch) {
            const responseStatusCode = Number(statusMatch[1]);
            runResult.responseStatusCode = responseStatusCode;
            runResult.responseMetadatas.push({ responseStatusCode });
            return;
        }

        const contentTypeMatch = /^content-type:\s*([^;]+)(?:;.*)?$/i.exec(trimmedLine);
        if (contentTypeMatch) {
            const responseContentType = contentTypeMatch[1].trim().toLowerCase();
            runResult.responseContentType = responseContentType;
            const currentResponseMetadata = runResult.responseMetadatas[runResult.responseMetadatas.length - 1];
            if (currentResponseMetadata) {
                currentResponseMetadata.responseContentType = responseContentType;
            }
        }
    }

    private appendOutputLine(outputLine: string): void {
        const trimmedLine = outputLine.trimEnd();
        if (!trimmedLine.trim()) {
            return;
        }

        if (this.isIjHttpNoiseLine(trimmedLine)) {
            return;
        }

        this.outputChannel.appendLine(trimmedLine);
    }

    private stripAnsiSequences(outputText: string): string {
        return outputText.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
    }

    private isIjHttpNoiseLine(outputLine: string): boolean {
        if (/setlocale:\s*LC_CTYPE/i.test(outputLine)) {
            return true;
        }

        if (/[┌┐└┘├┤┬┴┼│─━]/.test(outputLine)) {
            return true;
        }

        if (/^\s*\d+%\s+━+/.test(outputLine)) {
            return true;
        }

        if (/^(= request =>|<= response =)$/i.test(outputLine)) {
            return true;
        }

        if (/^[A-Za-z0-9-]+:\s+.+$/.test(outputLine)) {
            return true;
        }

        return false;
    }

    private async prepareResponseCapture(targetDocument: TextDocument, requestBlockText: string): Promise<ResponseCaptureContext | undefined> {
        if (Constants.ResponseRedirectRegex.test(requestBlockText)) {
            this.outputChannel.appendLine('Response history skipped: request already contains an explicit response redirect.');
            return undefined;
        }

        const responseDirectoryPath = path.join(path.dirname(targetDocument.fileName), '.response');
        await fileSystem.mkdir(responseDirectoryPath, { recursive: true });

        const captureFileName = `.ijhttp-response.${process.pid}.${Date.now()}.body`;
        return {
            captureFilePath: path.join(responseDirectoryPath, captureFileName),
            captureRelativePath: `./${path.posix.join('.response', captureFileName)}`,
        };
    }

    private buildTemporaryRequestText(requestBlockText: string, captureRelativePath?: string): string {
        const normalizedBlockText = this.normalizeBlockText(requestBlockText).replace(/\s+$/, '');
        if (!captureRelativePath) {
            return `${normalizedBlockText}\n`;
        }

        return `${normalizedBlockText}\n\n>>! ${captureRelativePath}\n`;
    }

    private getEffectiveLogLevel(logLevel: string, needsResponseMetadata: boolean): string {
        if (!needsResponseMetadata) {
            return logLevel;
        }

        return logLevel === 'BASIC' ? 'HEADERS' : logLevel;
    }

    private async persistResponseHistory(
        targetDocument: TextDocument,
        requestRange: Range,
        responseCaptureContext: ResponseCaptureContext | undefined,
        runResult: IjHttpRunResult
    ): Promise<void> {
        if (!responseCaptureContext) {
            return;
        }

        if (!(await this.fileExists(responseCaptureContext.captureFilePath))) {
            return;
        }

        const finalHistoryFileName = await this.finalizeResponseCapture(responseCaptureContext, runResult);
        const historyCommentLine = `# <> ./${path.posix.join('.response', finalHistoryFileName)}`;
        await this.appendHistoryComment(targetDocument, requestRange, historyCommentLine);
    }

    private async persistResponseHistories(
        targetDocument: TextDocument,
        responseHistoryPlans: ResponseHistoryPlan[],
        runResult: IjHttpRunResult
    ): Promise<void> {
        const historyEntries: Array<{ requestRange: Range; historyCommentLine: string }> = [];
        for (let planIndex = 0; planIndex < responseHistoryPlans.length; planIndex++) {
            const responseHistoryPlan = responseHistoryPlans[planIndex];
            if (!responseHistoryPlan.responseCaptureContext) {
                continue;
            }

            if (!(await this.fileExists(responseHistoryPlan.responseCaptureContext.captureFilePath))) {
                continue;
            }

            const responseMetadata = runResult.responseMetadatas[planIndex] ?? {};
            const finalHistoryFileName = await this.finalizeResponseCapture(responseHistoryPlan.responseCaptureContext, responseMetadata);
            historyEntries.push({
                requestRange: responseHistoryPlan.requestRange,
                historyCommentLine: `# <> ./${path.posix.join('.response', finalHistoryFileName)}`,
            });
        }

        historyEntries.sort((leftEntry, rightEntry) => rightEntry.requestRange.end.line - leftEntry.requestRange.end.line);
        for (const historyEntry of historyEntries) {
            await this.appendHistoryComment(targetDocument, historyEntry.requestRange, historyEntry.historyCommentLine);
        }
    }

    private async finalizeResponseCapture(responseCaptureContext: ResponseCaptureContext, responseMetadata: ResponseMetadata): Promise<string> {
        const responseExtension = this.getResponseFileExtension(responseMetadata.responseContentType);
        const statusCode = responseMetadata.responseStatusCode ?? 200;
        const baseFileName = `${this.formatTimestamp(new Date())}.${statusCode}.${responseExtension}`;
        const finalFilePath = await this.buildUniqueResponseFilePath(path.dirname(responseCaptureContext.captureFilePath), baseFileName);
        await fileSystem.rename(responseCaptureContext.captureFilePath, finalFilePath);
        return path.basename(finalFilePath);
    }

    private async appendHistoryComment(targetDocument: TextDocument, requestRange: Range, historyCommentLine: string): Promise<void> {
        const insertionLine = Math.min(requestRange.end.line + 1, targetDocument.lineCount);
        const previousLineText = targetDocument.lineAt(requestRange.end.line).text;
        const nextLineText = insertionLine < targetDocument.lineCount ? targetDocument.lineAt(insertionLine).text : '';
        const leadingSeparator = previousLineText.trim() === '' ? '' : '\n\n';
        const trailingSeparator = insertionLine < targetDocument.lineCount && nextLineText.trim() !== '' ? '\n' : '';
        const workspaceEdit = new WorkspaceEdit();
        workspaceEdit.insert(targetDocument.uri, new Position(insertionLine, 0), `${leadingSeparator}${historyCommentLine}${trailingSeparator}`);
        await workspace.applyEdit(workspaceEdit);
        await targetDocument.save();
    }

    private getResponseFileExtension(contentType?: string): string {
        if (!contentType) {
            return 'txt';
        }

        if (contentType.includes('json')) {
            return 'json';
        }

        if (contentType.includes('xml')) {
            return 'xml';
        }

        if (contentType === 'text/html') {
            return 'html';
        }

        if (contentType.startsWith('text/')) {
            return 'txt';
        }

        if (contentType.includes('javascript')) {
            return 'js';
        }

        if (contentType.includes('pdf')) {
            return 'pdf';
        }

        return 'bin';
    }

    private formatTimestamp(dateValue: Date): string {
        const year = dateValue.getFullYear();
        const month = `${dateValue.getMonth() + 1}`.padStart(2, '0');
        const day = `${dateValue.getDate()}`.padStart(2, '0');
        const hours = `${dateValue.getHours()}`.padStart(2, '0');
        const minutes = `${dateValue.getMinutes()}`.padStart(2, '0');
        const seconds = `${dateValue.getSeconds()}`.padStart(2, '0');
        return `${year}-${month}-${day}T${hours}${minutes}${seconds}`;
    }

    private async buildUniqueResponseFilePath(directoryPath: string, baseFileName: string): Promise<string> {
        const extension = path.extname(baseFileName);
        const baseName = path.basename(baseFileName, extension);
        let candidateFilePath = path.join(directoryPath, baseFileName);
        let suffixIndex = 1;

        while (await this.fileExists(candidateFilePath)) {
            candidateFilePath = path.join(directoryPath, `${baseName}-${suffixIndex}${extension}`);
            suffixIndex++;
        }

        return candidateFilePath;
    }

    private async cleanupResponseCapture(responseCaptureContext: ResponseCaptureContext | undefined): Promise<void> {
        if (!responseCaptureContext || !(await this.fileExists(responseCaptureContext.captureFilePath))) {
            return;
        }

        await this.removeTemporaryFile(responseCaptureContext.captureFilePath);
    }

    private async cleanupResponseHistories(responseHistoryPlans: ResponseHistoryPlan[]): Promise<void> {
        for (const responseHistoryPlan of responseHistoryPlans) {
            await this.cleanupResponseCapture(responseHistoryPlan.responseCaptureContext);
        }
    }

    private async prepareResponseHistoryPlans(
        targetDocument: TextDocument,
        requestRanges: [number, number][]
    ): Promise<ResponseHistoryPlan[]> {
        const responseHistoryPlans: ResponseHistoryPlan[] = [];
        for (const [requestStartLine, requestEndLine] of requestRanges) {
            const requestRange = new Range(
                requestStartLine,
                0,
                requestEndLine,
                targetDocument.lineAt(requestEndLine).text.length
            );
            const requestBlockText = targetDocument.getText(requestRange);
            const responseCaptureContext = await this.prepareResponseCapture(targetDocument, requestBlockText);
            responseHistoryPlans.push({
                requestRange,
                responseCaptureContext,
            });
        }

        return responseHistoryPlans;
    }

    private buildTemporaryDocumentText(targetDocument: TextDocument, responseHistoryPlans: ResponseHistoryPlan[]): string {
        let temporaryDocumentText = targetDocument.getText();
        const responseInsertions = responseHistoryPlans
            .filter((responseHistoryPlan): responseHistoryPlan is ResponseHistoryPlan & { responseCaptureContext: ResponseCaptureContext } =>
                !!responseHistoryPlan.responseCaptureContext)
            .map(responseHistoryPlan => ({
                offset: targetDocument.offsetAt(responseHistoryPlan.requestRange.end),
                text: `\n\n>>! ${responseHistoryPlan.responseCaptureContext.captureRelativePath}`,
            }))
            .sort((leftInsertion, rightInsertion) => rightInsertion.offset - leftInsertion.offset);

        for (const responseInsertion of responseInsertions) {
            temporaryDocumentText = `${temporaryDocumentText.slice(0, responseInsertion.offset)}${responseInsertion.text}${temporaryDocumentText.slice(responseInsertion.offset)}`;
        }

        return this.normalizeBlockText(temporaryDocumentText);
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
