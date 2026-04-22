// functions/index.js — dont-run-v2 API 프록시
// 역할: 클라이언트에서 직접 호출하던 외부 API를 서버에서 대리 호출하여
//       API 키를 브라우저에 노출하지 않는다.
// 리전: asia-northeast3 (서울)
// 런타임: Node 20 (package.json engines)

const { onRequest } = require('firebase-functions/v2/https')
const { setGlobalOptions } = require('firebase-functions/v2')
const { defineSecret } = require('firebase-functions/params')

// 로컬 에뮬레이터용 .env 로드 (프로덕션은 Secrets 사용)
try { require('dotenv').config() } catch (_) { /* optional */ }

setGlobalOptions({ region: 'asia-northeast3', maxInstances: 10 })

// ── Secrets (프로덕션은 `firebase functions:secrets:set <NAME>` 으로 저장) ───
const TMAP_TRANSPORTATION  = defineSecret('TMAP_TRANSPORTATION')
const SEOUL_BUS_KEY        = defineSecret('SEOUL_BUS_ARRIVAIL_KEY')
const SUBWAY_ARR_KEY       = defineSecret('SUBWAY_SEOUL_NOW_KEY')
const SUBWAY_CROWD_KEY     = defineSecret('SUBWAY_CROWD_API')
const SINHODUNG_KEY        = defineSecret('SINHODUNG_KEY')
// Kakao: 사용자 .env 는 KAKAO_MAP_API_KEY / KAKAO_MAP_APP_KEY 이름을 씀.
// 이 중 "REST API 키" 로 등록된 값이 필요. 여러 이름을 폴백으로 받는다.
const KAKAO_REST_KEY     = defineSecret('KAKAO_REST_API_KEY')
const KAKAO_MAP_API_KEY  = defineSecret('KAKAO_MAP_API_KEY')
const KAKAO_MAP_APP_KEY  = defineSecret('KAKAO_MAP_APP_KEY')

const ALL_SECRETS = [
  TMAP_TRANSPORTATION, SEOUL_BUS_KEY, SUBWAY_ARR_KEY,
  SUBWAY_CROWD_KEY, SINHODUNG_KEY,
  KAKAO_REST_KEY, KAKAO_MAP_API_KEY, KAKAO_MAP_APP_KEY,
]

// ── 키 헬퍼: 에뮬레이터에서는 process.env, 프로덕션은 Secret.value() ──────
const readKey = (secret, envName) => {
  try { const v = secret.value(); if (v) return v } catch (_) { /* not bound */ }
  return process.env[envName] || ''
}

// Kakao REST 키 — 여러 이름 중 먼저 발견되는 걸 사용
const readKakaoRestKey = () =>
  readKey(KAKAO_REST_KEY,    'KAKAO_REST_API_KEY') ||
  readKey(KAKAO_MAP_API_KEY, 'KAKAO_MAP_API_KEY')  ||
  readKey(KAKAO_MAP_APP_KEY, 'KAKAO_MAP_APP_KEY')

// ══════════════════════════════════════════════════════════════════════
// CORS 화이트리스트
// ══════════════════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = new Set([
  'https://gen-lang-client-0940345328.web.app',
  'https://gen-lang-client-0940345328.firebaseapp.com',
  'http://localhost:6001',
  'http://localhost:5000',
  'http://127.0.0.1:6001',
  'http://127.0.0.1:5000',
])

function applyCors(req, res) {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Vary', 'Origin')
  }
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type')
  res.set('Access-Control-Max-Age', '3600')
}

// ══════════════════════════════════════════════════════════════════════
// 공통 유틸
// ══════════════════════════════════════════════════════════════════════
function timeoutSignal(ms) {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(new Error('Timeout')), ms)
  return ctrl.signal
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const res = await fetch(url, { ...opts, signal: timeoutSignal(timeoutMs) })
  const text = await res.text()
  try { return { status: res.status, json: JSON.parse(text) } }
  catch (_) { return { status: res.status, json: null, text } }
}

async function fetchText(url, opts = {}, timeoutMs = 8000) {
  const res = await fetch(url, { ...opts, signal: timeoutSignal(timeoutMs) })
  return { status: res.status, text: await res.text() }
}

function sendJson(res, status, body) {
  res.status(status).json(body)
}

function sendErr(res, status, msg) {
  res.status(status).json({ error: msg })
}

// ══════════════════════════════════════════════════════════════════════
// 간단 LRU 캐시 (도보경로 중복 호출 억제)
// ══════════════════════════════════════════════════════════════════════
function createLRU(limit = 200) {
  const map = new Map()
  return {
    get(k) {
      if (!map.has(k)) return undefined
      const v = map.get(k); map.delete(k); map.set(k, v); return v
    },
    set(k, v) {
      if (map.has(k)) map.delete(k)
      map.set(k, v)
      if (map.size > limit) map.delete(map.keys().next().value)
    },
  }
}
const walkCache = createLRU(200)

