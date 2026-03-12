const XLSX = require('xlsx');
const wb = XLSX.utils.book_new();

// ===================================================================
// Sheet 1: API 서버 구조 설계
// ===================================================================
const arch = [
  ['PACE RISE API Server — 아키텍처 설계서'],
  [],
  ['1. 개요'],
  ['현재 시스템', 'Express.js 단일 서버 (server.js) + SQLite (better-sqlite3)'],
  ['제안 API 서버', 'RESTful API 서버 (별도 프로세스 또는 라우터 분리)'],
  ['인증 방식', 'API Key 기반 인증 (X-API-Key 헤더)'],
  ['베이스 URL', '/api/v1'],
  ['응답 포맷', 'JSON (Content-Type: application/json)'],
  ['문자 인코딩', 'UTF-8'],
  ['타임존', 'KST (UTC+9)'],
  [],
  ['2. 인증 (Authentication)'],
  ['방식', '설명'],
  ['X-API-Key', '모든 요청 헤더에 API Key 포함 필수'],
  ['권한 등급', 'read-only (조회만) / read-write (조회+수정) / admin (전체)'],
  ['Rate Limit', '1000 req/min (read), 300 req/min (write)'],
  [],
  ['3. 공통 응답 포맷'],
  ['필드', '타입', '설명'],
  ['success', 'boolean', '요청 성공 여부'],
  ['data', 'object|array', '응답 데이터 (성공 시)'],
  ['error', 'object', '에러 정보 (실패 시)'],
  ['error.code', 'string', '에러 코드 (AUTH_FAILED, NOT_FOUND, VALIDATION_ERROR 등)'],
  ['error.message', 'string', '에러 메시지 (한국어)'],
  ['meta', 'object', '페이지네이션 등 부가 정보'],
  ['meta.total', 'number', '전체 결과 수'],
  ['meta.page', 'number', '현재 페이지'],
  ['meta.per_page', 'number', '페이지당 결과 수'],
  [],
  ['4. HTTP 상태 코드'],
  ['코드', '의미', '사용 상황'],
  ['200', 'OK', '조회/수정 성공'],
  ['201', 'Created', '신규 생성 성공'],
  ['400', 'Bad Request', '필수 파라미터 누락, 유효성 검증 실패'],
  ['401', 'Unauthorized', 'API Key 없음 또는 유효하지 않음'],
  ['403', 'Forbidden', '권한 부족 (read-only 키로 write 시도 등)'],
  ['404', 'Not Found', '리소스 없음'],
  ['409', 'Conflict', '중복 데이터'],
  ['429', 'Too Many Requests', 'Rate Limit 초과'],
  ['500', 'Internal Server Error', '서버 내부 오류'],
  [],
  ['5. 제안 디렉토리 구조'],
  ['경로', '설명'],
  ['api/', 'API 서버 루트'],
  ['api/v1/', '버전 1 라우터'],
  ['api/v1/auth.js', '인증 미들웨어 (API Key 검증)'],
  ['api/v1/competitions.js', '대회 관리 라우터'],
  ['api/v1/events.js', '종목 관리 라우터'],
  ['api/v1/athletes.js', '선수 관리 라우터'],
  ['api/v1/heats.js', '조(Heat) 관리 라우터'],
  ['api/v1/results.js', '기록/결과 라우터'],
  ['api/v1/callroom.js', '소집실 라우터'],
  ['api/v1/relay.js', '릴레이 관리 라우터'],
  ['api/v1/combined.js', '혼성경기 라우터'],
  ['api/v1/pacing.js', '페이싱 라이트 라우터'],
  ['api/v1/public.js', '공개 조회 라우터 (인증 불필요)'],
  ['api/v1/upload.js', '엑셀 업로드 라우터'],
  ['api/v1/system.js', '시스템 관리 라우터'],
  [],
  ['6. 인증 요청 예시'],
  ['curl -H "X-API-Key: YOUR_KEY" https://domain/api/v1/competitions'],
  [],
  ['7. 성공 응답 예시'],
  ['{ "success": true, "data": { "id": 1, "name": "2026 전국체전" }, "meta": null }'],
  [],
  ['8. 에러 응답 예시'],
  ['{ "success": false, "error": { "code": "NOT_FOUND", "message": "해당 대회를 찾을 수 없습니다" }, "data": null }'],
];
const wsArch = XLSX.utils.aoa_to_sheet(arch);
wsArch['!cols'] = [{wch:30},{wch:30},{wch:60}];
XLSX.utils.book_append_sheet(wb, wsArch, '1. API 서버 구조');

