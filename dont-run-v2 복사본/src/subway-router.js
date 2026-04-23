// src/subway-router.js
// TMAP 대중교통 API 없이 지하철 경로를 계산한다.
// 데이터:
//   - src/data/subway-stations.json : 노선별 역 순서 + 역 인덱스
//   - src/data/subway-lines.geojson  : 노선별 실제 폴리라인
// 결과는 기존 getTransitRoutes() 가 반환하던 shape 와 호환된다.
// (routes[].subPaths[] 의 trafficType/startName/endName/startX/Y/endX/Y/passCoords/lane/...)

;(function () {
  'use strict'

  const DATA_URL   = 'src/data/subway-stations.json'
  const GEO_URL    = 'src/data/subway-lines.geojson'

  const INTER_STOP_MIN   = 2.2   // 역 간 평균 소요(분)
  const TRANSFER_MIN     = 4     // 환승 페널티(분)
  const WALK_SPEED_KMH   = 4.5
  const MAX_WALK_TO_STN_KM = 2.0 // 출발/도착 역까지 허용 도보거리
  const NEAR_K           = 4     // 각 끝에서 후보 역 K개
  const MAX_TRANSFERS    = 3

  // ref → tmap-style subwayCode (렌더/혼잡도 조회용)
  const REF_TO_CODE = {
    '1':'1','2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9',
    'AREX':'A','수인·분당':'B','경의·중앙':'K',
  }
  // ref → display 라벨
  const REF_TO_LABEL = {
    '1':'1호선','2':'2호선','3':'3호선','4':'4호선','5':'5호선',
    '6':'6호선','7':'7호선','8':'8호선','9':'9호선',
    '수인·분당':'수인분당선','경의·중앙':'경의중앙선',
    '신분당':'신분당선','경춘':'경춘선','경강':'경강선','서해':'서해선',
    'AREX':'공항철도','W':'우이신설선','U':'의정부경전철','E':'용인경전철',
    '김포 골드라인':'김포골드라인','인천1':'인천1호선','I2':'인천2호선','GTX-A':'GTX-A',
  }

  let _cache = null
  let _loading = null

  async function _load() {
    if (_cache) return _cache
    if (_loading) return _loading
    _loading = (async () => {
      const [stRes, geoRes] = await Promise.all([
        fetch(DATA_URL,  { cache:'force-cache' }),
        fetch(GEO_URL,   { cache:'force-cache' }),
      ])
      const st = await stRes.json()
      const gj = await geoRes.json()
      const geomByRef = {}
      for (const f of (gj.features||[])) {
        geomByRef[f.properties.ref] = f.geometry.coordinates
      }
      _cache = {
        stations: st.stations || {},  // name -> {lon,lat,lines:[{ref,idx}]}
        lines:    st.lines    || {},  // ref  -> [{name,lon,lat}]
        geom:     geomByRef,          // ref  -> [[lon,lat],...]
      }
      return _cache
    })()
    return _loading
  }

  function _haversineKm(lat1, lon1, lat2, lon2) {
    const R=6371, toRad=v=>v*Math.PI/180
    const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1)
    const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2
    return 2*R*Math.asin(Math.sqrt(a))
  }

  function _findNearestStations(x, y, topK) {
    const items = []
    for (const [name, s] of Object.entries(_cache.stations)) {
      const km = _haversineKm(y, x, s.lat, s.lon)
      if (km <= MAX_WALK_TO_STN_KM) items.push({ name, km, lon:s.lon, lat:s.lat, lines:s.lines })
    }
    items.sort((a,b)=>a.km-b.km)
    return items.slice(0, topK)
  }

  // 그래프 노드 키: `${stationName}` (환승은 자동으로 동일 이름으로 수렴)
  // 간선: 같은 노선 인접역 (2.2분), 혹은 같은 역의 서로 다른 노선(환승 자체는 그래프상 간선 X —
  // 환승 코스트는 경로 재구성 시점에 노선 변경 시 1회 추가)
  function _dijkstra(startNames, endSet, startExtraMin) {
    // 노드: station name. edges: inter-station.
    // state: { time, path:[{name,ref}], transfers }
    // 간선 추가 시 이전 ref 와 다르면 transfer 페널티.
    const best = new Map() // name -> min time seen
    const pq = []          // [{time, last, path, transfers}] — 단순 정렬 우선순위큐
    for (const s of startNames) {
      const init = startExtraMin.get(s.name) || 0
      const key = s.name
      if (!best.has(key) || best.get(key) > init) {
        best.set(key, init)
        pq.push({ time: init, name: s.name, path: [{ name: s.name, ref: null }], transfers: 0 })
      }
    }

    let bestFinal = null
    while (pq.length) {
      pq.sort((a,b)=>a.time-b.time)
      const cur = pq.shift()
      if (bestFinal && cur.time >= bestFinal.time) break
      if (endSet.has(cur.name)) {
        if (!bestFinal || cur.time < bestFinal.time) bestFinal = cur
        continue
      }
      const stn = _cache.stations[cur.name]
      if (!stn) continue
      const prevRef = cur.path[cur.path.length-1]?.ref
      for (const { ref, idx } of stn.lines) {
        const seq = _cache.lines[ref]
        if (!seq) continue
        for (const neighIdx of [idx-1, idx+1]) {
          if (neighIdx < 0 || neighIdx >= seq.length) continue
          const nb = seq[neighIdx]
          const transferCost = (prevRef && prevRef !== ref) ? TRANSFER_MIN : 0
          const nextTransfers = cur.transfers + (transferCost ? 1 : 0)
          if (nextTransfers > MAX_TRANSFERS) continue
          const nt = cur.time + INTER_STOP_MIN + transferCost
          if (best.has(nb.name) && best.get(nb.name) <= nt) continue
          best.set(nb.name, nt)
          pq.push({
            time: nt, name: nb.name,
            path: [...cur.path, { name: nb.name, ref }],
            transfers: nextTransfers,
          })
        }
      }
    }
    return bestFinal
  }

  // 같은 노선 안에서 두 역 인덱스 사이 slice
  function _sliceLine(ref, fromName, toName) {
    const seq = _cache.lines[ref]
    const geom = _cache.geom[ref]
    if (!seq || !geom) return null
    const findStn = nm => seq.findIndex(s => s.name === nm)
    const i0 = findStn(fromName), i1 = findStn(toName)
    if (i0 < 0 || i1 < 0) return null
    const a = seq[i0], b = seq[i1]
    // geom 에서 두 역 좌표 최근접 vertex 찾기
    const distSq = (p,q)=>{const dx=p[0]-q[0],dy=p[1]-q[1];return dx*dx+dy*dy}
    const nearest = (x,y)=>{let k=0,d=Infinity;for(let i=0;i<geom.length;i++){const dd=distSq(geom[i],[x,y]);if(dd<d){d=dd;k=i}}return k}
    let j0 = nearest(a.lon, a.lat), j1 = nearest(b.lon, b.lat)
    let slice
    if (j0 <= j1) slice = geom.slice(j0, j1+1)
    else          slice = geom.slice(j1, j0+1).reverse()
    return slice.map(([x,y])=>({ x, y, slope:0 }))
  }

  // path([{name,ref}]) 를 같은 ref 끼리 묶어 leg 로 변환
  function _groupLegs(path) {
    const legs = []
    let cur = null
    for (let i = 1; i < path.length; i++) {
      const step = path[i]
      if (!cur || cur.ref !== step.ref) {
        if (cur) legs.push(cur)
        cur = { ref: step.ref, stations: [path[i-1].name, step.name] }
      } else {
        cur.stations.push(step.name)
      }
    }
    if (cur) legs.push(cur)
    return legs
  }

  /**
   * @returns {Array<{totalTime:number, transferCount:number, subPaths:Array}>}
   */
  async function routeSubway(startX, startY, endX, endY) {
    await _load()

    const starts = _findNearestStations(startX, startY, NEAR_K)
    const ends   = _findNearestStations(endX,   endY,   NEAR_K)
    if (!starts.length || !ends.length) return []

    const walkMin = km => Math.max(1, Math.round((km / WALK_SPEED_KMH) * 60))
    const startExtra = new Map(starts.map(s => [s.name, walkMin(s.km)]))
    const endMap     = new Map(ends.map(s => [s.name, walkMin(s.km)]))
    const endSet     = new Set(ends.map(s => s.name))

    const res = _dijkstra(starts, endSet, startExtra)
    if (!res) return []

    const firstStn = res.path[0]
    const lastStn  = res.path[res.path.length-1]
    const firstS = starts.find(s=>s.name===firstStn.name)
    const lastS  = ends.find(s=>s.name===lastStn.name)
    if (!firstS || !lastS) return []

    const legs = _groupLegs(res.path)
    const subPaths = []

    // 시작 도보
    subPaths.push({
      trafficType: 3,
      sectionTime: walkMin(firstS.km),
      distance:    Math.round(firstS.km * 1000),
      stationCount: 0,
      startName:'출발지', endName: firstS.name,
      startX, startY,
      endX: firstS.lon, endY: firstS.lat,
      passCoords: [],
      lane: { name:'도보' },
    })

    // 지하철 leg 들
    for (const leg of legs) {
      const from = leg.stations[0]
      const to   = leg.stations[leg.stations.length-1]
      const fStn = _cache.stations[from]
      const tStn = _cache.stations[to]
      if (!fStn || !tStn) continue
      const slice = _sliceLine(leg.ref, from, to) || []
      subPaths.push({
        trafficType: 1,
        sectionTime: Math.max(1, Math.round((leg.stations.length-1) * INTER_STOP_MIN)),
        distance:    0,
        stationCount: leg.stations.length,
        startName: from, endName: to,
        startX: fStn.lon, startY: fStn.lat,
        endX:   tStn.lon, endY:   tStn.lat,
        passCoords: slice,
        lane: {
          name:       REF_TO_LABEL[leg.ref] || leg.ref,
          subwayCode: REF_TO_CODE[leg.ref] || '',
          busNo:'', arsId:'',
        },
      })
    }

    // 끝 도보
    const lastStnObj = _cache.stations[lastStn.name]
    subPaths.push({
      trafficType: 3,
      sectionTime: endMap.get(lastStn.name) || 1,
      distance:    Math.round((lastS.km) * 1000),
      stationCount: 0,
      startName: lastStn.name, endName:'도착지',
      startX: lastStnObj.lon, startY: lastStnObj.lat,
      endX, endY,
      passCoords: [],
      lane: { name:'도보' },
    })

    const totalTime = subPaths.reduce((s,sp)=>s + (sp.sectionTime||0), 0)
    const transferCount = Math.max(0, legs.length - 1)

    return [{ totalTime, transferCount, subPaths }]
  }

  function initSubwayRouter() { _load().catch(()=>{}) }

  window.routeSubway       = routeSubway
  window.initSubwayRouter  = initSubwayRouter
})()
