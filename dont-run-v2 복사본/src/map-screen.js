// map-screen.js — Kakao Maps 전체 화면 + 경로 오버레이 + 경사도 레이어 + GPS 추적
// session.js (_session / state / $ / _esc / _hasValidCoord)
// + verdict-render.js (renderVerdict / showError) 에 의존.
// 제거된 죽은 코드: _mapFullMode, _fullTileLayer, _haversineM.

let _mapInst        = null
let _mapOverlays    = []
let _mapPolylines   = []
let _slopePolylines = []
let _activeSlopeId  = null
let _myLocOverlay   = null
let sheetCollapsed  = false

function formatTime12(t) {
  if (!t) return '--'
  const [h, m] = t.split(':').map(Number)
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(m).padStart(2, '0')}`
}
function formatRemain(totalMin) {
  const abs = Math.abs(totalMin)
  const h = Math.floor(abs / 60), m = abs % 60
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`
}

function _loadKakaoSDK() {
  return new Promise((resolve, reject) => {
    if (window.kakao?.maps?.Map) { resolve(); return }
    if (window.kakao?.maps) { window.kakao.maps.load(resolve); return }
    const s = document.createElement('script')
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${CONFIG.KAKAO_MAP_API_KEY}&libraries=services&autoload=false`
    s.onload = () => {
      if (!window.kakao?.maps) { reject(new Error('카카오맵 앱 키 오류')); return }
      window.kakao.maps.load(resolve)
    }
    s.onerror = () => reject(new Error('카카오맵 SDK 로드 실패'))
    setTimeout(() => reject(new Error('카카오맵 로드 타임아웃')), 12000)
    document.head.appendChild(s)
  })
}

function _initMap() {
  const container = document.getElementById('map-full')
  if (!container) return

  container.removeAttribute('style')
  if (container._leaflet_id) { try { delete container._leaflet_id } catch(e) {} }
  if (_mapInst) {
    const w = window.innerWidth
    const h = window.innerHeight
    container.style.width  = w + 'px'
    container.style.height = h + 'px'
    try { _mapInst.relayout() } catch(e) {}
    _renderMapOverlays()
    return
  }

  const lat = state.start?.y || 37.5665
  const lng = state.start?.x || 126.978

  const _create = () => {
    const w = window.innerWidth
    const h = window.innerHeight
    container.style.cssText = `width:${w}px;height:${h}px;`

    try {
      _mapInst = new kakao.maps.Map(container, {
        center: new kakao.maps.LatLng(lat, lng),
        level: 5,
      })
      container.removeAttribute('style')
      setTimeout(_renderMapOverlays, 100)
    } catch(e) {
      console.error('[Map] Kakao init failed:', e)
    }
  }

  if (window.kakao?.maps?.Map) _create()
  else _loadKakaoSDK().then(_create).catch(e => console.error('[Map] SDK load failed:', e))
}

function openMapScreen() {
  const routes = _session.routes
  if (!routes?.length) return
  if (!_hasValidCoord(state.start) || !_hasValidCoord(state.end)) {
    showError('출발지와 도착지 좌표가 유효하지 않아요.')
    return
  }

  _session.mapRouteIdx = 0

  $('mf-goal-time').textContent  = formatTime12($('goal-time').value)
  $('mf-start-name').textContent = state.start?.name || '출발지'
  $('mf-end-name').textContent   = state.end?.name   || '도착지'

  _updateMapInfoCard(0)

  const wrap   = $('mf-route-tabs-wrap')
  const tabsEl = $('mf-route-tabs')
  if (routes.length > 1) {
    tabsEl.innerHTML = routes.map((r, i) =>
      `<button class="mf-pill ${i===0?'active':''}" onclick="switchMapRoute(${i})">경로 ${i+1} · ${_esc(r.estimated)}분</button>`
    ).join('')
    wrap.style.display = ''
  } else {
    wrap.style.display = 'none'
  }

  sheetCollapsed = false
  $('mf-sheet').classList.remove('collapsed')
  $('mf-collapse-btn').textContent = '▼ 접기'

  _session.currentSegIdx = 0
  _renderSegPanel(routes[0])

  document.querySelectorAll('.ob-screen').forEach(el => el.classList.remove('active'))
  $('screen-map').classList.add('active')

  requestAnimationFrame(() => requestAnimationFrame(() => {
    _initMap()
    _startGpsTracking()
  }))
}

function closeMapScreen() {
  _stopGpsTracking()
  document.querySelectorAll('.ob-screen').forEach(el => el.classList.remove('active'))
  $('screen-main').classList.add('active')
}

function _updateMapInfoCard(idx) {
  const r = _session.routes[idx] ?? _session.routes[0]
  if (!r) return
  $('mf-remain').textContent = formatRemain(r.margin)
  const badge = $('mf-verdict-badge')
  badge.className = `mf-verdict-badge ${r.verdict}`
  badge.textContent = { ok:'여유', hurry:'서둘러', run:'빨리', late:'지각' }[r.verdict] || '여유'
  $('mf-remain').style.color = r.verdict==='ok'?'#1a6b36':r.verdict==='hurry'?'#7a5e00':r.verdict==='run'?'#9c3a00':'#c0392b'

  const firstWalk    = r.segments[0]?.type === 'walk' ? r.segments[0] : null
  const firstTransit = r.segments.find(s => s.type==='subway'||s.type==='bus')
  if (firstTransit) {
    $('mf-next-icon').textContent  = firstTransit.type==='subway' ? '' : ''
    $('mf-next-title').textContent = `${firstTransit.startName} 탑승`
    $('mf-next-sub').textContent   = firstWalk
      ? `${firstWalk.distance}m 도보 후 탑승 · 약 ${firstWalk.time}분`
      : `다음 열차 ${firstTransit.waitMin}분 후 도착`
  } else if (firstWalk) {
    $('mf-next-icon').textContent  = ''
    $('mf-next-title').textContent = state.end?.name || '도착지'
    $('mf-next-sub').textContent   = `${firstWalk.distance}m 도보 · 약 ${firstWalk.time}분`
  }
}

function switchMapRoute(i) {
  if (!_session.routes[i]) return
  _session.mapRouteIdx = i
  document.querySelectorAll('#mf-route-tabs .mf-pill').forEach((btn, j) => btn.classList.toggle('active', i===j))
  _session.currentSegIdx = 0
  _updateMapInfoCard(i)
  _renderMapOverlays()
  _renderSegPanel(_session.routes[i])
}

// ── 오버레이 렌더 ─────────────────────────────────────────────────────
async function _renderMapOverlays() {
  if (!_mapInst) return
  _mapOverlays.forEach(o  => { try { o.setMap(null) } catch(e) {} })
  _mapPolylines.forEach(p => { try { p.setMap(null) } catch(e) {} })
  _mapOverlays  = []
  _mapPolylines = []

  const best   = _session.routes[_session.mapRouteIdx] ?? _session.routes[0]
  const bounds = new kakao.maps.LatLngBounds()
  let   hasPts = false

  if (state.start) {
    const pos = new kakao.maps.LatLng(state.start.y, state.start.x)
    const m   = _pinMarker(pos, state.start.name || '출발', '#16a34a')
    if (m) _mapOverlays.push(m)
    bounds.extend(pos); hasPts = true
  }
  if (state.end) {
    const pos = new kakao.maps.LatLng(state.end.y, state.end.x)
    const m   = _pinMarker(pos, state.end.name || '도착', '#dc2626')
    if (m) _mapOverlays.push(m)
    bounds.extend(pos); hasPts = true
  }
  _showMyLoc()

  if (best?.segments?.length) {
    await _drawRoutePolys(best.segments, bounds)
    hasPts = true
  } else if (state.start && state.end && hasPts) {
    const s = new kakao.maps.LatLng(state.start.y, state.start.x)
    const e = new kakao.maps.LatLng(state.end.y,   state.end.x)
    const p = new kakao.maps.Polyline({ path:[s,e], strokeColor:'#888', strokeWeight:3, strokeOpacity:0.6 })
    p.setMap(_mapInst); _mapPolylines.push(p)
    try { _mapInst.setBounds(bounds, 80, 80, 80, 80) } catch(z) {}
  }
}

function _pinMarker(position, label, color) {
  if (!window.kakao?.maps?.CustomOverlay) return null
  const safeLabel = _esc(label)
  const safeColor = _esc(color)
  const content = [
    `<div style="text-align:center;pointer-events:none;transform:translateX(-50%)">`,
    `<span style="display:inline-block;background:${safeColor};color:#fff;padding:4px 10px;`,
    `border-radius:20px;font-size:12px;font-weight:700;white-space:nowrap;`,
    `box-shadow:0 2px 8px rgba(0,0,0,.3);font-family:sans-serif;line-height:1.4;">${safeLabel}</span>`,
    `<div style="width:3px;height:8px;background:${safeColor};margin:0 auto;"></div>`,
    `<div style="width:10px;height:10px;border-radius:50%;background:${safeColor};`,
    `border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3);margin:0 auto;"></div>`,
    `</div>`,
  ].join('')
  return new kakao.maps.CustomOverlay({ position, content, xAnchor:0, yAnchor:1, map:_mapInst })
}

function _showMyLoc() {
  if (!navigator.geolocation || !_mapInst) return
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng } = pos.coords
      if (_myLocOverlay) { try { _myLocOverlay.setMap(null) } catch(e) {} _myLocOverlay = null }
      if (!window.kakao?.maps?.CustomOverlay) return
      _myLocOverlay = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(lat, lng),
        content: `<div style="width:18px;height:18px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 4px rgba(37,99,235,.25);transform:translate(-50%,-50%)"></div>`,
        xAnchor: 0, yAnchor: 0, map: _mapInst,
      })
    },
    () => {},
    { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 }
  )
}

