// src/subway-geometry.js
// 지하철 leg 의 실제 노선 폴리라인을 반환한다.
// 정적 GeoJSON 번들(src/data/subway-lines.geojson) 을 한 번만 로드해 캐시.
// TMAP passShape 없이도 역-역 구간의 실제 선로를 그릴 수 있게 해주는 유틸.

;(function () {
  'use strict'

  const GEOJSON_URL = 'src/data/subway-lines.geojson'

  // subwayCode('1'..'9','A','B','K') → GeoJSON feature.properties.ref 매칭 규칙
  const CODE_TO_REFS = {
    '1': ['1'],
    '2': ['2'],
    '3': ['3'],
    '4': ['4'],
    '5': ['5'],
    '6': ['6'],
    '7': ['7'],
    '8': ['8'],
    '9': ['9'],
    'A': ['AREX', '공항철도'],
    'B': ['수인·분당'],
    'K': ['경의·중앙'],
  }

  // seg.lane.name 에 들어올 수 있는 노선명 → ref
  const NAME_TO_REF = [
    [/신분당/, '신분당'],
    [/경의.*중앙|중앙.*경의/, '경의·중앙'],
    [/수인.*분당|분당.*수인/, '수인·분당'],
    [/분당/, '수인·분당'],
    [/경춘/, '경춘'],
    [/경강/, '경강'],
    [/서해/, '서해'],
    [/공항철도|AREX/i, 'AREX'],
    [/우이|신설/, 'W'],
    [/의정부/, 'U'],
    [/용인|에버라인/, 'E'],
    [/김포.*골드|골드라인/, '김포 골드라인'],
    [/인천.*1|1.*인천/, '인천1'],
    [/인천.*2|2.*인천/, 'I2'],
    [/GTX.*A/i, 'GTX-A'],
  ]

  let _cache = null       // { [ref]: { coords: [[lon,lat],...] } }
  let _loadPromise = null // 중복 로드 방지

  async function _load() {
    if (_cache) return _cache
    if (_loadPromise) return _loadPromise
    _loadPromise = (async () => {
      try {
        const res = await fetch(GEOJSON_URL, { cache: 'force-cache' })
        if (!res.ok) throw new Error('geojson fetch failed: ' + res.status)
        const fc = await res.json()
        const byRef = {}
        for (const f of (fc.features || [])) {
          const ref = f?.properties?.ref
          const coords = f?.geometry?.coordinates
          if (!ref || !Array.isArray(coords) || coords.length < 2) continue
          byRef[ref] = { coords }
        }
        _cache = byRef
        return byRef
      } catch (e) {
        console.warn('[subway-geom] load failed', e.message)
        _cache = {}
        return _cache
      }
    })()
    return _loadPromise
  }

  function _pickRef(seg) {
    const code = String(seg?.lane?.subwayCode || '').toUpperCase()
    const candidates = CODE_TO_REFS[code] || []
    for (const ref of candidates) {
      if (_cache[ref]) return ref
    }
    const name = String(seg?.lane?.name || seg?.label || '')
    for (const [re, ref] of NAME_TO_REF) {
      if (re.test(name) && _cache[ref]) return ref
    }
    return null
  }

  // Haversine squared in degrees² (good enough for nearest-vertex search)
  function _distSq(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by
    return dx * dx + dy * dy
  }

  function _nearestIdx(coords, x, y) {
    let best = -1, bestD = Infinity
    for (let i = 0; i < coords.length; i++) {
      const d = _distSq(coords[i][0], coords[i][1], x, y)
      if (d < bestD) { bestD = d; best = i }
    }
    return { idx: best, dist: bestD }
  }

  /**
   * 지하철 leg 의 실제 경로 좌표를 반환.
   * 실패(노선 미매칭/슬라이스 실패) 시 null 반환 → 호출자가 기존 폴백 사용.
   * @returns {Array<{x:number,y:number}>|null}
   */
  async function getSubwayPathCoords(seg) {
    if (!seg) return null
    const sx = +seg.startX, sy = +seg.startY, ex = +seg.endX, ey = +seg.endY
    if (!sx || !sy || !ex || !ey) return null

    await _load()
    const ref = _pickRef(seg)
    if (!ref) return null

    const line = _cache[ref]
    const coords = line.coords
    const a = _nearestIdx(coords, sx, sy)
    const b = _nearestIdx(coords, ex, ey)
    if (a.idx < 0 || b.idx < 0 || a.idx === b.idx) return null

    // Degree² → 대략 (deg*111km)². 1km² ≈ 8e-5 deg². 최근접 점이 너무 멀면(>3km) 매칭 실패로 간주.
    const FAR = 8e-4
    if (a.dist > FAR || b.dist > FAR) return null

    let i0 = a.idx, i1 = b.idx
    let slice
    if (i0 < i1) slice = coords.slice(i0, i1 + 1)
    else         slice = coords.slice(i1, i0 + 1).reverse()

    if (slice.length < 2) return null
    return slice.map(([x, y]) => ({ x, y, slope: 0 }))
  }

  // 앱 부팅 시 한 번 워밍업
  function initSubwayGeom() { _load() }

  window.getSubwayPathCoords = getSubwayPathCoords
  window.initSubwayGeom = initSubwayGeom
})()
