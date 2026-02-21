-- ============================================================
-- Pace Rise Competition OS — Seed Data v6 (Clean)
-- 2026 Pace Rise Invitational — Pre-competition state
-- 엑셀 업로드 후, 대회 시작 전 상태
-- 모든 종목: heats_generated (조편성 완료, 기록 없음)
-- 모든 소집 상태: registered (미소집)
-- 기록 데이터 없음 — UI에서 소집 → 기록입력 → 완료 순서로 진행
-- ============================================================

-- ============================================================
-- EVENTS
-- ============================================================

-- Track 남자 (id 1-12)
INSERT INTO event (id,name,category,gender,round_type,round_status) VALUES
-- DAY1: 100m예선,400m예선,800m예선,5000m결승,110m허들예선,멀리뛰기,포환,높이뛰기,10종Day1
-- DAY2: 100m결승(없음-예선만),200m예선,1500m예선,400m허들예선,3000m장애물,세단,원반,해머,창던지기,장대높이,10종Day2,7종
-- DAY3: 10000m,4x100m릴레이,4x400m릴레이,혼성릴레이
(1,'100m','track','M','preliminary','heats_generated'),
(2,'200m','track','M','preliminary','heats_generated'),
(3,'400m','track','M','preliminary','heats_generated'),
(4,'800m','track','M','preliminary','heats_generated'),
(5,'1500m','track','M','preliminary','heats_generated'),
(6,'5000m','track','M','final','heats_generated'),
(7,'10000m','track','M','final','heats_generated'),
(8,'110m 허들','track','M','preliminary','heats_generated'),
(9,'400m 허들','track','M','preliminary','heats_generated'),
(10,'3000m 장애물','track','M','final','heats_generated'),
(11,'4x100m 릴레이','track','M','final','heats_generated'),
(12,'4x400m 릴레이','track','M','final','heats_generated');

-- Track 여자 (id 13-24)
INSERT INTO event (id,name,category,gender,round_type,round_status) VALUES
(13,'100m','track','F','preliminary','heats_generated'),
(14,'200m','track','F','preliminary','heats_generated'),
(15,'400m','track','F','preliminary','heats_generated'),
(16,'800m','track','F','preliminary','heats_generated'),
(17,'1500m','track','F','preliminary','heats_generated'),
(18,'5000m','track','F','final','heats_generated'),
(19,'10000m','track','F','final','heats_generated'),
(20,'100m 허들','track','F','preliminary','heats_generated'),
(21,'400m 허들','track','F','preliminary','heats_generated'),
(22,'3000m 장애물','track','F','final','heats_generated'),
(23,'4x100m 릴레이','track','F','final','heats_generated'),
(24,'4x400m 릴레이','track','F','final','heats_generated');

-- 혼성 릴레이 (id 25)
INSERT INTO event (id,name,category,gender,round_type,round_status) VALUES
(25,'혼성 4x400m 릴레이','track','X','final','heats_generated');  -- Day3

-- Field Distance 남자 (id 26-31)
INSERT INTO event (id,name,category,gender,round_type,round_status) VALUES
(26,'멀리뛰기','field_distance','M','final','heats_generated'),
(27,'세단뛰기','field_distance','M','final','heats_generated'),
(28,'포환던지기','field_distance','M','final','heats_generated'),
(29,'원반던지기','field_distance','M','final','heats_generated'),
(30,'해머던지기','field_distance','M','final','heats_generated'),
(31,'창던지기','field_distance','M','final','heats_generated');

-- Field Distance 여자 (id 32-37)
INSERT INTO event (id,name,category,gender,round_type,round_status) VALUES
(32,'멀리뛰기','field_distance','F','final','heats_generated'),
(33,'세단뛰기','field_distance','F','final','heats_generated'),
(34,'포환던지기','field_distance','F','final','heats_generated'),
(35,'원반던지기','field_distance','F','final','heats_generated'),
(36,'해머던지기','field_distance','F','final','heats_generated'),
(37,'창던지기','field_distance','F','final','heats_generated');

-- Field Height 남자 (id 38-39)
INSERT INTO event (id,name,category,gender,round_type,round_status) VALUES
(38,'높이뛰기','field_height','M','final','heats_generated'),
(39,'장대높이뛰기','field_height','M','final','heats_generated');

-- Field Height 여자 (id 40-41)
INSERT INTO event (id,name,category,gender,round_type,round_status) VALUES
(40,'높이뛰기','field_height','F','final','heats_generated'),
(41,'장대높이뛰기','field_height','F','final','heats_generated');

-- Combined 혼성경기 parent (id 42-43)
INSERT INTO event (id,name,category,gender,round_type,round_status) VALUES
(42,'10종 경기','combined','M','final','heats_generated'),
(43,'7종 경기','combined','F','final','heats_generated');

-- 10종 세부 (id 101-110)
INSERT INTO event (id,name,category,gender,round_type,round_status,parent_event_id) VALUES
(101,'[10종] 100m','track','M','final','heats_generated',42),
(102,'[10종] 멀리뛰기','field_distance','M','final','heats_generated',42),
(103,'[10종] 포환던지기','field_distance','M','final','heats_generated',42),
(104,'[10종] 높이뛰기','field_height','M','final','heats_generated',42),
(105,'[10종] 400m','track','M','final','heats_generated',42),
(106,'[10종] 110m 허들','track','M','final','heats_generated',42),
(107,'[10종] 원반던지기','field_distance','M','final','heats_generated',42),
(108,'[10종] 장대높이뛰기','field_height','M','final','heats_generated',42),
(109,'[10종] 창던지기','field_distance','M','final','heats_generated',42),
(110,'[10종] 1500m','track','M','final','heats_generated',42);

-- 7종 세부 (id 201-207)
INSERT INTO event (id,name,category,gender,round_type,round_status,parent_event_id) VALUES
(201,'[7종] 100m 허들','track','F','final','heats_generated',43),
(202,'[7종] 높이뛰기','field_height','F','final','heats_generated',43),
(203,'[7종] 포환던지기','field_distance','F','final','heats_generated',43),
(204,'[7종] 200m','track','F','final','heats_generated',43),
(205,'[7종] 멀리뛰기','field_distance','F','final','heats_generated',43),
(206,'[7종] 창던지기','field_distance','F','final','heats_generated',43),
(207,'[7종] 800m','track','F','final','heats_generated',43);


-- ============================================================
-- ATHLETES (모든 종목 커버)
-- ============================================================

