// app.js — 부트스트랩 + 화면 전환 + 시각 입력 + 분석 실행
// 역할: 모듈 간 글루 로직만 담당. 상세 로직은 각 모듈로 이동.
//   - session.js           : 전역 상태(_session / state / $ / _esc / _hasValidCoord / 동의 플로우)
//   - onboarding-map.js    : STEP 1·2 Leaflet 지도 (initObMap / useMyLocation)
//   - modal-search.js      : 장소 검색 모달 (openModal / searchPlace / selectPlace)
//   - verdict-render.js    : 결과 화면 (_stopCountdown / renderVerdict / renderResult / switchTab / showError)
//   - map-screen.js        : 지도 전체 화면 (openMapScreen / setMapTheme / setPreset / toggleSheet …)
//
// 로드 순서(HTML): leaflet → firebase → config → api → engine
//                   → session → onboarding-map → modal-search → verdict-render → map-screen → app

// ── 화면 전환 ─────────────────────────────────────────────────────────
function goStep(n) {
  _stopCountdown()
  $('screen-main').removeAttribute('data-verdict')
  document.querySelectorAll('.ob-screen').forEach(el => el.classList.remove('active'))

  if (n <= 4) {
    const screen = $(`ob-${n}`)
    if (screen) screen.classList.add('active')
    if (n === 1 || n === 2) setTimeout(() => initObMap(n), 50)
    if (n === 3) {
      const fromEl = $('ob-rctx-from')
      const toEl   = $('ob-rctx-to')
      if (fromEl) fromEl.textContent = state.start?.name || '출발지'
      if (toEl)   toEl.textContent   = state.end?.name   || '도착지'

      // ★ 시각 반올림 버그 fix: 5분 단위 반올림이 60분으로 올림되면 시를 +1 하고 분을 0 으로.
      const now = new Date()
      let h = now.getHours()
      let m = Math.round(now.getMinutes() / 5) * 5
      if (m >= 60) { m = 0; h = (h + 1) % 24 }
      const mPad = String(m).padStart(2, '0')
      $('now-ampm').value = h >= 12 ? 'pm' : 'am'
      $('now-h').value    = String(h % 12 || 12)
      $('now-m').value    = mPad
      onTimeChange('now')
      if (!$('goal-time').value) {
        const gh = (h + 1) % 24
        $('goal-ampm').value = gh >= 12 ? 'pm' : 'am'
        $('goal-h').value    = String(gh % 12 || 12)
        $('goal-m').value    = mPad
        onTimeChange('goal')
      }
    }
  } else {
    $('screen-main').classList.add('active')
  }
}

// ── 시각 입력 ─────────────────────────────────────────────────────────
function onTimeChange(type) {
  const ampm = $(`${type}-ampm`).value
  const h    = parseInt($(`${type}-h`).value)
  const m    = $(`${type}-m`).value
  let h24 = h
  if (ampm === 'am' && h === 12) h24 = 0
  if (ampm === 'pm' && h !== 12) h24 = h + 12
  $(`${type}-time`).value = `${String(h24).padStart(2,'0')}:${m}`
  checkStep3()
}
function checkStep3() {
  $('ob-3-next').disabled = !$('now-time').value || !$('goal-time').value
}

// ── 분석 실행 ─────────────────────────────────────────────────────────
function startAnalysis() { goStep(5); runAnalysis() }

async function runAnalysis() {
  const nowTime  = $('now-time').value
  const goalTime = $('goal-time').value
  if (!nowTime || !goalTime) { alert('현재·마감 시각을 입력해주세요.'); return }

  // ★ P0 null 가드: 모달에서 선택 안 했거나, 좌표가 유효하지 않으면 즉시 에러 화면.
  if (!_hasValidCoord(state.start) || !_hasValidCoord(state.end)) {
    showError('출발지와 도착지를 먼저 선택해주세요.')
    return
  }

  $('result').classList.add('hidden')
  $('verdict-wrap').classList.add('hidden')
  $('verdict-wrap').innerHTML = ''

  const loadingEl  = $('sm-loading')
  const loadingTxt = $('sm-loading-txt')
  if (loadingEl)  loadingEl.classList.remove('hidden')
  if (loadingTxt) loadingTxt.textContent = '경로를 분석하는 중...'

  try {
    const res = await analyze({
      startX: state.start.x, startY: state.start.y,
      endX:   state.end.x,   endY:   state.end.y,
      nowTime, goalTime, walkSpeed: state.speed,
      onProgress: msg => { if (loadingTxt) loadingTxt.textContent = msg },
    })

    if (loadingEl) loadingEl.classList.add('hidden')
    if (res.error) { showError(res.error); return }
    if (!res.best) { showError('경로를 찾을 수 없어요. 출발지·도착지를 다시 확인해주세요.'); return }

    _session.isFallback = res._fallbackUsed === true
    renderVerdict(res.best, _session.isFallback)
    renderResult(res.routes)

    // ★ 개인정보 동의 플로우: 동의한 경우에만 Firestore 에 저장.
    if (db && _ensureAnalyticsConsent()) {
      db.collection('analyses').add({
        start: state.start.name, end: state.end.name,
        verdict: res.best.verdict, estimated: res.best.estimated,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {})
    }
  } catch(e) {
    if (loadingEl) loadingEl.classList.add('hidden')
    showError(e.message)
  }
}

// ── 초기화 ────────────────────────────────────────────────────────────
initObMap(1)
