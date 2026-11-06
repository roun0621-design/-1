# 앱스토어 iOS 앱(PWABuilder 래퍼) 네이티브 푸시 붙이기

작성 2026-09-25. 서버·웹 쪽은 끝나 있음(커밋 참고). 남은 건 **애플·Firebase 콘솔 설정 3가지**와 **Xcode 프로젝트 수정**.

## 왜 필요한가
앱스토어 앱은 PWABuilder가 만든 WKWebView 껍데기라 웹푸시(서비스워커)가 동작하지 않는다. 그래서 iOS 네이티브(APNs)로 FCM 토큰을 받아 웹 페이지에 넘기고, 서버는 그 토큰엔 APNs 알림 형식으로 보낸다.

## 서버·웹에 이미 들어간 것
- `push_token.platform` 열(`web | ios | android`). `/api/push/register` 가 `platform` 을 받는다.
- `lib/pushSender.js` `buildMessage(platform)` — iOS 는 `notification + apns(aps.sound, priority 10)`, 안드로이드는 `notification + android(high)`, 웹은 data-only.
- 발송(관리자 공지·관심 종목 결과 알림) `data.url` 에 열 주소(`/dashboard.html?comp=63`)가 실린다 — 알림 탭 시 네이티브가 이 주소로 웹뷰를 이동시키면 된다.
- `public/push.js` 네이티브 브리지 약속(아래). 브리지가 없는 옛 앱스토어 빌드에선 "앱 알림은 다음 앱 업데이트에서 지원돼요" 안내.

## 웹 ↔ 네이티브 약속 (JS 브리지)
| 방향 | 언제 | 코드 |
|---|---|---|
| 네이티브 → 웹 | 문서 시작 시 주입(WKUserScript, atDocumentStart) | `window.PaceNativePush = { platform: 'ios' };` |
| 웹 → 네이티브 | 사용자가 '알림 켜기' 탭 | `window.webkit.messageHandlers.pacePush.postMessage({ type: 'request' })` |
| 네이티브 → 웹 | 권한 허용 + FCM 토큰 확보 시(앱 실행마다·토큰 갱신마다) | `window.PaceNativePush.onToken('<fcm token>')` |
| 네이티브 → 웹 | 권한 거부 | `window.PaceNativePush.onDenied()` |
| 알림 탭 | 사용자가 알림을 누름 | `userInfo["url"]` 이 있으면 `https://www.pace-rise-node.com` + url 로 웹뷰 이동 |

웹 쪽은 토큰을 받으면 `/api/push/register` 에 `{ token, platform:'ios', competition_id }` 로 등록하고 관심 종목을 동기화한다. 이미 토큰을 받았던 기기는 앱 실행 시 자동 재등록.

## 1. 콘솔 설정 (사용자가 직접, 15분)
1. **Apple Developer** → Certificates, Identifiers & Profiles → Keys → `+` → 이름 `PaceRise APNs`, **Apple Push Notifications service (APNs)** 체크 → 등록 → `.p8` 다운로드(한 번만 받을 수 있음, 보관) + **Key ID** 와 **Team ID** 메모.
2. 같은 곳 Identifiers → 앱의 Bundle ID(예: `com.pacerise.node`) → **Push Notifications** capability 체크 후 저장.
3. **Firebase 콘솔**(프로젝트 `pace-rise-node-push`) → 프로젝트 설정 → 일반 → 앱 추가 → **iOS** → Bundle ID 입력 → `GoogleService-Info.plist` 다운로드. → 클라우드 메시징 탭 → Apple 앱 구성 → **APNs 인증 키 업로드**(.p8 + Key ID + Team ID).

## 2. Xcode 프로젝트 수정 (Claude Code에게 시킬 것)
아래 프롬프트를 **PWABuilder iOS 프로젝트 폴더**에서 Claude Code 를 열고 그대로 붙여넣는다. `GoogleService-Info.plist` 는 프로젝트 폴더에 미리 넣어 둔다.

