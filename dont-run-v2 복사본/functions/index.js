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
// 서울교통빅데이터플랫폼 (T-data). 지하철/버스 마스터 공용 키.
const TDATA_KEY          = defineSecret('SEOUL_SUBWAY_GEOM')
// 공공데이터포털 "서울특별시_노선정보조회 서비스" 키 (ws.bus.go.kr/busRouteInfo 용)
// 승인 후 해당 키를 .env 또는 Secret Manager 에 BUS_ROUTE_INFO_KEY 로 등록.
const BUS_ROUTE_INFO_KEY = defineSecret('BUS_ROUTE_INFO_KEY')

const ALL_SECRETS = [
  TMAP_TRANSPORTATION, SEOUL_BUS_KEY, SUBWAY_ARR_KEY,
  SUBWAY_CROWD_KEY, SINHODUNG_KEY,
  KAKAO_REST_KEY, KAKAO_MAP_API_KEY, KAKAO_MAP_APP_KEY,
  TDATA_KEY, BUS_ROUTE_INFO_KEY,
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
    if (path === 'tdata/bus/routes')       return await handleTdataBusRoutes(req, res)
    if (path === 'tdata/bus/route-nodes')  return await handleTdataBusRouteNodes(req, res)
    if (path === 'tdata/bus/stops-near')   return await handleTdataBusStopsNear(req, res)
    if (path === 'tdata/bus/stops')        return await handleTdataBusStops(req, res)
    if (path === 'tdata/bus/coords')       return await handleTdataBusCoords(req, res)
    if (path === 'bus/path')               return await handleBusRoutePath(req, res)
    if (path === 'bus/transit')            return await handleBusTransit(req, res)
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
    url, { headers: {
      Authorization: `KakaoAK ${key}`,
      KA: 'sdk/1.0 os/javascript lang/ko-KR origin/https://gen-lang-client-0940345328.web.app',
    } }, 6000,
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
    url, { headers: {
      Authorization: `KakaoAK ${key}`,
      KA: 'sdk/1.0 os/javascript lang/ko-KR origin/https://gen-lang-client-0940345328.web.app',
    } }, 5000,
  )
  return sendJson(res, status, json || { error: 'empty response' })
}

// ══════════════════════════════════════════════════════════════════════
// 9. T-data (서울교통빅데이터플랫폼) 버스 마스터 프록시
//    공용 apikey 로 게이트웨이 호출. 서버 측에 인메모리 캐시를 두어
//    같은 cold-start 인스턴스에서는 마스터를 한 번만 받는다.
//
//    GET /api/tdata/bus/routes            — 서울 시내버스 노선 마스터 (간선/지선/순환/마을/광역서울/공항)
//    GET /api/tdata/bus/route-nodes?routeId=…  — 노선별 정류장 순서
//    GET /api/tdata/bus/stops             — 전체 정류장 좌표 마스터
//    GET /api/tdata/bus/coords?routeId=…  — 노선 폴리라인 (권한 풀리면 사용)
// ══════════════════════════════════════════════════════════════════════
const TDATA_BASE = 'https://t-data.seoul.go.kr/apig/apiman-gateway/tapi'
const SEOUL_BUS_TYPES = new Set(['간선', '지선', '순환', '마을', '광역(서울)', '공항'])
const TDATA_CACHE_TTL_MS = 60 * 60 * 1000 // 1 시간

// 인스턴스-로컬 캐시 (cold-start 수명). Secret Manager 콜드 스타트 시 자연 재로드.
const tdataCache = {
  routes: null,       // { t: epochMs, data: [...] }
  stops:  null,
  routeNodes: new Map(), // routeId -> { t, data }
}

async function tdataFetch(service, params) {
  const key = readKey(TDATA_KEY, 'SEOUL_SUBWAY_GEOM')
  if (!key) throw new Error('TDATA key not configured')
  const qs = new URLSearchParams({ apikey: key, ...(params || {}) })
  const url = `${TDATA_BASE}/${service}/1.0?${qs.toString()}`
  const { status, json, text } = await fetchJson(url, {}, 12000)
  if (status !== 200) {
    const err = new Error(`TDATA ${service} ${status}: ${text || JSON.stringify(json)}`)
    err.status = status
    throw err
  }
  return json
}

function cacheFresh(entry) {
  return entry && (Date.now() - entry.t) < TDATA_CACHE_TTL_MS
}

