import { vi } from 'vitest';

export class Position {
    public constructor(public readonly line: number, public readonly character: number) {
    }
}

export class Range {
    public readonly start: Position;
    public readonly end: Position;

    public constructor(startLine: number | Position, startCharacter: number, endLine?: number, endCharacter?: number) {
        if (startLine instanceof Position) {
            this.start = startLine;
            this.end = new Position(endLine as number, endCharacter as number);
            return;
        }

        this.start = new Position(startLine, startCharacter);
        this.end = new Position(endLine as number, endCharacter as number);
    }
}

export class WorkspaceEdit {
    public readonly insertions: Array<{ uri: unknown; position: Position; text: string }> = [];

    public insert(uri: unknown, position: Position, text: string): void {
        this.insertions.push({ uri, position, text });
    }
}

export class Disposable {
    public dispose(): void {
    }
}

export const StatusBarAlignment = {
    Left: 1,
    Right: 2,
} as const;

export const window = {
    activeTextEditor: undefined,
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    createStatusBarItem: vi.fn(() => ({
        text: '',
        tooltip: '',
        name: '',
        command: undefined,
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
    })),
};

export const workspace = {
    applyEdit: vi.fn(async () => true),
    getConfiguration: vi.fn(() => ({
        get: (_key: string, defaultValue: unknown) => defaultValue,
    })),
    getWorkspaceFolder: vi.fn(),
    textDocuments: [],
};

export function resetVscodeMocks(): void {
    window.activeTextEditor = undefined;
    window.showWarningMessage.mockReset();
    window.showInformationMessage.mockReset();
    window.showErrorMessage.mockReset();
    window.showQuickPick.mockReset();
    window.createStatusBarItem.mockClear();
    workspace.applyEdit.mockReset();
    workspace.applyEdit.mockResolvedValue(true);
    workspace.getConfiguration.mockReset();
    workspace.getConfiguration.mockReturnValue({
        get: (_key: string, defaultValue: unknown) => defaultValue,
    });
    workspace.getWorkspaceFolder.mockReset();
    workspace.textDocuments = [];
}
