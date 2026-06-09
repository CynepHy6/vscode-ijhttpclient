import * as Constants from '../common/constants';

export type VariablePassMode = 'public' | 'private';

export interface PromptVariableDefinition {
    name: string;
    description?: string;
    passMode: VariablePassMode;
}

export interface RequestVariableOverrides {
    publicVariableOverrides: Record<string, string>;
    privateVariableOverrides: Record<string, string>;
}

export interface VariableResolutionContext {
    inlineVariableNames: ReadonlySet<string>;
    environmentVariableNames: ReadonlySet<string>;
    promptVariableNames: ReadonlySet<string>;
}

interface RequestSections {
    requestLineText: string;
    headerLines: string[];
}

export function parsePromptVariableDefinitions(requestText: string): PromptVariableDefinition[] {
    const promptVariables: PromptVariableDefinition[] = [];
    const seenVariableNames = new Set<string>();

    for (const sourceLine of requestText.split(Constants.LineSplitterRegex)) {
        const promptMatch = Constants.PromptCommentRegex.exec(sourceLine);
        if (!promptMatch) {
            continue;
        }

        const variableName = promptMatch[1].trim();
        if (!variableName || seenVariableNames.has(variableName)) {
            continue;
        }

        seenVariableNames.add(variableName);
        promptVariables.push({
            name: variableName,
            description: promptMatch[2]?.trim() || undefined,
            passMode: classifyVariablePassMode(requestText, variableName),
        });
    }

    return promptVariables;
}

export function collectPromptableVariables(requestText: string): PromptVariableDefinition[] {
    return parsePromptVariableDefinitions(requestText);
}

export function getInlineVariableNames(requestText: string): Set<string> {
    const inlineVariableNames = new Set<string>();
    for (const sourceLine of requestText.split(Constants.LineSplitterRegex)) {
        const variableMatch = Constants.FileVariableDefinitionRegex.exec(sourceLine);
        if (variableMatch) {
            inlineVariableNames.add(variableMatch[1]);
        }
    }

    return inlineVariableNames;
}

export function extractVariableReferences(requestText: string): string[] {
    const variableReferences: string[] = [];
    const seenVariableNames = new Set<string>();

    for (const variableMatch of requestText.matchAll(Constants.VariableReferenceRegex)) {
        const variableName = variableMatch[1].trim();
        if (!variableName || seenVariableNames.has(variableName)) {
            continue;
        }

        seenVariableNames.add(variableName);
        variableReferences.push(variableName);
    }

    return variableReferences;
}

export function isDynamicVariableName(variableName: string): boolean {
    return variableName.startsWith('$');
}

export function findUnresolvedVariableReferences(
    requestText: string,
    resolutionContext: VariableResolutionContext
): string[] {
    return extractVariableReferences(requestText).filter(variableName =>
        !isDynamicVariableName(variableName)
        && !resolutionContext.inlineVariableNames.has(variableName)
        && !resolutionContext.environmentVariableNames.has(variableName)
        && !resolutionContext.promptVariableNames.has(variableName)
    );
}

export function buildVariableResolutionContext(
    requestText: string,
    environmentVariableNames: ReadonlySet<string> = new Set<string>()
): VariableResolutionContext {
    return {
        inlineVariableNames: getInlineVariableNames(requestText),
        environmentVariableNames,
        promptVariableNames: new Set(collectPromptableVariables(requestText).map(promptVariable => promptVariable.name)),
    };
}

export function classifyVariablePassMode(requestText: string, variableName: string): VariablePassMode {
    const variablePattern = buildVariableReferencePattern(variableName);
    const requestSections = splitRequestSections(requestText);
    const inHeaders = requestSections.headerLines.some(headerLine => variablePattern.test(headerLine));
    if (inHeaders) {
        return 'private';
    }

    if (variablePattern.test(requestSections.requestLineText)) {
        return 'public';
    }

    return 'public';
}

export function isSensitiveVariableName(variableName: string): boolean {
    return /(?:token|password|passwd|secret|auth|cookie|credential|apikey|api_key)/i.test(variableName);
}

function splitRequestSections(requestText: string): RequestSections {
    const requestLines: string[] = [];
    const headerLines: string[] = [];
    let requestLineIndex: number | undefined;
    let afterHeaders = false;

    for (const sourceLine of requestText.split(Constants.LineSplitterRegex)) {
        if (Constants.ScriptStartRegex.test(sourceLine)
            || Constants.ScriptInlineRegex.test(sourceLine)
            || Constants.ScriptCloseRegex.test(sourceLine)
            || Constants.ResponseRedirectRegex.test(sourceLine)
            || Constants.DelimiterLineRegex.test(sourceLine)
            || Constants.FileVariableDefinitionRegex.test(sourceLine)
            || Constants.PromptCommentRegex.test(sourceLine)) {
            continue;
        }

        if (afterHeaders) {
            continue;
        }

        if (requestLineIndex === undefined) {
            if (Constants.RequestLineRegex.test(sourceLine)) {
                requestLineIndex = requestLines.length;
                requestLines.push(sourceLine);
            }
            continue;
        }

        if (sourceLine.trim() === '') {
            afterHeaders = requestLines.length > 0;
            continue;
        }

        if (isRequestContinuationLine(sourceLine)) {
            requestLines.push(sourceLine);
            continue;
        }

        if (Constants.HeaderLineRegex.test(sourceLine)) {
            headerLines.push(sourceLine);
            continue;
        }

        afterHeaders = true;
    }

    return {
        requestLineText: requestLines.join('\n'),
        headerLines,
    };
}

function isRequestContinuationLine(sourceLine: string): boolean {
    return /^\s+\S/.test(sourceLine) && !Constants.HeaderLineRegex.test(sourceLine);
}

function buildVariableReferencePattern(variableName: string): RegExp {
    const escapedVariableName = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\{\\{\\s*${escapedVariableName}\\s*\\}\\}`);
}
