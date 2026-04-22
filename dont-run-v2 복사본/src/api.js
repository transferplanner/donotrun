// api.js — 모든 외부 API 호출 (Kakao REST + TMAP + 서울 버스/지하철 + OSRM/Valhalla + OpenTopoData)
// CONFIG 객체는 config.js 에서 전역 로드됨
//
// ⚠️ 보안 주의 (P1 구조적 문제):
//   이 파일에서 참조하는 CONFIG.* 키들은 브라우저에 그대로 노출됨.
//   공개 가능한 Kakao JS SDK 키 / 도메인 제한이 걸린 키만 이 레이어에서 직접 사용할 것.
//   서버-투-서버가 원칙인 키(TMAP, 공공데이터포털, 서울 열린데이터)는
//   프로덕션에서는 반드시 백엔드 프록시(예: /api/tmap, /api/bus) 뒤로 옮겨야 함.
//   현재 구현은 개발/데모 단계 임시 구조.

// ══════════════════════════════════════════════════════════════════════
// 공통 헬퍼
// ══════════════════════════════════════════════════════════════════════

// AbortController 타임아웃 (Safari 16.3 이하 호환)
function _timeout(ms) {
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(new DOMException('Timeout', 'TimeoutError')), ms)
  return ctrl.signal
}

// r.ok 검사 + JSON 파싱 (4xx/5xx 를 조용히 JSON.parse 시도하지 않도록)
async function _fetchJson(url, opts = {}, tag = 'FETCH') {
  const res = await fetch(url, opts)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`[${tag}] HTTP ${res.status} ${res.statusText} ${body.slice(0, 120)}`)
  }
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('json')) {
    // 공공API가 장애 시 XML 에러페이지 반환하는 경우 방어
    const body = await res.text().catch(() => '')
    throw new Error(`[${tag}] non-JSON response: ${body.slice(0, 120)}`)
  }
  return res.json()
}

// r.ok 검사 + 텍스트 반환 (XML 등)
async function _fetchText(url, opts = {}, tag = 'FETCH') {
  const res = await fetch(url, opts)
  if (!res.ok) {
    throw new Error(`[${tag}] HTTP ${res.status} ${res.statusText}`)
  }
  return res.text()
}

// ── 서버 프록시 베이스 경로 ──────────────────────────────────────────
// Firebase Hosting rewrite (/api/** → Functions) 를 통해 모든 키드 API 를 경유.
// 로컬 에뮬레이터(:6001) / 프로덕션(.web.app) 모두 동일 경로.
const API_BASE = '/api'

// XML 파서 헬퍼
function _parseXML(text) { return new DOMParser().parseFromString(text, 'text/xml') }
function _xmlItems(xml, tag = 'itemList') { return Array.from(xml.querySelectorAll(tag)) }
function _xmlVal(el, tag) { return el.querySelector(tag)?.textContent?.trim() ?? '' }

// 좌표 정규화 — {lat,lng} / {x,y} / {lon} 어떤 형태가 와도 {lat,lng} 로 통일
function _toLatLng(c) {
  if (c == null) return null
  const lat = c.lat ?? c.latitude ?? c.y
  const lng = c.lng ?? c.lon ?? c.longitude ?? c.x
  const nLat = Number(lat), nLng = Number(lng)
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return null
  return { lat: nLat, lng: nLng }
}

// 간단한 LRU 캐시 (크기 상한 도달 시 가장 오래된 엔트리 제거)
function _createLRU(max = 200) {
  const map = new Map()
  return {
    get(k) {
      if (!map.has(k)) return undefined
      const v = map.get(k)
      map.delete(k); map.set(k, v)   // 최근 사용으로 이동
      return v
    },
    has(k) { return map.has(k) },
    set(k, v) {
      if (map.has(k)) map.delete(k)
      map.set(k, v)
      if (map.size > max) {
        const oldest = map.keys().next().value
        map.delete(oldest)
      }
    },
    delete(k) { map.delete(k) },
    clear() { map.clear() },
    get size() { return map.size },
  }
}

// ══════════════════════════════════════════════════════════════════════
// 1. Kakao REST API — 장소 검색 + 역지오코딩
// ══════════════════════════════════════════════════════════════════════