function _subwayColor(code) {
  const MAP = {
    '1':'#0052a4','2':'#00a84d','3':'#ef7c1c','4':'#00a5de',
    '5':'#996cac','6':'#cd7c2f','7':'#747f00','8':'#e6186c',
    '9':'#bdb092','A':'#569bbd','B':'#f5a200','K':'#71c8b2',
  }
  return MAP[code] || '#3498db'
}

async function _drawRoutePolys(segments, bounds) {
  const _ll = (lat, lng) => new kakao.maps.LatLng(lat, lng)

  for (const seg of segments) {
    const sx = +seg.startX, sy = +seg.startY, ex = +seg.endX, ey = +seg.endY
    if (!sx || !sy || !ex || !ey) continue

    let path
    if (seg.type === 'walk') {
      if (Math.abs(sx-ex)<1e-6 && Math.abs(sy-ey)<1e-6) continue
      let pts = []
      if (seg._walkPts && seg._walkPts.length >= 3) {
        pts = seg._walkPts
      } else {
        try { pts = await getWalkRoute(sx, sy, ex, ey) } catch(e) {}
        if (pts.length < 3) {
          const pc = (seg.passCoords||[]).filter(c=>c.x&&c.y)
          if (pc.length >= 3) pts = pc
        }
        if (pts.length >= 3) seg._walkPts = pts
        else pts = [{x:sx,y:sy},{x:ex,y:ey}]
      }
      path = pts.map(p => _ll(p.y, p.x))
    } else {
      // 지하철: 실제 노선 GeoJSON 에서 역 구간 slice 우선 시도
      let mid = null
      if (seg.type === 'subway' && typeof window.getSubwayPathCoords === 'function') {
        try {
          const geomPts = await window.getSubwayPathCoords(seg)
          if (geomPts && geomPts.length >= 2) mid = geomPts
        } catch (e) { /* ignore, fallback below */ }
      }
      if (!mid) mid = (seg.passCoords||[]).filter(c=>+c.x&&+c.y)
      if (mid.length >= 1) {
        path = [_ll(sy,sx), ...mid.map(c=>_ll(+c.y,+c.x)), _ll(ey,ex)]
      } else {
        path = [_ll(sy,sx), _ll(ey,ex)]
      }
    }

    const color  = seg.type==='subway' ? _subwayColor(seg.lane?.subwayCode)
                 : seg.type==='bus'    ? '#e67e22' : '#3498db'
    const weight = seg.type==='subway' ? 6 : seg.type==='bus' ? 5 : 4

    const poly = new kakao.maps.Polyline({ path, strokeColor:color, strokeWeight:weight, strokeOpacity:0.85 })
    poly.setMap(_mapInst)
    _mapPolylines.push(poly)
    path.forEach(p => bounds.extend(p))
  }

  if (_mapPolylines.length === 0 && state.start && state.end) {
    const s = _ll(state.start.y, state.start.x)
    const e = _ll(state.end.y, state.end.x)
    const p = new kakao.maps.Polyline({ path:[s,e], strokeColor:'#888', strokeWeight:3, strokeOpacity:0.6 })
    p.setMap(_mapInst); _mapPolylines.push(p)
    bounds.extend(s); bounds.extend(e)
  }
  try { _mapInst.setBounds(bounds, 80, 80, 80, 80) } catch(e) {}
}

