'use strict';
// ============================================================
// 예선 이후 라운드의 시드 순서 — WA Technical Rules TR 20.3.2(a)
//   ① 조 1위들을 기록순 → ② 조 2위들을 기록순 → … (순위 진출 Q 전원)
//   ③ 기록 진출(q)을 기록순
//   이 순서로 지그재그 조 배정(TR 20.3.3)과 레인 그룹 추첨(TR 20.4: 상위 4 → 중앙 레인 …)을 한다.
// 예전 구현은 Q 전원을 '기록만'으로 정렬 → 빠른 조의 2위가 느린 조의 1위보다 앞서 중앙 레인을 받았다.
//   perf: 작을수록 좋은 값(트랙=초, 필드는 음수 거리). place: 출신 조 안의 순위(없으면 기록으로만 비교)
// ============================================================
function seedOrder(athletes) {
    const qOrder = { Q: 0, q: 1 };
    const list = athletes.slice().sort((a, b) => {
        const aq = qOrder[a.qualification_type] ?? 2, bq = qOrder[b.qualification_type] ?? 2;
        if (aq !== bq) return aq - bq;
        if (aq === 0) {
            const ap = a.place == null ? Infinity : a.place, bp = b.place == null ? Infinity : b.place;
            if (ap !== bp) return ap - bp;
        }
        return (a.perf ?? Infinity) - (b.perf ?? Infinity);
    });
    list.forEach((a, i) => { a.seedRank = i + 1; });
    return list;
}
module.exports = { seedOrder };