async function handleTdataBusRoutes(req, res) {
  if (!cacheFresh(tdataCache.routes)) {
    const all = await tdataFetch('TaimsTaimsTbisMsRoute')
    const seoul = (all || []).filter(r => SEOUL_BUS_TYPES.has(r.routeTy))
    tdataCache.routes = { t: Date.now(), data: seoul }
  }
  res.set('Cache-Control', 'public, max-age=1800')
  return sendJson(res, 200, tdataCache.routes.data)
}

async function handleTdataBusRouteNodes(req, res) {
  const routeId = (req.query.routeId || '').trim()
  if (!routeId) return sendErr(res, 400, 'missing routeId')

  const cached = tdataCache.routeNodes.get(routeId)
  if (cacheFresh(cached)) {
    res.set('Cache-Control', 'public, max-age=1800')
    return sendJson(res, 200, cached.data)
  }
  const data = await tdataFetch('TaimsTaimsTbisMsRouteNode', { routeId })
  tdataCache.routeNodes.set(routeId, { t: Date.now(), data: data || [] })
  // LRU 흉내: 1000개 초과 시 오래된 항목 제거
  if (tdataCache.routeNodes.size > 1000) {
    const firstKey = tdataCache.routeNodes.keys().next().value
    tdataCache.routeNodes.delete(firstKey)
  }
  res.set('Cache-Control', 'public, max-age=1800')
  return sendJson(res, 200, data || [])
}

async function loadStops() {
  if (cacheFresh(tdataCache.stops)) return tdataCache.stops.data
  const all = await tdataFetch('TaimsTaimsTbisMsSttn', { rowCnt: '100000', startRow: '1' })
  // trim fields to reduce memory/payload
  const slim = (all || []).map(s => ({
    sttnId: s.sttnId,
    sttnNm: s.sttnNm,
    x: parseFloat(s.crdntX) || 0,
    y: parseFloat(s.crdntY) || 0,
  })).filter(s => s.x && s.y)
  tdataCache.stops = { t: Date.now(), data: slim }
  return slim
}

async function handleTdataBusStops(req, res) {
  const data = await loadStops()
  res.set('Cache-Control', 'public, max-age=1800')
  return sendJson(res, 200, data)
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, p = Math.PI/180
  const dLat = (lat2-lat1)*p, dLon = (lon2-lon1)*p
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*p)*Math.cos(lat2*p)*Math.sin(dLon/2)**2
  return 2*R*Math.asin(Math.sqrt(a))
}

async function handleTdataBusStopsNear(req, res) {
  const lon = parseFloat(req.query.lon)
  const lat = parseFloat(req.query.lat)
  const radiusM = parseInt(req.query.radius || '500', 10)
  if (!isFinite(lon) || !isFinite(lat)) return sendErr(res, 400, 'missing lon/lat')

  const stops = await loadStops()
  const maxKm = radiusM / 1000
  const near = []
  for (const s of stops) {
    // quick bbox cull (1 deg ≈ 111km)
    if (Math.abs(s.y - lat) > maxKm/110 || Math.abs(s.x - lon) > maxKm/90) continue
    const d = haversineKm(lat, lon, s.y, s.x)
    if (d <= maxKm) near.push({ ...s, km: +d.toFixed(3) })
  }
  near.sort((a, b) => a.km - b.km)
  res.set('Cache-Control', 'public, max-age=1800')
  return sendJson(res, 200, near.slice(0, 30))
}

// ── 버스 경로 라우팅 (직결 전용, 환승 없음) ────────────────────────────
//
//  POST /api/bus/transit  body: { startX, startY, endX, endY, radius? }
//  반환: getTransitRoutes 와 동일한 shape 의 배열
//  [{
//    totalTime, transferCount: 0, subPaths: [
//      { trafficType:3(도보), startName:'출발지', endName:<승차정류장>, ... passCoords:[] },
//      { trafficType:2(버스), lane:{name, busNo, arsId}, startName:<승차>, endName:<하차>,
//        passCoords:[{x,y}...] },       // 정류장 순차 연결선
//      { trafficType:3(도보), endName:'도착지', ... },
//    ],
//  }, ...]
//
//  전략:
//    1) start/end 반경 내 정류장 후보 (각 N개)
//    2) 필요한 노선의 route-node 를 lazy 로 fetch (인스턴스 캐시)
//    3) 공통 routeId 중 start.sttnSn < end.sttnSn (정방향) 필터
//    4) 총 소요시간 = 도보(출발→승차) + 버스(링크 누적거리/속도) + 도보(하차→도착)
// ──────────────────────────────────────────────────────────────────────
const BUS_AVG_SPEED_KMH = 18   // 서울 시내버스 평균
const WALK_SPEED_KMH    = 4.5
const BUS_MAX_RESULTS   = 3