async function searchKakaoPlace(q) {
  try {
    const data = await _fetchJson(
      `${API_BASE}/kakao/search?q=${encodeURIComponent(q)}`,
      { signal: _timeout(6000) },
      'KAKAO_SEARCH'
    )
    return (data.documents || []).map(d => ({
      name:    d.place_name,
      address: d.road_address_name || d.address_name || '',
      x: parseFloat(d.x),
      y: parseFloat(d.y),
    }))
  } catch(e) {
    console.warn(e.message)
    return []
  }
}

async function kakaoReverseGeocode(lat, lng) {
  try {
    const data = await _fetchJson(
      `${API_BASE}/kakao/rgeo?lat=${lat}&lng=${lng}`,
      { signal: _timeout(5000) },
      'KAKAO_RGEO'
    )
    const doc = data.documents?.[0]
    if (!doc) return null
    return doc.road_address?.address_name || doc.address?.address_name || null
  } catch(e) {
    console.warn(e.message)
    return null
  }
}

async function nominatimReverseGeocode(lat, lng) {
  try {
    const data = await _fetchJson(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
      { headers: { 'Accept-Language': 'ko' }, signal: _timeout(7000) },
      'NOMINATIM_RGEO'
    )
    const addr = data?.address || {}
    return addr.road || addr.suburb || addr.quarter || addr.city_district ||
           (data?.display_name || '').split(',')[0] ||
           `${lat.toFixed(5)}, ${lng.toFixed(5)}`
  } catch(e) {
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
  }
}