-- 남자 단거리 (100m/200m/400m) 16명 BIB 101-116
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(1,'김민수','101','삼성전자','PR2026101','M'),
(2,'이준호','102','LG전자','PR2026102','M'),
(3,'박성진','103','현대자동차','PR2026103','M'),
(4,'정우진','104','SK텔레콤','PR2026104','M'),
(5,'최동혁','105','포스코','PR2026105','M'),
(6,'강태현','106','한화','PR2026106','M'),
(7,'윤재석','107','롯데','PR2026107','M'),
(8,'한승우','108','두산','PR2026108','M'),
(9,'임도현','109','KT','PR2026109','M'),
(10,'서영민','110','기아','PR2026110','M'),
(11,'조현우','111','삼성전자','PR2026111','M'),
(12,'배진혁','112','LG전자','PR2026112','M'),
(13,'신동원','113','현대자동차','PR2026113','M'),
(14,'류성호','114','SK텔레콤','PR2026114','M'),
(15,'황민재','115','포스코','PR2026115','M'),
(16,'오준영','116','한화','PR2026116','M');

-- 여자 단거리 (100m/200m/400m) 16명 BIB 117-132
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(17,'김서연','117','삼성전자','PR2026117','F'),
(18,'이지은','118','LG전자','PR2026118','F'),
(19,'박하나','119','현대자동차','PR2026119','F'),
(20,'정유진','120','SK텔레콤','PR2026120','F'),
(21,'최수빈','121','포스코','PR2026121','F'),
(22,'강민지','122','한화','PR2026122','F'),
(23,'윤소희','123','롯데','PR2026123','F'),
(24,'한예진','124','두산','PR2026124','F'),
(25,'임채원','125','KT','PR2026125','F'),
(26,'서지원','126','기아','PR2026126','F'),
(27,'조은별','127','삼성전자','PR2026127','F'),
(28,'배수진','128','LG전자','PR2026128','F'),
(29,'신하늘','129','현대자동차','PR2026129','F'),
(30,'류지현','130','SK텔레콤','PR2026130','F'),
(31,'황보라','131','포스코','PR2026131','F'),
(32,'오미래','132','한화','PR2026132','F');

-- 남자 중장거리 (800m/1500m/5000m/10000m/3000m장애물) 12명 BIB 133-144
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(81,'고승현','133','삼성전자','PR2026133','M'),
(82,'나태우','134','LG전자','PR2026134','M'),
(83,'도경민','135','현대자동차','PR2026135','M'),
(84,'마준서','136','SK텔레콤','PR2026136','M'),
(85,'사현석','137','포스코','PR2026137','M'),
(86,'아진우','138','한화','PR2026138','M'),
(87,'자동건','139','롯데','PR2026139','M'),
(88,'차승호','140','두산','PR2026140','M'),
(89,'카민혁','141','KT','PR2026141','M'),
(90,'타윤재','142','기아','PR2026142','M'),
(91,'파성준','143','삼성전자','PR2026143','M'),
(92,'하도현','144','LG전자','PR2026144','M');

-- 여자 중장거리 12명 BIB 145-156
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(93,'고은서','145','삼성전자','PR2026145','F'),
(94,'나지현','146','LG전자','PR2026146','F'),
(95,'도하영','147','현대자동차','PR2026147','F'),
(96,'마소율','148','SK텔레콤','PR2026148','F'),
(97,'사예린','149','포스코','PR2026149','F'),
(98,'아채원','150','한화','PR2026150','F'),
(99,'자민서','151','롯데','PR2026151','F'),
(100,'차유진','152','두산','PR2026152','F'),
(101,'카은별','153','KT','PR2026153','F'),
(102,'타서영','154','기아','PR2026154','F'),
(103,'파지은','155','삼성전자','PR2026155','F'),
(104,'하수아','156','LG전자','PR2026156','F');

-- 남자 허들 (110m허들/400m허들) 12명 BIB 157-168
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(105,'구도현','157','삼성전자','PR2026157','M'),
(106,'두재윤','158','LG전자','PR2026158','M'),
(107,'루승민','159','현대자동차','PR2026159','M'),
(108,'무태양','160','SK텔레콤','PR2026160','M'),
(109,'부현준','161','포스코','PR2026161','M'),
(110,'수동우','162','한화','PR2026162','M'),
(111,'우진호','163','롯데','PR2026163','M'),
(112,'주민기','164','두산','PR2026164','M'),
(113,'추영석','165','KT','PR2026165','M'),
(114,'후성현','166','기아','PR2026166','M'),
(115,'곽준혁','167','삼성전자','PR2026167','M'),
(116,'남재호','168','LG전자','PR2026168','M');

-- 여자 허들 (100m허들/400m허들) 12명 BIB 169-180
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(117,'구서윤','169','삼성전자','PR2026169','F'),
(118,'두예진','170','LG전자','PR2026170','F'),
(119,'루하은','171','현대자동차','PR2026171','F'),
(120,'무소희','172','SK텔레콤','PR2026172','F'),
(121,'부채린','173','포스코','PR2026173','F'),
(122,'수가은','174','한화','PR2026174','F'),
(123,'우민지','175','롯데','PR2026175','F'),
(124,'주하늘','176','두산','PR2026176','F'),
(125,'추예원','177','KT','PR2026177','F'),
(126,'후지현','178','기아','PR2026178','F'),
(127,'곽보라','179','삼성전자','PR2026179','F'),
(128,'남수빈','180','LG전자','PR2026180','F');

-- 남자 Field Distance (멀리/세단/포환/원반/해머/창) 10명 BIB 201-210
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(33,'장현우','201','삼성전자','PR2026201','M'),
(34,'문태영','202','LG전자','PR2026202','M'),
(35,'권도윤','203','현대자동차','PR2026203','M'),
(36,'안세훈','204','SK텔레콤','PR2026204','M'),
(37,'송민기','205','포스코','PR2026205','M'),
(38,'노정환','206','한화','PR2026206','M'),
(39,'유승현','207','롯데','PR2026207','M'),
(40,'홍진우','208','두산','PR2026208','M'),
(41,'전병호','209','KT','PR2026209','M'),
(42,'남기혁','210','기아','PR2026210','M');

-- 여자 Field Distance 10명 BIB 211-220
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(43,'김나영','211','삼성전자','PR2026211','F'),
(44,'이수아','212','LG전자','PR2026212','F'),
(45,'박지민','213','현대자동차','PR2026213','F'),
(46,'정다은','214','SK텔레콤','PR2026214','F'),
(47,'최예린','215','포스코','PR2026215','F'),
(48,'강소율','216','한화','PR2026216','F'),
(49,'윤하은','217','롯데','PR2026217','F'),
(50,'한서영','218','두산','PR2026218','F'),
(51,'임가은','219','KT','PR2026219','F'),
(52,'서윤지','220','기아','PR2026220','F');

-- 남자 높이뛰기 8명 BIB 301-308
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(53,'우상혁','301','삼성전자','PR2026301','M'),
(54,'김태윤','302','LG전자','PR2026302','M'),
(55,'이호준','303','현대자동차','PR2026303','M'),
(56,'박건우','304','SK텔레콤','PR2026304','M'),
(57,'정현서','305','포스코','PR2026305','M'),
(58,'최재민','306','한화','PR2026306','M'),
(59,'강동현','307','롯데','PR2026307','M'),
(60,'윤시우','308','두산','PR2026308','M');

