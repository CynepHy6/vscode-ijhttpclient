import * as path from 'path';
import * as Constants from '../common/constants';

export interface HistoryCommentLink {
    pathText: string;
    startCharacter: number;
    endCharacter: number;
}

export function parseHistoryCommentLink(lineText: string): HistoryCommentLink | undefined {
    const historyMatch = Constants.HistoryCommentLineRegex.exec(lineText);
    if (!historyMatch) {
        return undefined;
    }

    const pathText = historyMatch[1];
    const startCharacter = lineText.indexOf(pathText);
    if (startCharacter < 0) {
        return undefined;
    }

    return {
        pathText,
        startCharacter,
        endCharacter: startCharacter + pathText.length,
    };
}

export function resolveHistoryCommentTarget(documentDirectory: string, pathText: string): string {
    return path.resolve(documentDirectory, pathText);
}