// ===================================================================
// Sheet 2: 엔드포인트 목록 (전체)
// ===================================================================
const endpoints = [
  ['#','카테고리','Method','엔드포인트 (v1)','설명','권한','요청 파라미터','응답 데이터'],

  // --- AUTH ---
  [1,'인증','POST','/api/v1/auth/verify','운영키(비밀번호) 인증','public','{ "key": "string" }','{ "success": true, "role": "operator" }'],
  [2,'인증','POST','/api/v1/auth/admin-verify','관리자키 인증','public','{ "key": "string" }','{ "success": true, "role": "admin" }'],

  // --- COMPETITION ---
  [3,'대회','GET','/api/v1/competitions','전체 대회 목록','read','query: ?page=1&per_page=20','[{ "id", "name", "start_date", "end_date", "venue", ... }]'],
  [4,'대회','GET','/api/v1/competitions/:id','대회 상세 조회','read','path: id (number)','{ "id", "name", "start_date", "end_date", "venue", "organizer", ... }'],
  [5,'대회','POST','/api/v1/competitions','대회 생성','admin','{ "name", "start_date", "end_date", "venue", "organizer" }','{ "id", "name", ... }'],
  [6,'대회','PUT','/api/v1/competitions/:id','대회 수정','admin','{ "name"?, "start_date"?, "end_date"?, "venue"?, "organizer"? }','{ "id", "name", ... }'],
  [7,'대회','DELETE','/api/v1/competitions/:id','대회 삭제 (모든 하위 데이터 포함)','admin','path: id','{ "success": true }'],
  [8,'대회','GET','/api/v1/competition-info','현재 활성 대회 정보','read','query: ?competition_id=1','{ "id", "name", "start_date", ... }'],

  // --- EVENT ---
  [9,'종목','GET','/api/v1/events','종목 목록 조회','read','query: ?competition_id=1','[{ "id", "name", "category", "gender", "round_type", "round_status", ... }]'],
  [10,'종목','GET','/api/v1/events/:id','종목 상세 조회','read','path: id','{ "id", "name", "category", "gender", ... }'],
  [11,'종목','GET','/api/v1/events/:id/entries','종목 참가 선수 목록','read','path: id','[{ "event_entry_id", "athlete_id", "name", "bib_number", "team", ... }]'],
  [12,'종목','GET','/api/v1/events/:id/live-results','종목 실시간 결과 (Heat 포함)','read','path: id','{ "event", "heats": [{ "id", "heat_number", "entries", "results" }] }'],
  [13,'종목','GET','/api/v1/events/:id/full-results','종목 전체 결과 (확정)','read','path: id','{ "event", "heats", "unified_results" }'],
  [14,'종목','POST','/api/v1/events','종목 생성','admin','{ "competition_id", "name", "category", "gender", "round_type" }','{ "id", "name", ... }'],
  [15,'종목','PUT','/api/v1/events/:id','종목 수정','admin','{ "name"?, "category"?, "gender"?, "round_type"? }','{ "id", "name", ... }'],
  [16,'종목','DELETE','/api/v1/events/:id','종목 삭제','admin','path: id','{ "success": true }'],
  [17,'종목','POST','/api/v1/events/:id/complete','종목 완료 처리','write','path: id','{ "success": true }'],
  [18,'종목','POST','/api/v1/events/:id/revert-complete','종목 완료 취소','write','path: id','{ "success": true }'],
  [19,'종목','POST','/api/v1/events/:id/callroom-complete','소집 완료 처리','write','path: id','{ "success": true }'],
  [20,'종목','POST','/api/v1/events/:id/create-final','결승 조 자동 생성','admin','path: id, body: { count?, ...qualificationRules }','{ "success": true, "heats" }'],
  [21,'종목','POST','/api/v1/events/:id/create-semifinal','준결승 조 자동 생성','admin','path: id, body: { count? }','{ "success": true, "heats" }'],

  // --- HEAT ---
  [22,'조(Heat)','GET','/api/v1/heats','Heat 목록','read','query: ?event_id=1','[{ "id", "event_id", "heat_number", "start_time", ... }]'],
  [23,'조(Heat)','GET','/api/v1/heats/:id/entries','Heat 참가 선수','read','path: id','[{ "event_entry_id", "athlete_id", "name", "bib_number", "lane_number", "status", ... }]'],
  [24,'조(Heat)','POST','/api/v1/heats/:id/wind','풍속 저장','write','{ "wind": number }','{ "success": true }'],
  [25,'조(Heat)','GET','/api/v1/heats/:id/wind','풍속 조회','read','path: id','{ "wind": number | null }'],
  [26,'조(Heat)','GET','/api/v1/events/:id/heat-allocations','Heat 배정 현황','read','path: event_id','[{ "heat_number", "lane_number", "athlete_name", ... }]'],
  [27,'조(Heat)','POST','/api/v1/admin/events/:id/add-heat','Heat 추가','admin','path: event_id','{ "id", "heat_number" }'],
  [28,'조(Heat)','DELETE','/api/v1/admin/heats/:id','Heat 삭제','admin','path: heat_id','{ "success": true }'],
  [29,'조(Heat)','POST','/api/v1/admin/heats/update-entries','Heat 엔트리 업데이트','admin','{ "heat_id", "entries": [{ "event_entry_id", "lane_number" }] }','{ "success": true }'],
  [30,'조(Heat)','POST','/api/v1/admin/heats/:id/remove-entry','Heat에서 선수 제거','admin','{ "event_entry_id" }','{ "success": true }'],
  [31,'조(Heat)','POST','/api/v1/admin/heats/:id/move-entry','선수 Heat 이동','admin','{ "event_entry_id", "target_heat_id" }','{ "success": true }'],

  // --- RESULT ---
  [32,'기록','GET','/api/v1/results','기록 조회','read','query: ?heat_id=1','[{ "id", "event_entry_id", "heat_id", "time_seconds", "distance_meters", "wind", "attempt_number", ... }]'],
  [33,'기록','POST','/api/v1/results/upsert','기록 저장/업데이트 (upsert)','write','{ "heat_id", "event_entry_id", "time_seconds"?, "distance_meters"?, "wind"?, "attempt_number"?, "status_code"? }','{ "id", ... }'],
  [34,'기록','DELETE','/api/v1/results','기록 삭제','write','{ "heat_id", "event_entry_id", "attempt_number"? }','{ "success": true }'],

  // --- HEIGHT ATTEMPT ---
  [35,'높이뛰기','GET','/api/v1/height-attempts','높이 시도 조회','read','query: ?heat_id=1&event_entry_id=2','[{ "id", "event_entry_id", "heat_id", "bar_height", "attempt_number", "result_mark" }]'],
  [36,'높이뛰기','POST','/api/v1/height-attempts/save','높이 시도 저장','write','{ "heat_id", "event_entry_id", "bar_height", "attempt_number", "result_mark" }','{ "id", ... }'],
  [37,'높이뛰기','POST','/api/v1/height-attempts/delete-bar','바 높이 삭제 (해당 높이 전체)','write','{ "heat_id", "bar_height" }','{ "success": true, "deleted": number }'],

  // --- COMBINED (혼성) ---
  [38,'혼성경기','GET','/api/v1/combined-scores','혼성 종합점수 조회','read','query: ?parent_event_id=1','[{ "event_entry_id", "sub_event_name", "sub_event_order", "raw_record", "wa_points" }]'],
  [39,'혼성경기','POST','/api/v1/combined-scores/save','혼성 개별점수 저장','write','{ "event_entry_id", "sub_event_name", "sub_event_order", "raw_record", "wa_points" }','{ "id", ... }'],
  [40,'혼성경기','POST','/api/v1/combined-scores/sync','혼성 전체점수 동기화','write','{ "parent_event_id" }','{ "success": true, "synced": number }'],
  [41,'혼성경기','GET','/api/v1/combined-sub-events','혼성 세부종목 목록','read','query: ?parent_event_id=1','[{ "id", "name", "category", "order" }]'],

  // --- CALLROOM ---
  [42,'소집실','POST','/api/v1/callroom/checkin','바코드/BIB 출석 처리','write','{ "barcode", "event_id"? }','{ "athlete", "entry", "status": "checked_in" }'],
  [43,'소집실','GET','/api/v1/barcode/:code','바코드로 선수 조회','read','path: code (string)','{ "id", "name", "bib_number", "team", ... }'],
  [44,'소집실','PATCH','/api/v1/event-entries/:id/status','출석 상태 변경','write','{ "status": "registered|checked_in|no_show" }','{ "id", "status", ... }'],

  // --- ATHLETE ---
  [45,'선수','GET','/api/v1/athletes','선수 목록 조회','read','query: ?competition_id=1&gender=M&team=서울','[{ "id", "name", "bib_number", "gender", "team", "birth_date" }]'],
  [46,'선수','GET','/api/v1/admin/athletes','선수 상세 목록 (관리용)','admin','query: ?competition_id=1','[{ "id", "name", "bib_number", ... }]'],
  [47,'선수','POST','/api/v1/admin/athletes','선수 등록','admin','{ "competition_id", "name", "bib_number", "gender", "team", "birth_date"? }','{ "id", "name", ... }'],
  [48,'선수','PUT','/api/v1/admin/athletes/:id','선수 정보 수정','admin','{ "name"?, "bib_number"?, "gender"?, "team"?, "birth_date"? }','{ "id", "name", ... }'],
  [49,'선수','DELETE','/api/v1/admin/athletes/:id','선수 삭제','admin','path: id','{ "success": true }'],
  [50,'선수','GET','/api/v1/admin/athletes/:id/events','선수의 참가 종목 조회','admin','path: id','[{ "event_entry_id", "event_id", "event_name", ... }]'],
  [51,'선수','POST','/api/v1/admin/athletes/:id/events','선수 종목 등록','admin','{ "event_ids": [1,2,3] }','{ "success": true, "added": number }'],
  [52,'선수','DELETE','/api/v1/admin/athletes/:athleteId/events/:entryId','선수 종목 해제','admin','path: athleteId, entryId','{ "success": true }'],

  // --- RELAY ---
  [53,'릴레이','GET','/api/v1/relay-members','릴레이 팀 멤버 조회','read','query: ?event_id=1&team=서울시청 OR ?event_entry_id=5','[{ "id", "name", "bib_number", "gender", "leg_order" }]'],
  [54,'릴레이','GET','/api/v1/relay-members/batch','릴레이 멤버 일괄 조회','read','query: ?event_id=1&entry_ids=1,2,3','{ "1": [...members], "2": [...members] }'],
  [55,'릴레이','POST','/api/v1/relay-members','릴레이 멤버 추가','write','{ "event_entry_id", "athlete_id", "leg_order" }','{ "id", "event_entry_id", "athlete_id", "leg_order" }'],
  [56,'릴레이','DELETE','/api/v1/relay-members','릴레이 멤버 제거','write','{ "event_entry_id", "athlete_id" }','{ "success": true }'],
  [57,'릴레이','PUT','/api/v1/relay-members/order','릴레이 주자 순서 변경','write','{ "event_entry_id", "members": [{ "athlete_id", "leg_order" }] }','{ "success": true }'],

  // --- LANE ---
  [58,'레인','POST','/api/v1/lanes/assign','레인 배정','write','{ "entries": [{ "event_entry_id", "lane_number" }] }','{ "success": true }'],

  // --- QUALIFICATION ---
  [59,'예선통과','GET','/api/v1/qualifications','예선 통과자 조회','read','query: ?event_id=1','[{ "event_entry_id", "qualified", ... }]'],
  [60,'예선통과','POST','/api/v1/qualifications/save','예선 통과자 저장','write','{ "event_id", "selections": [...] }','{ "success": true }'],
  [61,'예선통과','POST','/api/v1/qualifications/approve','예선 통과 승인','write','{ "event_id" }','{ "success": true }'],

  // --- UPLOAD (엑셀) ---
  [62,'업로드','POST','/api/v1/athletes/upload','선수 엑셀 업로드','admin','multipart/form-data: file (xlsx), competition_id','{ "success": true, "imported": number, "skipped": number }'],
  [63,'업로드','POST','/api/v1/events/upload','종목 엑셀 업로드','admin','multipart/form-data: file (xlsx), competition_id','{ "success": true, "imported": number }'],
  [64,'업로드','POST','/api/v1/heat-assignment/preview','조편성 엑셀 미리보기','admin','multipart/form-data: file (xlsx), competition_id','{ "events": [...], "preview": [...] }'],
  [65,'업로드','POST','/api/v1/heat-assignment/apply','조편성 엑셀 적용','admin','multipart/form-data: file (xlsx), competition_id','{ "success": true, "applied": number }'],
  [66,'업로드','POST','/api/v1/federation/preview','연맹 형식 엑셀 미리보기','admin','multipart/form-data: file (xlsx)','{ "athletes", "events", "heats" }'],
  [67,'업로드','POST','/api/v1/federation/import','연맹 형식 엑셀 가져오기','admin','multipart/form-data: file (xlsx), competition_id','{ "success": true, ... }'],

  // --- PACING LIGHT ---
  [68,'페이싱','GET','/api/v1/pacing','페이싱 설정 목록','read','query: ?competition_id=1','[{ "id", "event_name", "target_time", "lap_distance", ... }]'],
  [69,'페이싱','GET','/api/v1/pacing/:id','페이싱 설정 상세','read','path: id','{ "id", "event_name", "target_time", "splits", ... }'],
  [70,'페이싱','POST','/api/v1/pacing','페이싱 설정 생성','write','{ "competition_id", "event_name", "target_time", "lap_distance", ... }','{ "id", ... }'],
  [71,'페이싱','DELETE','/api/v1/pacing/:id','페이싱 설정 삭제','write','path: id','{ "success": true }'],

  // --- PUBLIC (인증 불필요) ---
  [72,'공개','GET','/api/v1/public/events','공개 종목 목록','public','query: ?competition_id=1','[{ "id", "name", "category", "round_status" }]'],
  [73,'공개','GET','/api/v1/public/callroom-status','소집 현황 공개 조회','public','query: ?competition_id=1','[{ "event_name", "total", "checked_in", "no_show" }]'],
  [74,'공개','GET','/api/v1/public/pacing','페이싱 공개 조회','public','query: ?competition_id=1','[{ "event_name", "target_time", ... }]'],

  // --- SYSTEM ---
  [75,'시스템','GET','/api/v1/audit-log','감사 로그 조회','admin','query: ?limit=100','[{ "id", "action", "details", "created_at" }]'],
  [76,'시스템','GET','/api/v1/operation-log','운영 로그 조회','admin','query: ?limit=100','[{ "id", "action", "details", "created_at" }]'],
  [77,'시스템','GET','/api/v1/site-config','사이트 설정 조회','read','none','{ "site_title", "logo_url", ... }'],
  [78,'시스템','POST','/api/v1/admin/site-config','사이트 설정 변경','admin','{ "key", "value" }','{ "success": true }'],
  [79,'시스템','POST','/api/v1/admin/change-keys','인증키 변경','admin','{ "operator_key"?, "admin_key"? }','{ "success": true }'],
  [80,'시스템','GET','/api/v1/admin/backup','전체 DB 백업 (JSON)','admin','query: ?competition_id=1','{ "competition", "events", "athletes", "results", ... }'],
  [81,'시스템','POST','/api/v1/admin/reset-db','DB 초기화','admin','{ "confirm": true }','{ "success": true }'],
  [82,'시스템','GET','/api/v1/sse','실시간 이벤트 스트림 (SSE)','read','none','Server-Sent Events 스트림'],

  // --- VIDEO ---
  [83,'영상','PUT','/api/v1/events/:id/video-url','종목 영상 URL 저장','write','{ "video_url": "string" }','{ "success": true }'],
  [84,'영상','GET','/api/v1/events/:id/video-url','종목 영상 URL 조회','read','path: id','{ "video_url": "string" | null }'],

  // --- WA 검증 ---
  [85,'WA검증','GET','/api/v1/wa-validate/:id','WA 규정 검증','read','path: event_id','{ "valid": boolean, "issues": [...] }'],
  [86,'WA검증','POST','/api/v1/wa-correct/:id','WA 규정 자동 보정','write','path: event_id','{ "success": true, "corrected": number }'],
];
const wsEP = XLSX.utils.aoa_to_sheet(endpoints);
wsEP['!cols'] = [{wch:4},{wch:10},{wch:8},{wch:45},{wch:35},{wch:8},{wch:55},{wch:60}];
XLSX.utils.book_append_sheet(wb, wsEP, '2. 엔드포인트 목록');