-- 여자 높이뛰기 8명 BIB 309-316
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(61,'김유나','309','삼성전자','PR2026309','F'),
(62,'이하린','310','LG전자','PR2026310','F'),
(63,'박소은','311','현대자동차','PR2026311','F'),
(64,'정민서','312','SK텔레콤','PR2026312','F'),
(65,'최윤아','313','포스코','PR2026313','F'),
(66,'강채은','314','한화','PR2026314','F'),
(67,'윤서현','315','롯데','PR2026315','F'),
(68,'한지유','316','두산','PR2026316','F');

-- 남자 장대높이뛰기 8명 BIB 317-324
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(129,'오태경','317','삼성전자','PR2026317','M'),
(130,'민준형','318','LG전자','PR2026318','M'),
(131,'양세찬','319','현대자동차','PR2026319','M'),
(132,'천재영','320','SK텔레콤','PR2026320','M'),
(133,'피동수','321','포스코','PR2026321','M'),
(134,'길태풍','322','한화','PR2026322','M'),
(135,'변준석','323','롯데','PR2026323','M'),
(136,'석민호','324','두산','PR2026324','M');

-- 여자 장대높이뛰기 8명 BIB 325-332
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(137,'오서현','325','삼성전자','PR2026325','F'),
(138,'민지은','326','LG전자','PR2026326','F'),
(139,'양하나','327','현대자동차','PR2026327','F'),
(140,'천소율','328','SK텔레콤','PR2026328','F'),
(141,'피예린','329','포스코','PR2026329','F'),
(142,'길채은','330','한화','PR2026330','F'),
(143,'변유진','331','롯데','PR2026331','F'),
(144,'석수아','332','두산','PR2026332','F');

-- 남자 릴레이 선수 (4x100m, 4x400m) — 재사용 단거리 선수 일부 + 8명 추가 BIB 501-508
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(145,'금동현','501','삼성전자','PR2026501','M'),
(146,'은재호','502','LG전자','PR2026502','M'),
(147,'동승민','503','현대자동차','PR2026503','M'),
(148,'철태우','504','SK텔레콤','PR2026504','M'),
(149,'성현준','505','포스코','PR2026505','M'),
(150,'광민기','506','한화','PR2026506','M'),
(151,'주영석','507','롯데','PR2026507','M'),
(152,'원성현','508','두산','PR2026508','M');

-- 여자 릴레이 추가 BIB 509-516
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(153,'금서윤','509','삼성전자','PR2026509','F'),
(154,'은예진','510','LG전자','PR2026510','F'),
(155,'동하은','511','현대자동차','PR2026511','F'),
(156,'철소희','512','SK텔레콤','PR2026512','F'),
(157,'성채린','513','포스코','PR2026513','F'),
(158,'광가은','514','한화','PR2026514','F'),
(159,'주하영','515','롯데','PR2026515','F'),
(160,'원지현','516','두산','PR2026516','F');

-- 남자 10종 경기 선수 6명 BIB 401-406
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(69,'김준혁','401','삼성전자','PR2026401','M'),
(70,'이태민','402','LG전자','PR2026402','M'),
(71,'박시원','403','현대자동차','PR2026403','M'),
(72,'정재윤','404','SK텔레콤','PR2026404','M'),
(73,'최승환','405','포스코','PR2026405','M'),
(74,'강민호','406','한화','PR2026406','M');

-- 여자 7종 경기 선수 6명 BIB 407-412
INSERT INTO athlete (id,name,bib_number,team,barcode,gender) VALUES
(75,'김하윤','407','삼성전자','PR2026407','F'),
(76,'이서진','408','LG전자','PR2026408','F'),
(77,'박채원','409','현대자동차','PR2026409','F'),
(78,'정아린','410','SK텔레콤','PR2026410','F'),
(79,'최은서','411','포스코','PR2026411','F'),
(80,'강지안','412','한화','PR2026412','F');


-- ============================================================
-- EVENT ENTRIES — 모든 종목에 선수 배정
-- ============================================================

-- === 남자 100m 예선 (event 1) — 16명 ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(1,1,1,'registered'),(2,1,2,'registered'),(3,1,3,'registered'),(4,1,4,'registered'),
(5,1,5,'registered'),(6,1,6,'registered'),(7,1,7,'registered'),(8,1,8,'registered'),
(9,1,9,'registered'),(10,1,10,'registered'),(11,1,11,'registered'),(12,1,12,'registered'),
(13,1,13,'registered'),(14,1,14,'registered'),(15,1,15,'registered'),(16,1,16,'registered');

-- === 남자 200m (event 2) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(50,2,1,'registered'),(51,2,2,'registered'),(52,2,3,'registered'),(53,2,4,'registered'),
(54,2,5,'registered'),(55,2,6,'registered'),(56,2,7,'registered'),(57,2,8,'registered'),
(58,2,9,'registered'),(59,2,10,'registered'),(60,2,11,'registered'),(61,2,12,'registered'),
(62,2,13,'registered'),(63,2,14,'registered'),(64,2,15,'registered'),(65,2,16,'registered');

-- === 남자 400m (event 3) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(70,3,1,'registered'),(71,3,2,'registered'),(72,3,3,'registered'),(73,3,4,'registered'),
(74,3,5,'registered'),(75,3,6,'registered'),(76,3,7,'registered'),(77,3,8,'registered'),
(78,3,9,'registered'),(79,3,10,'registered'),(80,3,11,'registered'),(81,3,12,'registered');

-- === 남자 800m (event 4) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(90,4,81,'registered'),(91,4,82,'registered'),(92,4,83,'registered'),(93,4,84,'registered'),
(94,4,85,'registered'),(95,4,86,'registered'),(96,4,87,'registered'),(97,4,88,'registered'),
(98,4,89,'registered'),(99,4,90,'registered'),(100,4,91,'registered'),(101,4,92,'registered');

-- === 남자 1500m (event 5) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(110,5,81,'registered'),(111,5,82,'registered'),(112,5,83,'registered'),(113,5,84,'registered'),
(114,5,85,'registered'),(115,5,86,'registered'),(116,5,87,'registered'),(117,5,88,'registered'),
(118,5,89,'registered'),(119,5,90,'registered'),(120,5,91,'registered'),(121,5,92,'registered');

-- === 남자 5000m (event 6) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(130,6,81,'registered'),(131,6,82,'registered'),(132,6,83,'registered'),(133,6,84,'registered'),
(134,6,85,'registered'),(135,6,86,'registered'),(136,6,87,'registered'),(137,6,88,'registered');

