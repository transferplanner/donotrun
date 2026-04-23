# dont-run-indoor

지하철 역사 내부 위치·경로 시스템. 두 파트로 구성:

- **`pipeline/`** — 파이썬 오프라인 전처리 (Claude Vision으로 역 안내도 JPEG → 노드·링크 JSON, 270개역 × 1~8호선)
- **`src/location/`** — 브라우저 JS 런타임. Wi-Fi RSSI 삼각측량 + PDR 융합. 네이티브 브릿지(iOS/Android WebView)로 스캔 데이터 수신.

## 구조
```
pipeline/
  config.py              # API 키, 경로, 상수
  step1_vision_extract.py  # JPEG → 구조화 JSON (Claude Vision)
  step2_db_merge.py        # 공공 CSV(역/출구/환승/시설) 병합
  step3_review_ui.py       # Tkinter 수동 검수 UI
  step4_link_gen.py        # scipy KDTree로 노드 간 링크 자동 생성
  utils/
    vision_client.py
    geometry.py
    io_helpers.py
  scripts/
    preprocess_wifi_ap.py  # tdata + KISA Wi-Fi 좌표 병합
  requirements.txt
  run_pipeline.sh

src/location/
  wifiPositioning.js       # RSSI → 거리 → 가중 중심
  pedestrianDeadReckoning.js # 가속도 스텝 검출 + 자이로 헤딩
  indoorLocationManager.js # Wi-Fi + PDR 융합 (EKF 유사)
  nodeMatcher.js           # 현재 좌표 → 가장 가까운 노드
  pathfinding.js           # Dijkstra, 환승경로 포함

data/
  sample/                  # 개발용 샘플 CSV (1개 역)
  raw_maps/                # 수집한 역 안내도 JPEG
  output/                  # 파이프라인 결과 JSON
```

## 런타임 통합 방법 (현재 앱에)

현 앱(`gen-lang-client-0940345328.web.app`)은 JS + WebView 래퍼 구조. RN 도입 없이 네이티브 브릿지 2개만 추가:

### iOS (`dont-run-ios/ios/App/App/`)
- `WKScriptMessageHandler` 로 `window.webkit.messageHandlers.wifi.postMessage(...)` 수신
- `NEHotspotNetwork` + `CoreLocation` 으로 Wi-Fi 스캔 (공식 Wi-Fi 스캔 API는 제한적 → BSSID 가져오려면 `NEHotspotHelper` entitlement 필요. 실전에서는 Apple 승인 어려워서 대안: CLBeacon 또는 사전 배포된 BLE 비콘으로 대체 권장)
- 가속도·자이로는 `CMMotionManager` → JS로 push

### Android (`dont-run-android/android/app/src/main/kotlin/.../MainActivity.kt`)
- `WifiManager.scanResults` (ACCESS_FINE_LOCATION + CHANGE_WIFI_STATE)
- `SensorManager` TYPE_LINEAR_ACCELERATION + TYPE_ROTATION_VECTOR
- `WebView.addJavascriptInterface` 로 JS에 push

## 실행

```bash
cd pipeline
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=...
./run_pipeline.sh sample   # 샘플 1역 end-to-end
```

## 현재 상태

- [x] 디렉터리 스캐폴드
- [x] Python 파이프라인 스텁 (4단계 + 유틸)
- [x] JS 위치 모듈 스텁 (4개)
- [x] 샘플 CSV (1개 역)
- [ ] iOS/Android 네이티브 Wi-Fi 브릿지
- [ ] 270개 역 JPEG 수집
- [ ] Claude Vision 실제 호출 검증
- [ ] 실측 환경에서 RSSI → 위치 정확도 튜닝
