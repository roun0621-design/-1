/**
 * [사용성] 세 상태 화면(비어 있음 · 불러오는 중 · 실패) — public/common.js uiStateHtml (Phase 6, 규칙집 §10)
 *   같은 모양, 문구 + 다음 행동 버튼, HTML 이스케이프
 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '../../public/common.js'), 'utf8');
const m = src.match(/function uiStateHtml\(kind, opts = \{\}\) \{[\s\S]*?\n\}\n/);
const uiStateHtml = new Function(m[0] + '; return uiStateHtml;')();

describe('uiStateHtml', () => {
    it('비어 있음: 제목·안내·행동 버튼', () => {
        const h = uiStateHtml('empty', { title: '등록된 종목이 없습니다', hint: '명단을 올리세요', action: { label: '관리자 열기', onclick: "location.href='/admin.html'" } });
        expect(h).toContain('class="ui-state is-empty"'); expect(h).toContain('role="status"');
        expect(h).toContain('등록된 종목이 없습니다'); expect(h).toContain('명단을 올리세요'); expect(h).toContain('>관리자 열기<');
        expect(h).not.toContain('ui-state-spinner');
    });
    it('불러오는 중: 스피너, 실패: alert 역할 + 기본 "다시 시도"', () => {
        expect(uiStateHtml('loading')).toContain('ui-state-spinner');
        const e = uiStateHtml('error', { title: '종목을 불러오지 못했습니다' });
        expect(e).toContain('role="alert"'); expect(e).toContain('다시 시도'); expect(e).toContain('location.reload()'); expect(e).toContain('btn-primary');
    });
    it('서버 메시지에 든 태그는 글자로', () => {
        const h = uiStateHtml('error', { hint: '<img src=x onerror=alert(1)>' });
        expect(h).not.toContain('<img'); expect(h).toContain('&lt;img');
    });
});