-- === 남자 10000m (event 7) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(140,7,81,'registered'),(141,7,82,'registered'),(142,7,83,'registered'),(143,7,84,'registered'),
(144,7,85,'registered'),(145,7,86,'registered'),(146,7,87,'registered'),(147,7,88,'registered');

-- === 남자 110m 허들 (event 8) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(150,8,105,'registered'),(151,8,106,'registered'),(152,8,107,'registered'),(153,8,108,'registered'),
(154,8,109,'registered'),(155,8,110,'registered'),(156,8,111,'registered'),(157,8,112,'registered'),
(158,8,113,'registered'),(159,8,114,'registered'),(160,8,115,'registered'),(161,8,116,'registered');

-- === 남자 400m 허들 (event 9) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(170,9,105,'registered'),(171,9,106,'registered'),(172,9,107,'registered'),(173,9,108,'registered'),
(174,9,109,'registered'),(175,9,110,'registered'),(176,9,111,'registered'),(177,9,112,'registered'),
(178,9,113,'registered'),(179,9,114,'registered'),(180,9,115,'registered'),(181,9,116,'registered');

-- === 남자 3000m 장애물 (event 10) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(190,10,81,'registered'),(191,10,82,'registered'),(192,10,83,'registered'),(193,10,84,'registered'),
(194,10,85,'registered'),(195,10,86,'registered'),(196,10,87,'registered'),(197,10,88,'registered');

-- === 남자 4x100m 릴레이 (event 11) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(200,11,145,'registered'),(201,11,146,'registered'),(202,11,147,'registered'),(203,11,148,'registered'),
(204,11,149,'registered'),(205,11,150,'registered'),(206,11,151,'registered'),(207,11,152,'registered');

-- === 남자 4x400m 릴레이 (event 12) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(210,12,145,'registered'),(211,12,146,'registered'),(212,12,147,'registered'),(213,12,148,'registered'),
(214,12,149,'registered'),(215,12,150,'registered'),(216,12,151,'registered'),(217,12,152,'registered');

-- === 여자 100m (event 13) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(220,13,17,'registered'),(221,13,18,'registered'),(222,13,19,'registered'),(223,13,20,'registered'),
(224,13,21,'registered'),(225,13,22,'registered'),(226,13,23,'registered'),(227,13,24,'registered'),
(228,13,25,'registered'),(229,13,26,'registered'),(230,13,27,'registered'),(231,13,28,'registered'),
(232,13,29,'registered'),(233,13,30,'registered'),(234,13,31,'registered'),(235,13,32,'registered');

-- === 여자 200m (event 14) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(240,14,17,'registered'),(241,14,18,'registered'),(242,14,19,'registered'),(243,14,20,'registered'),
(244,14,21,'registered'),(245,14,22,'registered'),(246,14,23,'registered'),(247,14,24,'registered'),
(248,14,25,'registered'),(249,14,26,'registered'),(250,14,27,'registered'),(251,14,28,'registered');

-- === 여자 400m (event 15) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(260,15,17,'registered'),(261,15,18,'registered'),(262,15,19,'registered'),(263,15,20,'registered'),
(264,15,21,'registered'),(265,15,22,'registered'),(266,15,23,'registered'),(267,15,24,'registered'),
(268,15,25,'registered'),(269,15,26,'registered'),(270,15,27,'registered'),(271,15,28,'registered');

-- === 여자 800m (event 16) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(280,16,93,'registered'),(281,16,94,'registered'),(282,16,95,'registered'),(283,16,96,'registered'),
(284,16,97,'registered'),(285,16,98,'registered'),(286,16,99,'registered'),(287,16,100,'registered'),
(288,16,101,'registered'),(289,16,102,'registered'),(290,16,103,'registered'),(291,16,104,'registered');

-- === 여자 1500m (event 17) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(300,17,93,'registered'),(301,17,94,'registered'),(302,17,95,'registered'),(303,17,96,'registered'),
(304,17,97,'registered'),(305,17,98,'registered'),(306,17,99,'registered'),(307,17,100,'registered'),
(308,17,101,'registered'),(309,17,102,'registered'),(310,17,103,'registered'),(311,17,104,'registered');

-- === 여자 5000m (event 18) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(320,18,93,'registered'),(321,18,94,'registered'),(322,18,95,'registered'),(323,18,96,'registered'),
(324,18,97,'registered'),(325,18,98,'registered'),(326,18,99,'registered'),(327,18,100,'registered');

-- === 여자 10000m (event 19) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(330,19,93,'registered'),(331,19,94,'registered'),(332,19,95,'registered'),(333,19,96,'registered'),
(334,19,97,'registered'),(335,19,98,'registered'),(336,19,99,'registered'),(337,19,100,'registered');

-- === 여자 100m 허들 (event 20) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(340,20,117,'registered'),(341,20,118,'registered'),(342,20,119,'registered'),(343,20,120,'registered'),
(344,20,121,'registered'),(345,20,122,'registered'),(346,20,123,'registered'),(347,20,124,'registered'),
(348,20,125,'registered'),(349,20,126,'registered'),(350,20,127,'registered'),(351,20,128,'registered');

-- === 여자 400m 허들 (event 21) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(360,21,117,'registered'),(361,21,118,'registered'),(362,21,119,'registered'),(363,21,120,'registered'),
(364,21,121,'registered'),(365,21,122,'registered'),(366,21,123,'registered'),(367,21,124,'registered'),
(368,21,125,'registered'),(369,21,126,'registered'),(370,21,127,'registered'),(371,21,128,'registered');

-- === 여자 3000m 장애물 (event 22) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(380,22,93,'registered'),(381,22,94,'registered'),(382,22,95,'registered'),(383,22,96,'registered'),
(384,22,97,'registered'),(385,22,98,'registered'),(386,22,99,'registered'),(387,22,100,'registered');

-- === 여자 4x100m 릴레이 (event 23) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(390,23,153,'registered'),(391,23,154,'registered'),(392,23,155,'registered'),(393,23,156,'registered'),
(394,23,157,'registered'),(395,23,158,'registered'),(396,23,159,'registered'),(397,23,160,'registered');

-- === 여자 4x400m 릴레이 (event 24) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(400,24,153,'registered'),(401,24,154,'registered'),(402,24,155,'registered'),(403,24,156,'registered'),
(404,24,157,'registered'),(405,24,158,'registered'),(406,24,159,'registered'),(407,24,160,'registered');

-- === 혼성 4x400m 릴레이 (event 25) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(410,25,1,'registered'),(411,25,2,'registered'),(412,25,17,'registered'),(413,25,18,'registered'),
(414,25,3,'registered'),(415,25,4,'registered'),(416,25,19,'registered'),(417,25,20,'registered');

