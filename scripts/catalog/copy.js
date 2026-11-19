'use strict';
/**
 * 해외용 카탈로그 문안 (영문 en · 일문 ja) — build.js 가 읽어 14쪽 PDF 로 조판한다.
 *   - 영문은 2026-10-23 확정 문안(P1~P14)을 그대로 옮긴 것. 고친 곳: 실적 표에 빠져 있던 10번째 대회(정선 마스터즈) 추가,
 *     그에 맞춰 '2,900+' → '3,100+'(운영 10개 대회 선수 행 합계 3,190 — 운영 공개 API `/api/athletes?competition_id=` 집계, 2026-11-19).
 *   - 일문은 영문을 옮긴 것. 눈썹 글자(eyebrow)·캡션 꼬리표는 Audiowide(라틴 전용)라 영문 그대로 둔다.
 *   - 쓰지 않는 말: "WaveLight integration", 계측 업체 상표명, 가격, SLA 수치, "WA 공인/인증". ("WA 규칙 기반"만 된다.)
 *   - 글 안의 <b>·<br>·<em> 은 그대로 HTML 로 들어간다.
 */

// 실적 표 — 운영(심판 입력) 대회만. 결과 동기화(아시안게임·전국체전)·노출용·문자 발송만 한 대회는 뺀다.
const ROWS = [
    { en: '2026 Bucheon International 10K Road Race', ja: '2026 富川国際10Kロードレース', org: 'KTFL', d: ['8 Mar', '3月8日'], n: 40 },
    { en: '2026 Gimhae KTFL National Athletics Meet', ja: '2026 金海 KTFL全国実業団陸上競技大会', org: 'KTFL', d: ['25–27 Mar', '3月25–27日'], n: 475 },
    { en: '30th KTFL National Championships', ja: '第30回 KTFL全国実業団陸上競技選手権大会', org: 'KTFL', d: ['26–28 May', '5月26–28日'], n: 513 },
    { en: '81st National University Championships', ja: '第81回 全国大学陸上競技選手権大会', org: 'KUAF', d: ['26–28 May', '5月26–28日'], n: 190 },
    { en: "2nd KTFL President's Cup", ja: '第2回 KTFL会長杯 全国実業団陸上競技大会', org: 'KTFL', d: ['29 Jun – 1 Jul', '6月29日–7月1日'], n: 511 },
    { en: '5th National University Athletics Meet', ja: '第5回 全国大学陸上競技大会', org: 'KUAF', d: ['29 Jun – 1 Jul', '6月29日–7月1日'], n: 397 },
    { en: '2026 Jeongseon Distance Challenge (Masters)', ja: '2026 旌善 中長距離チャレンジ（マスターズ）', org: 'KAAF', d: ['25 Jul', '7月25日'], n: 248 },
    { en: '2026 Ansan RUN TRACK Meet', ja: '2026 安山市 RUN TRACK 陸上競技大会', org: 'Ansan City', d: ['5 Sep', '9月5日'], n: 115 },
    { en: '37th KTFL Inter-Club Championships', ja: '第37回 KTFL全国実業団対抗陸上競技大会', org: 'KTFL', d: ['14–16 Sep', '9月14–16日'], n: 509 },
    { en: '80th National Inter-University Championships', ja: '第80回 全国大学対抗陸上競技大会', org: 'KUAF', d: ['14–16 Sep', '9月14–16日'], n: 192 },
];
const rows = lang => ROWS.map(r => [r[lang], r.org, r.d[lang === 'ja' ? 1 : 0], String(r.n)]);
const COMPS = String(ROWS.length);                                             // 10
const ENTRIES = (Math.floor(ROWS.reduce((s, r) => s + r.n, 0) / 100) * 100).toLocaleString('en-US');   // 3,190 → '3,100'