// ── 경사도 레이어 ─────────────────────────────────────────────────────
function _slopeColor(pct) {
  if (pct >  8) return '#ef4444'
  if (pct >  2) return '#f97316'
  if (pct > -2) return '#eab308'
  return '#3b82f6'
}

function clearSlopeLayer() {
  _slopePolylines.forEach(p => { try { p.setMap?.(null) } catch(e) {} })
  _slopePolylines = []
  _activeSlopeId  = null
}

function _drawSlopePolys(walkPts, elevs) {
  if (!_mapInst) return
  for (let i = 0; i < walkPts.length - 1; i++) {
    const p0=walkPts[i],p1=walkPts[i+1],e0=elevs[i]??0,e1=elevs[i+1]??0
    const dlat=(p1.y-p0.y)*111320,dlng=(p1.x-p0.x)*111320*Math.cos(+p0.y*Math.PI/180)
    const dDist=Math.sqrt(dlat*dlat+dlng*dlng)
    const slopePct=dDist>2?((e1-e0)/dDist)*100:0
    const poly=new kakao.maps.Polyline({
      path:[new kakao.maps.LatLng(+p0.y,+p0.x),new kakao.maps.LatLng(+p1.y,+p1.x)],
      strokeColor:_slopeColor(slopePct),strokeWeight:7,strokeOpacity:0.95,
    })
    poly.setMap(_mapInst)
    _slopePolylines.push(poly)
  }
}