// ══════════════════════════════════════════════════════════════════════
// 라우터
// ══════════════════════════════════════════════════════════════════════
async function route(req, res) {
  applyCors(req, res)
  if (req.method === 'OPTIONS') { res.status(204).end(); return }

  // Firebase hosting rewrite 는 /api/** 를 전달. path 에는 전체 경로가 남음.
  // req.path 는 '/api/tmap/transit' 형태로 옴.
  const path = (req.path || '').replace(/^\/+/, '').replace(/^api\/?/, '')

  try {
    if (path === 'tmap/transit')     return await handleTmapTransit(req, res)
    if (path === 'tmap/walk')        return await handleTmapWalk(req, res)
    if (path === 'subway/arrival')   return await handleSubwayArrival(req, res)
    if (path === 'subway/crowd')     return await handleSubwayCrowd(req, res)
    if (path === 'bus/arrival')      return await handleBusArrival(req, res)
    if (path === 'signal')           return await handleSignal(req, res)
    if (path === 'kakao/search')     return await handleKakaoSearch(req, res)
    if (path === 'kakao/rgeo')       return await handleKakaoRgeo(req, res)
    return sendErr(res, 404, `Unknown endpoint: ${path}`)
  } catch (e) {
    console.error('[route]', path, e && e.message)
    return sendErr(res, 500, e && e.message ? e.message : 'internal error')
  }
}

// ══════════════════════════════════════════════════════════════════════
// 1. TMAP 대중교통 경로
//    POST /api/tmap/transit   body: { startX, startY, endX, endY }
// ══════════════════════════════════════════════════════════════════════
async function handleTmapTransit(req, res) {
  if (req.method !== 'POST') return sendErr(res, 405, 'POST required')
  const { startX, startY, endX, endY, count } = req.body || {}
  if (!startX || !startY || !endX || !endY) return sendErr(res, 400, 'missing coords')

  const key = readKey(TMAP_TRANSPORTATION, 'TMAP_TRANSPORTATION')
  if (!key) return sendErr(res, 500, 'TMAP key not configured')

  const d = new Date(); const p = n => String(n).padStart(2, '0')
  const searchDttm = `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`

  const { status, json } = await fetchJson(
    'https://apis.openapi.sk.com/transit/routes',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', appKey: key },
      body: JSON.stringify({
        startX: String(startX), startY: String(startY),
        endX: String(endX), endY: String(endY),
        reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO',
        searchDttm, count: count || 3,
      }),
    },
    10000,
  )
  return sendJson(res, status, json || { error: 'empty response' })
}

// ══════════════════════════════════════════════════════════════════════
// 2. TMAP 도보 경로
//    POST /api/tmap/walk   body: { startX, startY, endX, endY }
// ══════════════════════════════════════════════════════════════════════
async function handleTmapWalk(req, res) {
  if (req.method !== 'POST') return sendErr(res, 405, 'POST required')
  const { startX, startY, endX, endY } = req.body || {}
  if (!startX || !startY || !endX || !endY) return sendErr(res, 400, 'missing coords')

  const cacheKey = `${startX},${startY},${endX},${endY}`
  const cached = walkCache.get(cacheKey)
  if (cached) return sendJson(res, 200, cached)

  const key = readKey(TMAP_TRANSPORTATION, 'TMAP_TRANSPORTATION')
  if (!key) return sendErr(res, 500, 'TMAP key not configured')

  const { status, json } = await fetchJson(
    'https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', appKey: key },
      body: JSON.stringify({
        startX: String(startX), startY: String(startY),
        endX: String(endX), endY: String(endY),
        reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO',
        startName: '출발', endName: '도착',
      }),
    },
    8000,
  )
  if (status === 200 && json) walkCache.set(cacheKey, json)
  return sendJson(res, status, json || { error: 'empty response' })
}

// ══════════════════════════════════════════════════════════════════════
// 3. 지하철 실시간 도착
//    GET /api/subway/arrival?station=강남
// ══════════════════════════════════════════════════════════════════════
async function handleSubwayArrival(req, res) {
  const station = (req.query.station || '').trim()
  if (!station) return sendErr(res, 400, 'missing station')
  const key = readKey(SUBWAY_ARR_KEY, 'SUBWAY_SEOUL_NOW_KEY')
  if (!key) return sendErr(res, 500, 'subway arrival key not configured')

  const url = `https://openapi.seoul.go.kr:443/${encodeURIComponent(key)}/json/realtimeStationArrival/0/5/${encodeURIComponent(station)}`
  const { status, json } = await fetchJson(url, {}, 5000)
  return sendJson(res, status, json || { error: 'empty response' })
}

