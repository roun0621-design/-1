'use strict';
/**
 * 대회 운영 체크리스트 — GET /api/admin/competitions/:id/readiness
 *   대회 전·당일·후 단계에서 빠뜨리기 쉬운 것을 시스템이 직접 점검해 관리자 화면(대회 설정 탭)에 보여준다.
 *   2026 예천 대회 운영 메모에서 나온 항목: 시리즈 연결(대회신 판정), 운영키 강도, 명단·조편성·시간표 연결, 백업/오프사이트,
 *   종료 잠금, 신기록 승인 대기, 상장·문서 양식.
 *
 *   응답: { phase: 'before'|'during'|'after', groups: [{ key, title, items: [{ key, label, status: 'ok'|'warn'|'fail'|'info', detail, action?: {tab, label} }] }] }
 */
module.exports = function mountReadinessRoutes(app, deps) {
    const { db, isAdminKey, kstNow, lastBackupAgeMs, backupS3, listFinalSnapshots } = deps;

    const cnt = async (sql, ...p) => { const r = await db.get(sql, ...p); return r ? Number(r.c || 0) : 0; };
    const item = (key, label, status, detail, action) => ({ key, label, status, detail: detail || '', ...(action ? { action } : {}) });

    app.get('/api/admin/competitions/:id/readiness', async (req, res) => {
        try {
            const key = req.headers['x-admin-key'] || req.query.key || req.query.admin_key || '';
            if (!isAdminKey(String(key))) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
            const comp = await db.get('SELECT * FROM competition WHERE id=?', req.params.id);
            if (!comp) return res.status(404).json({ error: '대회를 찾을 수 없습니다.' });
            const today = kstNow().slice(0, 10);
            const phase = comp.status === 'completed' ? 'after' : (comp.start_date && comp.start_date <= today && (!comp.end_date || comp.end_date >= today)) ? 'during' : (comp.end_date && comp.end_date < today) ? 'after' : 'before';
            const groups = [];

            // ── 1. 대회 준비 ─────────────────────────────────────────
            const prep = [];
            const athletes = await cnt('SELECT COUNT(*) c FROM athlete WHERE competition_id=? AND (barcode IS NULL OR barcode NOT LIKE ?)', comp.id, 'RELAY_%');
            const events = await cnt('SELECT COUNT(*) c FROM event WHERE competition_id=? AND parent_event_id IS NULL', comp.id);
            const entries = await cnt('SELECT COUNT(*) c FROM event_entry ee JOIN event e ON e.id=ee.event_id WHERE e.competition_id=?', comp.id);
            const heats = await cnt('SELECT COUNT(*) c FROM heat h JOIN event e ON e.id=h.event_id WHERE e.competition_id=?', comp.id);
            const eventsNoHeat = await cnt("SELECT COUNT(*) c FROM event e WHERE e.competition_id=? AND e.parent_event_id IS NULL AND e.category<>'combined' AND NOT EXISTS (SELECT 1 FROM heat h WHERE h.event_id=e.id)", comp.id);
            const noBib = await cnt("SELECT COUNT(*) c FROM athlete WHERE competition_id=? AND (bib_number IS NULL OR bib_number='') AND (barcode IS NULL OR barcode NOT LIKE 'RELAY_%')", comp.id);
            prep.push(item('roster', '선수 명단', athletes ? 'ok' : 'fail', athletes ? `선수 ${athletes}명 · 출전 ${entries}건` : '선수가 없습니다 — 연맹 명단을 올리세요', { tab: 'upload', label: '업로드' }));
            prep.push(item('events', '종목', events ? 'ok' : 'fail', events ? `${events}개 종목` : '종목이 없습니다', { tab: 'events', label: '종목 관리' }));
            prep.push(item('heats', '조편성', !events ? 'info' : eventsNoHeat === 0 ? 'ok' : 'warn', !events ? '' : eventsNoHeat === 0 ? `${heats}개 조` : `조가 없는 종목 ${eventsNoHeat}개 (결승 대기 종목이면 정상)`, { tab: 'upload', label: '조편성 업로드' }));
            prep.push(item('bib', '배번', !athletes ? 'info' : noBib === 0 ? 'ok' : 'warn', noBib ? `배번 없는 선수 ${noBib}명 — 소집실 스캔·ID카드가 되지 않습니다` : '전원 배번 있음', { tab: 'upload', label: '배번 일괄 수정' }));
            let ttTotal = 0, ttLinked = 0;
            try { ttTotal = await cnt('SELECT COUNT(*) c FROM timetable WHERE competition_id=?', comp.id); ttLinked = await cnt('SELECT COUNT(*) c FROM timetable WHERE competition_id=? AND event_id IS NOT NULL', comp.id); } catch (e) {}
            prep.push(item('timetable', '시간표', ttTotal === 0 ? 'warn' : (ttLinked / ttTotal >= 0.8 ? 'ok' : 'warn'), ttTotal === 0 ? '시간표가 없습니다 — 대시보드·소집 알림이 시간표를 씁니다' : `${ttTotal}행 중 ${ttLinked}행이 종목과 연결됨${ttLinked < ttTotal ? ' (미연결은 결승 생성 시 자동 연결되는 결승 행일 수 있음)' : ''}`, { tab: 'upload', label: '시간표' }));
            // 시리즈 · 기록표 — 대회신(CR) 판정은 시리즈에 묶인 기록표로 한다
            let seriesName = null, crCount = 0, nrCount = 0;
            if (comp.series_id) { const s = await db.get('SELECT name FROM competition_series WHERE id=?', comp.series_id); seriesName = s && s.name; crCount = await cnt("SELECT COUNT(*) c FROM event_record WHERE record_type='competition' AND series_id=?", comp.series_id); }
            try { nrCount = await cnt("SELECT COUNT(*) c FROM event_record WHERE record_type='national'"); } catch (e) {}
            prep.push(item('series', '시리즈 연결 (대회신 판정)', comp.series_id ? (crCount ? 'ok' : 'warn') : 'warn', comp.series_id ? `${seriesName} · 대회 기록 ${crCount}건` : '시리즈에 연결되지 않아 대회신(CR)을 판정하지 못합니다. 대회 정보의 시리즈를 지정하세요', { tab: 'competition', label: '대회 정보' }));
            prep.push(item('records', '한국 기록표 (한국신 판정)', nrCount ? 'ok' : 'warn', nrCount ? `한국 기록 ${nrCount}건` : '기록표가 비어 있어 한국신을 판정하지 못합니다', { tab: 'records', label: '기록 관리' }));
            groups.push({ key: 'prep', title: '대회 전 — 자료', items: prep });

            // ── 2. 운영 준비 ─────────────────────────────────────────
            const ops = [];
            const opKeys = await cnt("SELECT COUNT(*) c FROM operation_key WHERE active=1");
            const secWarn = [...(global.__dbSecurityWarnings || []), ...(global.__securityWarnings || [])];
            ops.push(item('opkeys', '심판·운영키', opKeys ? 'ok' : 'warn', opKeys ? `운영키 ${opKeys}개 활성` : '발급된 운영키가 없습니다 — 심판이 로그인할 수 없습니다', { tab: 'judges', label: '심판·운영키' }));
            ops.push(item('security', '보안 경고', secWarn.length ? 'warn' : 'ok', secWarn.length ? secWarn.join(' / ') : '약한 키·기본값 없음', { tab: 'users', label: '사용자 관리' }));
            const sbMissing = await cnt("SELECT COUNT(*) c FROM heat h JOIN event e ON e.id=h.event_id WHERE e.competition_id=? AND (h.scoreboard_key IS NULL OR h.scoreboard_key='')", comp.id);
            ops.push(item('scoreboard', '전광판 키', heats === 0 ? 'info' : sbMissing === 0 ? 'ok' : 'warn', heats === 0 ? '' : sbMissing === 0 ? '모든 조에 전광판 키 있음' : `전광판 키 없는 조 ${sbMissing}개 — 계측 결과(.lif) 자동 매칭이 안 될 수 있음`, { tab: 'scoreboard', label: '스코어보드' }));
            let awardTpl = 'builtin';
            try { const r = await db.get("SELECT scope_key FROM award_docx_template WHERE scope_key IN (?, 'global') ORDER BY CASE WHEN scope_key='global' THEN 1 ELSE 0 END LIMIT 1", `c${comp.id}`); awardTpl = r ? (r.scope_key === 'global' ? 'global' : 'competition') : 'builtin'; } catch (e) {}
            ops.push(item('award', '워드 상장 양식', awardTpl === 'builtin' ? 'warn' : 'ok', awardTpl === 'competition' ? '이 대회 전용 양식' : awardTpl === 'global' ? '전체 기본 양식' : '수여 기관·직함이 비어 있는 내장 양식입니다 — 상장관리에서 채우세요', { tab: 'certificates', label: '상장관리' }));
            let sms = null; try { sms = await db.get('SELECT sim_mode, api_key, sender_number FROM sms_config WHERE id=1'); } catch (e) {}
            ops.push(item('sms', '문자(기록증) 발송', !sms ? 'info' : (sms.sim_mode || !sms.api_key) ? 'info' : 'ok', !sms ? '설정 없음' : (sms.sim_mode || !sms.api_key) ? '시뮬레이션 모드 — 실제 문자는 나가지 않습니다 (쓰지 않으면 그대로 두세요)' : '실제 발송 켜짐'));
            groups.push({ key: 'ops', title: '대회 전 — 운영', items: ops });

            // ── 3. 당일 ──────────────────────────────────────────────
            if (phase !== 'before') {
                const day = [];
                const inProgress = await cnt("SELECT COUNT(*) c FROM event WHERE competition_id=? AND parent_event_id IS NULL AND round_status='in_progress'", comp.id);
                const completed = await cnt("SELECT COUNT(*) c FROM event WHERE competition_id=? AND parent_event_id IS NULL AND round_status='completed'", comp.id);
                const pendingFinal = await cnt("SELECT COUNT(*) c FROM event e WHERE e.competition_id=? AND e.parent_event_id IS NULL AND e.round_type='preliminary' AND e.round_status='completed' AND NOT EXISTS (SELECT 1 FROM event f WHERE f.competition_id=e.competition_id AND f.name=e.name AND f.gender=e.gender AND COALESCE(f.division,'')=COALESCE(e.division,'') AND f.round_type IN ('semifinal','final'))", comp.id);
                day.push(item('progress', '경기 진행', 'info', `진행 중 ${inProgress} · 완료 ${completed} / 전체 ${events}`));
                day.push(item('nextround', '다음 라운드 생성', pendingFinal ? 'warn' : 'ok', pendingFinal ? `예선이 끝났는데 결승·준결승이 아직 없는 종목 ${pendingFinal}개` : '예선 완료 종목은 모두 다음 라운드가 있음'));
                const pendingRec = await cnt("SELECT COUNT(*) c FROM record_breaking_log WHERE competition_id=? AND status='pending'", comp.id);
                day.push(item('recordq', '신기록 승인 대기', pendingRec ? 'warn' : 'ok', pendingRec ? `${pendingRec}건 — 기록위원 확인 필요` : '대기 없음', { tab: 'records', label: '기록 관리' }));
                const stale = await cnt("SELECT COUNT(*) c FROM event e WHERE e.competition_id=? AND e.parent_event_id IS NULL AND e.round_status='in_progress' AND EXISTS (SELECT 1 FROM timetable t WHERE t.competition_id=e.competition_id AND t.event_id=e.id AND t.scheduled_date < ?)", comp.id, today);
                if (stale) day.push(item('stale', '어제 종목이 아직 진행 중', 'warn', `${stale}개 — 경기 완료 처리를 잊었을 수 있습니다`));
                const hourlyAge = lastBackupAgeMs ? lastBackupAgeMs('hourly') : Infinity;
                day.push(item('backup', '자동 백업', !isFinite(hourlyAge) ? 'warn' : hourlyAge < 70 * 60 * 1000 ? 'ok' : 'warn', !isFinite(hourlyAge) ? '시간별 백업이 없습니다' : `마지막 시간별 백업 ${Math.round(hourlyAge / 60000)}분 전`));
                groups.push({ key: 'day', title: '대회 당일', items: day });
            }

            // ── 4. 대회 후 ───────────────────────────────────────────
            const after = [];
            const notCompleted = await cnt("SELECT COUNT(*) c FROM event WHERE competition_id=? AND parent_event_id IS NULL AND round_status<>'completed' AND EXISTS (SELECT 1 FROM heat h WHERE h.event_id=event.id)", comp.id);
            after.push(item('closed', '대회 종료 잠금', comp.status === 'completed' ? 'ok' : (phase === 'after' ? 'warn' : 'info'), comp.status === 'completed' ? '종료됨 — 운영키로는 수정할 수 없습니다' : phase === 'after' ? '종료일이 지났지만 아직 종료 처리하지 않았습니다 (종료일 기준으로 자동 잠금 중)' : '대회가 끝나면 대회 정보에서 종료 처리하세요', { tab: 'competition', label: '대회 정보' }));
            after.push(item('allcomplete', '모든 종목 완료', notCompleted === 0 ? 'ok' : (phase === 'after' ? 'warn' : 'info'), notCompleted === 0 ? '조가 있는 종목은 모두 완료' : `완료되지 않은 종목 ${notCompleted}개`));
            const snaps = listFinalSnapshots ? listFinalSnapshots(comp.id) : [];
            after.push(item('snapshot', '종료 스냅샷 백업', snaps.length ? 'ok' : (comp.status === 'completed' ? 'warn' : 'info'), snaps.length ? snaps[snaps.length - 1] : '대회를 종료 처리하면 영구 스냅샷이 만들어집니다'));
            after.push(item('offsite', '오프사이트(S3) 백업', backupS3 && backupS3.isConfigured() ? 'ok' : 'warn', backupS3 && backupS3.isConfigured() ? '설정됨' : '설정되지 않음 — 서버 디스크가 유일한 사본입니다 (.env BACKUP_S3_BUCKET)'));
            const certIssued = await cnt('SELECT COUNT(*) c FROM certificate_issue_log WHERE competition_id=?', comp.id);
            after.push(item('certs', '상장·기록증 발급', 'info', certIssued ? `${certIssued}건 발급` : '아직 발급 없음', { tab: 'certificates', label: '상장관리' }));
            groups.push({ key: 'after', title: '대회 후', items: after });

            const summary = { fail: 0, warn: 0, ok: 0 };
            for (const g of groups) for (const it of g.items) if (summary[it.status] != null) summary[it.status]++;
            res.json({ competition_id: comp.id, phase, today, summary, groups });
        } catch (e) { console.error('[readiness]', e); res.status(500).json({ error: e.message }); }
    });
};