async function fetchRouteNodes(routeId) {
  const cached = tdataCache.routeNodes.get(routeId)
  if (cacheFresh(cached)) return cached.data
  const data = await tdataFetch('TaimsTaimsTbisMsRouteNode', { routeId })
  tdataCache.routeNodes.set(routeId, { t: Date.now(), data: data || [] })
  return data || []
}

// 동시성 제어 병렬 map
async function parallelMap(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++
      if (idx >= items.length) return
      try { out[idx] = await fn(items[idx], idx) }
      catch (e) { out[idx] = { __err: e && e.message } }
    }
  })
  await Promise.all(workers)
  return out
}

async function handleBusTransit(req, res) {
  if (req.method !== 'POST') return sendErr(res, 405, 'POST required')
  const { startX, startY, endX, endY, radius } = req.body || {}
  const sx = parseFloat(startX), sy = parseFloat(startY)
  const ex = parseFloat(endX),   ey = parseFloat(endY)
  if (![sx, sy, ex, ey].every(isFinite)) return sendErr(res, 400, 'missing coords')

  const stops = await loadStops()
  const routesAll = (cacheFresh(tdataCache.routes)
    ? tdataCache.routes.data
    : (tdataCache.routes = { t: Date.now(),
        data: ((await tdataFetch('TaimsTaimsTbisMsRoute')) || [])
              .filter(r => SEOUL_BUS_TYPES.has(r.routeTy)) }).data)
  const routeById = new Map(routesAll.map(r => [r.routeId, r]))

  const maxKm = (radius || 500) / 1000
  const nearest = (x, y) => {
    const out = []
    for (const s of stops) {
      if (Math.abs(s.y - y) > maxKm/110 || Math.abs(s.x - x) > maxKm/90) continue
      const d = haversineKm(y, x, s.y, s.x)
      if (d <= maxKm) out.push({ ...s, km: d })
    }
    out.sort((a, b) => a.km - b.km)
    return out.slice(0, 8)
  }
  const startStops = nearest(sx, sy)
  const endStops   = nearest(ex, ey)
  if (!startStops.length || !endStops.length) return sendJson(res, 200, [])

  // 후보 정류장들을 지나는 모든 route-node (lazy fetch).
  // 문제: stop->routes 역인덱스가 없음 → 모든 서울 시내버스 route-node 를 훑어야 함.
  // 최적화: 인스턴스 캐시에 있는 것 우선, 없는 것만 병렬 fetch.
  // (첫 cold start 에 ~500 route * ~80 stops 페치 = 느림. 이후는 빠름.)
  const allRouteIds = routesAll.map(r => r.routeId)
  const allNodes = await parallelMap(allRouteIds, 20, async rid => {
    const list = await fetchRouteNodes(rid).catch(() => [])
    return { rid, list }
  })

  // stop(sttnId) -> [{routeId, sttnSn, linkDstncAcmtl}]
  const stopRoutes = new Map()
  for (const entry of allNodes) {
    if (!entry || !entry.list) continue
    for (const n of entry.list) {
      const arr = stopRoutes.get(n.nodeId) || []
      arr.push({ routeId: n.routeId, sttnSn: +n.sttnSn, dst: parseFloat(n.linkDstncAcmtl) || 0 })
      stopRoutes.set(n.nodeId, arr)
    }
  }

  const startMap = new Map()
  for (const s of startStops) {
    for (const r of (stopRoutes.get(s.sttnId) || [])) {
      startMap.set(`${r.routeId}|${s.sttnId}`, { stop: s, ...r })
    }
  }

  const candidates = []
  for (const e of endStops) {
    for (const r of (stopRoutes.get(e.sttnId) || [])) {
      // 같은 노선, sttnSn(start) < sttnSn(end)
      for (const [k, st] of startMap.entries()) {
        if (st.routeId !== r.routeId) continue
        if (st.sttnSn >= r.sttnSn) continue
        const distKm = Math.max(0.1, (r.dst - st.dst) / 1000)
        const busMin = (distKm / BUS_AVG_SPEED_KMH) * 60
        const walkStartMin = (st.stop.km / WALK_SPEED_KMH) * 60
        const walkEndMin   = (e.km / WALK_SPEED_KMH) * 60
        const totalMin = walkStartMin + busMin + walkEndMin + 3 // 대기 3분 가정
        candidates.push({
          totalMin,
          routeId: r.routeId,
          route:   routeById.get(r.routeId),
          startStop: st.stop, startSn: st.sttnSn,
          endStop:   e,       endSn:   r.sttnSn,
          distKm, busMin, walkStartMin, walkEndMin,
        })
      }
    }
  }
  candidates.sort((a, b) => a.totalMin - b.totalMin)
  const top = candidates.slice(0, BUS_MAX_RESULTS)
  if (!top.length) return sendJson(res, 200, [])

  // subPaths 조립 — 우선 "도로 shape 폴리라인" 시도, 실패 시 "정류장 연결선" 폴백
  const result = await parallelMap(top, 3, async c => {
    const [rn, roadPoly] = await Promise.all([
      fetchRouteNodes(c.routeId).catch(() => []),
      fetchBusRoutePath(c.routeId).catch(() => []),
    ])
    const sorted = rn.slice().sort((a, b) => +a.sttnSn - +b.sttnSn)
    // 정류장 기반 폴백 라인
    const stopLine = []
    for (const n of sorted) {
      const sn = +n.sttnSn
      if (sn < c.startSn || sn > c.endSn) continue
      const st = stops.find(s => s.sttnId === n.nodeId)
      if (st) stopLine.push({ x: st.x, y: st.y, slope: 0 })
    }
    // 도로 shape slice 시도 — 성공 시 이걸 사용, 실패 시 stopLine
    let pass = stopLine
    if (roadPoly && roadPoly.length >= 2) {
      const sliced = sliceBusPolyline(
        roadPoly,
        +c.startStop.x, +c.startStop.y,
        +c.endStop.x,   +c.endStop.y,
      )
      if (sliced && sliced.length >= 2) {
        pass = sliced.map(([x, y]) => ({ x, y, slope: 0 }))
      }
    }
    const lane = {
      name: c.route?.routeNm || c.routeId,
      busNo: c.route?.routeNm || '',
      subwayCode: '',
      arsId: '',
      type: c.route?.routeTy || '',
    }
    return {
      totalTime: Math.round(c.totalMin),
      transferCount: 0,
      subPaths: [
        {
          trafficType: 3,
          sectionTime: Math.max(1, Math.round(c.walkStartMin)),
          distance: Math.round(c.startStop.km * 1000),
          stationCount: 0,
          startName: '출발지', endName: c.startStop.sttnNm,
          startX: sx, startY: sy,
          endX: c.startStop.x, endY: c.startStop.y,
          passCoords: [], lane: { name: '도보' },
        },
        {
          trafficType: 2,
          sectionTime: Math.max(1, Math.round(c.busMin)),
          distance: Math.round(c.distKm * 1000),
          stationCount: c.endSn - c.startSn,
          startName: c.startStop.sttnNm, endName: c.endStop.sttnNm,
          startX: c.startStop.x, startY: c.startStop.y,
          endX:   c.endStop.x,   endY:   c.endStop.y,
          passCoords: pass, lane,
        },
        {
          trafficType: 3,
          sectionTime: Math.max(1, Math.round(c.walkEndMin)),
          distance: Math.round(c.endStop.km * 1000),
          stationCount: 0,
          startName: c.endStop.sttnNm, endName: '도착지',
          startX: c.endStop.x, startY: c.endStop.y,
          endX: ex, endY: ey,
          passCoords: [], lane: { name: '도보' },
        },
      ],
    }
  })

  return sendJson(res, 200, result)
}