const en = {
    title: 'PACE RISE : Node — Product catalogue 2026',
    cover: {
        tag: 'Product catalogue · 2026',
        line: 'Every event,<br>on one system.',
        sub: 'Competition operating system for athletics — from the start list to the official results, on one screen, in one database.',
        stats: [
            [COMPS, 'competitions operated<br>2026 season'],
            [ENTRIES + '<i>+</i>', 'athlete entries<br>processed'],
            ['≈1<i>s</i>', "from judge's save<br>to spectator's phone"],
            ['iOS · Android · Web', 'spectator apps,<br>operator web', 'sm'],
            ['EN · JA · KO', 'interface languages,<br>switch per user', 'sm'],
        ],
    },
    p2: {
        eyebrow: 'How it runs', title: 'A competition day, in one picture', foot: 'Everything above comes from one database. Nothing is copied by hand between steps.',
        steps: [
            ['07:30', 'Import', 'Start lists from Excel. Column names recognised in English and Korean.'],
            ['09:00', 'Call room', 'Athletes scan a barcode or type a bib. 8 / 8 present, in one glance.'],
            ['09:40', 'Track', 'Photo-finish result file is dropped into a folder. Node reads it. No retyping.'],
            ['09:40', 'Field', 'Judges enter marks on a tablet. Wind, attempts, bar heights — checked as they type.'],
            ['09:41', 'Spectators', 'Results on phones about one second after the judge saves.'],
            ['10:40', 'Next round', 'Final drawn automatically by World Athletics rules. Operator reviews, confirms.'],
            ['17:30', 'Documents', 'Results book, official sheets, ID cards, broadcast overlay — from the same data.'],
        ],
    },
    p3: {
        eyebrow: 'For spectators, coaches and media', title: 'Results on every phone,<br>as they happen', foot: 'Spectator screens',
        bullets: [
            'Live banner shows what is on the track now and what is next.',
            'Event table by time or by event; tabs for Men / Women / Mixed.',
            'Result sheet with rank, lane, bib, team, mark, wind, and tags for CR · PB · SB · DNF.',
            'One tap: result card image for social media (1080 × 1350).',
            'Alerts: follow an event and get a push notification when results are official.',
            'Public pages need no login. Operator pages do.',
        ],
        cap: ['Dashboard', 'Desktop, mobile and result sheet. Fictional competition data.'],
    },
    p4: {
        eyebrow: 'For judges and the call room', title: 'Built for the people on the infield', foot: 'Operator screens',
        call: {
            h: 'Call room',
            bullets: ['Scan a barcode or type a bib. Counters update: All / Present / Absent /&nbsp;Unconfirmed.', 'Bulk check-in for teams. Call-room note printed in large type under the event title.'],
            note: '<b>Preload for offline.</b> One tap downloads the whole competition — every event, heat, start list, result and bar height — to the tablet. If the venue Wi-Fi drops, the judge keeps entering; saves queue up and send once the connection returns.',
        },
        rec: {
            h: 'Record entry',
            bullets: ['Marks typed as SS.xx or SS.xxx. Enter = save, Tab = next athlete. Wind once per heat, flagged legal / aided.', 'Status per athlete: DNS · DNF · DQ · NM. Font size A− / A+ for sunlight and gloves. Video link per event.'],
            note: '<b>Field events.</b> Attempts, heights and fouls are entered per round; ranks update as marks come in. A paper sheet can still be kept where regulations require it.',
        },
    },
    p5: {
        eyebrow: 'Connecting your timing system', title: 'Drop the file<br>in the folder. <em>That\'s it.</em>', foot: 'Timing integration',
        boxes: [
            ['Your timing', 'Photo-finish system', 'Any system that writes the standard result file (.lif). Node does not replace timing.'],
            ['Shared folder', 'One folder, watched', 'The timing PC saves to a shared folder. Node picks the file up within seconds.'],
            ['Node', 'Heat filled in', 'Lane, bib, time and wind land in the right rows. Rank and qualification computed.'],
            ['Everyone', 'Published', 'Spectator app, venue board, broadcast overlay, results book.'],
        ],
        arrows: ['.lif file', 'read', '≈1 s'],
        notes: [
            '<b>Nothing is retyped.</b> It replaces the step where someone reads a printout and types it into a spreadsheet.',
            '<b>One wrong row, one fix.</b> If a file is wrong, the operator corrects the row, not the heat. Every correction is logged with before → after.',
            '<b>Field stays with the judges.</b> Field marks are entered on tablets; wind gauges and EDM readings are typed as they are called.',
        ],
    },
    p6: {
        eyebrow: 'Rules, applied automatically', title: 'World Athletics rules,<br>applied by the system', foot: 'Rules engine',
        bullets: [
            '<b>Qualification.</b> Place qualifiers (Q) and time qualifiers (q) computed from heats or semifinals (TR 20.3, 20.4).',
            '<b>Lane draw.</b> WA lane patterns per event — e.g. 200 m: seeds 1–3 to lanes 5, 6, 7 — with a random draw inside each group (TR 21). Every lane shows its reason; the operator can override before confirming.',
            '<b>Seeding.</b> Serpentine seeding for heats.',
            '<b>Ties.</b> Track ties share a place (TR 19.24); field ties broken on second-best mark (TR 25.22); vertical jumps by count-back (TR 26.8).',
            '<b>Records.</b> CR · PB · SB computed automatically. National and division records checked against tables the federation supplies; a new record is flagged for approval before it is published.',
            '<b>Combined events.</b> Decathlon / heptathlon scored from the 10 / 7 sub-events.',
            '<b>WA check.</b> One button on every heat shows anything that breaks a rule.',
        ],
        cap: ['Final created', '200 m final drawn from the semifinals. Each lane carries its WA reason — pattern group, Q or q, random draw.'],
    },
    p7: {
        eyebrow: 'Official documents', title: 'One click to the<br>results book', foot: 'Documents',
        bullets: [
            'Results book — Excel and PDF, by gender or full meet.',
            'Per-event official result sheet with date, wind, remarks and signature lines for Recorder, Chief Judge and Chief Recorder.',
            'Start lists and timetable PDFs.',
            'Athlete ID cards with barcodes for the call room.',
            "Operation log export to CSV for the federation's records.",
        ],
        caps: { book: ['Results book', 'Summary page, Men.'], sheet: ['Official result', 'Per-event sheet, A4 portrait.'], docs: ['Documents', 'Admin — generate and download.'] },
    },
    p8: {
        eyebrow: 'Broadcast and venue display', title: 'The same data on the big<br>screen and the stream', foot: 'Broadcast',
        bullets: [
            '<b>OBS-ready overlays.</b> Full scoreboard and lower-third (winner pop-up). Transparent background, updates live.',
            '<b>Venue scoreboard.</b> Display operators read Node through a read-only API. No re-entry at the display desk.',
            '<b>Venue monitor.</b> One screen for the technical delegate: which events are checked in, in progress, completed — across one or several competitions.',
        ],
        caps: { score: ['Scoreboard overlay', 'Women 100 m final, live.'], lower: ['Lower third', 'Winner pop-up.'], monitor: ['Venue monitor', 'Two competitions as tabs.'] },
    },
    p9: {
        eyebrow: 'Track record', title: 'Adopted as the official<br>competition system', foot: '2026 season',
        lead: "The <b>Korea Track &amp; Field League (KTFL)</b> runs its national championships on Node. Results published by Node are the league's official announcement.",
        nums: [[COMPS, 'competitions operated, 2026'], [ENTRIES + '<i>+</i>', 'athlete entries processed']],
        note: 'KUAF = Korea University Athletics Federation. KAAF = Korea Association of Athletics Federations. Entries include relay teams. Competitions mirrored for display only are not counted.',
        th: ['Competition', 'Organiser', 'Date', 'Entries'], rows: rows('en'),
    },
    p10: {
        eyebrow: 'Built to be trusted', title: 'What happens when something goes wrong', foot: 'Reliability',
        caps: [['Conflict', 'Second save is stopped; screen reloads the latest value.'], ['Operation log', 'Every change, time-stamped, filterable, CSV export.'], ['Two at once', 'Two national championships on one instance.']],
        cards: [
            ['Two judges, same cell', 'If two people edit the same mark, the second save is stopped and the screen reloads the latest value. Nothing is silently overwritten.'],
            ['Undo', 'A deleted or corrected result is logged with before → after and can be restored.'],
            ['Access', 'Judges work with an operation key that expires at the end of the day. Admin, judge and public roles are separate.'],
            ['Backups', 'Results are written to three places automatically — local, cloud storage and a second cloud — so a server failure does not lose a meet.'],
            ['Several meets at once', 'In 2026 Node ran two national championships side by side three times, including joint heats shared between the two competitions.'],
            ['Load', '500 simultaneous users with responses under 0.1&nbsp;s and zero errors (in-house test, single server).'],
        ],
    },
    p11: {
        eyebrow: 'Ready for use outside Korea', title: 'What works on day one', foot: 'International',
        bullets: [
            'Interface in English, Japanese and Korean. Switch per user, not per installation.',
            'Excel import recognises English column names (Bib, Name, Team, Gender, Event…).',
            'Dates, times and marks follow WA formats.',
            'Data ownership stays with the federation or organiser. Export everything at any time.',
            'Personal data stored: name, team, gender, date of birth (optional), bib. No national ID numbers.',
        ],
        hostH: 'Hosting',
        host: [['PACE RISE cloud', 'Hosted in Korea. Nothing to install.'], ['Your region', 'Same image deployed in a cloud region of your choice.'], ['On-premises', 'Single Docker image with PostgreSQL, on your own server.']],
        shot: 'dashboard_ja_desktop',
        cap: ['Japanese UI', 'Same competition, language switched by the viewer.'],
    },
    p12: {
        eyebrow: "Working with your federation's registration system", title: 'Node sits between registration and results', foot: 'Data flow',
        boxes: [
            ['Your side', 'Federation athlete registry', 'Licences, personal bests, entries — stays where it is.'],
            ['Node', 'Call room · results · rounds · documents', "Runs the competition day. WA-style entry sheets or your federation's format are both accepted."],
            ['Your side', 'Federation records &amp; rankings', 'Results returned in the format your system imports.'],
        ],
        arrows: ['start lists<br>Excel / CSV', 'official results<br>Excel / CSV / PDF'],
        notes: [
            "<b>Node does not replace your athlete registry.</b> It takes the start list from it and returns results to it. In Korea this is how Node runs under the national federation's database today.",
            '<b>Live results for third parties.</b> A read-only public API serves live results to venue displays, broadcasters and websites.',
        ],
    },
    p13: {
        eyebrow: 'Getting started', title: 'From first call to first competition', foot: 'Onboarding',
        steps: [
            ['1 hour', 'Discovery call', 'Your event formats, timing setup, languages.'],
            ['1 day', 'Setup', 'Competition template, import mapping, overlays.'],
            ['half day', 'Training', 'Operators and chief judges, remote or on site.'],
            ['event', 'First competition', 'PACE RISE operator on site or on call.'],
            ['after', 'Review', 'Log review, adjustments, handover.'],
        ],
        modelsH: 'Models', chips: ['Hosted subscription', 'Annual licence', 'Per event'],
        pricing: 'Pricing on request — it depends on hosting, number of competitions and on-site support.',
        who: "<b>Who you'll work with.</b> PACE RISE is run by former national-level athletes. Node was built on the infield, one competition at a time — every screen exists because a judge or an operator needed it.",
    },
    p14: {
        company: 'PACE RISE Co., Ltd.', person: 'Roun Kim, CEO',
        lines: ['info@pace-rise.com', '+82 70-7954-9751', 'pace-rise.com &nbsp;·&nbsp; pace-rise-node.com &nbsp;·&nbsp; @pace.rise'],
        addr: 'Mungyeong, Gyeongsangbuk-do, Republic of Korea',
        tagline: 'Beyond Limits',
        note: 'PACE RISE : Node — Product catalogue, 2026.<br>Screens show a fictional competition.',
    },
};