-- === 남자 멀리뛰기 (event 26) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(17,26,33,'registered'),(18,26,34,'registered'),(19,26,35,'registered'),(20,26,36,'registered'),
(21,26,37,'registered'),(22,26,38,'registered'),(23,26,39,'registered'),(24,26,40,'registered'),
(25,26,41,'registered'),(26,26,42,'registered');

-- === 남자 세단뛰기 (event 27) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(420,27,33,'registered'),(421,27,34,'registered'),(422,27,35,'registered'),(423,27,36,'registered'),
(424,27,37,'registered'),(425,27,38,'registered'),(426,27,39,'registered'),(427,27,40,'registered'),
(428,27,41,'registered'),(429,27,42,'registered');

-- === 남자 포환던지기 (event 28) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(430,28,33,'registered'),(431,28,34,'registered'),(432,28,35,'registered'),(433,28,36,'registered'),
(434,28,37,'registered'),(435,28,38,'registered'),(436,28,39,'registered'),(437,28,40,'registered'),
(438,28,41,'registered'),(439,28,42,'registered');

-- === 남자 원반던지기 (event 29) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(440,29,33,'registered'),(441,29,34,'registered'),(442,29,35,'registered'),(443,29,36,'registered'),
(444,29,37,'registered'),(445,29,38,'registered'),(446,29,39,'registered'),(447,29,40,'registered'),
(448,29,41,'registered'),(449,29,42,'registered');

-- === 남자 해머던지기 (event 30) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(450,30,33,'registered'),(451,30,34,'registered'),(452,30,35,'registered'),(453,30,36,'registered'),
(454,30,37,'registered'),(455,30,38,'registered'),(456,30,39,'registered'),(457,30,40,'registered'),
(458,30,41,'registered'),(459,30,42,'registered');

-- === 남자 창던지기 (event 31) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(460,31,33,'registered'),(461,31,34,'registered'),(462,31,35,'registered'),(463,31,36,'registered'),
(464,31,37,'registered'),(465,31,38,'registered'),(466,31,39,'registered'),(467,31,40,'registered'),
(468,31,41,'registered'),(469,31,42,'registered');

-- === 여자 멀리뛰기 (event 32) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(470,32,43,'registered'),(471,32,44,'registered'),(472,32,45,'registered'),(473,32,46,'registered'),
(474,32,47,'registered'),(475,32,48,'registered'),(476,32,49,'registered'),(477,32,50,'registered'),
(478,32,51,'registered'),(479,32,52,'registered');

-- === 여자 세단뛰기 (event 33) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(480,33,43,'registered'),(481,33,44,'registered'),(482,33,45,'registered'),(483,33,46,'registered'),
(484,33,47,'registered'),(485,33,48,'registered'),(486,33,49,'registered'),(487,33,50,'registered'),
(488,33,51,'registered'),(489,33,52,'registered');

-- === 여자 포환던지기 (event 34) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(490,34,43,'registered'),(491,34,44,'registered'),(492,34,45,'registered'),(493,34,46,'registered'),
(494,34,47,'registered'),(495,34,48,'registered'),(496,34,49,'registered'),(497,34,50,'registered'),
(498,34,51,'registered'),(499,34,52,'registered');

-- === 여자 원반던지기 (event 35) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(500,35,43,'registered'),(501,35,44,'registered'),(502,35,45,'registered'),(503,35,46,'registered'),
(504,35,47,'registered'),(505,35,48,'registered'),(506,35,49,'registered'),(507,35,50,'registered'),
(508,35,51,'registered'),(509,35,52,'registered');

-- === 여자 해머던지기 (event 36) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(510,36,43,'registered'),(511,36,44,'registered'),(512,36,45,'registered'),(513,36,46,'registered'),
(514,36,47,'registered'),(515,36,48,'registered'),(516,36,49,'registered'),(517,36,50,'registered'),
(518,36,51,'registered'),(519,36,52,'registered');

-- === 여자 창던지기 (event 37) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(520,37,43,'registered'),(521,37,44,'registered'),(522,37,45,'registered'),(523,37,46,'registered'),
(524,37,47,'registered'),(525,37,48,'registered'),(526,37,49,'registered'),(527,37,50,'registered'),
(528,37,51,'registered'),(529,37,52,'registered');

-- === 남자 높이뛰기 (event 38) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(27,38,53,'registered'),(28,38,54,'registered'),(29,38,55,'registered'),(30,38,56,'registered'),
(31,38,57,'registered'),(32,38,58,'registered'),(33,38,59,'registered'),(34,38,60,'registered');

-- === 남자 장대높이뛰기 (event 39) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(530,39,129,'registered'),(531,39,130,'registered'),(532,39,131,'registered'),(533,39,132,'registered'),
(534,39,133,'registered'),(535,39,134,'registered'),(536,39,135,'registered'),(537,39,136,'registered');

-- === 여자 높이뛰기 (event 40) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(540,40,61,'registered'),(541,40,62,'registered'),(542,40,63,'registered'),(543,40,64,'registered'),
(544,40,65,'registered'),(545,40,66,'registered'),(546,40,67,'registered'),(547,40,68,'registered');

-- === 여자 장대높이뛰기 (event 41) ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(550,41,137,'registered'),(551,41,138,'registered'),(552,41,139,'registered'),(553,41,140,'registered'),
(554,41,141,'registered'),(555,41,142,'registered'),(556,41,143,'registered'),(557,41,144,'registered');

-- === 10종 parent entries ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(35,42,69,'registered'),(36,42,70,'registered'),(37,42,71,'registered'),
(38,42,72,'registered'),(39,42,73,'registered'),(40,42,74,'registered');

-- === 7종 parent entries ===
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(41,43,75,'registered'),(42,43,76,'registered'),(43,43,77,'registered'),
(44,43,78,'registered'),(45,43,79,'registered'),(46,43,80,'registered');

-- 10종 세부 entries (1001~1096)
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(1001,101,69,'registered'),(1002,101,70,'registered'),(1003,101,71,'registered'),
(1004,101,72,'registered'),(1005,101,73,'registered'),(1006,101,74,'registered'),
(1011,102,69,'registered'),(1012,102,70,'registered'),(1013,102,71,'registered'),
(1014,102,72,'registered'),(1015,102,73,'registered'),(1016,102,74,'registered'),
(1021,103,69,'registered'),(1022,103,70,'registered'),(1023,103,71,'registered'),
(1024,103,72,'registered'),(1025,103,73,'registered'),(1026,103,74,'registered'),
(1031,104,69,'registered'),(1032,104,70,'registered'),(1033,104,71,'registered'),
(1034,104,72,'registered'),(1035,104,73,'registered'),(1036,104,74,'registered'),
(1041,105,69,'registered'),(1042,105,70,'registered'),(1043,105,71,'registered'),
(1044,105,72,'registered'),(1045,105,73,'registered'),(1046,105,74,'registered'),
(1051,106,69,'registered'),(1052,106,70,'registered'),(1053,106,71,'registered'),
(1054,106,72,'registered'),(1055,106,73,'registered'),(1056,106,74,'registered'),
(1061,107,69,'registered'),(1062,107,70,'registered'),(1063,107,71,'registered'),
(1064,107,72,'registered'),(1065,107,73,'registered'),(1066,107,74,'registered'),
(1071,108,69,'registered'),(1072,108,70,'registered'),(1073,108,71,'registered'),
(1074,108,72,'registered'),(1075,108,73,'registered'),(1076,108,74,'registered'),
(1081,109,69,'registered'),(1082,109,70,'registered'),(1083,109,71,'registered'),
(1084,109,72,'registered'),(1085,109,73,'registered'),(1086,109,74,'registered'),
(1091,110,69,'registered'),(1092,110,70,'registered'),(1093,110,71,'registered'),
(1094,110,72,'registered'),(1095,110,73,'registered'),(1096,110,74,'registered');

