// engine.js — 소요시간 계산 엔진 v2
//
// 수정 이력 (코드 리뷰 반영):
//   P0  analyze 내부의 지하철/버스 API 호출을 병렬화 — 환승 많을수록 지연 누적 문제 해결
//   P1  자정 경계 처리 — 23:50 출발, 00:10 마감 같은 케이스 정상 계산
//   P1  _timeBasedCrowdLevel — 9:00~9:29 extreme 오탐 → high 로 분리
//   P1  elevBatch 100 좌표 이상일 때 silent 잘림 → chunk 병렬 호출 + 패딩
//   P2  sp.lane 이 배열로 올 수 있는 공급자 응답 정규화 (_normalizeLane)

const SPEED_KMH = { slow: 3, normal: 4.5, fast: 6 }

// ── 상수 (매직 넘버 축소) ────────────────────────────────────────────
const DAY_MIN                = 1440   // 24h * 60
const MAX_HORIZON_MIN        = 720    // analyze 가 허용하는 최대 남은 시간 (12h)
const ELEV_BATCH_CAP         = 100    // OpenTopoData 1회 요청당 좌표 상한
const SUBWAY_WAIT_CAP_MIN    = 8      // 지하철 첫 열차 대기 상한
const SUBWAY_MISS_FALLBACK   = 12     // 놓친 후 둘째 열차 정보 없을 때 상한
const BUS_WAIT_CAP_MIN       = 10     // 버스 대기 상한
const BUS_WAIT_DEFAULT_MIN   = 5
const MISS_TRAIN_THRESHOLD   = 0.5    // 도보가 다음 열차보다 +0.5분 초과면 놓침
const VERDICT_OK_MARGIN      = 5
const VERDICT_HURRY_MARGIN   = 0
const VERDICT_RUN_MARGIN     = -5
const MIN_WALK_DIST_FOR_SLOPE = 150   // 이 미만은 경사 보정 의미 X

// 판정 헬퍼 — 여러 곳에서 중복되던 분기 통일
function _verdictByMargin(margin) {
  if (margin >= VERDICT_OK_MARGIN)    return 'ok'
  if (margin >= VERDICT_HURRY_MARGIN) return 'hurry'
  if (margin >= VERDICT_RUN_MARGIN)   return 'run'
  return 'late'
}

// sp.lane 정규화 — 공급자가 배열로 주는 경우 첫 요소만 사용
function _normalizeLane(lane) {
  if (!lane) return null
  if (Array.isArray(lane)) return lane[0] ?? null
  return lane
}

function crowdLevel(val) {
  if (val < 30) return 'low'
  if (val < 60) return 'medium'
  if (val < 80) return 'high'
  return 'extreme'
}

const CROWD_LABEL  = { low:'여유', medium:'보통', high:'혼잡', extreme:'매우 혼잡' }
const CROWD_EMOJI  = { low:'🟢', medium:'🟡', high:'🟠', extreme:'🔴' }
const CROWD_BUFFER = { low:0, medium:0.5, high:1.2, extreme:2.5 }

const BUS_CROWD_LABEL = { 0:'정보없음', 1:'여유', 2:'보통', 3:'혼잡', 4:'매우 혼잡' }
const BUS_CROWD_EMOJI = { 0:'⚪', 1:'🟢', 2:'🟡', 3:'🟠', 4:'🔴' }