```
이 폴더는 PWABuilder 가 만든 iOS 앱(WKWebView 래퍼, Swift) Xcode 프로젝트야. 여기에 Firebase 네이티브 푸시를 붙여 줘. 웹 쪽 약속은 docs/IOS_NATIVE_PUSH.md 의 'JS 브리지' 표와 같다(아래에도 적어 둠).

해야 할 일:
1. Swift Package Manager 로 firebase-ios-sdk(https://github.com/firebase/firebase-ios-sdk) 추가, 제품은 FirebaseMessaging 만. 이미 폴더에 있는 GoogleService-Info.plist 를 앱 타깃에 추가(Copy Bundle Resources 포함).
2. 타깃 Signing & Capabilities 에 Push Notifications 와 Background Modes(Remote notifications) 추가. (프로젝트 파일 편집으로 안 되면 Xcode 에서 할 수 있게 정확한 클릭 순서를 알려 줘.)
3. AppDelegate(없으면 SwiftUI App 에 UIApplicationDelegateAdaptor 로 추가):
   - FirebaseApp.configure(), UNUserNotificationCenter.current().delegate = self, Messaging.messaging().delegate = self, application.registerForRemoteNotifications()
   - didRegisterForRemoteNotificationsWithDeviceToken 에서 Messaging.messaging().apnsToken = deviceToken
   - messaging(_:didReceiveRegistrationToken:) 에서 토큰을 저장하고, 웹뷰가 준비돼 있으면 window.PaceNativePush.onToken('<token>') 를 evaluateJavaScript 로 호출(작은따옴표 이스케이프).
   - userNotificationCenter(_:willPresent:) 는 [.banner, .list, .sound] 로 앞에서도 표시.
   - userNotificationCenter(_:didReceive:) 에서 userInfo["url"] 이 문자열이면 https://www.pace-rise-node.com + url 로 웹뷰를 이동.
4. 웹뷰 설정(WKWebViewConfiguration):
   - userContentController 에 WKUserScript(source: "window.PaceNativePush = { platform: 'ios' };", injectionTime: .atDocumentStart, forMainFrameOnly: true) 추가.
   - add(self, name: "pacePush") 로 메시지 핸들러 등록. body 가 {type:'request'} 이면 UNUserNotificationCenter.requestAuthorization(options: [.alert,.sound,.badge]) 호출 → 허용이면 registerForRemoteNotifications 하고, 이미 FCM 토큰이 있으면 즉시 onToken 호출 / 거부면 window.PaceNativePush.onDenied() 호출.
   - 페이지 로드가 끝날 때(didFinish) 저장된 FCM 토큰이 있고 권한이 허용 상태면 onToken 을 한 번 더 호출(앱 재실행 시 자동 재등록용).
5. 웹뷰가 여러 개 만들어지는 구조면 메인 웹뷰 하나에만 걸어 줘. 기존 PWABuilder 기능(스플래시, 외부 링크 처리, 상태바)은 건드리지 마.
6. 빌드가 되는지 xcodebuild 로 확인하고, 실제 기기 테스트 순서(시뮬레이터는 푸시 안 됨)와 TestFlight 업로드 순서를 마지막에 정리해 줘.

브리지 약속:
- 주입: window.PaceNativePush = { platform: 'ios' }
- 웹→앱: window.webkit.messageHandlers.pacePush.postMessage({ type: 'request' })
- 앱→웹: window.PaceNativePush.onToken('<fcm token>') / window.PaceNativePush.onDenied()
- 알림 데이터: userInfo["url"] (예: /dashboard.html?comp=63), userInfo["event_id"]
```

## 3. 확인 순서
1. 실제 아이폰에 개발 빌드 설치 → 앱에서 종목 창 '알림 켜기' → iOS 권한 팝업 → 허용. 이때부터 **설정 → 알림에 PACE RISE 가 나타난다.**
2. 서버 DB: `SELECT platform, COUNT(*) FROM push_token WHERE active=1 GROUP BY platform` 에 `ios` 가 보이면 등록 성공.
3. 관리자 → 문자 탭 → '앱 푸시 공지 보내기'로 테스트 발송 → 폰에 배너.
4. 관심 종목(즐겨찾기) 켜고 그 종목 공식 결과 → 자동 알림.
5. TestFlight → 앱스토어 심사 제출(심사 1~2일). 심사 메모에 "알림은 종목 창의 알림 켜기 버튼으로 켠다"고 적어 두면 리젝 확률이 준다.

## 안드로이드(나중)
같은 약속으로 `window.PaceNativePush = { platform:'android' }` + `window.PaceNativePushAndroid.request()` (JavascriptInterface) 만 만들면 서버는 그대로 동작한다. TWA(PWABuilder 안드로이드)는 크롬 웹푸시가 그대로 되므로 보통 필요 없다.

## (추가, 2026-09-26) 결과 이미지 '사진 앱에 저장' 브리지 — `paceSave`
앱스토어 앱(WKWebView)은 공유창(`navigator.share`)과 다운로드가 안 되므로, 결과 이미지 저장을 네이티브가 맡는다. 없으면 웹이 "이미지를 길게 눌러 '사진에 추가'"로 안내한다.

Claude Code 프롬프트에 아래를 덧붙인다:
```
7. 메시지 핸들러 "paceSave" 도 등록해 줘. body 는 { name: String, base64: String }(PNG). Data(base64Encoded:) → UIImage → PHPhotoLibrary.shared().performChanges { PHAssetChangeRequest.creationRequestForAsset(from:) } 로 사진 앱에 저장하고, 끝나면 웹에 window.PaceNativePush.onSaved(true|false) 를 evaluateJavaScript 로 호출해. Info.plist 에 NSPhotoLibraryAddUsageDescription("경기 결과 이미지를 사진 앱에 저장합니다") 추가. 권한이 거부돼 있으면 onSaved(false).
```
웹 쪽(`public/result-image.js`)은 `window.webkit.messageHandlers.paceSave` 가 있으면 그쪽으로 보내고 "사진 앱에 저장했습니다" 토스트를 띄운다.