// ══════════════════════════════════════════════════════════════════════
// 서울 노선정보조회(ws.bus.go.kr) getRoutePath 프록시
//   GET /api/bus/path?routeId=100100472  → [[lon,lat], ...] (WGS84)
//   "정류장 연결선" 이 아닌 "도로 따라가는 shape" 폴리라인을 내려준다.
//   API 키: BUS_ROUTE_INFO_KEY (공공데이터포털 "서울특별시_노선정보조회").
// ══════════════════════════════════════════════════════════════════════
const busPathCache = createLRU(1000)
const BUS_PATH_TTL_MS = 24 * 60 * 60 * 1000

async function fetchBusRoutePath(routeId) {
  if (!routeId) return []
  const now = Date.now()
  const cached = busPathCache.get(routeId)
  if (cached && (now - cached.ts) < BUS_PATH_TTL_MS) return cached.data

  const key = readKey(BUS_ROUTE_INFO_KEY, 'BUS_ROUTE_INFO_KEY')
  if (!key) return []

  const url = `http://ws.bus.go.kr/api/rest/busRouteInfo/getRoutePath` +
    `?serviceKey=${encodeURIComponent(key)}&busRouteId=${encodeURIComponent(routeId)}`

  try {
    const { status, text } = await fetchText(url, {}, 8000)
    if (status !== 200 || !text) return []
    const coords = []
    const blockRe = /<itemList>([\s\S]*?)<\/itemList>/g
    let m
    while ((m = blockRe.exec(text)) !== null) {
      const block = m[1]
      const gx = /<gpsX>([\d.\-]+)<\/gpsX>/.exec(block)
      const gy = /<gpsY>([\d.\-]+)<\/gpsY>/.exec(block)
      if (gx && gy) {
        const lon = parseFloat(gx[1]), lat = parseFloat(gy[1])
        if (Number.isFinite(lon) && Number.isFinite(lat)) coords.push([lon, lat])
      }
    }
    busPathCache.set(routeId, { data: coords, ts: now })
    return coords
  } catch (e) {
    console.warn('[fetchBusRoutePath]', routeId, e && e.message)
    return []
  }
}

