import { describe, expect, it } from 'vitest';
import { parseHistoryCommentLink, resolveHistoryCommentTarget } from '../../src/utils/historyComment';

describe('historyComment', () => {
    it('parses history comment path range for ctrl+click links', () => {
        const lineText = '# <> ./.response/2026-06-09T214712.200.response';

        expect(parseHistoryCommentLink(lineText)).toEqual({
            pathText: './.response/2026-06-09T214712.200.response',
            startCharacter: 5,
            endCharacter: 47,
        });
    });

    it('resolves history comment paths relative to the http file directory', () => {
        const targetPath = resolveHistoryCommentTarget(
            '/tmp/example/temp',
            './.response/2026-06-09T214712.200.response'
        );

        expect(targetPath).toBe('/tmp/example/temp/.response/2026-06-09T214712.200.response');
    });

    it('ignores non-history comment lines', () => {
        expect(parseHistoryCommentLink('# @prompt token')).toBeUndefined();
        expect(parseHistoryCommentLink('GET https://example.com')).toBeUndefined();
    });
});
