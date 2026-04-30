#!/usr/bin/env python3
"""
종합기록지 엑셀 생성 스크립트
사용법: python3 generate_record_sheet.py <db_path> <competition_id> <gender> <output_path> [comp_name] [comp_date] [judge_name]
gender: M or F
"""
import sys, sqlite3, json, openpyxl, os

def main():
    if len(sys.argv) < 5:
        print("Usage: python3 generate_record_sheet.py <db_path> <comp_id> <gender> <output>", file=sys.stderr)
        sys.exit(1)
    
    db_path = sys.argv[1]
    comp_id = sys.argv[2]
    gender = sys.argv[3]  # M or F
    output_path = sys.argv[4]
    comp_name = sys.argv[5] if len(sys.argv) > 5 else ''
    comp_date = sys.argv[6] if len(sys.argv) > 6 else ''
    judge_name = sys.argv[7] if len(sys.argv) > 7 else ''

    # 템플릿 선택
    script_dir = os.path.dirname(os.path.abspath(__file__))
    base_dir = os.path.dirname(script_dir)
    if gender == 'M':
        template = os.path.join(base_dir, 'public', 'template_men.xlsx')
    else:
        template = os.path.join(base_dir, 'public', 'template_women.xlsx')
    
    wb = openpyxl.load_workbook(template)
    ws = wb['Sheet1']

    # 병합 셀 맵
    merged_map = {}
    for mr in list(ws.merged_cells.ranges):
        for row in range(mr.min_row, mr.max_row + 1):
            for col in range(mr.min_col, mr.max_col + 1):
                if row == mr.min_row and col == mr.min_col:
                    continue
                merged_map[(row, col)] = True

    def safe_set(row, col, value):
        if (row, col) not in merged_map:
            ws.cell(row=row, column=col).value = value

    # 헤더 채우기
    if comp_name:
        ws['B2'].value = f'       {comp_name}'
    if comp_date:
        ws['H3'].value = comp_date
    if judge_name:
        ws['X3'].value = f'심판장: {judge_name} (인)'

    # DB 연결
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 종목 행 매핑 — 양식에서의 종목명과 DB 종목명 매핑
    if gender == 'M':
        event_map = {
            6: ['100m'],
            9: ['200m'],
            12: ['400m'],
            15: ['800m'],
            18: ['1500m'],
            21: ['5000m'],
            24: ['10000m', '10,000m'],
            27: ['110mH', '110m허들'],
            30: ['400mH', '400m허들'],
            33: ['3000mSC', '3000m장애물'],
            36: ['10000mW', '10,000mW', '10000m경보', '10,000m경보'],
            39: ['높이뛰기'],
            42: ['장대높이뛰기'],
            45: ['멀리뛰기'],
            48: ['세단뛰기'],
            51: ['포환던지기'],
            54: ['원반던지기'],
            57: ['해머던지기'],
            60: ['창던지기'],
            63: ['10종경기'],
            66: ['4x100mR', '4x100m릴레이', '4×100m릴레이', '400mR'],
            69: ['4x400mR', '4x400m릴레이', '4×400m릴레이', '1600mR'],
            72: ['MIXED 4x400mR', '혼성 4x400mR', '혼성4x400m릴레이', 'MIXED 4×400m릴레이'],
            75: ['4x1500mR', '4x1500m릴레이', '4×1500m릴레이'],
        }
    else:
        event_map = {
            6: ['100m'],
            9: ['200m'],
            12: ['400m'],
            15: ['800m'],
            18: ['1500m'],
            21: ['5000m'],
            24: ['10000m', '10,000m'],
            27: ['100mH', '100m허들'],
            30: ['400mH', '400m허들'],
            33: ['3000mSC', '3000m장애물'],
            36: ['10000mW', '10,000mW', '10000m경보', '10,000m경보'],
            39: ['높이뛰기'],
            42: ['장대높이뛰기'],
            45: ['멀리뛰기'],
            48: ['세단뛰기'],
            51: ['포환던지기'],
            54: ['원반던지기'],
            57: ['해머던지기'],
            60: ['창던지기'],
            63: ['7종경기'],
            66: ['4x100mR', '4x100m릴레이', '4×100m릴레이', '400mR'],
            69: ['4x400mR', '4x400m릴레이', '4×400m릴레이', '1600mR'],
            72: ['MIXED 4x400mR', '혼성 4x400mR', '혼성4x400m릴레이', 'MIXED 4×400m릴레이'],
            75: ['4x1500mR', '4x1500m릴레이', '4×1500m릴레이'],
        }

    # 풍속 필요 종목
    wind_events = {'100m', '200m', '110mH', '100mH', '멀리뛰기', '세단뛰기'}
    # 릴레이 종목 (행)
    relay_rows = {66, 69, 72, 75}
    # 필드 높이 종목
    height_events = {'높이뛰기', '장대높이뛰기'}
    # 필드 거리 종목
    distance_events = {'멀리뛰기', '세단뛰기'}
    # 투척 종목 (OOmOO 형식)
    throw_events = {'포환던지기', '원반던지기', '해머던지기', '창던지기'}
    # 혼성 종목
    combined_events = {'10종경기', '7종경기'}

    # 순위별 열 매핑
    rank_cols = [
        {'name_c': 3, 'name_d': 4, 'record': 5},   # 1위
        {'name_c': 6, 'name_d': 7, 'record': 8},    # 2위
        {'name_c': 9, 'name_d': 10, 'record': 11},  # 3위
        {'name_c': 12, 'name_d': 13, 'record': 14}, # 4위
        {'name_c': 15, 'name_d': 16, 'record': 17}, # 5위
        {'name_c': 18, 'name_d': 19, 'record': 20}, # 6위
        {'name_c': 21, 'name_d': 22, 'record': 23}, # 7위
        {'name_c': 24, 'name_d': 25, 'record': 26}, # 8위
    ]

    def format_time(seconds, event_name):
        """시간 포맷 — 양식과 동일하게"""
        if seconds is None or seconds <= 0:
            return ''
        if seconds < 60:
            return f"{seconds:.2f}"
        elif seconds < 3600:
            mins = int(seconds // 60)
            secs = seconds - mins * 60
            return f"{mins}:{secs:05.2f}"
        else:
            hours = int(seconds // 3600)
            remain = seconds - hours * 3600
            mins = int(remain // 60)
            secs = remain - mins * 60
            return f"{hours}:{mins:02d}:{secs:05.2f}"

    def format_height(cm):
        """높이뛰기/장대: cm 정수"""
        if cm is None or cm <= 0:
            return ''
        return int(round(cm * 100)) if cm < 10 else int(round(cm))

    def format_distance(meters, event_name):
        """멀리뛰기/세단뛰기: cm 정수"""
        if meters is None or meters <= 0:
            return ''
        cm = round(meters * 100)
        return int(cm)

    def format_throw(meters):
        """투척: OOmOO 형식"""
        if meters is None or meters <= 0:
            return ''
        m = int(meters)
        cm = int(round((meters - m) * 100))
        return f"{m}m{cm:02d}"

    def format_wind(wind):
        """풍속 포맷"""
        if wind is None:
            return ''
        w = float(wind)
        if w > 0:
            return f"+{w:.1f}"
        elif w == 0:
            return "+0.0"
        else:
            return f"{w:.1f}"

    # 각 종목별 결과 조회 및 채우기
    for start_row, names in event_map.items():
        is_relay = start_row in relay_rows
        event_name = names[0]
        
        # 이벤트 찾기 (결승 우선, 없으면 예선)
        evt = None
        for n in names:
            # MIXED는 gender 무시
            if start_row == 72:
                evt = cur.execute("""
                    SELECT * FROM event WHERE competition_id=? AND name LIKE ? 
                    AND round_status='completed' AND parent_event_id IS NULL
                    ORDER BY CASE round_type WHEN 'final' THEN 0 WHEN 'semifinal' THEN 1 ELSE 2 END
                    LIMIT 1
                """, (comp_id, f'%{n}%')).fetchone()
            else:
                evt = cur.execute("""
                    SELECT * FROM event WHERE competition_id=? AND name=? AND gender=?
                    AND round_status='completed' AND parent_event_id IS NULL
                    ORDER BY CASE round_type WHEN 'final' THEN 0 WHEN 'semifinal' THEN 1 ELSE 2 END
                    LIMIT 1
                """, (comp_id, n, gender)).fetchone()
            if evt:
                break
        
        if not evt:
            continue

        evt_id = evt['id']
        category = evt['category']

        # 결과 가져오기 — 카테고리별
        ranked = []

        if category in ('track', 'road', 'relay'):
            # 트랙/릴레이: 히트별 결과 모아서 기록순
            heats = cur.execute("SELECT id FROM heat WHERE event_id=?", (evt_id,)).all()
            entries = []
            for h in heats:
                heat_id = h['id']
                # 풍속
                heat_wind = cur.execute("SELECT wind FROM heat WHERE id=?", (heat_id,)).fetchone()
                wind_val = heat_wind['wind'] if heat_wind and heat_wind['wind'] else None
                
                hentries = cur.execute("""
                    SELECT he.event_entry_id, ee.athlete_id, he.lane_number,
                           a.name, a.team, a.bib_number
                    FROM heat_entry he
                    JOIN event_entry ee ON ee.id = he.event_entry_id
                    JOIN athlete a ON a.id = ee.athlete_id
                    WHERE he.heat_id=?
                """, (heat_id,)).fetchall()
                
                for e in hentries:
                    # 최고 기록
                    r = cur.execute("""
                        SELECT MIN(time_seconds) AS best, status_code 
                        FROM result WHERE heat_id=? AND event_entry_id=?
                    """, (heat_id, e['event_entry_id'])).fetchone()
                    
                    best = r['best'] if r and r['best'] and r['best'] > 0 else None
                    status = r['status_code'] if r else None
                    
                    # 릴레이 멤버
                    members = []
                    if is_relay:
                        members = cur.execute("""
                            SELECT a.name FROM relay_member rm
                            JOIN athlete a ON a.id = rm.athlete_id
                            WHERE rm.event_entry_id=?
                            ORDER BY rm.leg_order
                        """, (e['event_entry_id'],)).fetchall()
                    
                    entries.append({
                        'name': e['name'], 'team': e['team'],
                        'best': best, 'status': status, 'wind': wind_val,
                        'members': [m['name'] for m in members]
                    })
            
            # 정렬: 유효기록 → 시간순, status 있으면 뒤로
            valid = [e for e in entries if e['best'] and not e['status']]
            invalid = [e for e in entries if not e['best'] or e['status']]
            valid.sort(key=lambda x: x['best'])
            ranked = valid + invalid

        elif category == 'field_distance':
            heats = cur.execute("SELECT id FROM heat WHERE event_id=?", (evt_id,)).all()
            entries = []
            for h in heats:
                heat_id = h['id']
                hentries = cur.execute("""
                    SELECT he.event_entry_id, a.name, a.team
                    FROM heat_entry he
                    JOIN event_entry ee ON ee.id = he.event_entry_id
                    JOIN athlete a ON a.id = ee.athlete_id
                    WHERE he.heat_id=?
                """, (heat_id,)).fetchall()
                
                for e in hentries:
                    results = cur.execute("""
                        SELECT distance_meters, wind, status_code FROM result
                        WHERE heat_id=? AND event_entry_id=?
                        ORDER BY attempt_number
                    """, (heat_id, e['event_entry_id'])).fetchall()
                    
                    best = 0
                    best_wind = None
                    status = None
                    for r in results:
                        if r['status_code'] and r['status_code'] in ('DNS','DNF','DQ','NM'):
                            status = r['status_code']
                        if r['distance_meters'] and r['distance_meters'] > best:
                            best = r['distance_meters']
                            best_wind = r['wind']
                    
                    entries.append({
                        'name': e['name'], 'team': e['team'],
                        'best': best if best > 0 else None,
                        'status': status, 'wind': best_wind, 'members': []
                    })
            
            valid = [e for e in entries if e['best'] and not e['status']]
            invalid = [e for e in entries if not e['best'] or e['status']]
            valid.sort(key=lambda x: -x['best'])
            ranked = valid + invalid

        elif category == 'field_height':
            heats = cur.execute("SELECT id FROM heat WHERE event_id=?", (evt_id,)).all()
            entries = []
            for h in heats:
                heat_id = h['id']
                hentries = cur.execute("""
                    SELECT he.event_entry_id, a.name, a.team
                    FROM heat_entry he
                    JOIN event_entry ee ON ee.id = he.event_entry_id
                    JOIN athlete a ON a.id = ee.athlete_id
                    WHERE he.heat_id=?
                """, (heat_id,)).fetchall()
                
                for e in hentries:
                    attempts = cur.execute("""
                        SELECT bar_height, result_mark FROM height_attempt
                        WHERE heat_id=? AND event_entry_id=?
                        ORDER BY bar_height
                    """, (heat_id, e['event_entry_id'])).fetchall()
                    
                    best = 0
                    status = None
                    # DNS/DNF 등 체크
                    r_status = cur.execute("""
                        SELECT status_code FROM result
                        WHERE heat_id=? AND event_entry_id=? AND status_code IS NOT NULL
                        LIMIT 1
                    """, (heat_id, e['event_entry_id'])).fetchone()
                    if r_status:
                        status = r_status['status_code']
                    
                    for a in attempts:
                        if a['result_mark'] == 'O' and a['bar_height'] > best:
                            best = a['bar_height']
                    
                    if best == 0 and not status:
                        status = 'NM'
                    
                    entries.append({
                        'name': e['name'], 'team': e['team'],
                        'best': best if best > 0 else None,
                        'status': status, 'wind': None, 'members': []
                    })
            
            valid = [e for e in entries if e['best'] and not e['status']]
            invalid = [e for e in entries if not e['best'] or e['status']]
            valid.sort(key=lambda x: -x['best'])
            ranked = valid + invalid

        elif category == 'combined':
            # 혼성경기: 합계 점수 기반
            heats = cur.execute("SELECT id FROM heat WHERE event_id=?", (evt_id,)).all()
            entries = []
            for h in heats:
                heat_id = h['id']
                hentries = cur.execute("""
                    SELECT he.event_entry_id, a.name, a.team
                    FROM heat_entry he
                    JOIN event_entry ee ON ee.id = he.event_entry_id
                    JOIN athlete a ON a.id = ee.athlete_id
                    WHERE he.heat_id=?
                """, (heat_id,)).fetchall()
                
                for e in hentries:
                    # 혼성경기 점수 가져오기
                    score_r = cur.execute("""
                        SELECT wa_points FROM result
                        WHERE heat_id=? AND event_entry_id=? AND wa_points IS NOT NULL
                        ORDER BY wa_points DESC LIMIT 1
                    """, (heat_id, e['event_entry_id'])).fetchone()
                    
                    status_r = cur.execute("""
                        SELECT status_code FROM result
                        WHERE heat_id=? AND event_entry_id=? AND status_code IS NOT NULL
                        LIMIT 1
                    """, (heat_id, e['event_entry_id'])).fetchone()
                    
                    score = score_r['wa_points'] if score_r else None
                    status = status_r['status_code'] if status_r else None
                    
                    entries.append({
                        'name': e['name'], 'team': e['team'],
                        'best': score, 'status': status, 'wind': None, 'members': []
                    })
            
            valid = [e for e in entries if e['best'] and not e['status']]
            invalid = [e for e in entries if not e['best'] or e['status']]
            valid.sort(key=lambda x: -x['best'])
            ranked = valid + invalid

        # 상위 8명 채우기
        for rank_idx, rc in enumerate(rank_cols):
            if rank_idx >= len(ranked):
                break
            entry = ranked[rank_idx]
            r1 = start_row      # 선수명/기록
            r2 = start_row + 1  # 소속/풍속
            r3 = start_row + 2  # WA점수

            # 선수명
            if is_relay and entry['members']:
                members = entry['members']
                half = (len(members) + 1) // 2
                safe_set(r1, rc['name_c'], ' '.join(members[:half]))
                safe_set(r1, rc['name_d'], ' '.join(members[half:]))
            else:
                safe_set(r1, rc['name_c'], entry['name'])

            # 기록
            if entry['status'] and entry['status'] in ('DNS', 'DNF', 'DQ', 'NM'):
                safe_set(r1, rc['record'], entry['status'])
            elif entry['best']:
                if category in ('track', 'road', 'relay'):
                    safe_set(r1, rc['record'], format_time(entry['best'], event_name))
                elif category == 'field_height':
                    safe_set(r1, rc['record'], format_height(entry['best']))
                elif category == 'field_distance':
                    if event_name in throw_events:
                        safe_set(r1, rc['record'], format_throw(entry['best']))
                    else:
                        safe_set(r1, rc['record'], format_distance(entry['best'], event_name))
                elif category == 'combined':
                    safe_set(r1, rc['record'], int(entry['best']))

            # 소속
            safe_set(r2, rc['name_c'], entry['team'] or '')

            # 풍속
            if event_name in wind_events and entry.get('wind') is not None:
                try:
                    safe_set(r2, rc['record'], format_wind(entry['wind']))
                except:
                    pass

    conn.close()
    wb.save(output_path)
    print(json.dumps({"success": True, "path": output_path}))

if __name__ == '__main__':
    main()