-- 7종 세부 entries (2001~2066)
INSERT INTO event_entry (id,event_id,athlete_id,status) VALUES
(2001,201,75,'registered'),(2002,201,76,'registered'),(2003,201,77,'registered'),
(2004,201,78,'registered'),(2005,201,79,'registered'),(2006,201,80,'registered'),
(2011,202,75,'registered'),(2012,202,76,'registered'),(2013,202,77,'registered'),
(2014,202,78,'registered'),(2015,202,79,'registered'),(2016,202,80,'registered'),
(2021,203,75,'registered'),(2022,203,76,'registered'),(2023,203,77,'registered'),
(2024,203,78,'registered'),(2025,203,79,'registered'),(2026,203,80,'registered'),
(2031,204,75,'registered'),(2032,204,76,'registered'),(2033,204,77,'registered'),
(2034,204,78,'registered'),(2035,204,79,'registered'),(2036,204,80,'registered'),
(2041,205,75,'registered'),(2042,205,76,'registered'),(2043,205,77,'registered'),
(2044,205,78,'registered'),(2045,205,79,'registered'),(2046,205,80,'registered'),
(2051,206,75,'registered'),(2052,206,76,'registered'),(2053,206,77,'registered'),
(2054,206,78,'registered'),(2055,206,79,'registered'),(2056,206,80,'registered'),
(2061,207,75,'registered'),(2062,207,76,'registered'),(2063,207,77,'registered'),
(2064,207,78,'registered'),(2065,207,79,'registered'),(2066,207,80,'registered');


-- ============================================================
-- HEATS — 모든 종목에 heat 생성
-- ============================================================

-- 남자 100m: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (1,1,1),(2,1,2);
-- 남자 200m: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (7,2,1),(8,2,2);
-- 남자 400m: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (9,3,1),(10,3,2);
-- 남자 800m: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (11,4,1),(12,4,2);
-- 남자 1500m: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (13,5,1),(14,5,2);
-- 남자 5000m: 1 heat
INSERT INTO heat (id,event_id,heat_number) VALUES (15,6,1);
-- 남자 10000m: 1 heat
INSERT INTO heat (id,event_id,heat_number) VALUES (16,7,1);
-- 남자 110m 허들: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (17,8,1),(18,8,2);
-- 남자 400m 허들: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (19,9,1),(20,9,2);
-- 남자 3000m 장애물: 1 heat
INSERT INTO heat (id,event_id,heat_number) VALUES (21,10,1);
-- 남자 4x100m 릴레이: 1 heat
INSERT INTO heat (id,event_id,heat_number) VALUES (22,11,1);
-- 남자 4x400m 릴레이: 1 heat
INSERT INTO heat (id,event_id,heat_number) VALUES (23,12,1);
-- 여자 100m: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (24,13,1),(25,13,2);
-- 여자 200m: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (26,14,1),(27,14,2);
-- 여자 400m: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (28,15,1),(29,15,2);
-- 여자 800m: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (30,16,1),(31,16,2);
-- 여자 1500m: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (32,17,1),(33,17,2);
-- 여자 5000m: 1 heat
INSERT INTO heat (id,event_id,heat_number) VALUES (34,18,1);
-- 여자 10000m: 1 heat
INSERT INTO heat (id,event_id,heat_number) VALUES (35,19,1);
-- 여자 100m 허들: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (36,20,1),(37,20,2);
-- 여자 400m 허들: 2 heats
INSERT INTO heat (id,event_id,heat_number) VALUES (38,21,1),(39,21,2);
-- 여자 3000m 장애물: 1 heat
INSERT INTO heat (id,event_id,heat_number) VALUES (40,22,1);
-- 여자 4x100m 릴레이: 1 heat
INSERT INTO heat (id,event_id,heat_number) VALUES (41,23,1);
-- 여자 4x400m 릴레이: 1 heat
INSERT INTO heat (id,event_id,heat_number) VALUES (42,24,1);
-- 혼성 4x400m 릴레이: 1 heat
INSERT INTO heat (id,event_id,heat_number) VALUES (43,25,1);
-- 남자 멀리뛰기
INSERT INTO heat (id,event_id,heat_number) VALUES (3,26,1);
-- 남자 세단뛰기
INSERT INTO heat (id,event_id,heat_number) VALUES (44,27,1);
-- 남자 포환던지기
INSERT INTO heat (id,event_id,heat_number) VALUES (45,28,1);
-- 남자 원반던지기
INSERT INTO heat (id,event_id,heat_number) VALUES (46,29,1);
-- 남자 해머던지기
INSERT INTO heat (id,event_id,heat_number) VALUES (47,30,1);
-- 남자 창던지기
INSERT INTO heat (id,event_id,heat_number) VALUES (48,31,1);
-- 여자 멀리뛰기
INSERT INTO heat (id,event_id,heat_number) VALUES (49,32,1);
-- 여자 세단뛰기
INSERT INTO heat (id,event_id,heat_number) VALUES (50,33,1);
-- 여자 포환던지기
INSERT INTO heat (id,event_id,heat_number) VALUES (51,34,1);
-- 여자 원반던지기
INSERT INTO heat (id,event_id,heat_number) VALUES (52,35,1);
-- 여자 해머던지기
INSERT INTO heat (id,event_id,heat_number) VALUES (53,36,1);
-- 여자 창던지기
INSERT INTO heat (id,event_id,heat_number) VALUES (54,37,1);
-- 남자 높이뛰기
INSERT INTO heat (id,event_id,heat_number) VALUES (4,38,1);
-- 남자 장대높이뛰기
INSERT INTO heat (id,event_id,heat_number) VALUES (55,39,1);
-- 여자 높이뛰기
INSERT INTO heat (id,event_id,heat_number) VALUES (56,40,1);
-- 여자 장대높이뛰기
INSERT INTO heat (id,event_id,heat_number) VALUES (57,41,1);
-- 10종 parent
INSERT INTO heat (id,event_id,heat_number) VALUES (5,42,1);
-- 7종 parent
INSERT INTO heat (id,event_id,heat_number) VALUES (6,43,1);
-- 10종 세부 heats
INSERT INTO heat (id,event_id,heat_number) VALUES
(101,101,1),(102,102,1),(103,103,1),(104,104,1),(105,105,1),
(106,106,1),(107,107,1),(108,108,1),(109,109,1),(110,110,1);
-- 7종 세부 heats
INSERT INTO heat (id,event_id,heat_number) VALUES
(201,201,1),(202,202,1),(203,203,1),(204,204,1),(205,205,1),(206,206,1),(207,207,1);