const ja = {
    title: 'PACE RISE : Node — 製品カタログ 2026',
    cover: {
        tag: 'Product catalogue · 2026',
        line: 'すべての競技を、<br>ひとつのシステムで。',
        sub: '陸上競技のための大会運営システム。<br>スタートリストから公式記録まで、ひとつの画面、ひとつのデータベースで。',
        stats: [
            [COMPS, '運営した大会<br>2026年シーズン'],
            [ENTRIES + '<i>+</i>', '処理した<br>選手エントリー'],
            ['≈1<i>s</i>', '審判の保存から<br>観客のスマートフォンまで'],
            ['iOS · Android · Web', '観客向けアプリ、<br>運営はWeb', 'sm'],
            ['EN · JA · KO', '表示言語は<br>ユーザーごとに切替', 'sm'],
        ],
    },
    p2: {
        eyebrow: 'How it runs', title: '大会の一日を、一枚の図で', foot: '上のすべてが、ひとつのデータベースから生まれます。工程の間で手作業の転記はありません。',
        steps: [
            ['07:30', 'インポート', 'スタートリストをExcelから取り込み。英語と韓国語の列名を認識します。'],
            ['09:00', '招集所', '選手はバーコードをスキャン、またはビブ番号を入力。8人中8人の出席がひと目で。'],
            ['09:40', 'トラック', '写真判定の結果ファイルをフォルダに置くだけ。Nodeが読み込み、再入力は不要。'],
            ['09:40', 'フィールド', '審判がタブレットで記録を入力。風速・試技・バーの高さを入力と同時にチェック。'],
            ['09:41', '観客', '審判の保存から約1秒で、結果がスマートフォンに届きます。'],
            ['10:40', '次のラウンド', '決勝はWorld Athletics規則に沿って自動編成。オペレーターが確認して確定。'],
            ['17:30', '公式文書', '総合成績表、公式記録用紙、IDカード、放送用オーバーレイ。すべて同じデータから。'],
        ],
    },
    p3: {
        eyebrow: 'For spectators, coaches and media', title: '結果は、その瞬間に<br>すべてのスマートフォンへ', foot: '観客向け画面',
        bullets: [
            'ライブバナーに、いま行われている種目と次の種目を表示。',
            '種目一覧は時刻順・種目順で切替。男子／女子／混合のタブ。',
            'リザルト画面には順位・レーン・ビブ・所属・記録・風速と、CR・PB・SB・DNF のタグ。',
            'ワンタップでSNS用のリザルト画像（1080 × 1350）。',
            '通知：種目をフォローすると、結果が確定したときにプッシュ通知。',
            '公開ページはログイン不要。運営ページはログインが必要です。',
        ],
        cap: ['Dashboard', 'デスクトップ、モバイル、リザルト画面。大会データは架空のものです。'],
    },
    p4: {
        eyebrow: 'For judges and the call room', title: '現場に立つ人のためのつくり', foot: '運営画面',
        call: {
            h: '招集所（コールルーム）',
            bullets: ['バーコードをスキャン、またはビブ番号を入力。カウンターが更新されます：全員／出席／欠席／未確認。', 'チーム単位の一括チェックイン。招集所メモは種目名の下に大きな文字で表示。'],
            note: '<b>オフライン用の事前読み込み。</b>ワンタップで大会全体（全種目・組・スタートリスト・結果・バーの高さ）をタブレットに保存。会場のWi-Fiが切れても審判は入力を続けられ、保存は待機列に入り、接続が戻ると送信されます。',
        },
        rec: {
            h: '記録入力',
            bullets: ['記録は SS.xx または SS.xxx で入力。Enter＝保存、Tab＝次の選手。風速は組ごとに一度入力し、公認／追い風参考を表示。', '選手ごとのステータス：DNS・DNF・DQ・NM。日差しや手袋に合わせて文字サイズ A−／A+。種目ごとのビデオリンク。'],
            note: '<b>フィールド種目。</b>試技・高さ・ファウルはラウンドごとに入力し、記録が入るたびに順位が更新されます。規則上必要な場合は、紙の記録用紙も併用できます。',
        },
    },
    p5: {
        eyebrow: 'Connecting your timing system', title: 'ファイルをフォルダに置くだけ。<br><em>それで完了。</em>', foot: '計時連携',
        boxes: [
            ['Your timing', '写真判定システム', '標準の結果ファイル（.lif）を出力するシステムなら、どれでも。Nodeは計時を置き換えません。'],
            ['Shared folder', 'フォルダを監視', '計時PCが共有フォルダに保存。Nodeが数秒以内にファイルを取り込みます。'],
            ['Node', '組の記録を自動入力', 'レーン・ビブ・タイム・風速が正しい行に入り、順位と通過が計算されます。'],
            ['Everyone', '公開', '観客アプリ、会場ボード、放送オーバーレイ、総合成績表へ。'],
        ],
        arrows: ['.lif ファイル', '読み込み', '≈1 秒'],
        notes: [
            '<b>再入力はありません。</b>出力紙を読んで表計算ソフトに打ち直す工程が、なくなります。',
            '<b>誤りは、その1行だけ。</b>ファイルに誤りがあれば、オペレーターは組全体ではなくその行だけを直します。すべての修正は変更前 → 変更後で記録されます。',
            '<b>フィールドは審判の手で。</b>フィールドの記録はタブレットで入力。風速計や光波距離計（EDM）の値は、読み上げと同時に入力します。',
        ],
    },
    p6: {
        eyebrow: 'Rules, applied automatically', title: 'World Athletics 規則を、<br>システムが適用', foot: '規則エンジン',
        bullets: [
            '<b>通過判定。</b>予選・準決勝から、着順通過（Q）とタイム通過（q）を計算（TR 20.3、20.4）。',
            '<b>レーン抽選。</b>種目ごとのWAレーンパターン（例：200 m はシード1〜3位をレーン5・6・7へ）で、グループ内は無作為抽選（TR 21）。各レーンに理由を表示し、確定前にオペレーターが変更できます。',
            '<b>組分け。</b>予選はサーペンタイン（蛇行）方式でシード。',
            '<b>同順位。</b>トラックは同順位（TR 19.24）、フィールドは2番目の記録で決定（TR 25.22）、走高跳・棒高跳はカウントバック（TR 26.8）。',
            '<b>記録。</b>CR・PB・SB は自動判定。国内記録・区分別記録は連盟提供の記録表と照合し、新記録は公開前に承認待ちとして表示します。',
            '<b>混成競技。</b>十種競技／七種競技を、10／7種目から自動採点。',
            '<b>WAチェック。</b>各組のボタンひとつで、規則に反する箇所を表示。',
        ],
        cap: ['Final created', '準決勝から200 m決勝を編成。各レーンにWAの理由（パターングループ、Q／q、無作為抽選）を表示。'],
    },
    p7: {
        eyebrow: 'Official documents', title: 'ワンクリックで<br>総合成績表まで', foot: '公式文書',
        bullets: [
            '総合成績表（リザルトブック）— Excel・PDF、男女別または大会全体。',
            '種目ごとの公式記録用紙 — 日付・風速・備考と、記録員・審判長・記録主任の署名欄つき。',
            'スタートリストとタイムテーブルのPDF。',
            '招集所で使う、バーコードつき選手IDカード。',
            '運営ログをCSVで出力し、連盟の記録として保管。',
        ],
        caps: { book: ['Results book', '集計ページ（男子）。文書は英語版です。'], sheet: ['Official result', '種目別の用紙、A4縦。'], docs: ['Documents', '管理画面 — 作成とダウンロード。'] },
    },
    p8: {
        eyebrow: 'Broadcast and venue display', title: '同じデータを、<br>大型ビジョンと配信に', foot: '放送・会場表示',
        bullets: [
            '<b>OBS対応オーバーレイ。</b>フルスコアボードとロワーサード（優勝者ポップアップ）。背景は透過、ライブで更新。',
            '<b>会場スコアボード。</b>表示担当者は、読み取り専用APIでNodeを参照。表示卓での再入力は不要です。',
            '<b>会場モニター。</b>技術代表のための一画面。どの種目が招集済み・進行中・終了かを、ひとつまたは複数の大会にまたがって表示。',
        ],
        caps: { score: ['Scoreboard overlay', '女子100 m決勝、ライブ。'], lower: ['Lower third', '優勝者ポップアップ。'], monitor: ['Venue monitor', '2つの大会をタブで表示。'] },
    },
    p9: {
        eyebrow: 'Track record', title: '公式の大会運営システム<br>として採用', foot: '2026年シーズン',
        lead: '<b>韓国実業陸上連盟（KTFL）</b>は、全国選手権をNodeで運営しています。Nodeが公開する結果が、連盟の公式発表です。',
        nums: [[COMPS, '運営した大会（2026年）'], [ENTRIES + '<i>+</i>', '処理した選手エントリー']],
        note: 'KUAF＝韓国大学陸上連盟、KAAF＝大韓陸上連盟。エントリー数にはリレーチームを含みます。表示のみを行った大会は数えていません。',
        th: ['大会', '主催', '日程', 'エントリー'], rows: rows('ja'),
    },
    p10: {
        eyebrow: 'Built to be trusted', title: '問題が起きたとき、何が起こるか', foot: '信頼性',
        caps: [['Conflict', '2人目の保存は止まり、画面は最新値を再読み込み。'], ['Operation log', 'すべての変更を時刻つきで記録。絞り込み、CSV出力。'], ['Two at once', 'ひとつのインスタンスで、2つの全国選手権。']],
        cards: [
            ['2人の審判、同じセル', '2人が同じ記録を編集した場合、2人目の保存は止まり、画面は最新値を再読み込みします。黙って上書きされることはありません。'],
            ['取り消し', '削除・訂正された結果は変更前 → 変更後で記録され、復元できます。'],
            ['アクセス権', '審判は、当日限りで失効する運営キーで作業します。管理者・審判・一般公開の権限は分かれています。'],
            ['バックアップ', '結果は自動的に3か所（ローカル、クラウドストレージ、第2のクラウド）へ書き込まれ、サーバー障害でも大会を失いません。'],
            ['複数大会の同時運営', '2026年、Nodeは2つの全国選手権を3回、並行して運営しました。2大会が共有する合同の組も含みます。'],
            ['負荷', '同時500ユーザーで応答0.1秒未満、エラーゼロ（自社テスト、サーバー1台）。'],
        ],
    },
    p11: {
        eyebrow: 'Ready for use outside Korea', title: '初日から使えること', foot: '海外対応',
        bullets: [
            '画面は日本語・英語・韓国語。導入単位ではなく、ユーザーごとに切替。',
            'Excelインポートは英語の列名（Bib、Name、Team、Gender、Event…）を認識。',
            '日付・時刻・記録の表記はWA形式。',
            'データの所有権は連盟・主催者に。いつでもすべてエクスポートできます。',
            '保存する個人データ：氏名、所属、性別、生年月日（任意）、ビブ番号。国民識別番号は保存しません。',
        ],
        hostH: 'ホスティング',
        host: [['PACE RISE クラウド', '韓国でホスティング。インストール不要。'], ['ご希望のリージョン', '同じイメージを、お選びのクラウドリージョンに。'], ['オンプレミス', 'PostgreSQLを含む単一のDockerイメージを自社サーバーに。']],
        shot: 'dashboard_en_desktop',
        cap: ['English UI', '同じ大会を、見る人が言語を切り替えて表示。'],
    },
    p12: {
        eyebrow: "Working with your federation's registration system", title: 'Nodeは、選手登録と記録の間に入ります', foot: 'データの流れ',
        boxes: [
            ['Your side', '連盟の選手登録システム', '登録・自己ベスト・エントリーは、いまの場所にそのまま。'],
            ['Node', '招集所 · 記録 · ラウンド · 文書', '大会当日を運営します。WA形式のエントリーシートにも、連盟独自の形式にも対応。'],
            ['Your side', '連盟の記録・ランキング', '結果は、お使いのシステムが取り込める形式で返します。'],
        ],
        arrows: ['スタートリスト<br>Excel / CSV', '公式結果<br>Excel / CSV / PDF'],
        notes: [
            '<b>Nodeは選手登録システムを置き換えません。</b>そこからスタートリストを受け取り、結果を返します。韓国では現在、この形で国内連盟のデータベースのもとで運用しています。',
            '<b>第三者へのライブ結果。</b>読み取り専用の公開APIが、会場ディスプレイ・放送局・Webサイトにライブ結果を提供します。',
        ],
    },
    p13: {
        eyebrow: 'Getting started', title: '最初のご相談から、最初の大会まで', foot: '導入の流れ',
        steps: [
            ['1時間', 'ヒアリング', '種目構成、計時環境、使用言語。'],
            ['1日', 'セットアップ', '大会テンプレート、インポート設定、オーバーレイ。'],
            ['半日', 'トレーニング', 'オペレーターと審判長向け。リモートまたは現地。'],
            ['大会当日', '最初の大会', 'PACE RISEのオペレーターが、現地またはオンコールで対応。'],
            ['終了後', 'レビュー', 'ログの確認、調整、引き継ぎ。'],
        ],
        modelsH: '提供形態', chips: ['ホスティング型サブスクリプション', '年間ライセンス', '大会単位'],
        pricing: '料金はお問い合わせください。ホスティング形態、大会数、現地サポートの有無によって異なります。',
        who: '<b>一緒に仕事をするチーム。</b>PACE RISEは、元ナショナルレベルの陸上選手が運営しています。Nodeは競技場の現場で、大会をひとつずつ重ねながら作られました。すべての画面は、審判やオペレーターが必要としたから存在します。',
    },
    p14: {
        company: 'PACE RISE Co., Ltd.', person: 'Roun Kim, CEO',
        lines: ['info@pace-rise.com', '+82 70-7954-9751', 'pace-rise.com &nbsp;·&nbsp; pace-rise-node.com &nbsp;·&nbsp; @pace.rise'],
        addr: '大韓民国 慶尚北道 聞慶市',
        tagline: 'Beyond Limits',
        note: 'PACE RISE : Node — 製品カタログ 2026<br>画面は架空の大会データです。',
    },
};

module.exports = { en, ja, ROWS };
