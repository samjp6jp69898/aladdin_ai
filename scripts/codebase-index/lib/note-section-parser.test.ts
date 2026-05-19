import { describe, test, expect } from 'bun:test';
import { parseNote } from './note-section-parser.ts';

describe('parseNote', () => {
    test('parses 功能描述 / 業務場景 / 相關規則與踩坑 / 備註', () => {
        const note = [
            '---',
            'type: rpc-method',
            '---',
            '',
            '# foo',
            '',
            '## 功能描述',
            '',
            'Main description.',
            '',
            '## 業務場景',
            '',
            'Scenario paragraph.',
            '',
            '## 相關規則與踩坑',
            '',
            '- rule one',
            '- rule two',
            '',
            '## 備註',
            '',
            '- note one',
        ].join('\n');
        const result = parseNote(note);
        expect(result.description.sentences).toEqual(['Main description.']);
        expect(result.scenarios.bullets).toEqual(['Scenario paragraph.']);
        expect(result.rules.bullets).toEqual(['rule one', 'rule two']);
        expect(result.notes.bullets).toEqual(['note one']);
    });

    test('strips [[wikilinks]] to 「name」', () => {
        const note = [
            '## 相關規則與踩坑',
            '- 參考 [[註冊欄位驗證 checklist]]',
        ].join('\n');
        const result = parseNote(note);
        expect(result.rules.bullets).toEqual(['參考「註冊欄位驗證 checklist」']);
    });

    test('strips backticks and bold markers from content', () => {
        const note = [
            '## 業務場景',
            '- `prepareProviderData` 是 **必要** 步驟',
        ].join('\n');
        const result = parseNote(note);
        expect(result.scenarios.bullets).toEqual(['prepareProviderData 是 必要 步驟']);
    });

    test('inlines numbered list under 功能描述', () => {
        const note = [
            '## 功能描述',
            '',
            'App 註冊主流程。',
            '',
            '詳細步驟：',
            '',
            '1. step one',
            '2. step two',
            '3. step three',
        ].join('\n');
        const result = parseNote(note);
        const joined = result.description.sentences.join(' ');
        expect(joined).toContain('1) step one');
        expect(joined).toContain('2) step two');
        expect(joined).toContain('3) step three');
    });

    test('ignores 輸入參數 / 回傳 / 呼叫關係 etc.', () => {
        const note = [
            '## 功能描述',
            'Desc.',
            '',
            '## 輸入參數',
            '- foo',
            '',
            '## 回傳',
            '- bar',
            '',
            '## 呼叫關係',
            '- baz',
            '',
            '## 業務場景',
            '- scen',
        ].join('\n');
        const result = parseNote(note);
        expect(result.description.sentences).toEqual(['Desc.']);
        expect(result.scenarios.bullets).toEqual(['scen']);
    });
});