function _buildElevChart(walkPts, elevs) {
  const W=280,H=76,PAD={t:6,r:8,b:20,l:32},iW=W-PAD.l-PAD.r,iH=H-PAD.t-PAD.b
  const dists=[0]
  for(let i=1;i<walkPts.length;i++){
    const dlat=(walkPts[i].y-walkPts[i-1].y)*111320
    const dlng=(walkPts[i].x-walkPts[i-1].x)*111320*Math.cos(+walkPts[i-1].y*Math.PI/180)
    dists.push(dists[i-1]+Math.sqrt(dlat*dlat+dlng*dlng))
  }
  const totalDist=dists[dists.length-1]||1
  const minElev=Math.min(...elevs),maxElev=Math.max(...elevs),elevRange=(maxElev-minElev)||1
  const sx=d=>PAD.l+(d/totalDist)*iW,sy=e=>PAD.t+iH-((e-minElev)/elevRange)*iH
  let lines=''
  for(let i=0;i<walkPts.length-1;i++){
    const dE=elevs[i+1]-elevs[i],dD=dists[i+1]-dists[i]
    const pct=dD>2?(dE/dD)*100:0
    lines+=`<line x1="${sx(dists[i]).toFixed(1)}" y1="${sy(elevs[i]).toFixed(1)}" x2="${sx(dists[i+1]).toFixed(1)}" y2="${sy(elevs[i+1]).toFixed(1)}" stroke="${_slopeColor(pct)}" stroke-width="2.5" stroke-linecap="round"/>`
  }
  const fill=walkPts.map((_,i)=>`${sx(dists[i]).toFixed(1)},${sy(elevs[i]).toFixed(1)}`).join(' ')
    +` ${sx(totalDist).toFixed(1)},${(PAD.t+iH).toFixed(1)} ${PAD.l},${(PAD.t+iH).toFixed(1)}`
  const elevDiff=maxElev-minElev
  const distLabel=totalDist>=1000?`${(totalDist/1000).toFixed(1)}km`:`${Math.round(totalDist)}m`
  return `
  <div class="elev-legend">
    <span style="color:#ef4444">— 급경사</span><span style="color:#f97316">— 완경사</span>
    <span style="color:#eab308">— 평지</span><span style="color:#3b82f6">— 내리막</span>
  </div>
  <svg width="100%" viewBox="0 0 ${W} ${H}" class="elev-svg">
    <polyline points="${fill}" fill="rgba(255,255,255,0.05)" stroke="none"/>
    ${lines}
    <line x1="${PAD.l}" y1="${(PAD.t+iH).toFixed(1)}" x2="${(W-PAD.r).toFixed(1)}" y2="${(PAD.t+iH).toFixed(1)}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
    <text x="${(PAD.l-3).toFixed(1)}" y="${(PAD.t+4).toFixed(1)}" text-anchor="end" font-size="9" fill="rgba(255,255,255,0.45)">${Math.round(maxElev)}m</text>
    <text x="${(PAD.l-3).toFixed(1)}" y="${(PAD.t+iH+1).toFixed(1)}" text-anchor="end" font-size="9" fill="rgba(255,255,255,0.45)">${Math.round(minElev)}m</text>
    <text x="${(W/2).toFixed(1)}" y="${(H-2).toFixed(1)}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.35)">${_esc(distLabel)} · 고도차 ${elevDiff>=0?'+':''}${Math.round(elevDiff)}m</text>
  </svg>`
}

