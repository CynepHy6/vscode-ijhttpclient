// @ts-nocheck
import { createServer } from 'http';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspace, window, Range, resetVscodeMocks } from 'vscode';
import { IjHttpCliRunner } from '../../src/ijhttp/ijHttpCliRunner';

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
    const offsetAt = (lineNumber: number, characterNumber: number): number => {
        const lines = getLines();
        let offset = 0;
        for (let index = 0; index < lineNumber; index++) {
            offset += (lines[index] ?? '').length + 1;
        }

        return offset + characterNumber;
    };

    return {
        fileName,
        uri: { scheme: 'file', toString: () => fileName, fsPath: fileName },
        languageId: 'http',
        isClosed: false,
        get lineCount() {
            return getLines().length;
        },
        getText(range?: { start: { line: number; character: number }; end: { line: number; character: number } }) {
            if (!range) {
                return documentText;
            }

            return documentText.slice(
                offsetAt(range.start.line, range.start.character),
                offsetAt(range.end.line, range.end.character)
            );
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

describe('IjHttpCliRunner e2e', () => {
    beforeEach(() => {
        resetVscodeMocks();
    });

    it('executes a real request against a local server and writes a response dump plus ordered history links', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ijhttp-e2e-test-'));
        const requestFilePath = join(temporaryDirectory, 'request.http');
        const receivedBodies: string[] = [];
        const server = createServer((request, response) => {
            let requestBody = '';
            request.on('data', chunk => {
                requestBody += chunk.toString();
            });
            request.on('end', () => {
                receivedBodies.push(requestBody);
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ ok: true, requestNumber: receivedBodies.length }));
            });
        });

        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', () => resolve());
            });

            const serverAddress = server.address();
            if (!serverAddress || typeof serverAddress === 'string') {
                throw new Error('Unable to determine local test server port.');
            }

            const requestText = [
                '### local update',
                '# @name localUpdate',
                `POST http://127.0.0.1:${serverAddress.port}/update`,
                'Content-Type: application/json',
                '',
                '{',
                '# this comment must not reach the server',
                '  "message": "hello from e2e"',
                '}',
            ].join('\n');
            await writeFile(requestFilePath, requestText, 'utf8');

            const targetDocument = createMutableTextDocument(requestFilePath, requestText);
            installWorkspaceEditMock(targetDocument);
            targetDocument.save.mockImplementation(async () => {
                await writeFile(requestFilePath, targetDocument.getText(), 'utf8');
                return true;
            });

            workspace.getConfiguration.mockReturnValue({
                get: (key: string, defaultValue: unknown) => {
                    if (key === 'ijhttpPath') {
                        return 'ijhttp';
                    }
                    if (key === 'logLevel') {
                        return 'BASIC';
                    }
                    return defaultValue;
                },
            });
            workspace.getWorkspaceFolder.mockReturnValue({
                uri: { fsPath: temporaryDirectory },
            });

            const runner = new IjHttpCliRunner(createOutputChannel() as never, createGlobalState() as never);
            await runner.runCurrentRequest(targetDocument as never, new Range(2, 0, 2, 10));
            await runner.runCurrentRequest(targetDocument as never, new Range(2, 0, 2, 10));

            expect(receivedBodies).toHaveLength(2);
            expect(receivedBodies[0]).toBe('{\n  "message": "hello from e2e"\n}');
            expect(receivedBodies[1]).toBe('{\n  "message": "hello from e2e"\n}');

            const finalDocumentText = await readFile(requestFilePath, 'utf8');
            const historyLines = finalDocumentText.match(/^# <> \.\/\.response\/.+$/gm) ?? [];
            expect(historyLines).toHaveLength(2);
            expect(finalDocumentText).toContain('}\n\n# <> ./.response/');
            expect(finalDocumentText).toContain(`${historyLines[0]}\n${historyLines[1]}`);

            const firstResponsePath = join(temporaryDirectory, historyLines[0].replace('# <> ./', ''));
            const secondResponsePath = join(temporaryDirectory, historyLines[1].replace('# <> ./', ''));
            const firstResponseText = await readFile(firstResponsePath, 'utf8');
            const secondResponseText = await readFile(secondResponsePath, 'utf8');

            expect(firstResponseText).toContain('HTTP/1.1 200 OK');
            expect(firstResponseText).toContain('"ok":true');
            expect(secondResponseText).toContain('HTTP/1.1 200 OK');
            expect(secondResponseText).toContain('"requestNumber":2');
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }, 20000);

    it('parses a JSON response successfully inside a response-handler script', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ijhttp-e2e-json-test-'));
        const requestFilePath = join(temporaryDirectory, 'json-response.http');
        const server = createServer((request, response) => {
            if (request.url === '/json') {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({
                    message: 'parsed successfully',
                    nested: { count: 2 },
                }));
                return;
            }

            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: 'not found' }));
        });

        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', () => resolve());
            });

            const serverAddress = server.address();
            if (!serverAddress || typeof serverAddress === 'string') {
                throw new Error('Unable to determine local JSON test server port.');
            }

            const requestText = [
                '### json response',
                '# @name parseJsonResponse',
                `GET http://127.0.0.1:${serverAddress.port}/json`,
                'Accept: application/json',
                '',
                '> {%',
                '  client.test("response body json is parsed", function() {',
                '    client.assert(response.status === 200, "Expected HTTP 200");',
                '    client.assert(response.body.message === "parsed successfully", "Unexpected message");',
                '    client.assert(response.body.nested.count === 2, "Unexpected nested count");',
                '  });',
                '%}',
            ].join('\n');
            await writeFile(requestFilePath, requestText, 'utf8');

            const targetDocument = createMutableTextDocument(requestFilePath, requestText);
            installWorkspaceEditMock(targetDocument);
            targetDocument.save.mockImplementation(async () => {
                await writeFile(requestFilePath, targetDocument.getText(), 'utf8');
                return true;
            });

            workspace.getConfiguration.mockReturnValue({
                get: (key: string, defaultValue: unknown) => {
                    if (key === 'ijhttpPath') {
                        return 'ijhttp';
                    }
                    if (key === 'logLevel') {
                        return 'BASIC';
                    }
                    return defaultValue;
                },
            });
            workspace.getWorkspaceFolder.mockReturnValue({
                uri: { fsPath: temporaryDirectory },
            });

            const runner = new IjHttpCliRunner(createOutputChannel() as never, createGlobalState() as never);
            await runner.runCurrentRequest(targetDocument as never, new Range(2, 0, 2, 10));

            expect(window.showErrorMessage).not.toHaveBeenCalled();
            expect(window.showInformationMessage).toHaveBeenCalledWith('ijhttp finished successfully.');

            const finalDocumentText = await readFile(requestFilePath, 'utf8');
            const historyLine = finalDocumentText.match(/^# <> \.\/\.response\/.+$/m);
            expect(historyLine?.[0]).toBeTruthy();

            const responsePath = join(temporaryDirectory, historyLine![0].replace('# <> ./', ''));
            const responseText = await readFile(responsePath, 'utf8');
            expect(responseText).toContain('HTTP/1.1 200 OK');
            expect(responseText).toContain('"message":"parsed successfully"');
            expect(responseText).toContain('"count":2');
        } finally {
            await new Promise<void>((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
            await rm(temporaryDirectory, { recursive: true, force: true });
        }
    }, 20000);
});
