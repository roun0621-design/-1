// ============================================================
// 필드 종목 순위 규칙 — 서버(Node)와 브라우저가 함께 쓰는 단일 구현 (UMD)
//   브라우저: window.PaceRanking / Node: require('../public/lib/ranking')
//
// 근거: World Athletics Technical Rules
//   TR 25.6   8명 초과 시 3차 시기 후 상위 8명만 4~6차 (마지막 자리 동률은 25.22 로 가리고, 그래도 같으면 모두 진출)
//   TR 25.22  거리 종목 동률: 두 번째로 좋은 기록 → 세 번째 … 로 가린다. 끝까지 같으면 같은 순위(1위 포함)
//   TR 26.2   높이 종목: 높이와 무관하게 3회 "연속" 실패면 경기 종료 (패스는 연속을 끊지 않는다)
//   TR 26.8   높이 종목 동률: ① 마지막으로 넘은 높이에서의 실패 수가 적은 선수
//                            ② 마지막으로 넘은 높이"까지"의 전체 실패 수가 적은 선수 (그 뒤의 실패는 세지 않는다)
//                            ③ 그래도 같으면 같은 순위 — 1위만 점프오프(운영자가 수동 순위 입력)
// 이 파일이 생기기 전에는 같은 계산이 record.js·dashboard.js(2곳)·results.js·record-fieldpad.js·lib/fieldCardImport.js 에
// 각각 복사돼 있었고, 모두 ②를 "경기 전체 실패 수"로, 26.2 를 "한 높이에서 3회 실패"로 계산하고 있었다.
// ============================================================
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.PaceRanking = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const normMark = m => {
        const s = String(m == null ? '' : m).trim().toUpperCase();
        if (s === 'O' || s === 'X') return s;
        if (s === '-' || s === '–' || s === 'PASS' || s === 'P') return '-';
        return '';
    };
    // 한 높이의 시도 목록 — {1:'X',2:'O'} / ['X','O'] 둘 다 받는다
    const marksOf = d => {
        if (!d) return [];
        if (Array.isArray(d)) return d.map(normMark).filter(Boolean);
        return Object.keys(d).map(Number).sort((a, b) => a - b).map(k => normMark(d[k])).filter(Boolean);
    };

    /**
     * 높이 종목 한 선수의 통계
     * @param {Object} hd       { [높이]: {시도번호: 'O'|'X'|'PASS'|'-'} | ['X','O'] }
     * @param {number[]} [heights] 높이 목록(없으면 hd 의 키). 오름차순으로 처리한다.
     */
    function heightStats(hd, heights) {
        const hs = (heights && heights.length ? heights.slice() : Object.keys(hd || {}).map(Number)).sort((a, b) => a - b);
        let best = null, failsAtBest = 0, failsUpToBest = 0;
        let cumFails = 0, consecutive = 0, elim = false, hasAttempts = false, allFails = 0;
        for (const h of hs) {
            const marks = marksOf(hd ? hd[h] : null);
            if (!marks.length) continue;
            hasAttempts = true;
            let xHere = 0;
            for (const m of marks) {
                if (m === 'X') { xHere++; cumFails++; allFails++; consecutive++; if (consecutive >= 3) elim = true; }
                else if (m === 'O') { best = h; failsAtBest = xHere; failsUpToBest = cumFails; consecutive = 0; }
                // '-' (패스) 는 연속 실패를 끊지 않는다
            }
        }
        return {
            best, failsAtBest,
            totalFails: best == null ? allFails : failsUpToBest,   // 동률 판정용: 마지막으로 넘은 높이까지의 실패 수
            allFails,                                              // 참고용: 경기 전체 실패 수
            eliminated: elim, hasAttempts,
            isNM: best == null && elim,
        };
    }
    function compareHeight(a, b) {
        if (a.best == null && b.best == null) return 0;
        if (a.best == null) return 1;
        if (b.best == null) return -1;
        if (b.best !== a.best) return b.best - a.best;
        if (a.failsAtBest !== b.failsAtBest) return a.failsAtBest - b.failsAtBest;
        return a.totalFails - b.totalFails;
    }

    /** 거리 종목 한 선수의 통계. att: {시기: m | 0(파울) | -1(패스) | null} 또는 배열 */
    function distanceStats(att) {
        const vals = Array.isArray(att) ? att : Object.keys(att || {}).map(k => att[k]);
        const valid = vals.filter(v => typeof v === 'number' && v > 0).sort((a, b) => b - a);
        return { best: valid.length ? valid[0] : null, sortedValid: valid };
    }
    function compareDistance(a, b) {
        if (a.best == null && b.best == null) return 0;
        if (a.best == null) return 1;
        if (b.best == null) return -1;
        const A = a.sortedValid || [a.best], B = b.sortedValid || [b.best];
        const n = Math.max(A.length, B.length);
        for (let k = 0; k < n; k++) {
            const av = A[k] == null ? -1 : A[k], bv = B[k] == null ? -1 : B[k];
            if (bv !== av) return bv - av;
        }
        return 0;
    }

    /** 정렬 + 순위 부여(동률은 같은 순위, 다음 순위는 건너뜀). best 가 없으면 rank=null. 새 배열을 돌려준다. */
    function assignRanks(rows, compare) {
        const ranked = rows.filter(r => r.best != null).slice().sort(compare);
        ranked.forEach((r, i) => { r.rank = (i > 0 && compare(ranked[i - 1], r) === 0) ? ranked[i - 1].rank : i + 1; });
        rows.forEach(r => { if (r.best == null) r.rank = null; });
        return ranked;
    }

    /** 4~6차 진출자(상위 n). 마지막 자리 동률은 2·3번째 기록으로 가리고, 그래도 같으면 모두 포함. rows: [{id|event_entry_id, best, sortedValid}] */
    function topNIds(rows, n) {
        n = n || 8;
        const idOf = r => (r.event_entry_id != null ? r.event_entry_id : r.id);
        const ranked = rows.filter(r => r.best != null).slice().sort(compareDistance);
        const ids = new Set();
        ranked.forEach((r, i) => { if (i < n || compareDistance(ranked[n - 1], r) === 0) ids.add(idOf(r)); });
        return ids;
    }

    /**
     * 다음 라운드 진출자 자동 선정 (WA TR 20.3 · 21): 조별 상위 qPerHeat 명은 Q(순위), 나머지 중 기록 상위 qTotal 명은 q(기록).
     *   - DQ/DNF/DNS 등 상태코드가 있거나 기록이 없는 선수는 대상이 아니다
     *   - 마지막 자리에 1/1000초까지 같은 선수가 걸리면 ties 로 돌려준다 → 자동으로 가르지 않는다.
     *     (규정: 레인이 남으면 모두 진출, 아니면 추첨 — 심판장이 결정할 일)
     * rows: [{event_entry_id, heat_number, time_seconds, status_code}]
     */
    function autoQualify(rows, qPerHeat, qTotal) {
        const ms = t => Math.round(t * 1000);
        const valid = (rows || []).filter(r => typeof r.time_seconds === 'number' && r.time_seconds > 0 && !r.status_code);
        const Q = new Set(), q = new Set(), ties = [];
        const byHeat = {};
        valid.forEach(r => { (byHeat[r.heat_number] = byHeat[r.heat_number] || []).push(r); });
        for (const hn of Object.keys(byHeat)) {
            const sorted = byHeat[hn].slice().sort((a, b) => a.time_seconds - b.time_seconds);
            const n = Math.min(qPerHeat || 0, sorted.length);
            for (let i = 0; i < n; i++) Q.add(sorted[i].event_entry_id);
            if (n > 0 && sorted[n] && ms(sorted[n].time_seconds) === ms(sorted[n - 1].time_seconds)) {
                ties.push({ type: 'Q', heat_number: Number(hn), time_seconds: sorted[n - 1].time_seconds, ids: sorted.filter(r => ms(r.time_seconds) === ms(sorted[n - 1].time_seconds)).map(r => r.event_entry_id) });
            }
        }
        if (qTotal > 0) {
            const rest = valid.filter(r => !Q.has(r.event_entry_id)).sort((a, b) => a.time_seconds - b.time_seconds);
            const n = Math.min(qTotal, rest.length);
            for (let i = 0; i < n; i++) q.add(rest[i].event_entry_id);
            if (n > 0 && rest[n] && ms(rest[n].time_seconds) === ms(rest[n - 1].time_seconds)) {
                ties.push({ type: 'q', heat_number: null, time_seconds: rest[n - 1].time_seconds, ids: rest.filter(r => ms(r.time_seconds) === ms(rest[n - 1].time_seconds)).map(r => r.event_entry_id) });
            }
        }
        return { Q, q, ties };
    }

    return { normMark, heightStats, compareHeight, distanceStats, compareDistance, assignRanks, topNIds, autoQualify };
});