async function toggleSlopeView(btn, segIdx) {
  const seg   = _session.tabSegs[segIdx]
  const chart = document.getElementById(`elev-${segIdx}`)
  if (!seg || !chart) return
  if (_activeSlopeId === segIdx) {
    clearSlopeLayer(); chart.innerHTML = ''; chart.classList.remove('visible'); btn.classList.remove('active'); return
  }
  if (_activeSlopeId !== null) {
    const prev = document.getElementById(`elev-${_activeSlopeId}`)
    if (prev) { prev.innerHTML=''; prev.classList.remove('visible') }
    document.querySelectorAll('.slope-btn.active').forEach(b => b.classList.remove('active'))
  }
  clearSlopeLayer(); _activeSlopeId = segIdx; btn.classList.add('active')
  chart.innerHTML = '<div class="elev-loading">고도 데이터 불러오는 중...</div>'
  chart.classList.add('visible')
  try {
    let walkPts = (seg._walkPts && seg._walkPts.length > 2) ? seg._walkPts : []
    if (walkPts.length < 3) walkPts = await getWalkRoute(+seg.startX, +seg.startY, +seg.endX, +seg.endY).catch(() => [])
    if (walkPts.length > 2) seg._walkPts = walkPts
    if (walkPts.length<2) walkPts=[{x:+seg.startX,y:+seg.startY},{x:+seg.endX,y:+seg.endY}]
    const elevs=await getElevations(walkPts.map(p=>({lat:+p.y,lng:+p.x}))).catch(()=>walkPts.map(()=>0))
    _drawSlopePolys(walkPts,elevs)
    const fallbackTag = walkPts.length<=2 ? ' (직선 폴백)' : ''
    chart.innerHTML=`<div style="font-size:.7rem;color:rgba(255,255,255,.35);margin-bottom:2px">경로점 ${walkPts.length}개${fallbackTag}</div>`+_buildElevChart(walkPts,elevs)
  } catch(e) {
    chart.innerHTML='<div class="elev-loading" style="color:#f87171">고도 데이터 조회 실패</div>'
  }
}

function setMapTheme(btn, theme) {
  btn.closest('.mf-pills').querySelectorAll('.mf-pill').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  clearSlopeLayer()
  const legend = $('mf-slope-legend')
  if (legend) legend.style.display = 'none'
  if (!_mapInst) return
  if (theme==='crowd')  _mapInst.setMapTypeId(kakao.maps.MapTypeId.HYBRID)
  else if (theme==='slope') { _mapInst.setMapTypeId(kakao.maps.MapTypeId.ROADMAP); _drawAllSlopePolys() }
  else                   _mapInst.setMapTypeId(kakao.maps.MapTypeId.ROADMAP)
}