// ===================================================================
// Sheet 3: 주요 데이터 모델 (JSON 포맷)
// ===================================================================
const models = [
  ['데이터 모델명','필드명','타입','필수','설명','예시'],
  [],
  ['Competition (대회)','id','integer','자동','대회 고유 ID','1'],
  ['','name','string','Y','대회명','"2026 전국체전"'],
  ['','start_date','string (YYYY-MM-DD)','Y','시작일','"2026-05-01"'],
  ['','end_date','string (YYYY-MM-DD)','Y','종료일','"2026-05-05"'],
  ['','venue','string','N','개최지','"잠실종합운동장"'],
  ['','organizer','string','N','주최기관','"대한체육회"'],
  ['','created_at','string (ISO 8601)','자동','생성 시각','"2026-03-06T09:00:00+09:00"'],
  [],
  ['Event (종목)','id','integer','자동','종목 고유 ID','10'],
  ['','competition_id','integer','Y','소속 대회 ID','1'],
  ['','name','string','Y','종목명','"100m"'],
  ['','category','string','Y','카테고리','track | field_distance | field_height | relay | combined | road'],
  ['','gender','string','Y','성별','M | F | X (혼성)'],
  ['','round_type','string','Y','라운드 유형','preliminary | semifinal | final | timerace'],
  ['','round_status','string','자동','라운드 상태','created | heats_generated | in_progress | completed'],
  ['','parent_event_id','integer','N','혼성경기 부모 종목 ID (세부종목인 경우)','5'],
  ['','sort_order','integer','N','정렬 순서','1'],
  [],
  ['Athlete (선수)','id','integer','자동','선수 고유 ID','100'],
  ['','competition_id','integer','Y','소속 대회 ID','1'],
  ['','name','string','Y','선수명','"김민수"'],
  ['','bib_number','string','N','배번 (빈칸 가능)','"174"'],
  ['','gender','string','Y','성별','M | F'],
  ['','team','string','N','소속','"서울시청"'],
  ['','birth_date','string','N','생년월일','"2000-01-15"'],
  ['','barcode','string','N','바코드','"PR2026174"'],
  [],
  ['EventEntry (참가등록)','id','integer','자동','참가등록 고유 ID','200'],
  ['','event_id','integer','Y','종목 ID','10'],
  ['','athlete_id','integer','Y','선수 ID','100'],
  ['','status','string','자동','출석상태','registered | checked_in | no_show'],
  [],
  ['Heat (조)','id','integer','자동','조 고유 ID','50'],
  ['','event_id','integer','Y','종목 ID','10'],
  ['','heat_number','integer','Y','조 번호','1'],
  ['','start_time','string','N','시작 시각','"14:00"'],
  ['','wind','real','N','풍속 (m/s)','1.5'],
  [],
  ['HeatEntry (조 배정)','heat_id','integer','Y','조 ID','50'],
  ['','event_entry_id','integer','Y','참가등록 ID','200'],
  ['','lane_number','integer','N','레인/순번','3'],
  ['','seed_group','string','N','그룹 (A/B)','A'],
  [],
  ['Result (트랙/거리 기록)','id','integer','자동','기록 고유 ID','500'],
  ['','heat_id','integer','Y','조 ID','50'],
  ['','event_entry_id','integer','Y','참가등록 ID','200'],
  ['','time_seconds','real','N','기록 (초) — 트랙종목','10.25'],
  ['','distance_meters','real','N','기록 (m) — 필드거리종목','8.12'],
  ['','wind','real','N','풍속 (m/s)','0.8'],
  ['','attempt_number','integer','N','시기 번호 (1~6) — 필드종목','3'],
  ['','status_code','string','N','상태코드','DNS | DNF | DQ | NM'],
  ['','remark','string','N','비고','"PB"'],
  [],
  ['HeightAttempt (높이 시도)','id','integer','자동','시도 고유 ID','800'],
  ['','heat_id','integer','Y','조 ID','50'],
  ['','event_entry_id','integer','Y','참가등록 ID','200'],
  ['','bar_height','real','Y','바 높이 (m)','1.85'],
  ['','attempt_number','integer','Y','시도 번호 (1~3)','1'],
  ['','result_mark','string','Y','결과 마크','O (성공) | X (실패) | PASS (패스)'],
  [],
  ['CombinedScore (혼성 점수)','id','integer','자동','점수 고유 ID','900'],
  ['','event_entry_id','integer','Y','참가등록 ID (부모 종목)','200'],
  ['','sub_event_name','string','Y','세부 종목명','"100m"'],
  ['','sub_event_order','integer','Y','세부 종목 순서','1'],
  ['','raw_record','real','N','원본 기록 (초 또는 m)','11.05'],
  ['','wa_points','integer','N','WA 점수','850'],
  [],
  ['RelayMember (릴레이 멤버)','id','integer','자동','멤버 고유 ID','1000'],
  ['','event_entry_id','integer','Y','팀 참가등록 ID','200'],
  ['','athlete_id','integer','Y','선수 ID','100'],
  ['','leg_order','integer','Y','주자 순서','2'],
];
const wsModel = XLSX.utils.aoa_to_sheet(models);
wsModel['!cols'] = [{wch:25},{wch:20},{wch:22},{wch:6},{wch:40},{wch:35}];
XLSX.utils.book_append_sheet(wb, wsModel, '3. 데이터 모델 (JSON)');

