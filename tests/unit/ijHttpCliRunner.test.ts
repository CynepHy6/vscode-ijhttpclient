// @ts-nocheck
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspace, window, Range, resetVscodeMocks } from 'vscode';
import { IjHttpCliRunner } from '../../src/ijhttp/ijHttpCliRunner';
import { Selector } from '../../src/utils/selector';

function createOutputChannel() {
    return {
        appendLine: vi.fn(),
        show: vi.fn(),
    };
}

function createGlobalState() {
    return {
        get: vi.fn(),
        update: vi.fn(),
    };
}

function createMutableTextDocument(fileName: string, initialText: string) {
    let documentText = initialText;

    const getLines = (): string[] => documentText.split('\n');

    return {
        fileName,
        uri: { scheme: 'file', toString: () => fileName, fsPath: fileName },
        languageId: 'http',
        isClosed: false,
        get lineCount() {
            return getLines().length;
        },
        getText() {
            return documentText;
        },
        lineAt(lineNumber: number) {
            return { text: getLines()[lineNumber] ?? '' };
        },
        save: vi.fn(async () => true),
        setText(nextText: string) {
            documentText = nextText;
        },
    };
}

function installWorkspaceEditMock(targetDocument: ReturnType<typeof createMutableTextDocument>): void {
    workspace.applyEdit.mockImplementation(async (workspaceEdit: { insertions: Array<{ position: { line: number; character: number }; text: string }> }) => {
        let updatedText = targetDocument.getText();
        const sortedInsertions = [...workspaceEdit.insertions].sort((leftInsertion, rightInsertion) => {
            if (leftInsertion.position.line === rightInsertion.position.line) {
                return rightInsertion.position.character - leftInsertion.position.character;
            }

            return rightInsertion.position.line - leftInsertion.position.line;
        });

        for (const insertion of sortedInsertions) {
            const beforeLines = updatedText.split('\n');
            let offset = 0;
            for (let index = 0; index < insertion.position.line; index++) {
                offset += (beforeLines[index] ?? '').length + 1;
            }
            offset += insertion.position.character;
            updatedText = `${updatedText.slice(0, offset)}${insertion.text}${updatedText.slice(offset)}`;
        }

        targetDocument.setText(updatedText);
        return true;
    });
}

