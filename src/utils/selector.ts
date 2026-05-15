import { EOL } from 'os';
import { Range, TextDocument } from 'vscode';
import * as Constants from '../common/constants';

export interface RequestRangeOptions {
    ignoreCommentLine?: boolean;
    ignoreEmptyLine?: boolean;
    ignoreFileVariableDefinitionLine?: boolean;
    ignoreResponseRange?: boolean;
}

export interface SelectedRequestBlock {
    text: string;
    range: Range;
}

export class Selector {
    public static getRequestBlock(document: TextDocument, range: Range | null = null): SelectedRequestBlock | null {
        const activeLine = range?.start.line ?? 0;
        const text = this.getDelimitedText(document.getText(), activeLine);
        if (text === null) {
            return null;
        }

        const lines = document.getText().split(Constants.LineSplitterRegex);
        const blockRange = this.findBlockRange(lines, activeLine);
        if (!blockRange) {
            return null;
        }

        return {
            text,
            range: new Range(blockRange[0], 0, blockRange[1], document.lineAt(blockRange[1]).text.length),
        };
    }

    public static getRequestRanges(lines: string[], options?: RequestRangeOptions): [number, number][] {
        options = {
            ignoreCommentLine: true,
            ignoreEmptyLine: true,
            ignoreFileVariableDefinitionLine: true,
            ignoreResponseRange: true,
            ...options
        };
        const requestRanges: [number, number][] = [];
        const delimitedLines = this.getDelimiterRows(lines);
        delimitedLines.push(lines.length);

        let prev = -1;
        for (const current of delimitedLines) {
            let start = prev + 1;
            let end = current - 1;
            while (start <= end) {
                const startLine = lines[start];
                if (options.ignoreResponseRange && this.isResponseStatusLine(startLine)) {
                    break;
                }

                if (options.ignoreCommentLine && this.isCommentLine(startLine)
                    || options.ignoreEmptyLine && this.isEmptyLine(startLine)
                    || options.ignoreFileVariableDefinitionLine && this.isFileVariableDefinitionLine(startLine)) {
                    start++;
                    continue;
                }

                const endLine = lines[end];
                if (options.ignoreCommentLine && this.isCommentLine(endLine)
                    || options.ignoreEmptyLine && this.isEmptyLine(endLine)) {
                    end--;
                    continue;
                }

                requestRanges.push([start, end]);
                break;
            }
            prev = current;
        }

        return requestRanges;
    }

    public static isCommentLine(line: string): boolean {
        return Constants.CommentLineRegex.test(line);
    }

    public static isEmptyLine(line: string): boolean {
        return line.trim() === '';
    }

    public static isRequestVariableDefinitionLine(line: string): boolean {
        return Constants.FileVariableDefinitionRegex.test(line);
    }

    public static isFileVariableDefinitionLine(line: string): boolean {
        return Constants.FileVariableDefinitionRegex.test(line);
    }

    public static isResponseStatusLine(line: string): boolean {
        return Constants.ResponseStatusLineRegex.test(line);
    }

    public static getDelimitedText(fullText: string, currentLine: number): string | null {
        const lines: string[] = fullText.split(Constants.LineSplitterRegex);
        const delimiterLineNumbers: number[] = this.getDelimiterRows(lines);
        if (delimiterLineNumbers.length === 0) {
            return fullText;
        }

        // return null if cursor is in delimiter line
        if (delimiterLineNumbers.includes(currentLine)) {
            return null;
        }

        if (currentLine < delimiterLineNumbers[0]) {
            return lines.slice(0, delimiterLineNumbers[0]).join(EOL);
        }

        if (currentLine > delimiterLineNumbers[delimiterLineNumbers.length - 1]) {
            return lines.slice(delimiterLineNumbers[delimiterLineNumbers.length - 1] + 1).join(EOL);
        }

        for (let index = 0; index < delimiterLineNumbers.length - 1; index++) {
            const start = delimiterLineNumbers[index];
            const end = delimiterLineNumbers[index + 1];
            if (start < currentLine && currentLine < end) {
                return lines.slice(start + 1, end).join(EOL);
            }
        }

        return null;
    }

    public static getDelimiterRows(lines: string[]): number[] {
        return Object.entries(lines)
            .filter(([, value]) => Constants.DelimiterLineRegex.test(value))
            .map(([index]) => +index);
    }

    private static findBlockRange(lines: string[], currentLine: number): [number, number] | null {
        const delimiterLineNumbers = this.getDelimiterRows(lines);
        if (delimiterLineNumbers.includes(currentLine)) {
            return null;
        }

        let startLine = 0;
        let endLine = lines.length - 1;

        for (const delimiterLine of delimiterLineNumbers) {
            if (delimiterLine < currentLine) {
                startLine = delimiterLine + 1;
                continue;
            }

            endLine = delimiterLine - 1;
            break;
        }

        return [startLine, Math.max(startLine, endLine)];
    }
}