// ===================================================================
// Sheet 4: 사용 예시 (curl + 응답)
// ===================================================================
const examples = [
  ['#','시나리오','curl 명령어','응답 JSON'],
  [],
  [1,'대회 목록 조회',
   'curl -H "X-API-Key: YOUR_KEY" https://domain/api/v1/competitions',
   '{ "success": true, "data": [{ "id": 1, "name": "2026 전국체전", "start_date": "2026-05-01", "end_date": "2026-05-05", "venue": "잠실" }], "meta": { "total": 1 } }'],
  [],
  [2,'종목 목록 조회',
   'curl -H "X-API-Key: YOUR_KEY" "https://domain/api/v1/events?competition_id=1"',
   '{ "success": true, "data": [{ "id": 10, "name": "100m", "category": "track", "gender": "M", "round_type": "final", "round_status": "completed" }] }'],
  [],
  [3,'실시간 결과 조회',
   'curl -H "X-API-Key: YOUR_KEY" https://domain/api/v1/events/10/live-results',
   '{ "success": true, "data": { "event": { "id": 10, "name": "100m" }, "heats": [{ "id": 50, "heat_number": 1, "wind": 1.2, "entries": [...], "results": [{ "event_entry_id": 200, "time_seconds": 10.25, "lane_number": 4 }] }] } }'],
  [],
  [4,'트랙 기록 저장',
   'curl -X POST -H "X-API-Key: YOUR_KEY" -H "Content-Type: application/json" -d \'{"heat_id":50,"event_entry_id":200,"time_seconds":10.25}\' https://domain/api/v1/results/upsert',
   '{ "success": true, "data": { "id": 500, "heat_id": 50, "event_entry_id": 200, "time_seconds": 10.25 } }'],
  [],
  [5,'필드 거리 기록 저장 (3차시기)',
   'curl -X POST -H "X-API-Key: YOUR_KEY" -H "Content-Type: application/json" -d \'{"heat_id":50,"event_entry_id":200,"distance_meters":8.12,"wind":0.8,"attempt_number":3}\' https://domain/api/v1/results/upsert',
   '{ "success": true, "data": { "id": 501, "distance_meters": 8.12, "wind": 0.8, "attempt_number": 3 } }'],
  [],
  [6,'높이뛰기 시도 저장',
   'curl -X POST -H "X-API-Key: YOUR_KEY" -H "Content-Type: application/json" -d \'{"heat_id":50,"event_entry_id":200,"bar_height":1.85,"attempt_number":1,"result_mark":"O"}\' https://domain/api/v1/height-attempts/save',
   '{ "success": true, "data": { "id": 800, "bar_height": 1.85, "attempt_number": 1, "result_mark": "O" } }'],
  [],
  [7,'바코드 출석 처리',
   'curl -X POST -H "X-API-Key: YOUR_KEY" -H "Content-Type: application/json" -d \'{"barcode":"PR2026174","event_id":10}\' https://domain/api/v1/callroom/checkin',
   '{ "success": true, "data": { "athlete": { "id": 100, "name": "김민수", "bib_number": "174" }, "entry": { "id": 200, "status": "checked_in" } } }'],
  [],
  [8,'릴레이 멤버 조회',
   'curl -H "X-API-Key: YOUR_KEY" "https://domain/api/v1/relay-members?event_id=20&team=서울시청"',
   '{ "success": true, "data": [{ "id": 1000, "name": "김민수", "bib_number": "174", "leg_order": 1 }, { "id": 1001, "name": "이영희", "bib_number": "175", "leg_order": 2 }] }'],
  [],
  [9,'혼성경기 종합점수 조회',
   'curl -H "X-API-Key: YOUR_KEY" "https://domain/api/v1/combined-scores?parent_event_id=5"',
   '{ "success": true, "data": [{ "event_entry_id": 200, "sub_event_name": "100m", "sub_event_order": 1, "raw_record": 11.05, "wa_points": 850 }] }'],
  [],
  [10,'선수 엑셀 업로드',
   'curl -X POST -H "X-API-Key: YOUR_KEY" -F "file=@athletes.xlsx" -F "competition_id=1" https://domain/api/v1/athletes/upload',
   '{ "success": true, "data": { "imported": 450, "skipped": 5, "errors": ["Row 23: BIB 중복"] } }'],
  [],
  [11,'SSE 실시간 이벤트 구독',
   'curl -H "X-API-Key: YOUR_KEY" -N https://domain/api/v1/sse',
   'event: result_update\\ndata: {"heat_id":50,"event_entry_id":200}\\n\\nevent: entry_status\\ndata: {"event_entry_id":200,"status":"checked_in"}'],
  [],
  [12,'에러 응답 예시 (인증 실패)',
   'curl https://domain/api/v1/competitions',
   '{ "success": false, "error": { "code": "AUTH_REQUIRED", "message": "API Key가 필요합니다. X-API-Key 헤더를 포함해주세요." }, "data": null }'],
  [],
  [13,'에러 응답 예시 (리소스 없음)',
   'curl -H "X-API-Key: YOUR_KEY" https://domain/api/v1/events/99999',
   '{ "success": false, "error": { "code": "NOT_FOUND", "message": "해당 종목을 찾을 수 없습니다 (id: 99999)" }, "data": null }'],
];
const wsEx = XLSX.utils.aoa_to_sheet(examples);
wsEx['!cols'] = [{wch:4},{wch:25},{wch:80},{wch:100}];
XLSX.utils.book_append_sheet(wb, wsEx, '4. 사용 예시 (curl)');