function timeToMin(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

// 시간대 기반 혼잡도 추정 — API 데이터 없을 때 폴백
// 출발 시각(분)을 받아 low/medium/high/extreme 반환
function _timeBasedCrowdLevel(nowMin) {
  const h = Math.floor(nowMin / 60)
  // 아침 첨두 — 경계 엄격 분리
  //   7:00~7:30 = high
  //   7:30~9:00 = extreme  ← 첨두
  //   9:00~9:30 = high     ← 이전 버전은 여길 extreme 으로 오탐했음
  if (nowMin >= 7 * 60      && nowMin < 7 * 60 + 30) return 'high'
  if (nowMin >= 7 * 60 + 30 && nowMin < 9 * 60)      return 'extreme'
  if (nowMin >= 9 * 60      && nowMin < 9 * 60 + 30) return 'high'
  // 저녁 첨두 17:30~20:00
  if (nowMin >= 17 * 60 + 30 && nowMin < 19 * 60 + 30) return 'high'
  if (nowMin >= 19 * 60 + 30 && nowMin < 20 * 60)      return 'medium'
  // 점심 혼잡 12:00~13:30
  if (h === 12 || (h === 13 && nowMin < 13 * 60 + 30)) return 'medium'
  // 야간 23:00~06:00
  if (h >= 23 || h < 6) return 'low'
  // 나머지 평시
  return 'medium'
}

function _haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2
          + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

// 경사도 → 보행 속도 보정계수
function _slopeMult(riseMeter, runMeter) {
  if (runMeter < 10) return 1.0
  const pct = (riseMeter / runMeter) * 100
  if (pct > 10)  return 0.65   // 급한 오르막 (-35%)
  if (pct > 5)   return 0.80   // 오르막 (-20%)
  if (pct > 2)   return 0.92   // 약한 오르막 (-8%)
  if (pct < -10) return 0.85   // 급경사 내리막 (위험)
  if (pct < -5)  return 1.12   // 내리막 (+12%)
  if (pct < -2)  return 1.06   // 약한 내리막 (+6%)
  return 1.0
}

// 대중교통 API 실패 시 거리 기반 추정 폴백
function _fallbackRoutes(startX, startY, endX, endY, available, walkSpeed) {
  const distKm   = _haversineKm(startY, startX, endY, endX)
  const distM    = Math.round(distKm * 1000)
  const speedKmh = SPEED_KMH[walkSpeed]
  const walkMin  = Math.ceil((distKm / speedKmh) * 60)
  const transitMin = Math.ceil((distKm / 20) * 60) + 5

  const makeRoute = (estimated, type) => {
    const margin  = available - estimated
    const verdict = _verdictByMargin(margin)
    const segs = type === 'walk'
      ? [{ type:'walk', icon:'🚶', label:'도보', time:estimated, distance:distM,
           sigCount:Math.ceil(distM/100), sigWait:0, slopePct:0, isTransfer:false,
           startX, startY, endX, endY }]
      : [
          { type:'walk',   icon:'🚶', label:'도보',   time:5, distance:400,
            sigCount:4, sigWait:1, slopePct:0, isTransfer:false,
            startX, startY, endX:startX, endY:startY },
          { type:'subway', icon:'🚇', label:'지하철', time:transitMin-8,
            startName:'출발역', endName:'도착역',
            stationCount:Math.max(2, Math.round(distKm/2)),
            level:'medium', crowdLabel:'보통', crowdEmoji:'🟡',
            waitMin:3, nextTrain:3, willMiss:false, optimalCar:null,
            startX, startY, endX, endY },
          { type:'walk',   icon:'🚶', label:'도보',   time:3, distance:250,
            sigCount:2, sigWait:0, slopePct:0, isTransfer:false,
            startX:endX, startY:endY, endX, endY },
        ]
    return {
      index:1, estimated, available, margin, verdict,
      transferCount: type==='walk' ? 0 : 1, segments:segs, _isFallback:true,
    }
  }

  const routes = []
  if (distKm <= 2) routes.push(makeRoute(walkMin, 'walk'))
  routes.push(makeRoute(transitMin, 'transit'))
  if (distKm > 2)  routes.push(makeRoute(walkMin, 'walk'))
  routes.sort((a, b) => a.estimated - b.estimated)
  return routes
}

async function analyze({ startX, startY, endX, endY, nowTime, goalTime, walkSpeed='normal', onProgress=()=>{} }) {
  // 자정 경계 보정 — 23:50→00:10 같은 케이스 +1440 분
  let available = timeToMin(goalTime) - timeToMin(nowTime)
  if (available < 0) available += DAY_MIN
  if (available <= 0)            throw new Error('마감 시각이 현재 시각과 같거나 이전입니다.')
  if (available > MAX_HORIZON_MIN) throw new Error('마감 시각이 너무 멉니다. (최대 12시간)')

  onProgress('환승 경로 탐색 중...')
  const routes = await getTransitRoutes(startX, startY, endX, endY)

  if (!routes.length) {
    onProgress('직선거리 기반으로 추정 중...')
    const fallback = _fallbackRoutes(startX, startY, endX, endY, available, walkSpeed)
    return { available, routes:fallback, best:fallback[0], verdict:fallback[0]?.verdict, _fallbackUsed:true }
  }

  onProgress('실시간 데이터 수집 중...')

  // 모든 경로에서 등장하는 지하철 노선 코드 / 역 이름 / 버스 ARS 번호 수집
  // (lane 은 배열로 올 수도 있으니 _normalizeLane 으로 평탄화)
  const subwayCodes    = new Set()
  const subwayStations = new Set()
  const busArsIds      = new Set()
  for (const r of routes) {
    for (const sp of r.subPaths) {
      const lane = _normalizeLane(sp.lane)
      if (sp.trafficType === 1) {
        if (lane?.subwayCode) subwayCodes.add(String(lane.subwayCode))
        if (sp.startName)     subwayStations.add(sp.startName)
      } else if (sp.trafficType === 2) {
        if (lane?.arsId) busArsIds.add(lane.arsId)
      }
    }
  }

  // ★ P0 — 실시간 API 병렬 프리페치:
  //   신호등 + 노선 혼잡도 + 지하철 도착 + 버스 도착 을 한 번에 Promise.all
  //   이전엔 analyze 내부 for-of 에서 역마다 await 로 순차 호출하던 걸 제거
  const [signals, congestionGroups, subwayArrEntries, busArrEntries] = await Promise.all([
    getNearbySignals(startY, startX).catch(() => []),
    Promise.all([...subwayCodes].map(code => getSubwayCongestion(code).catch(() => []))),
    Promise.all([...subwayStations].map(async name =>
      [name, await getSubwayArrival(name).catch(() => [])]
    )),
    Promise.all([...busArsIds].map(async id =>
      [id, await getBusArrival(id).catch(() => [])]
    )),
  ])
  const congestion    = congestionGroups.flat()
  const subwayArrMap  = new Map(subwayArrEntries)
  const busArrMap     = new Map(busArrEntries)

  // ── 도보 구간 고도 배치 — chunk 병렬 호출로 silent 잘림 제거 ──────────
  onProgress('도보 경사도 분석 중...')
  const allWalkSPs = routes.flatMap(r =>
    r.subPaths.filter(sp =>
      sp.trafficType === 3 && sp.distance > MIN_WALK_DIST_FOR_SLOPE
      && sp.startX && sp.startY && sp.endX && sp.endY
    )
  )
  const elevCoords = allWalkSPs.flatMap(sp => [
    { lat: sp.startY, lng: sp.startX },
    { lat: sp.endY,   lng: sp.endX },
  ])
  let elevBatch = []
  if (elevCoords.length) {
    const chunks = []
    for (let i = 0; i < elevCoords.length; i += ELEV_BATCH_CAP) {
      chunks.push(elevCoords.slice(i, i + ELEV_BATCH_CAP))
    }
    const chunkResults = await Promise.all(
      chunks.map(c => getElevations(c).catch(() => []))
    )
    elevBatch = chunkResults.flat()
    // 응답 누락 시 인덱스 밀림 방지 — 원본 길이만큼 0 패딩
    while (elevBatch.length < elevCoords.length) elevBatch.push(0)
  }

  onProgress('소요시간 계산 중...')
  const speedKmh = SPEED_KMH[walkSpeed]
  const nowMin   = timeToMin(nowTime)

  // 이제 내부 루프는 await 가 없으므로 Promise.all 래핑도 동기 map 으로 단순화 가능
  const analyzed = routes.map((route, routeIdx) => {
    let total = 0
    const segs = []
    let prevWalkMin = 0  // 직전 도보 시간 — 열차 놓침 판정용

    for (let spIdx = 0; spIdx < route.subPaths.length; spIdx++) {
      const sp   = route.subPaths[spIdx]
      const lane = _normalizeLane(sp.lane)
      let t = 0
      let seg = {}

      if (sp.trafficType === 3) {
        // ── 도보 ─────────────────────────────────────────────────────────
        const baseMin  = (sp.distance / 1000) / speedKmh * 60
        const sigCount = Math.ceil(sp.distance / 100)
        const avgWait  = signals.length
          ? signals.reduce((s, x) => s + x.redTime / 2, 0) / signals.length
          : 30
        const sigWait = sigCount * avgWait / 60

        // 경사도 보정 (elevBatch 인덱스 매핑)
        const wi  = allWalkSPs.indexOf(sp)
        const e0  = wi >= 0 ? elevBatch[wi * 2]     : undefined
        const e1  = wi >= 0 ? elevBatch[wi * 2 + 1] : undefined
        const rise     = (e0 != null && e1 != null) ? (e1 - e0) : 0
        const slopePct = sp.distance > 0
          ? Math.round((rise / sp.distance) * 100 * 10) / 10
          : 0
        const mult = _slopeMult(rise, sp.distance)

        // 환승 통로 여부 (이전·다음이 모두 지하철 → 역 내부 이동)
        const prevSP = route.subPaths[spIdx - 1]
        const nextSP = route.subPaths[spIdx + 1]
        const isTransfer = prevSP?.trafficType === 1 && nextSP?.trafficType === 1

        let transferOverride = null
        if (isTransfer) {
          const stationName = (sp.startName || sp.endName || '').replace(/역$/, '')
          const fromLane = _normalizeLane(prevSP.lane)
          const toLane   = _normalizeLane(nextSP.lane)
          const fromLine = String(fromLane?.subwayCode || '')
          const toLine   = String(toLane?.subwayCode   || '')
          const key = `${stationName}_${fromLine}_${toLine}`
          transferOverride = TRANSFER_WALK[key] ?? null
        }

        t = transferOverride !== null
          ? transferOverride
          : (baseMin / mult) + sigWait

        seg = {
          type:'walk', icon:'🚶',
          label: isTransfer ? '환승 통로' : '도보',
          time: Math.round(t),
          distance: sp.distance,
          sigCount, sigWait: Math.round(sigWait),
          slopePct, isTransfer, transferOverride,
          startX:sp.startX, startY:sp.startY,
          endX:sp.endX, endY:sp.endY,
          passCoords: sp.passCoords,
        }
        prevWalkMin = t

      } else if (sp.trafficType === 1) {
        // ── 지하철 ───────────────────────────────────────────────────────
        const arrivals    = subwayArrMap.get(sp.startName) || []
        const crowd       = congestion.find(c => c.stationName?.includes(sp.startName))
        const crowdIsReal = !!crowd
        const level       = crowd ? crowdLevel(crowd.crowdLevel) : _timeBasedCrowdLevel(nowMin)

        const nextTrainMins = arrivals[0] ? Math.ceil(arrivals[0].barvlDt / 60) : null
        const nextNextMins  = arrivals[1] ? Math.ceil(arrivals[1].barvlDt / 60) : null

        // 열차 놓치는지 판정
        const willMiss = nextTrainMins !== null && prevWalkMin > nextTrainMins + MISS_TRAIN_THRESHOLD

        let waitMin
        if (willMiss && nextNextMins)
          waitMin = Math.max(nextNextMins - Math.round(prevWalkMin), 1)
        else if (willMiss)
          waitMin = Math.min(nextTrainMins + 4, SUBWAY_MISS_FALLBACK)
        else
          waitMin = arrivals[0] ? Math.min(Math.ceil(arrivals[0].barvlDt / 60), SUBWAY_WAIT_CAP_MIN) : 3

        // 최적 탑승 칸 (이 지하철을 타고 내릴 역에서 다음 지하철로 환승하는 경우)
        const nextSubSP = route.subPaths.slice(spIdx + 1).find(s => s.trafficType === 1)
        let optimalCar = null
        if (nextSubSP) {
          const nextLane   = _normalizeLane(nextSubSP.lane)
          const endStation = (sp.endName || '').replace(/역$/, '') + '역'
          const curLine    = String(lane?.subwayCode || '')
          const nextLine   = String(nextLane?.subwayCode || '')
          const carKey     = `${endStation}_${curLine}_${nextLine}`
          optimalCar = OPTIMAL_CAR[carKey] ?? null
        }

        t = sp.sectionTime + CROWD_BUFFER[level] * sp.stationCount + waitMin
        seg = {
          type:'subway', icon:'🚇',
          label: lane?.name || '지하철',
          time: Math.round(t),
          startName: sp.startName, endName: sp.endName,
          stationCount: sp.stationCount,
          level, crowdLabel:CROWD_LABEL[level], crowdEmoji:CROWD_EMOJI[level],
          crowdIsReal,
          waitMin, nextTrain:nextTrainMins, nextNextTrain:nextNextMins,
          willMiss, optimalCar,
          startX:sp.startX, startY:sp.startY,
          endX:sp.endX, endY:sp.endY,
          passCoords: sp.passCoords, lane,
        }
        prevWalkMin = 0  // 탑승 후 리셋

      } else if (sp.trafficType === 2) {
        // ── 버스 ─────────────────────────────────────────────────────────
        const arrivals = busArrMap.get(lane?.arsId) || []
        const waitMin  = Math.min(arrivals[0]?.predictTime1 ?? BUS_WAIT_DEFAULT_MIN, BUS_WAIT_CAP_MIN)
        const carLoad  = arrivals[0]?.carLoad1 || 0
        const avgSpeed = (sp.distance && sp.sectionTime)
          ? Math.round((sp.distance / 1000) / (sp.sectionTime / 60) * 10) / 10
          : null

        t = sp.sectionTime + waitMin
        seg = {
          type:'bus', icon:'🚌',
          label: lane?.busNo || '버스',
          time: Math.round(t),
          startName: sp.startName, endName: sp.endName,
          stationCount: sp.stationCount,
          arrmsg: arrivals[0]?.arrmsg1 || '정보없음',
          waitMin, carLoad,
          crowdLabel: BUS_CROWD_LABEL[carLoad],
          crowdEmoji: BUS_CROWD_EMOJI[carLoad],
          avgSpeed,
          startX:sp.startX, startY:sp.startY,
          endX:sp.endX, endY:sp.endY,
          passCoords: sp.passCoords,
        }
        prevWalkMin = 0
      }

      total += t
      segs.push(seg)
    }

    const margin  = available - Math.round(total)
    const verdict = _verdictByMargin(margin)
    return {
      index: routeIdx + 1,
      estimated: Math.round(total),
      available, margin, verdict,
      transferCount: route.transferCount,
      segments: segs,
    }
  })

  analyzed.sort((a, b) => a.estimated - b.estimated)
  return { available, routes:analyzed, best:analyzed[0], verdict:analyzed[0]?.verdict }
}

const VERDICT = {
  ok:    { emoji:'😎', label:'커피 한 잔 사들고\n가도 안 늦어요!',       color:'#0d5c2a', bg:'#C3FFCC', cls:'ok'    },
  hurry: { emoji:'😬', label:'유튜브 끄고\n빨리 걸어요!!',              color:'#4a3a00', bg:'#FFF9B0', cls:'hurry' },
  run:   { emoji:'🏃', label:'당장 뛰어요\n안 뛰면 지각!!',             color:'#5c2200', bg:'#FFCBA4', cls:'run'   },
  late:  { emoji:'😱', label:'이미 늦었습니다.\n포기하면 편해요ㅜㅜ',   color:'#f0f0f0', bg:'#1e1e28', cls:'late'  },
}