-- ============================================================
-- HEAT ENTRIES — 모든 종목
-- ============================================================

-- 남자 100m Heat 1 (8명)
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(1,1,1),(1,2,2),(1,3,3),(1,4,4),(1,5,5),(1,6,6),(1,7,7),(1,8,8);
-- 남자 100m Heat 2 (8명)
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(2,9,1),(2,10,2),(2,11,3),(2,12,4),(2,13,5),(2,14,6),(2,15,7),(2,16,8);

-- 남자 200m Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(7,50,1),(7,51,2),(7,52,3),(7,53,4),(7,54,5),(7,55,6),(7,56,7),(7,57,8),
(8,58,1),(8,59,2),(8,60,3),(8,61,4),(8,62,5),(8,63,6),(8,64,7),(8,65,8);

-- 남자 400m Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(9,70,1),(9,71,2),(9,72,3),(9,73,4),(9,74,5),(9,75,6),
(10,76,1),(10,77,2),(10,78,3),(10,79,4),(10,80,5),(10,81,6);

-- 남자 800m Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(11,90,1),(11,91,2),(11,92,3),(11,93,4),(11,94,5),(11,95,6),
(12,96,1),(12,97,2),(12,98,3),(12,99,4),(12,100,5),(12,101,6);

-- 남자 1500m Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(13,110,1),(13,111,2),(13,112,3),(13,113,4),(13,114,5),(13,115,6),
(14,116,1),(14,117,2),(14,118,3),(14,119,4),(14,120,5),(14,121,6);

-- 남자 5000m Heat 1
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(15,130,1),(15,131,2),(15,132,3),(15,133,4),(15,134,5),(15,135,6),(15,136,7),(15,137,8);

-- 남자 10000m Heat 1
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(16,140,1),(16,141,2),(16,142,3),(16,143,4),(16,144,5),(16,145,6),(16,146,7),(16,147,8);

-- 남자 110m 허들 Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(17,150,1),(17,151,2),(17,152,3),(17,153,4),(17,154,5),(17,155,6),
(18,156,1),(18,157,2),(18,158,3),(18,159,4),(18,160,5),(18,161,6);

-- 남자 400m 허들 Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(19,170,1),(19,171,2),(19,172,3),(19,173,4),(19,174,5),(19,175,6),
(20,176,1),(20,177,2),(20,178,3),(20,179,4),(20,180,5),(20,181,6);

-- 남자 3000m 장애물 Heat 1
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(21,190,1),(21,191,2),(21,192,3),(21,193,4),(21,194,5),(21,195,6),(21,196,7),(21,197,8);

-- 남자 4x100m 릴레이 Heat 1
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(22,200,1),(22,201,2),(22,202,3),(22,203,4),(22,204,5),(22,205,6),(22,206,7),(22,207,8);

-- 남자 4x400m 릴레이 Heat 1
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(23,210,1),(23,211,2),(23,212,3),(23,213,4),(23,214,5),(23,215,6),(23,216,7),(23,217,8);

-- 여자 100m Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(24,220,1),(24,221,2),(24,222,3),(24,223,4),(24,224,5),(24,225,6),(24,226,7),(24,227,8),
(25,228,1),(25,229,2),(25,230,3),(25,231,4),(25,232,5),(25,233,6),(25,234,7),(25,235,8);

-- 여자 200m Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(26,240,1),(26,241,2),(26,242,3),(26,243,4),(26,244,5),(26,245,6),
(27,246,1),(27,247,2),(27,248,3),(27,249,4),(27,250,5),(27,251,6);

-- 여자 400m Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(28,260,1),(28,261,2),(28,262,3),(28,263,4),(28,264,5),(28,265,6),
(29,266,1),(29,267,2),(29,268,3),(29,269,4),(29,270,5),(29,271,6);

-- 여자 800m Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(30,280,1),(30,281,2),(30,282,3),(30,283,4),(30,284,5),(30,285,6),
(31,286,1),(31,287,2),(31,288,3),(31,289,4),(31,290,5),(31,291,6);

-- 여자 1500m Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(32,300,1),(32,301,2),(32,302,3),(32,303,4),(32,304,5),(32,305,6),
(33,306,1),(33,307,2),(33,308,3),(33,309,4),(33,310,5),(33,311,6);

-- 여자 5000m Heat 1
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(34,320,1),(34,321,2),(34,322,3),(34,323,4),(34,324,5),(34,325,6),(34,326,7),(34,327,8);

-- 여자 10000m Heat 1
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(35,330,1),(35,331,2),(35,332,3),(35,333,4),(35,334,5),(35,335,6),(35,336,7),(35,337,8);

-- 여자 100m 허들 Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(36,340,1),(36,341,2),(36,342,3),(36,343,4),(36,344,5),(36,345,6),
(37,346,1),(37,347,2),(37,348,3),(37,349,4),(37,350,5),(37,351,6);

-- 여자 400m 허들 Heat 1 & 2
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(38,360,1),(38,361,2),(38,362,3),(38,363,4),(38,364,5),(38,365,6),
(39,366,1),(39,367,2),(39,368,3),(39,369,4),(39,370,5),(39,371,6);

-- 여자 3000m 장애물 Heat 1
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(40,380,1),(40,381,2),(40,382,3),(40,383,4),(40,384,5),(40,385,6),(40,386,7),(40,387,8);

-- 여자 4x100m 릴레이 Heat 1
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(41,390,1),(41,391,2),(41,392,3),(41,393,4),(41,394,5),(41,395,6),(41,396,7),(41,397,8);

-- 여자 4x400m 릴레이 Heat 1
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(42,400,1),(42,401,2),(42,402,3),(42,403,4),(42,404,5),(42,405,6),(42,406,7),(42,407,8);

-- 혼성 4x400m 릴레이 Heat 1
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(43,410,1),(43,411,2),(43,412,3),(43,413,4),(43,414,5),(43,415,6),(43,416,7),(43,417,8);

-- 남자 멀리뛰기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(3,17,NULL),(3,18,NULL),(3,19,NULL),(3,20,NULL),(3,21,NULL),
(3,22,NULL),(3,23,NULL),(3,24,NULL),(3,25,NULL),(3,26,NULL);

