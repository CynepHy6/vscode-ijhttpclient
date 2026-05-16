import { describe, expect, it } from 'vitest';
import { Selector } from '../src/utils/selector';

describe('Selector.sanitizeExecutableText', () => {
    it('removes ordinary comments but preserves executable directives and scripts', () => {
        const sourceText = [
            '# @name updateGroupSchedule',
            '@groupId = 1005559',
            'POST https://example.com/api/groups/update',
            'Content-Type: application/json',
            '',
            '{',
            '# this comment must be removed',
            '  "groupId": {{groupId}}',
            '}',
            '',
            '# <> ./.response/previous.response',
            '>>! ./saved-response.json',
            '',
            '> {%',
            '  // keep this line inside response script',
            '  client.test("status is 200", function() {});',
            '%}',
        ].join('\n');

        const sanitizedText = Selector.sanitizeExecutableText(sourceText);

        expect(sanitizedText).toContain('# @name updateGroupSchedule');
        expect(sanitizedText).toContain('@groupId = 1005559');
        expect(sanitizedText).toContain('POST https://example.com/api/groups/update');
        expect(sanitizedText).toContain('"groupId": {{groupId}}');
        expect(sanitizedText).toContain('>>! ./saved-response.json');
        expect(sanitizedText).toContain('// keep this line inside response script');
        expect(sanitizedText).not.toContain('# this comment must be removed');
        expect(sanitizedText).not.toContain('# <> ./.response/previous.response');
    });
});