// ===================================================================
// Sheet 5: SSE 이벤트 타입
// ===================================================================
const sse = [
  ['이벤트 타입','발생 시점','data 포맷','설명'],
  ['connected','SSE 연결 시','{}','연결 성공 확인'],
  ['result_update','기록 저장/수정/삭제 시','{ "heat_id", "event_entry_id" }','해당 Heat의 결과가 변경됨'],
  ['wind_update','풍속 저장 시','{ "heat_id", "wind" }','Heat 풍속 업데이트'],
  ['entry_status','출석상태 변경 시','{ "event_entry_id", "status" }','선수 출석/결석/등록 변경'],
  ['height_update','높이 시도 저장/삭제 시','{ "heat_id", "event_entry_id" }','높이뛰기 시도 결과 변경'],
  ['combined_update','혼성점수 변경 시','{ "parent_event_id" }','혼성경기 점수 동기화 완료'],
  ['event_status','종목 상태 변경 시','{ "event_id", "status" }','종목 완료/진행중 등 상태 변경'],
  ['callroom_complete','소집 완료 시','{ "event_id" }','소집실 완료 처리됨'],
];
const wsSSE = XLSX.utils.aoa_to_sheet(sse);
wsSSE['!cols'] = [{wch:20},{wch:25},{wch:45},{wch:40}];
XLSX.utils.book_append_sheet(wb, wsSSE, '5. SSE 이벤트 타입');

