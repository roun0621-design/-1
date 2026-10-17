// 앱스토어/PWA 스크린샷용 가상(허구) 데이터
// ※ 실제 존재하는 팀/선수/대회가 아니며, 개인정보 보호를 위해 전부 임의로 지어낸 값입니다.
// ※ This is entirely fictional data created for app-store screenshots. No real persons/teams.
module.exports = {
  // 가상 대회
  competition: {
    title: '제1회 페이스라이즈 오픈 육상경기대회',
    badge: 'DEMO',
    dateRange: '2026-08-21 ~ 2026-08-23',
    venue: '서울 가상스타디움',
  },

  // 가상 트랙 결승 결과 (남자 100m 결승)
  trackResult: {
    eventTitle: '남자 100m 결승',
    wind: '+1.2',
    rows: [
      { rank: 1, lane: 4, bib: '101', name: '김하준', team: '한라스포츠클럽', time: '10.41', remark: '대회신' },
      { rank: 2, lane: 5, bib: '215', name: '이서진', team: '동백체육회',     time: '10.55', remark: '' },
      { rank: 3, lane: 3, bib: '342', name: '박도윤', team: '미르육상단',     time: '10.62', remark: '' },
      { rank: 4, lane: 6, bib: '128', name: '최은우', team: '청람대학교',     time: '10.74', remark: '' },
      { rank: 5, lane: 2, bib: '477', name: '정시우', team: '가람실업팀',     time: '10.81', remark: '' },
      { rank: 6, lane: 7, bib: '503', name: '강주원', team: '솔빛스포츠',     time: '10.93', remark: '' },
      { rank: 7, lane: 1, bib: '266', name: '윤건후', team: '나래육상클럽',   time: '11.07', remark: '' },
      { rank: '', lane: 8, bib: '319', name: '임지호', team: '바다고등학교',   time: 'DNF',   remark: '', sc: 'DNF' },
    ],
  },

  // 가상 명단 (여자 200m 예선 1조)
  roster: {
    eventTitle: '여자 200m 예선 — 8명',
    heatLabel: '1조',
    rows: [
      { lane: 3, bib: '612', name: '한소율', team: '바람체육고' },
      { lane: 4, bib: '588', name: '오나윤', team: '들꽃육상단' },
      { lane: 5, bib: '741', name: '서아린', team: '햇살스포츠클럽' },
      { lane: 6, bib: '630', name: '문채아', team: '하늘대학교' },
      { lane: 2, bib: '655', name: '배수민', team: '한빛실업팀' },
      { lane: 7, bib: '702', name: '신예린', team: '푸른육상회' },
      { lane: 1, bib: '519', name: '권지안', team: '온누리스포츠' },
      { lane: 8, bib: '480', name: '황다은', team: '별빛고등학교' },
    ],
  },

  // 가상 대회 목록 (메인 화면 COMPETITION LIST 치환용)
  competitionList: [
    { fed: 'KAAF', name: '대한가상육상연맹', count: '4개 대회' },
    { fed: 'KTFL', name: '가상실업육상연맹', count: '3개 대회' },
    { fed: 'KUAF', name: '가상대학육상연맹', count: '2개 대회' },
  ],
};