async function _drawAllSlopePolys() {
  const route = _session.routes[_session.mapRouteIdx] ?? _session.routes[0]
  if (!route?.segments?.length) return
  const legend = $('mf-slope-legend')
  if (legend) legend.style.display = ''
  const walkSegs = route.segments.filter(s =>
    s.type==='walk' && (Math.abs(+s.startX-+s.endX)>1e-6 || Math.abs(+s.startY-+s.endY)>1e-6)
  )
  for (const seg of walkSegs) {
    let pts = (seg._walkPts && seg._walkPts.length > 2) ? seg._walkPts : []
    if (pts.length < 3) { try { pts = await getWalkRoute(+seg.startX, +seg.startY, +seg.endX, +seg.endY) } catch(e) {} }
    if (pts.length > 2) seg._walkPts = pts
    if (pts.length < 2) pts = [{x:+seg.startX,y:+seg.startY},{x:+seg.endX,y:+seg.endY}]
    const elevs=await getElevations(pts.map(p=>({lat:+p.y,lng:+p.x}))).catch(()=>pts.map(()=>0))
    _drawSlopePolys(pts, elevs)
  }
}

function setPreset(btn, type) {
  btn.closest('.mf-pills').querySelectorAll('.mf-pill').forEach(b => b.classList.remove('active'))
  btn.classList.add('active')
  const all = _session.routesAll
  if (!all?.length) return
  _session.routes = type==='transfer'
    ? all.slice().sort((a,b)=>a.transferCount-b.transferCount||a.estimated-b.estimated)
    : all.slice()
  renderVerdict(_session.routes[0], _session.isFallback)
  const tabsEl=$('mf-route-tabs')
  if(tabsEl) tabsEl.innerHTML=_session.routes.map((r,i)=>
    `<button class="mf-pill ${i===0?'active':''}" onclick="switchMapRoute(${i})">경로 ${i+1} · ${_esc(r.estimated)}분</button>`
  ).join('')
  _session.currentSegIdx=0
  _renderSegPanel(_session.routes[0])
  _updateMapInfoCard(0)
  _session.mapRouteIdx=0
}

function toggleSheet() {
  sheetCollapsed = !sheetCollapsed
  $('mf-sheet').classList.toggle('collapsed', sheetCollapsed)
  $('mf-collapse-btn').textContent = sheetCollapsed ? '▲ 펼치기' : '▼ 접기'
}

// ── 세그먼트 패널 ─────────────────────────────────────────────────────
function _renderSegPanel(route) {
  const panel = $('mf-seg-panel')
  if (!panel) return
  panel.innerHTML = route.segments.map(s => {
    let sub = ''
    if(s.type==='walk')   sub=`${_esc(s.distance)}m · ${_esc(s.time)}분`
    if(s.type==='subway') sub=`${_esc(s.startName)} → ${_esc(s.endName)}`
    if(s.type==='bus')    sub=`${_esc(s.startName)} → ${_esc(s.endName)}`
    const label = s.type==='bus' ? _esc(s.label)+'번' : _esc(s.label)
    return `<div class="mf-sp-item ${_esc(s.type)}">
      <span class="mf-sp-icon">${_esc(s.icon)}</span>
      <div class="mf-sp-body">
        <div class="mf-sp-name">${label}</div>
        <div class="mf-sp-sub">${sub}</div>
      </div>
      <span class="mf-sp-time">${_esc(s.time)}분</span>
    </div>`
  }).join('')
  panel.classList.remove('hidden')
}

// ── GPS 추적 ──────────────────────────────────────────────────────────
let _gpsWatchId = null

function _startGpsTracking() {
  if (!navigator.geolocation) return
  _stopGpsTracking()
  _gpsWatchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude: lat, longitude: lng } = pos.coords
      if (!_mapInst) return
      if (_myLocOverlay) { try { _myLocOverlay.setMap(null) } catch(e) {} }
      _myLocOverlay = new kakao.maps.CustomOverlay({
        position: new kakao.maps.LatLng(lat, lng),
        content: `<div style="width:18px;height:18px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 4px rgba(37,99,235,.25);transform:translate(-50%,-50%)"></div>`,
        xAnchor:0, yAnchor:0, map:_mapInst,
      })
    },
    () => {},
    { enableHighAccuracy:true, timeout:10000, maximumAge:3000 }
  )
}

function _stopGpsTracking() {
  if (_gpsWatchId !== null) { navigator.geolocation.clearWatch(_gpsWatchId); _gpsWatchId = null }
}