-- 남자 세단뛰기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(44,420,NULL),(44,421,NULL),(44,422,NULL),(44,423,NULL),(44,424,NULL),
(44,425,NULL),(44,426,NULL),(44,427,NULL),(44,428,NULL),(44,429,NULL);

-- 남자 포환던지기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(45,430,NULL),(45,431,NULL),(45,432,NULL),(45,433,NULL),(45,434,NULL),
(45,435,NULL),(45,436,NULL),(45,437,NULL),(45,438,NULL),(45,439,NULL);

-- 남자 원반던지기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(46,440,NULL),(46,441,NULL),(46,442,NULL),(46,443,NULL),(46,444,NULL),
(46,445,NULL),(46,446,NULL),(46,447,NULL),(46,448,NULL),(46,449,NULL);

-- 남자 해머던지기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(47,450,NULL),(47,451,NULL),(47,452,NULL),(47,453,NULL),(47,454,NULL),
(47,455,NULL),(47,456,NULL),(47,457,NULL),(47,458,NULL),(47,459,NULL);

-- 남자 창던지기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(48,460,NULL),(48,461,NULL),(48,462,NULL),(48,463,NULL),(48,464,NULL),
(48,465,NULL),(48,466,NULL),(48,467,NULL),(48,468,NULL),(48,469,NULL);

-- 여자 멀리뛰기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(49,470,NULL),(49,471,NULL),(49,472,NULL),(49,473,NULL),(49,474,NULL),
(49,475,NULL),(49,476,NULL),(49,477,NULL),(49,478,NULL),(49,479,NULL);

-- 여자 세단뛰기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(50,480,NULL),(50,481,NULL),(50,482,NULL),(50,483,NULL),(50,484,NULL),
(50,485,NULL),(50,486,NULL),(50,487,NULL),(50,488,NULL),(50,489,NULL);

-- 여자 포환던지기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(51,490,NULL),(51,491,NULL),(51,492,NULL),(51,493,NULL),(51,494,NULL),
(51,495,NULL),(51,496,NULL),(51,497,NULL),(51,498,NULL),(51,499,NULL);

-- 여자 원반던지기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(52,500,NULL),(52,501,NULL),(52,502,NULL),(52,503,NULL),(52,504,NULL),
(52,505,NULL),(52,506,NULL),(52,507,NULL),(52,508,NULL),(52,509,NULL);

-- 여자 해머던지기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(53,510,NULL),(53,511,NULL),(53,512,NULL),(53,513,NULL),(53,514,NULL),
(53,515,NULL),(53,516,NULL),(53,517,NULL),(53,518,NULL),(53,519,NULL);

-- 여자 창던지기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(54,520,NULL),(54,521,NULL),(54,522,NULL),(54,523,NULL),(54,524,NULL),
(54,525,NULL),(54,526,NULL),(54,527,NULL),(54,528,NULL),(54,529,NULL);

-- 남자 높이뛰기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(4,27,NULL),(4,28,NULL),(4,29,NULL),(4,30,NULL),(4,31,NULL),(4,32,NULL),(4,33,NULL),(4,34,NULL);

-- 남자 장대높이뛰기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(55,530,NULL),(55,531,NULL),(55,532,NULL),(55,533,NULL),(55,534,NULL),(55,535,NULL),(55,536,NULL),(55,537,NULL);

-- 여자 높이뛰기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(56,540,NULL),(56,541,NULL),(56,542,NULL),(56,543,NULL),(56,544,NULL),(56,545,NULL),(56,546,NULL),(56,547,NULL);

-- 여자 장대높이뛰기
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(57,550,NULL),(57,551,NULL),(57,552,NULL),(57,553,NULL),(57,554,NULL),(57,555,NULL),(57,556,NULL),(57,557,NULL);

-- 10종 parent heat entries
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(5,35,NULL),(5,36,NULL),(5,37,NULL),(5,38,NULL),(5,39,NULL),(5,40,NULL);
-- 7종 parent heat entries
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(6,41,NULL),(6,42,NULL),(6,43,NULL),(6,44,NULL),(6,45,NULL),(6,46,NULL);

-- 10종 세부 heat entries
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(101,1001,1),(101,1002,2),(101,1003,3),(101,1004,4),(101,1005,5),(101,1006,6),
(102,1011,NULL),(102,1012,NULL),(102,1013,NULL),(102,1014,NULL),(102,1015,NULL),(102,1016,NULL),
(103,1021,NULL),(103,1022,NULL),(103,1023,NULL),(103,1024,NULL),(103,1025,NULL),(103,1026,NULL),
(104,1031,NULL),(104,1032,NULL),(104,1033,NULL),(104,1034,NULL),(104,1035,NULL),(104,1036,NULL),
(105,1041,1),(105,1042,2),(105,1043,3),(105,1044,4),(105,1045,5),(105,1046,6),
(106,1051,1),(106,1052,2),(106,1053,3),(106,1054,4),(106,1055,5),(106,1056,6),
(107,1061,NULL),(107,1062,NULL),(107,1063,NULL),(107,1064,NULL),(107,1065,NULL),(107,1066,NULL),
(108,1071,NULL),(108,1072,NULL),(108,1073,NULL),(108,1074,NULL),(108,1075,NULL),(108,1076,NULL),
(109,1081,NULL),(109,1082,NULL),(109,1083,NULL),(109,1084,NULL),(109,1085,NULL),(109,1086,NULL),
(110,1091,1),(110,1092,2),(110,1093,3),(110,1094,4),(110,1095,5),(110,1096,6);

-- 7종 세부 heat entries
INSERT INTO heat_entry (heat_id,event_entry_id,lane_number) VALUES
(201,2001,1),(201,2002,2),(201,2003,3),(201,2004,4),(201,2005,5),(201,2006,6),
(202,2011,NULL),(202,2012,NULL),(202,2013,NULL),(202,2014,NULL),(202,2015,NULL),(202,2016,NULL),
(203,2021,NULL),(203,2022,NULL),(203,2023,NULL),(203,2024,NULL),(203,2025,NULL),(203,2026,NULL),
(204,2031,1),(204,2032,2),(204,2033,3),(204,2034,4),(204,2035,5),(204,2036,6),
(205,2041,NULL),(205,2042,NULL),(205,2043,NULL),(205,2044,NULL),(205,2045,NULL),(205,2046,NULL),
(206,2051,NULL),(206,2052,NULL),(206,2053,NULL),(206,2054,NULL),(206,2055,NULL),(206,2056,NULL),
(207,2061,1),(207,2062,2),(207,2063,3),(207,2064,4),(207,2065,5),(207,2066,6);


-- No results — pre-competition state. All data will be entered via the UI.
