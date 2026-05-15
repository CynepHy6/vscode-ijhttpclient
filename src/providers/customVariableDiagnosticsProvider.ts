import * as path from 'path';
import { Diagnostic, DiagnosticCollection, DiagnosticSeverity, Disposable, languages, Position, Range, TextDocument, workspace } from 'vscode';
import * as Constants from '../common/constants';
import { disposeAll } from '../utils/dispose';
import { Selector } from '../utils/selector';

export class IjHttpDiagnosticsProvider implements Disposable {
    private readonly diagnosticCollection: DiagnosticCollection = languages.createDiagnosticCollection('ijhttp-client');

    private disposables: Disposable[] = [this.diagnosticCollection];

    private readonly pendingDocuments = new Set<TextDocument>();

    private timer: NodeJS.Timeout | undefined;

    constructor() {
        this.disposables.push(
            workspace.onDidOpenTextDocument(document => this.queueDocument(document)),
            workspace.onDidChangeTextDocument(event => this.queueDocument(event.document)),
            workspace.onDidCloseTextDocument(document => this.clearDiagnostics(document)),
            workspace.onDidChangeConfiguration(() => this.queueAllDocuments())
        );
        this.queueAllDocuments();
    }

    public async checkDocument(document: TextDocument): Promise<Diagnostic[]> {
        if (!this.supportsDocument(document)) {
            this.diagnosticCollection.delete(document.uri);
            return [];
        }

        const diagnostics = this.buildDiagnostics(document);
        this.diagnosticCollection.set(document.uri, diagnostics);
        return diagnostics;
    }

    public dispose(): void {
        disposeAll(this.disposables);
        this.disposables = [];
    }

    private queueDocument(document: TextDocument): void {
        if (this.supportsDocument(document)) {
            this.pendingDocuments.add(document);
            this.startTimer();
        }
    }

    private queueAllDocuments(): void {
        workspace.textDocuments.forEach(document => this.queueDocument(document));
    }

