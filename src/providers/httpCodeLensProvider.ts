import { CancellationToken, CodeLens, CodeLensProvider, Command, Range, TextDocument, workspace } from 'vscode';
import * as Constants from '../common/constants';
import { Selector } from '../utils/selector';

export class HttpCodeLensProvider implements CodeLensProvider {
    public provideCodeLenses(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
        if (!workspace.getConfiguration('ijhttp-client', document.uri).get<boolean>('enableRunCodeLens', true)) {
            return Promise.resolve([]);
        }

        const blocks: CodeLens[] = [];
        const lines: string[] = document.getText().split(Constants.LineSplitterRegex);
        const requestRanges: [number, number][] = Selector.getRequestRanges(lines);

        if (requestRanges.length > 0) {
            const fileRange = new Range(0, 0, 0, 0);
            const runAllCommand: Command = {
                arguments: [document],
                title: 'Run all with ijhttp',
                command: 'ijhttp-client.runAllRequests'
            };
            blocks.push(new CodeLens(fileRange, runAllCommand));
        }

        for (const [blockStart, blockEnd] of requestRanges) {
            const range = new Range(blockStart, 0, blockEnd, 0);
            const cmd: Command = {
                arguments: [document, range],
                title: 'Run with ijhttp',
                command: 'ijhttp-client.runCurrentRequest'
            };
            blocks.push(new CodeLens(range, cmd));
        }

        return Promise.resolve(blocks);
    }
}