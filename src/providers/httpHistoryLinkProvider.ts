import { promises as fileSystem } from 'fs';
import * as path from 'path';
import {
    CancellationToken,
    Disposable,
    DocumentLink,
    DocumentLinkProvider,
    languages,
    Range,
    TextDocument,
    Uri,
    window,
    workspace
} from 'vscode';
import * as Constants from '../common/constants';
import { parseHistoryCommentLink, resolveHistoryCommentTarget } from '../utils/historyComment';

export class HistoryDocumentLink extends DocumentLink {
    public constructor(range: Range, public readonly targetPath: string) {
        super(range);
    }
}

export class HttpHistoryLinkProvider implements DocumentLinkProvider<HistoryDocumentLink>, Disposable {
    private readonly responseWatcher = workspace.createFileSystemWatcher('**/.response/**');

    public constructor() {
        this.responseWatcher.onDidCreate(() => void this.refreshVisibleHttpDocuments());
        this.responseWatcher.onDidDelete(() => void this.refreshVisibleHttpDocuments());
        this.responseWatcher.onDidChange(() => void this.refreshVisibleHttpDocuments());
    }

    public dispose(): void {
        this.responseWatcher.dispose();
    }

    public async provideDocumentLinks(document: TextDocument, _token: CancellationToken): Promise<HistoryDocumentLink[]> {
        if (document.uri.scheme !== 'file' || !document.fileName) {
            return [];
        }

        const documentDirectory = path.dirname(document.fileName);
        const documentLinks: HistoryDocumentLink[] = [];
        const documentLines = document.getText().split(Constants.LineSplitterRegex);

        for (let lineNumber = 0; lineNumber < documentLines.length; lineNumber++) {
            const historyCommentLink = parseHistoryCommentLink(documentLines[lineNumber]);
            if (!historyCommentLink) {
                continue;
            }

            const targetPath = resolveHistoryCommentTarget(documentDirectory, historyCommentLink.pathText);
            if (!(await this.fileExists(targetPath))) {
                continue;
            }

            documentLinks.push(new HistoryDocumentLink(
                new Range(
                    lineNumber,
                    historyCommentLink.startCharacter,
                    lineNumber,
                    historyCommentLink.endCharacter
                ),
                targetPath
            ));
        }

        return documentLinks;
    }

    public async resolveDocumentLink(link: HistoryDocumentLink, _token: CancellationToken): Promise<HistoryDocumentLink> {
        if (!(await this.fileExists(link.targetPath))) {
            window.showWarningMessage(`Response file not found: ${link.targetPath}`);
            return link;
        }

        link.target = Uri.file(link.targetPath);
        return link;
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fileSystem.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    private async refreshVisibleHttpDocuments(): Promise<void> {
        for (const textEditor of window.visibleTextEditors) {
            if (textEditor.document.languageId !== 'http' || textEditor.document.uri.scheme !== 'file') {
                continue;
            }

            await languages.setTextDocumentLanguage(textEditor.document, 'http');
        }
    }
}