async function nominatimSearch(q) {
  try {
    const data = await _fetchJson(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&countrycodes=kr&limit=5&addressdetails=1`,
      { headers: { 'Accept-Language': 'ko' }, signal: _timeout(6000) },
      'NOMINATIM_SEARCH'
    )
    return (data || []).map(d => {
      const addr = d.address || {}
      const name = addr.road || addr.amenity || addr.building || d.display_name.split(',')[0]
      return { name, address: d.display_name, x: parseFloat(d.lon), y: parseFloat(d.lat) }
    })
  } catch(e) {
    console.warn('[NOMINATIM_SEARCH]', e.message)
    return []
  }
}

async function reverseGeocode(lat, lng) {
  const kakao = await kakaoReverseGeocode(lat, lng)
  if (kakao) return kakao
  return nominatimReverseGeocode(lat, lng)
}

// ══════════════════════════════════════════════════════════════════════
// 2. TMAP 대중교통 경로 탐색
// ──
// ⚠️ TMAP 키는 Referer 제한을 반드시 콘솔에서 걸어둘 것.
//    이전 구현은 ?appKey=... 쿼리스트링으로 키를 노출했음 (서버 로그·리퍼러 유출 위험).
//    현재 구현은 appKey 를 헤더로 전달. Safari 에서 preflight (OPTIONS) 는 발생하지만
//    TMAP 이 CORS 응답을 제대로 주므로 동작함. 만약 특정 환경에서 preflight 가 깨지면
//    자체 백엔드 프록시 경유로 전환해야 함.
// ══════════════════════════════════════════════════════════════════════

function _tmapNow() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`
}

function _tmapSubwayCode(color, route) {
  if (!color && !route) return ''
  const r = route || ''
  const m = r.match(/(\d)호선/)
  if (m) return m[1]
  const c = (color || '').toLowerCase().replace('#', '')
  const MAP = {
    '0052a4':'1','00a84d':'2','ef7c1c':'3','00a5de':'4',
    '996cac':'5','cd7c2f':'6','747f00':'7','e6186c':'8',
    'bdb092':'9','569bbd':'A','f5a200':'B','71c8b2':'K',
  }
  return MAP[c] || ''
}

async function getTransitRoutes(startX, startY, endX, endY) {
  // 1) 로컬 지하철 라우터(OSM 기반) 와 2) 서버 버스 라우터(T-data 기반) 를 병렬 호출해 합친다.
  //    — 둘 다 getTransitRoutes 와 동일 shape 반환.
  //    — 실패/빈값 은 폴백 체인(원본 TMAP) 으로.
  try {
    const [sub, bus] = await Promise.all([
      (async () => {
        if (typeof window.routeSubway !== 'function') return []
        try { return (await window.routeSubway(+startX, +startY, +endX, +endY)) || [] }
        catch (e) { console.warn('[SUBWAY_ROUTER]', e.message); return [] }
      })(),
      (async () => {
        try {
          const data = await _fetchJson(`${API_BASE}/bus/transit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ startX, startY, endX, endY, radius: 600 }),
            signal: _timeout(45000), // cold start 시 route-node 일괄 fetch 가 오래 걸릴 수 있음
          }, 'BUS_TRANSIT')
          return Array.isArray(data) ? data : []
        } catch (e) { console.warn('[BUS_ROUTER]', e.message); return [] }
      })(),
    ])

    const merged = [...sub, ...bus].filter(r => r && Array.isArray(r.subPaths))
    if (merged.length) {
      merged.sort((a, b) => (a.totalTime || 0) - (b.totalTime || 0))
      return merged
    }
  } catch (e) {
    console.warn('[TRANSIT_MERGE]', e.message)
  }
  // (이하 원본 TMAP 경로 — 로컬 라우터 실패 시만 호출. 실제론 거의 안 닿음)
  try {
    const data = await _fetchJson(`${API_BASE}/tmap/transit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        startX: String(startX), startY: String(startY),
        endX:   String(endX),   endY:   String(endY),
        count: 3,
      }),
      signal: _timeout(10000),
    }, 'TMAP_TRANSIT')

    const its = data?.metaData?.plan?.itineraries
    if (!Array.isArray(its) || !its.length) return []

    return its.map(it => ({
      totalTime:     it.totalTime    || 0,
      transferCount: it.transferCount || 0,
      subPaths: (it.legs || []).map(leg => {
        const tt = leg.mode === 'WALK' ? 3
                 : (leg.mode === 'SUBWAY' || leg.mode === 'METRO_RAIL') ? 1 : 2

        // WKT LINESTRING 또는 공백 구분 "lon,lat lon,lat ..." 모두 허용
        const _parseLS = (ls) => {
          const out = []
          if (!ls) return out
          const inner = String(ls).replace(/^LINESTRING\s*\(/i, '').replace(/\)$/, '')
          for (const pair of inner.split(',')) {
            const [x, y] = pair.trim().split(/\s+/).map(parseFloat)
            if (isFinite(x) && isFinite(y) && x && y) out.push({ x, y, slope: 0 })
          }
          return out
        }

        const passCoords = (() => {
          if (tt === 3) {
            // 도보: steps[].linestring 연결
            const pts = []
            for (const step of (leg.steps || [])) {
              pts.push(..._parseLS(step.linestring || step.lineString))
            }
            if (pts.length >= 2) return pts
          } else {
            // 지하철/버스: TMAP passShape.linestring 이 실제 노선 경로
            const shapePts = _parseLS(leg.passShape?.linestring || leg.passShape?.lineString)
            if (shapePts.length >= 2) return shapePts
          }
          // 폴백: 정류장 좌표만 (직선)
          return (leg.passStopList?.stationList || [])
            .map(s => ({ x: parseFloat(s.lon || s.x || '0'), y: parseFloat(s.lat || s.y || '0') }))
            .filter(c => c.x && c.y)
        })()

        return {
          trafficType:  tt,
          sectionTime:  Math.round((leg.sectionTime || leg.travelTime || 0) / 60),
          distance:     leg.distance || 0,
          stationCount: leg.passStopList?.stationList?.length || 0,
          startName:    leg.start?.name || '',
          endName:      leg.end?.name   || '',
          startX:       parseFloat(leg.start?.lon || leg.start?.x || '0'),
          startY:       parseFloat(leg.start?.lat || leg.start?.y || '0'),
          endX:         parseFloat(leg.end?.lon   || leg.end?.x   || '0'),
          endY:         parseFloat(leg.end?.lat   || leg.end?.y   || '0'),
          passCoords,
          lane: {
            name:       leg.route     || leg.routeName || '',
            busNo:      leg.route     || '',
            arsId:      leg.stop?.arsId || '',
            subwayCode: _tmapSubwayCode(leg.routeColor, leg.route),
          },
        }
      }),
    }))
  } catch(e) {
    console.warn('[TMAP_TRANSIT]', e.message)
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. 지하철 실시간 도착 + 혼잡도 (서울 열린데이터)
// ══════════════════════════════════════════════════════════════════════

async function getSubwayArrival(stationName) {
  try {
    const data = await _fetchJson(
      `${API_BASE}/subway/arrival?station=${encodeURIComponent(stationName)}`,
      { signal: _timeout(5000) },
      'SUBWAY_ARR'
    )
    return (data?.realtimeStationArrival?.row ?? []).map(r => ({
      trainLineNm: r.TRAIN_LINE_NM,
      arvlMsg2:    r.ARVL_MSG2,
      barvlDt:     parseInt(r.BARVL_DT) || 999,
    }))
  } catch(e) {
    console.warn('[SUBWAY_ARR]', e.message)
    return []
  }
}

async function getSubwayCongestion(line) {
  try {
    const data = await _fetchJson(
      `${API_BASE}/subway/crowd?line=${encodeURIComponent(line)}`,
      { signal: _timeout(5000) },
      'SUBWAY_CROWD'
    )
    return (data?.JSON_SUBWAY_CROWD_DATA?.row ?? []).map(r => ({
      stationName: r.STATION_NM,
      crowdLevel:  parseInt(r.CONGESTION_VAL) || 0,
    }))
  } catch(e) {
    console.warn('[SUBWAY_CROWD]', e.message)
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════
// 4. 버스 도착 정보 (ws.bus.go.kr — corsproxy.io 경유)
// ══════════════════════════════════════════════════════════════════════

async function getBusArrival(arsId) {
  if (!arsId) return []
  try {
    const text = await _fetchText(
      `${API_BASE}/bus/arrival?arsId=${encodeURIComponent(arsId)}`,
      { signal: _timeout(5000) },
      'BUS_ARR'
    )
    const xml = _parseXML(text)
    return _xmlItems(xml).map(item => ({
      busRouteAbrv: _xmlVal(item, 'busRouteAbrv'),
      busRouteId:   _xmlVal(item, 'busRouteId'),
      arrmsg1:      _xmlVal(item, 'arrmsg1'),
      arrmsg2:      _xmlVal(item, 'arrmsg2'),
      predictTime1: parseInt(_xmlVal(item, 'predictTime1')) || 99,
      predictTime2: parseInt(_xmlVal(item, 'predictTime2')) || 99,
      carLoad1:     parseInt(_xmlVal(item, 'carLoad1'))     || 0,
    }))
  } catch(e) {
    console.warn('[BUS_ARR]', e.message)
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════
// 5. 신호등 정보 (부산시 TrafficLightService)
// ══════════════════════════════════════════════════════════════════════

async function getNearbySignals(lat, lng) {
  try {
    const data = await _fetchJson(
      `${API_BASE}/signal?lat=${lat}&lng=${lng}&radius=300`,
      { signal: _timeout(5000) },
      'SIGNAL'
    )
    const items = data?.response?.body?.items?.item ?? []
    const list  = Array.isArray(items) ? items : [items]
    return list.map(s => ({ redTime: parseInt(s.redTime) || 60, cycleTime: parseInt(s.cycleTime) || 90 }))
  } catch(e) {
    console.warn('[SIGNAL]', e.message)
    return []
  }
}

// ══════════════════════════════════════════════════════════════════════
// 6. 보행 경로 좌표 (TMAP → Valhalla → OSRM 폴백, LRU 캐시)
// ══════════════════════════════════════════════════════════════════════

const _walkCache    = _createLRU(200)          // 최대 200개 좌표 쌍 캐시
const _walkInflight = new Map()

function _decodePolyline(encoded, precision) {
  const pts = []
  const div = precision
  let idx = 0, lat = 0, lng = 0
  while (idx < encoded.length) {
    let b, shift = 0, result = 0
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lat += (result & 1) ? ~(result >> 1) : (result >> 1)
    shift = 0; result = 0
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lng += (result & 1) ? ~(result >> 1) : (result >> 1)
    const rlat = lat / div, rlng = lng / div
    if (rlat < 33 || rlat > 39 || rlng < 124 || rlng > 132) continue
    pts.push({ x: rlng, y: rlat, slope: 0 })
  }
  return pts
}

function _decodePolylineAuto(encoded) {
  const p5 = _decodePolyline(encoded, 1e5)
  const p6 = _decodePolyline(encoded, 1e6)
  return p5.length >= p6.length ? p5 : p6
}

async function getWalkRoute(startX, startY, endX, endY) {
  const cacheKey = `${startX},${startY},${endX},${endY}`
  if (_walkCache.has(cacheKey))    return _walkCache.get(cacheKey)
  if (_walkInflight.has(cacheKey)) return _walkInflight.get(cacheKey)

  const promise = (async () => {
    // 1순위: TMAP 보행 (Functions 프록시 경유)
    try {
      const data = await _fetchJson(`${API_BASE}/tmap/walk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startX: String(startX), startY: String(startY),
          endX:   String(endX),   endY:   String(endY),
        }),
        signal: _timeout(7000),
      }, 'TMAP_WALK')
      const pts = []
      for (const f of (data?.features ?? [])) {
        if (f.geometry?.type === 'LineString') {
          for (const [x, y] of (f.geometry.coordinates || [])) {
            if (isFinite(x) && isFinite(y) && x && y) pts.push({ x, y, slope: 0 })
          }
        }
      }
      if (pts.length >= 2) { _walkCache.set(cacheKey, pts); return pts }
    } catch(e) { console.warn('[TMAP_WALK]', e.message) }

    // 2순위: Valhalla
    try {
      const body = {
        locations: [{ lon: startX, lat: startY }, { lon: endX, lat: endY }],
        costing: 'pedestrian',
        shape_format: 'polyline6',
      }
      const data = await _fetchJson('https://valhalla1.openstreetmap.de/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: _timeout(8000),
      }, 'VALHALLA')
      const shape = data?.trip?.legs?.[0]?.shape
      if (shape) {
        const pts = _decodePolylineAuto(shape)
        if (pts.length >= 2) { _walkCache.set(cacheKey, pts); return pts }
      }
    } catch(e) { console.warn('[VALHALLA]', e.message) }

    // 3순위: OSRM foot
    try {
      const data = await _fetchJson(
        `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${startX},${startY};${endX},${endY}?geometries=geojson&overview=full`,
        { signal: _timeout(10000) },
        'OSRM_FOOT'
      )
      const coords = data?.routes?.[0]?.geometry?.coordinates
      if (coords?.length >= 2) {
        const pts = coords.map(([x, y]) => ({ x, y, slope: 0 }))
        _walkCache.set(cacheKey, pts)
        return pts
      }
    } catch(e) { console.warn('[OSRM_FOOT]', e.message) }

    // 4순위: OSRM driving (최후)
    try {
      const data = await _fetchJson(
        `https://router.project-osrm.org/route/v1/driving/${startX},${startY};${endX},${endY}?geometries=geojson&overview=full`,
        { signal: _timeout(8000) },
        'OSRM_DRV'
      )
      const coords = data?.routes?.[0]?.geometry?.coordinates
      if (coords?.length >= 2) {
        const pts = coords.map(([x, y]) => ({ x, y, slope: 0 }))
        _walkCache.set(cacheKey, pts)
        return pts
      }
    } catch(e) { console.warn('[OSRM_DRV]', e.message) }

    return []
  })()

  _walkInflight.set(cacheKey, promise)
  try {
    return await promise
  } finally {
    _walkInflight.delete(cacheKey)
  }
}

// ══════════════════════════════════════════════════════════════════════
// 7. 고도 데이터 (OpenTopoData SRTM 30m)
// ──
// ★ P0 버그 수정: 이전 구현은 c.lat/c.lng 만 참조했는데
//    호출부에서 {x,y} 를 그대로 넘기는 케이스가 있어 "undefined,undefined" 로
//    API 가 전송되던 문제. _toLatLng 로 어떤 포맷이 와도 안전하게 정규화.
// ══════════════════════════════════════════════════════════════════════

async function getElevations(coords) {
  if (!Array.isArray(coords) || !coords.length) return []

  // {x,y} / {lat,lng} / {lon,latitude} 어떤 형태든 {lat,lng} 로 정규화
  const normalized = coords.map(_toLatLng)

  // 유효한 좌표만 추려서 API 요청 (원본 인덱스 보존)
  const valid = []
  normalized.forEach((p, i) => { if (p) valid.push({ i, p }) })
  if (!valid.length) return coords.map(() => 0)

  const locs = valid.map(({ p }) => `${p.lat},${p.lng}`).join('|')
  try {
    const data = await _fetchJson(
      `https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(locs)}`,
      { signal: _timeout(8000) },
      'ELEVATION'
    )
    const results = data?.results ?? []
    // 원본 길이에 맞춰 반환, 유효 인덱스에만 값 채움
    const out = new Array(coords.length).fill(0)
    valid.forEach(({ i }, k) => {
      const elev = results[k]?.elevation
      out[i] = Number.isFinite(elev) ? elev : 0
    })
    return out
  } catch(e) {
    console.warn('[ELEVATION]', e.message)
    return coords.map(() => 0)
  }
}
