/**
 * lib/securityCheck — 약한 자격증명 자가점검 단위 테스트
 */
const { runSecuritySelfCheck } = require('../../lib/securityCheck');

describe('runSecuritySelfCheck', () => {
    it('강한 설정이면 경고가 없어야 한다', () => {
        const w = runSecuritySelfCheck({
            OPERATION_KEY: 'r9X2k7Qm4pLs',
            ADMIN_PW: 'Str0ng!Passw0rd#2026',
            ADMIN_ID: 'pacerise_ops',
        });
        expect(w).toEqual([]);
    });

    it("운영키 '1234' 를 약하다고 경고해야 한다", () => {
        const w = runSecuritySelfCheck({
            OPERATION_KEY: '1234',
            ADMIN_PW: 'Str0ng!Passw0rd#2026',
            ADMIN_ID: 'pacerise_ops',
        });
        expect(w.some(m => m.includes('OPERATION_KEY'))).toBe(true);
    });

    it('미설정(기본값 사용) 시 경고해야 한다', () => {
        const w = runSecuritySelfCheck({});
        // OPERATION_KEY, ADMIN_PW, ADMIN_ID 모두 경고
        expect(w.length).toBeGreaterThanOrEqual(3);
    });

    it("기본 ADMIN_ID 'admin' 을 경고해야 한다", () => {
        const w = runSecuritySelfCheck({
            OPERATION_KEY: 'r9X2k7Qm4pLs',
            ADMIN_PW: 'Str0ng!Passw0rd#2026',
            ADMIN_ID: 'admin',
        });
        expect(w.some(m => m.includes('ADMIN_ID'))).toBe(true);
    });

    it('짧은 ADMIN_PW 를 약하다고 경고해야 한다', () => {
        const w = runSecuritySelfCheck({
            OPERATION_KEY: 'r9X2k7Qm4pLs',
            ADMIN_PW: 'abc12',
            ADMIN_ID: 'pacerise_ops',
        });
        expect(w.some(m => m.includes('ADMIN_PW'))).toBe(true);
    });
});