    private startTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => {
            void this.flushPendingDocuments();
        }, 300);
    }

    private clearDiagnostics(document: TextDocument): void {
        this.diagnosticCollection.delete(document.uri);
        this.pendingDocuments.delete(document);
    }

    private async flushPendingDocuments(): Promise<void> {
        for (const document of this.pendingDocuments) {
            this.pendingDocuments.delete(document);
            if (document.isClosed) {
                continue;
            }

            await this.checkDocument(document);
        }
    }

    private supportsDocument(document: TextDocument): boolean {
        if (document.languageId === 'http') {
            return true;
        }

        const fileName = path.basename(document.fileName);
        return fileName === Constants.PublicEnvironmentFileName || fileName === Constants.PrivateEnvironmentFileName;
    }

    private buildDiagnostics(document: TextDocument): Diagnostic[] {
        if (document.languageId === 'http') {
            return this.buildHttpDiagnostics(document);
        }

        return this.buildEnvironmentDiagnostics(document);
    }

    private buildEnvironmentDiagnostics(document: TextDocument): Diagnostic[] {
        const diagnostics: Diagnostic[] = [];
        try {
            const parsedContent = JSON.parse(document.getText());
            if (!parsedContent || Array.isArray(parsedContent) || typeof parsedContent !== 'object') {
                diagnostics.push(new Diagnostic(
                    new Range(new Position(0, 0), new Position(0, Math.max(1, document.lineAt(0).text.length))),
                    'Environment file must contain a JSON object with environment names.',
                    DiagnosticSeverity.Error
                ));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid JSON.';
            diagnostics.push(new Diagnostic(
                new Range(new Position(0, 0), new Position(0, Math.max(1, document.lineAt(0).text.length))),
                message,
                DiagnosticSeverity.Error
            ));
        }

        return diagnostics;
    }

    private buildHttpDiagnostics(document: TextDocument): Diagnostic[] {
        const diagnostics: Diagnostic[] = [];
        const lines = document.getText().split(Constants.LineSplitterRegex);
        const blockRanges = this.collectBlockRanges(lines);

        this.validateScriptBlocks(lines, diagnostics);
        this.validateVariables(lines, diagnostics);

        for (const [startLine, endLine] of blockRanges) {
            this.validateRequestBlock(lines, startLine, endLine, diagnostics);
        }

        return diagnostics;
    }

    private collectBlockRanges(lines: string[]): [number, number][] {
        const blockRanges: [number, number][] = [];
        const delimiterRows = Selector.getDelimiterRows(lines);
        const boundaries = [-1, ...delimiterRows, lines.length];
        for (let index = 0; index < boundaries.length - 1; index++) {
            const startLine = boundaries[index] + 1;
            const endLine = boundaries[index + 1] - 1;
            if (startLine <= endLine) {
                blockRanges.push([startLine, endLine]);
            }
        }

        return blockRanges;
    }

    private validateScriptBlocks(lines: string[], diagnostics: Diagnostic[]): void {
        let currentScriptStart: number | undefined;

        lines.forEach((lineText, lineNumber) => {
            if (Constants.ScriptInlineRegex.test(lineText)) {
                currentScriptStart = undefined;
                return;
            }

            if (Constants.ScriptStartRegex.test(lineText)) {
                if (currentScriptStart !== undefined) {
                    diagnostics.push(this.createDiagnostic(lineNumber, lineText.length, 'Nested script blocks are not supported.', DiagnosticSeverity.Error));
                }

                currentScriptStart = lineNumber;
                return;
            }

            if (Constants.ScriptCloseRegex.test(lineText)) {
                if (currentScriptStart === undefined) {
                    diagnostics.push(this.createDiagnostic(lineNumber, lineText.length, 'Unexpected script block closing marker.', DiagnosticSeverity.Error));
                } else {
                    currentScriptStart = undefined;
                }
            }
        });

        if (currentScriptStart !== undefined) {
            const lineText = lines[currentScriptStart];
            diagnostics.push(this.createDiagnostic(currentScriptStart, lineText.length, 'Unclosed script block. Expected a closing `%}` line.', DiagnosticSeverity.Error));
        }
    }

    private validateVariables(lines: string[], diagnostics: Diagnostic[]): void {
        lines.forEach((lineText, lineNumber) => {
            const openingCount = this.countOccurrences(lineText, '{{');
            const closingCount = this.countOccurrences(lineText, '}}');
            if (openingCount !== closingCount) {
                diagnostics.push(this.createDiagnostic(lineNumber, lineText.length, 'Unbalanced variable braces in this line.', DiagnosticSeverity.Warning));
            }
        });
    }

    private validateRequestBlock(lines: string[], startLine: number, endLine: number, diagnostics: Diagnostic[]): void {
        const requestLineIndex = this.findRequestLine(lines, startLine, endLine);
        if (requestLineIndex === undefined) {
            const hasMeaningfulContent = lines.slice(startLine, endLine + 1).some(lineText => lineText.trim() !== '');
            if (hasMeaningfulContent) {
                diagnostics.push(this.createDiagnostic(startLine, lines[startLine].length, 'Request block does not contain a valid request line.', DiagnosticSeverity.Warning));
            }
            return;
        }

        const requestLine = lines[requestLineIndex];
        if (!Constants.RequestLineRegex.test(requestLine)) {
            diagnostics.push(this.createDiagnostic(requestLineIndex, requestLine.length, 'Invalid request line.', DiagnosticSeverity.Error));
            return;
        }

        let headerLineIndex = requestLineIndex + 1;
        while (headerLineIndex <= endLine) {
            const headerLine = lines[headerLineIndex];
            if (headerLine.trim() === '') {
                break;
            }

            if (Selector.isCommentLine(headerLine) || Constants.ScriptInlineRegex.test(headerLine)) {
                headerLineIndex++;
                continue;
            }

            if (Constants.ScriptStartRegex.test(headerLine)) {
                headerLineIndex = this.findScriptEnd(lines, headerLineIndex, endLine) + 1;
                continue;
            }

            if (this.isUrlContinuation(headerLine) || Constants.HeaderLineRegex.test(headerLine)) {
                headerLineIndex++;
                continue;
            }

            diagnostics.push(this.createDiagnostic(headerLineIndex, headerLine.length, 'Unexpected line in request headers. Expected a header, URL continuation, or blank line.', DiagnosticSeverity.Warning));
            headerLineIndex++;
        }
    }

    private findRequestLine(lines: string[], startLine: number, endLine: number): number | undefined {
        let lineIndex = startLine;
        while (lineIndex <= endLine) {
            const currentLine = lines[lineIndex];
            if (currentLine.trim() === '' || Selector.isCommentLine(currentLine) || Selector.isFileVariableDefinitionLine(currentLine)) {
                lineIndex++;
                continue;
            }

            if (Constants.MetadataLineRegex.test(currentLine)) {
                lineIndex++;
                continue;
            }

            if (Constants.ScriptInlineRegex.test(currentLine)) {
                lineIndex++;
                continue;
            }

            if (Constants.ScriptStartRegex.test(currentLine)) {
                lineIndex = this.findScriptEnd(lines, lineIndex, endLine) + 1;
                continue;
            }

            if (Constants.ResponseRedirectRegex.test(currentLine)) {
                lineIndex++;
                continue;
            }

            return lineIndex;
        }

        return undefined;
    }

    private findScriptEnd(lines: string[], startLine: number, endLine: number): number {
        for (let lineIndex = startLine + 1; lineIndex <= endLine; lineIndex++) {
            if (Constants.ScriptCloseRegex.test(lines[lineIndex])) {
                return lineIndex;
            }
        }

        return endLine;
    }

    private isUrlContinuation(lineText: string): boolean {
        return /^\s+[/?&].*$/.test(lineText);
    }

    private countOccurrences(lineText: string, tokenText: string): number {
        return lineText.split(tokenText).length - 1;
    }

    private createDiagnostic(lineNumber: number, lineLength: number, message: string, severity: DiagnosticSeverity): Diagnostic {
        const safeLength = Math.max(1, lineLength);
        return new Diagnostic(
            new Range(new Position(lineNumber, 0), new Position(lineNumber, safeLength)),
            message,
            severity
        );
    }
}