// 폴리라인에서 (sx,sy)~(ex,ey) 사이 구간 슬라이스.
// 각 엔드포인트에 가장 가까운 버텍스 인덱스를 찾고,
// 두 인덱스 사이를 순방향으로 잘라 리턴. 2점 미만이면 null.
function sliceBusPolyline(poly, sx, sy, ex, ey) {
  if (!Array.isArray(poly) || poly.length < 2) return null
  const d2 = (a, b) => { const dx = a[0] - b[0], dy = a[1] - b[1]; return dx*dx + dy*dy }
  const S = [sx, sy], E = [ex, ey]
  let iS = 0, iE = 0, bS = Infinity, bE = Infinity
  for (let i = 0; i < poly.length; i++) {
    const dS = d2(poly[i], S); if (dS < bS) { bS = dS; iS = i }
    const dE = d2(poly[i], E); if (dE < bE) { bE = dE; iE = i }
  }
  if (iS === iE) return null
  const [lo, hi] = iS < iE ? [iS, iE] : [iE, iS]
  const slice = poly.slice(lo, hi + 1)
  // 역방향이면 뒤집어서 방향 맞춤
  if (iS > iE) slice.reverse()
  return slice.length >= 2 ? slice : null
}

async function handleBusRoutePath(req, res) {
  const routeId = String(req.query.routeId || '').trim()
  if (!routeId) return sendErr(res, 400, 'missing routeId')
  const coords = await fetchBusRoutePath(routeId)
  res.set('Cache-Control', 'public, max-age=86400')
  return sendJson(res, 200, coords)
}

async function handleTdataBusCoords(req, res) {
  const routeId = (req.query.routeId || '').trim()
  if (!routeId) return sendErr(res, 400, 'missing routeId')
  // 페이징 지원 (스크린샷: rowCnt, startRow). 기본 1000 한번에.
  const rowCnt   = req.query.rowCnt   || '1000'
  const startRow = req.query.startRow || '1'
  const data = await tdataFetch('BisTbisMsRouteCrdnt', { routeId, rowCnt, startRow })
  res.set('Cache-Control', 'public, max-age=3600')
  return sendJson(res, 200, data || [])
}

// ══════════════════════════════════════════════════════════════════════
// Export — 단일 함수 `api` 가 /api/** 모두 처리
// ══════════════════════════════════════════════════════════════════════
exports.api = onRequest(
  { secrets: ALL_SECRETS, cors: false, timeoutSeconds: 120, memory: '1GiB' },
  route,
)
