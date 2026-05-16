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
        const lines = document.getText().split(Constants.LineSplitterRegex);
        const blockRange = this.findBlockRange(lines, activeLine);
        if (!blockRange) {
            return null;
        }

        const blockLines = lines.slice(blockRange[0], blockRange[1] + 1);
        const requestLineIndex = this.findRequestLineIndex(blockLines);
        const globalFileVariableLines = blockRange[0] > 0 ? this.getGlobalFileVariableLines(lines) : [];
        const localFileVariableLines = this.getLocalFileVariableLines(blockLines, requestLineIndex);
        const executableBlockLines = this.removeLocalFileVariableLines(blockLines, requestLineIndex);
        const text = this.joinExecutableSections([
            globalFileVariableLines,
            localFileVariableLines,
            executableBlockLines,
        ]);

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

    public static sanitizeExecutableText(sourceText: string): string {
        const sourceLines = sourceText.split(Constants.LineSplitterRegex);
        const sanitizedLines: string[] = [];
        let insideScriptBlock = false;

        for (const sourceLine of sourceLines) {
            if (insideScriptBlock) {
                sanitizedLines.push(sourceLine);
                if (Constants.ScriptCloseRegex.test(sourceLine)) {
                    insideScriptBlock = false;
                }
                continue;
            }

            if (Constants.ScriptInlineRegex.test(sourceLine)) {
                sanitizedLines.push(sourceLine);
                continue;
            }

            if (Constants.ScriptStartRegex.test(sourceLine)) {
                sanitizedLines.push(sourceLine);
                insideScriptBlock = true;
                continue;
            }

            if (Constants.DelimiterLineRegex.test(sourceLine)
                || Constants.MetadataLineRegex.test(sourceLine)
                || Constants.FileVariableDefinitionRegex.test(sourceLine)
                || Constants.ResponseRedirectRegex.test(sourceLine)
                || !this.isCommentLine(sourceLine)) {
                sanitizedLines.push(sourceLine);
            }
        }

        return sanitizedLines.join(EOL);
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

    public static getDelimiterRows(lines: string[]): number[] {
        return Object.entries(lines)
            .filter(([, value]) => Constants.DelimiterLineRegex.test(value))
            .map(([index]) => +index);
    }

    private static getGlobalFileVariableLines(lines: string[]): string[] {
        const firstDelimiterLine = this.getDelimiterRows(lines)[0] ?? lines.length;
        const globalPrefixLines = lines.slice(0, firstDelimiterLine);

        return globalPrefixLines.filter(lineText => this.isFileVariableDefinitionLine(lineText));
    }

    private static getLocalFileVariableLines(blockLines: string[], requestLineIndex: number | undefined): string[] {
        if (requestLineIndex === undefined) {
            return [];
        }

        return blockLines
            .slice(0, requestLineIndex)
            .filter(lineText => this.isFileVariableDefinitionLine(lineText));
    }

    private static removeLocalFileVariableLines(blockLines: string[], requestLineIndex: number | undefined): string[] {
        if (requestLineIndex === undefined) {
            return blockLines;
        }

        return blockLines.filter((lineText, lineIndex) =>
            lineIndex >= requestLineIndex || !this.isFileVariableDefinitionLine(lineText)
        );
    }

    private static joinExecutableSections(sectionLines: string[][]): string {
        const sectionTexts = sectionLines
            .map(lines => this.trimEmptyBoundaryLines(lines).join(EOL))
            .filter(sectionText => sectionText.length > 0);

        return sectionTexts.join(`${EOL}${EOL}`);
    }

    private static trimEmptyBoundaryLines(lines: string[]): string[] {
        let startIndex = 0;
        let endIndex = lines.length - 1;

        while (startIndex <= endIndex && this.isEmptyLine(lines[startIndex])) {
            startIndex++;
        }

        while (endIndex >= startIndex && this.isEmptyLine(lines[endIndex])) {
            endIndex--;
        }

        return lines.slice(startIndex, endIndex + 1);
    }

    private static findRequestLineIndex(blockLines: string[]): number | undefined {
        let insideScriptBlock = false;

        for (let lineIndex = 0; lineIndex < blockLines.length; lineIndex++) {
            const currentLine = blockLines[lineIndex];

            if (insideScriptBlock) {
                if (Constants.ScriptCloseRegex.test(currentLine)) {
                    insideScriptBlock = false;
                }
                continue;
            }

            if (this.isEmptyLine(currentLine) || this.isCommentLine(currentLine) || this.isFileVariableDefinitionLine(currentLine)) {
                continue;
            }

            if (Constants.MetadataLineRegex.test(currentLine) || Constants.ResponseRedirectRegex.test(currentLine)) {
                continue;
            }

            if (Constants.ScriptInlineRegex.test(currentLine)) {
                continue;
            }

            if (Constants.ScriptStartRegex.test(currentLine)) {
                insideScriptBlock = true;
                continue;
            }

            if (Constants.RequestLineRegex.test(currentLine)) {
                return lineIndex;
            }
        }

        return undefined;
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