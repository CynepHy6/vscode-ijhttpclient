import { describe, expect, it } from 'vitest';
import {
    buildVariableResolutionContext,
    classifyVariablePassMode,
    collectPromptableVariables,
    findUnresolvedVariableReferences,
    isSensitiveVariableName,
    parsePromptVariableDefinitions,
} from '../../src/utils/requestVariablePrompt';

describe('requestVariablePrompt', () => {
    it('parses # @prompt definitions and classifies pass mode by usage', () => {
        const requestText = [
            '# @prompt studentId',
            '# @prompt token',
            'GET https://start.{{y10}}/api/v1/showcase/get-tariffs-for-user?studentId={{studentId}}',
            'Cookie: token_global={{token}}',
        ].join('\n');

        expect(parsePromptVariableDefinitions(requestText)).toEqual([
            { name: 'studentId', description: undefined, passMode: 'public' },
            { name: 'token', description: undefined, passMode: 'private' },
        ]);
    });

    it('classifies header variables as private and request-line variables as public', () => {
        const requestText = [
            'GET https://start.{{host}}/api/items?id={{itemId}}',
            'Authorization: Bearer {{token}}',
        ].join('\n');

        expect(classifyVariablePassMode(requestText, 'itemId')).toBe('public');
        expect(classifyVariablePassMode(requestText, 'host')).toBe('public');
        expect(classifyVariablePassMode(requestText, 'token')).toBe('private');
    });

    it('always prompts explicit @prompt variables even when defined in env or inline', () => {
        const requestText = [
            '@token = inline-token',
            '# @prompt studentId',
            '# @prompt token',
            'GET https://example.com?studentId={{studentId}}',
            'Cookie: token_global={{token}}',
        ].join('\n');

        expect(collectPromptableVariables(requestText)).toEqual([
            { name: 'studentId', description: undefined, passMode: 'public' },
            { name: 'token', description: undefined, passMode: 'private' },
        ]);
    });

    it('detects sensitive variable names', () => {
        expect(isSensitiveVariableName('token')).toBe(true);
        expect(isSensitiveVariableName('studentId')).toBe(false);
    });

    it('reports unresolved variables and ignores dynamic, env, inline, and prompt variables', () => {
        const requestText = [
            '@baseUrl = https://example.com',
            '# @prompt token',
            'GET {{baseUrl}}/api?studentId={{studentId}}',
            'Cookie: token_global={{token}}',
            'X-Request-Id: {{$uuid}}',
        ].join('\n');

        const resolutionContext = buildVariableResolutionContext(requestText, new Set(['studentId']));

        expect(findUnresolvedVariableReferences(requestText, resolutionContext)).toEqual([]);
        expect(findUnresolvedVariableReferences('GET https://start.{{y10}}/api', resolutionContext)).toEqual(['y10']);
    });
});