// ══════════════════════════════════════════════════════════════════════
// 4. 지하철 혼잡도
//    GET /api/subway/crowd?line=2
// ══════════════════════════════════════════════════════════════════════
async function handleSubwayCrowd(req, res) {
  const line = (req.query.line || '').trim()
  if (!line) return sendErr(res, 400, 'missing line')
  const key = readKey(SUBWAY_CROWD_KEY, 'SUBWAY_CROWD_API')
  if (!key) return sendErr(res, 500, 'subway crowd key not configured')

  const url = `https://openapi.seoul.go.kr:443/${encodeURIComponent(key)}/json/JSON_SUBWAY_CROWD_DATA/1/100/${encodeURIComponent(line)}`
  const { status, json } = await fetchJson(url, {}, 5000)
  return sendJson(res, status, json || { error: 'empty response' })
}

// ══════════════════════════════════════════════════════════════════════
// 5. 버스 도착 정보 (XML → 그대로 전달: 기존 클라이언트가 XML 파싱)
//    GET /api/bus/arrival?arsId=12345
// ══════════════════════════════════════════════════════════════════════
async function handleBusArrival(req, res) {
  const arsId = (req.query.arsId || '').trim()
  if (!arsId) return sendErr(res, 400, 'missing arsId')
  const key = readKey(SEOUL_BUS_KEY, 'SEOUL_BUS_ARRIVAIL_KEY')
  if (!key) return sendErr(res, 500, 'bus key not configured')

  const url = `http://ws.bus.go.kr/api/rest/stationinfo/getStationByUid?ServiceKey=${encodeURIComponent(key)}&arsId=${encodeURIComponent(arsId)}`
  const { status, text } = await fetchText(url, {}, 6000)
  res.status(status)
  res.set('Content-Type', 'application/xml; charset=utf-8')
  res.send(text || '')
}

// ══════════════════════════════════════════════════════════════════════
// 6. 신호등
//    GET /api/signal?lat=35.1&lng=129.0&radius=300
// ══════════════════════════════════════════════════════════════════════
async function handleSignal(req, res) {
  const lat = parseFloat(req.query.lat)
  const lng = parseFloat(req.query.lng)
  const radius = parseInt(req.query.radius || '300') || 300
  if (!isFinite(lat) || !isFinite(lng)) return sendErr(res, 400, 'missing lat/lng')
  const key = readKey(SINHODUNG_KEY, 'SINHODUNG_KEY')
  if (!key) return sendErr(res, 500, 'signal key not configured')

  const url = `https://apis.data.go.kr/6260000/TrafficLightService/getTrafficLightList` +
    `?serviceKey=${encodeURIComponent(key)}&pageNo=1&numOfRows=10&lat=${lat}&lon=${lng}&radius=${radius}&type=json`
  const { status, json } = await fetchJson(url, {}, 5000)
  return sendJson(res, status, json || { error: 'empty response' })
}

// ══════════════════════════════════════════════════════════════════════
// 7. Kakao 키워드 검색
//    GET /api/kakao/search?q=강남역
// ══════════════════════════════════════════════════════════════════════
async function handleKakaoSearch(req, res) {
  const q = (req.query.q || '').trim()
  if (!q) return sendErr(res, 400, 'missing q')
  const key = readKakaoRestKey()
  if (!key) return sendErr(res, 500, 'kakao key not configured')

  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=8`
  const { status, json } = await fetchJson(
    url, { headers: { Authorization: `KakaoAK ${key}` } }, 6000,
  )
  return sendJson(res, status, json || { error: 'empty response' })
}

// ══════════════════════════════════════════════════════════════════════
// 8. Kakao 역지오코딩
//    GET /api/kakao/rgeo?lat=37.5&lng=127.0
// ══════════════════════════════════════════════════════════════════════
async function handleKakaoRgeo(req, res) {
  const lat = parseFloat(req.query.lat)
  const lng = parseFloat(req.query.lng)
  if (!isFinite(lat) || !isFinite(lng)) return sendErr(res, 400, 'missing lat/lng')
  const key = readKakaoRestKey()
  if (!key) return sendErr(res, 500, 'kakao key not configured')

  const url = `https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${lng}&y=${lat}`
  const { status, json } = await fetchJson(
    url, { headers: { Authorization: `KakaoAK ${key}` } }, 5000,
  )
  return sendJson(res, status, json || { error: 'empty response' })
}

// ══════════════════════════════════════════════════════════════════════
// Export — 단일 함수 `api` 가 /api/** 모두 처리
// ══════════════════════════════════════════════════════════════════════
exports.api = onRequest(
  { secrets: ALL_SECRETS, cors: false, timeoutSeconds: 30, memory: '256MiB' },
  route,
)