describe('IjHttpCliRunner unit regressions', () => {
    beforeEach(() => {
        resetVscodeMocks();
    });

    it('strips ordinary comments from full-document execution text', () => {
        const runner = new IjHttpCliRunner(createOutputChannel() as never, createGlobalState() as never) as never;
        const buildTemporaryDocumentText = runner['buildTemporaryDocumentText'].bind(runner) as (document: { getText: () => string }) => string;
        const documentText = [
            '### first',
            '# @name first',
            'GET https://example.com/first',
            '',
            '### second',
            '# @name second',
            'POST https://example.com/second',
            '',
            '{',
            '# remove this commented template',
            '  "message": "hello"',
            '}',
            '',
            '# <> ./.response/older.response',
        ].join('\n');

        const temporaryDocumentText = buildTemporaryDocumentText({
            getText: () => documentText,
        });

        expect(temporaryDocumentText).toContain('# @name first');
        expect(temporaryDocumentText).toContain('POST https://example.com/second');
        expect(temporaryDocumentText).toContain('"message": "hello"');
        expect(temporaryDocumentText).not.toContain('# remove this commented template');
        expect(temporaryDocumentText).not.toContain('# <> ./.response/older.response');
    });

    it('writes fallback response dumps with the .response extension', async () => {
        const runner = new IjHttpCliRunner(createOutputChannel() as never, createGlobalState() as never) as never;
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ijhttp-runner-test-'));
        const captureFilePath = join(temporaryDirectory, 'capture.response');

        try {
            const finalizeFallbackResponseCapture = runner['finalizeFallbackResponseCapture'].bind(runner) as (
                context: { captureFilePath: string },
                runResult: { responseStatusCode?: number; responseContentType?: string; outputLines: string[] }
            ) => Promise<string | undefined>;

            const fileName = await finalizeFallbackResponseCapture(
                { captureFilePath },
                {
                    responseStatusCode: 401,
                    responseContentType: 'application/json',
                    outputLines: ['HTTP/2 401 Unauthorized', '{"error":"bad token"}'],
                }
            );

            expect(fileName).toMatch(/\.401\.response$/);
            const savedFileContent = await readFile(join(temporaryDirectory, fileName as string), 'utf8');
            expect(savedFileContent).toContain('HTTP/2 401 Unauthorized');
            expect(savedFileContent).toContain('{"error":"bad token"}');
        } finally {
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    });

    it('persists response history even when ijhttp exits with an error', async () => {
        const outputChannel = createOutputChannel();
        const runner = new IjHttpCliRunner(outputChannel as never, createGlobalState() as never) as never;
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ijhttp-runner-test-'));
        const documentFilePath = join(temporaryDirectory, 'request.http');
        const targetDocument = {
            fileName: documentFilePath,
            uri: { scheme: 'file', toString: () => documentFilePath },
            languageId: 'http',
        };

        try {
            const persistResponseHistory = vi.fn(async () => undefined);
            runner['getRunnableDocument'] = vi.fn().mockReturnValue(targetDocument);
            runner['createActiveLineRange'] = vi.fn().mockReturnValue(new Range(0, 0, 0, 0));
            runner['getValidatedRuntimeSettings'] = vi.fn().mockResolvedValue({
                executablePath: 'ijhttp',
                environmentName: '',
                logLevel: 'VERBOSE',
            });
            runner['prepareResponseCapture'] = vi.fn().mockResolvedValue({
                captureFilePath: join(temporaryDirectory, 'capture.response'),
            });
            runner['buildArgumentList'] = vi.fn().mockReturnValue(['request.http']);
            runner['runProcess'] = vi.fn().mockResolvedValue({
                exitCode: 1,
                requestCaptures: [],
                outputLines: ['HTTP/2 401 Unauthorized', '{"error":"bad token"}'],
            });
            runner['persistResponseHistory'] = persistResponseHistory;
            runner['refreshStatus'] = vi.fn().mockResolvedValue(undefined);
            runner['cleanupResponseCapture'] = vi.fn().mockResolvedValue(undefined);
            runner['removeTemporaryFile'] = vi.fn().mockResolvedValue(undefined);
            vi.spyOn(Selector, 'getRequestBlock').mockReturnValue({
                text: 'GET https://example.com/protected',
                range: new Range(0, 0, 0, 33),
            });

            await runner.runCurrentRequest(targetDocument);

            expect(persistResponseHistory).toHaveBeenCalledTimes(1);
            expect(window.showErrorMessage).toHaveBeenCalledWith('ijhttp finished with exit code 1.');
        } finally {
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    });

    it('places the first history link after one blank line and appends subsequent links contiguously', async () => {
        const runner = new IjHttpCliRunner(createOutputChannel() as never, createGlobalState() as never) as never;
        const targetDocument = createMutableTextDocument(
            '/tmp/request.http',
            [
                'POST https://example.com/api/update',
                'Content-Type: application/json',
                '',
                '{',
                '  "message": "hello"',
                '}',
            ].join('\n')
        );
        installWorkspaceEditMock(targetDocument);

        const appendHistoryComment = runner['appendHistoryComment'].bind(runner) as (
            document: typeof targetDocument,
            requestRange: Range,
            historyCommentLine: string
        ) => Promise<void>;
        const requestRange = new Range(0, 0, 5, 1);

        await appendHistoryComment(targetDocument, requestRange, '# <> ./.response/first.response');
        expect(targetDocument.getText()).toBe([
            'POST https://example.com/api/update',
            'Content-Type: application/json',
            '',
            '{',
            '  "message": "hello"',
            '}',
            '',
            '# <> ./.response/first.response',
        ].join('\n'));

        await appendHistoryComment(targetDocument, requestRange, '# <> ./.response/second.response');
        expect(targetDocument.getText()).toBe([
            'POST https://example.com/api/update',
            'Content-Type: application/json',
            '',
            '{',
            '  "message": "hello"',
            '}',
            '',
            '# <> ./.response/first.response',
            '# <> ./.response/second.response',
        ].join('\n'));
    });
});