// ===================================================================
// Sheet 6: 순위 결정 규칙 (WA 규정)
// ===================================================================
const ranking = [
  ['종목 유형','순위 결정 순서','설명'],
  [],
  ['트랙 (100m, 200m, ...)','1. time_seconds ASC','빠른 시간이 상위'],
  ['','2. 동점 시 → FAT 1/1000초 비교','사진판독 기준'],
  ['','3. 여전히 동점 → 동순위','같은 순위 부여'],
  [],
  ['필드 거리 (멀리뛰기, 포환, ...)','1. best distance DESC','최고 기록이 상위'],
  ['','2. 동점 → 2nd best mark 비교','두 번째로 좋은 기록 비교'],
  ['','3. 여전히 동점 → 3rd best, 4th...','계속 다음 기록 비교'],
  ['','4. 모든 시기 동일 → 동순위','같은 순위 부여'],
  ['','※ 풍속은 순위에 영향 없음','표시만 함'],
  ['','※ 같은 선수 동일 거리 → 나중 시기가 공식 기록',''],
  [],
  ['필드 높이 (높이뛰기, 장대높이)','1. 최고 성공 높이 DESC','높은 쪽이 상위'],
  ['','2. 동점 → 최고높이 실패횟수 ASC','적은 쪽이 상위'],
  ['','3. 동점 → 전체 대회 총실패횟수 ASC','적은 쪽이 상위'],
  ['','4. 여전히 동점 → 동순위 (1위는 점프오프)',''],
  [],
  ['혼성경기 (10종/7종)','1. WA 점수 합산 DESC','총점 높은 쪽이 상위'],
  ['','2. 동점 → 동순위','같은 순위 부여'],
  ['','※ NM(No Mark) = 0점','시도했으나 유효기록 없음'],
  [],
  ['상태코드','코드','의미'],
  ['','DNS','Did Not Start (불참)'],
  ['','DNF','Did Not Finish (완주 실패)'],
  ['','DQ','Disqualified (실격)'],
  ['','NM','No Mark (유효기록 없음)'],
];
const wsRank = XLSX.utils.aoa_to_sheet(ranking);
wsRank['!cols'] = [{wch:30},{wch:40},{wch:40}];
XLSX.utils.book_append_sheet(wb, wsRank, '6. 순위 규칙 (WA 규정)');

XLSX.writeFile(wb, '/home/user/webapp/public/PACE_RISE_API_Documentation.xlsx');
console.log('DONE - API documentation generated');
