// session.js — Firebase 초기화 + 전역 상태 + 공용 유틸
// 모든 모듈에서 공유하는 상태는 여기서 한 번만 선언.

// ── Firebase ──────────────────────────────────────────────────────────
let db = null
try {
  firebase.initializeApp({
    apiKey:            CONFIG.FIREBASE_API_KEY,
    authDomain:        CONFIG.FIREBASE_AUTH_DOMAIN,
    projectId:         CONFIG.FIREBASE_PROJECT_ID,
    storageBucket:     CONFIG.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: CONFIG.FIREBASE_MESSAGING_SENDER_ID,
    appId:             CONFIG.FIREBASE_APP_ID,
  })
  db = firebase.firestore()
} catch(e) { console.warn('[Firebase]', e.message) }

// ── 전역 상태 ──────────────────────────────────────────────────────────
const state = { start: null, end: null, speed: 'normal' }

// 이전에 window 에 흩어져 있던 세션 상태를 한 곳으로 응집.
// 모듈 간 공유가 필요한 가변 상태는 모두 여기 둔다.
const _session = {
  searchResults: [],     // 장소 검색 결과
  routes: [],            // 현재 표시 중 경로
  routesAll: [],         // 원본 경로 (프리셋용)
  isFallback: null,      // 직선거리 폴백 사용 여부
  tabSegs: [],           // 현재 탭의 segments (경사도 토글용)
  currentSegIdx: 0,      // 지도 패널에서 강조할 구간
  mapRouteIdx: 0,        // 지도에서 그릴 경로 인덱스
  countdownInterval: null, // 카운트다운 타이머 핸들
}

// ── 공용 DOM 헬퍼 ─────────────────────────────────────────────────────
const $     = id => document.getElementById(id)

// XSS 방지 — 외부 API 응답을 innerHTML 로 넣기 전 반드시 통과.
function _esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;')
}

// 좌표가 유효한지 검사 — null/undefined/NaN/0,0 방어.
function _hasValidCoord(p) {
  if (!p) return false
  const x = Number(p.x), y = Number(p.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  if (x === 0 && y === 0) return false
  return true
}

// ── 개인정보 수집 동의 (분석 로그) ─────────────────────────────────────
// 사용자가 한 번 거부하면 세션 간에도 유지. 다시 물어보지 않음.
const _CONSENT_KEY = 'dontrun_analytics_consent_v1'

function _getAnalyticsConsent() {
  try { return localStorage.getItem(_CONSENT_KEY) } catch(e) { return null }
}
function _setAnalyticsConsent(val) {
  try { localStorage.setItem(_CONSENT_KEY, val) } catch(e) {}
}
function _ensureAnalyticsConsent() {
  const cur = _getAnalyticsConsent()
  if (cur === 'yes' || cur === 'no') return cur === 'yes'
  const ok = window.confirm(
    '앱 개선을 위해 출발지·도착지·판정 결과를 익명으로 저장해도 될까요?\n'
    + '거부해도 앱은 정상 작동합니다.'
  )
  _setAnalyticsConsent(ok ? 'yes' : 'no')
  return ok
}
