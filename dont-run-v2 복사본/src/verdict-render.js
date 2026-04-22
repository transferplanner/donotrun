// verdict-render.js — 결과 판정 화면(vc3) + 경로 카드 + 구간 렌더 + 에러 화면
// session.js (_session / state / $ / _esc) + engine.js (VERDICT) 에 의존.

// ── 카운트다운 ────────────────────────────────────────────────────────
function _stopCountdown() {
  if (_session.countdownInterval) {
    clearInterval(_session.countdownInterval)
    _session.countdownInterval = null
  }
}

function _startCountdown(goalTimeStr) {
  _stopCountdown()
  const pad = n => String(n).padStart(2, '0')
  const tick = () => {
    const el = document.getElementById('vc3-countdown')
    if (!el) { _stopCountdown(); return }
    const now = new Date()
    const [gh, gm] = (goalTimeStr || '00:00').split(':').map(Number)
    const goal = new Date(); goal.setHours(gh, gm, 0, 0)
    if (goal <= now) goal.setDate(goal.getDate() + 1)
    const diff = Math.max(0, Math.floor((goal - now) / 1000))
    el.textContent = `${pad(Math.floor(diff/3600))}:${pad(Math.floor(diff%3600/60))}:${pad(diff%60)}`
  }
  tick()
  _session.countdownInterval = setInterval(tick, 1000)
}

function _verdictVideo(verdict) {
  if (verdict === 'ok')    return 'assets/walk.mp4'
  if (verdict === 'hurry') return 'assets/powerwalk.mp4'
  if (verdict === 'run')   return 'assets/run.mp4'
  return 'assets/late.mp4'
}

// ── 판정 카드 ─────────────────────────────────────────────────────────
function renderVerdict(route, isFallback) {
  const v        = VERDICT[route.verdict] ?? VERDICT.ok
  const nowTime  = $('now-time').value  || '--:--'
  const goalTime = $('goal-time').value || '--:--'
  const noticeTpl = isFallback === true
    ? `<div class="vc3-notice warn">실시간 API 연결 실패 — 직선거리 기반 추정값</div>`
    : isFallback === false
    ? `<div class="vc3-notice live">실시간 데이터 연동됨</div>` : ''

  const endName   = _esc(state.end?.name ?? '도착지')
  const cls       = _esc(v.cls)
  const label     = _esc(v.label)
  const videoSrc  = _esc(_verdictVideo(route.verdict))
  const vNow      = _esc(nowTime)
  const vGoal     = _esc(goalTime)

  $('verdict-wrap').innerHTML = `
    <div class="vc3 ${cls}">
      ${noticeTpl}
      <div class="vc3-crumb">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        <span>${endName}</span>
      </div>
      <div class="vc3-circle-wrap">
        <div class="vc3-circle">
          <div class="vc3-char-ring">
            <video src="${videoSrc}" autoplay loop muted playsinline></video>
          </div>
        </div>
      </div>
      <p class="vc3-msg">${label}</p>
      <div class="vc3-timer-wrap">
        <span class="vc3-timer-label">TIME REMAINING</span>
        <div class="vc3-timer" id="vc3-countdown">--:--:--</div>
      </div>
      <div class="vc3-times">
        <div class="vc3-tc"><span class="vc3-tk">출발</span><span class="vc3-tv">${vNow}</span></div>
        <div class="vc3-tsep"></div>
        <div class="vc3-tc"><span class="vc3-tk">마감</span><span class="vc3-tv">${vGoal}</span></div>
      </div>
      <div class="vc3-actions">
        <button class="vc3-btn-sec" onclick="goStep(1)">메인</button>
        <button class="vc3-btn-pri" onclick="openMapScreen()">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          지도 보기
        </button>
      </div>
    </div>`
  $('verdict-wrap').classList.remove('hidden')
  $('screen-main').dataset.verdict = v.cls
  _startCountdown(goalTime)
}

// ── 경로 탭 + 카드 ─────────────────────────────────────────────────────
function renderResult(routes) {
  _session.routesAll = routes.slice()
  _session.routes    = routes
  $('result').innerHTML = `<div id="tab-content"></div>`
  renderTabContent(0)
  $('result').classList.remove('hidden')
}

function switchTab(i) {
  document.querySelectorAll('.route-tab').forEach((b, j) => b.classList.toggle('active', i === j))
  clearSlopeLayer()
  const route = _session.routes[i]
  if (!route) return
  renderVerdict(route, _session.isFallback)
  renderTabContent(i)
}

function renderTabContent(i) {
  clearSlopeLayer()
  const r = _session.routes[i]
  if (!r) return
  const v = VERDICT[r.verdict] ?? VERDICT.ok
  _session.tabSegs = r.segments

  // 도보 경로 미리 캐시
  setTimeout(() => {
    r.segments.forEach(s => {
      if (s.type !== 'walk') return
      const sx = +s.startX, sy = +s.startY, ex = +s.endX, ey = +s.endY
      if (!sx || !sy || !ex || !ey || (Math.abs(sx-ex)<1e-6 && Math.abs(sy-ey)<1e-6)) return
      getWalkRoute(sx, sy, ex, ey).then(pts => { if (pts.length > 2) s._walkPts = pts }).catch(()=>{})
    })
  }, 500)

  const safeColor = _esc(v.color)
  const marginLabel = r.margin >= 0 ? '여유' : '부족'

  $('tab-content').innerHTML = `
    <div class="route-card">
      <div class="route-summary">
        <div class="rs-item"><span class="rs-val">${r.estimated}<small>분</small></span><span class="rs-key">예상 소요</span></div>
        <div class="rs-item"><span class="rs-val">${r.available}<small>분</small></span><span class="rs-key">가능 시간</span></div>
        <div class="rs-item"><span class="rs-val" style="color:${safeColor}">${Math.abs(r.margin)}<small>분</small></span><span class="rs-key">${marginLabel}</span></div>
        <div class="rs-item"><span class="rs-val">${r.transferCount}</span><span class="rs-key">환승</span></div>
      </div>
      <div class="segments">
        ${r.segments.map((s, idx) => renderSeg(s, idx)).join('')}
      </div>
    </div>`
}

function renderSeg(s, segIdx = 0) {
  const icon = _esc(s.icon)
  const time = Number(s.time) || 0

  if (s.type === 'walk') {
    const slopeTag = Math.abs(s.slopePct||0) > 2
      ? `<span class="seg-badge ${s.slopePct>0?'slope-up':'slope-dn'} slope-btn" onclick="toggleSlopeView(this,${segIdx})">
           ${s.slopePct>0?'▲':'▼'} 경사 ${_esc(Math.abs(s.slopePct).toFixed(1))}%</span>` : ''
    const transferTag = s.isTransfer
      ? `<span class="seg-badge seg-badge--transfer">환승 통로${s.transferOverride?' ('+_esc(s.transferOverride)+'분)':''}</span>` : ''
    return `
    <div class="seg walk">
      <div class="seg-top">
        <span>${icon}</span>
        <span class="seg-name">${_esc(s.label)}</span>
        ${slopeTag}${transferTag}
        <span class="seg-time">${time}분</span>
      </div>
      <div class="seg-sub">${_esc(s.distance)}m · 신호 약 ${_esc(s.sigCount)}개 · 대기 약 ${_esc(s.sigWait)}분</div>
      <div class="elev-chart" id="elev-${segIdx}"></div>
    </div>`
  }

  if (s.type === 'subway') {
    const nextMiss = s.nextNextTrain != null ? s.nextNextTrain : (Number(s.nextTrain)||0)+4
    const missBlock = s.willMiss
      ? `<div class="seg-warn">이 속도로는 현재 열차 놓침 → 다음 열차 ${_esc(nextMiss)}분 후</div>` : ''
    const carBlock = s.optimalCar
      ? `<div class="seg-car">최적 탑승 위치: ${_esc(s.optimalCar.side)} — ${_esc(s.optimalCar.desc)}</div>` : ''
    const badge = s.crowdEmoji
      ? `<span class="badge ${_esc(s.level)}">${_esc(s.crowdEmoji)} ${_esc(s.crowdLabel)}</span>` : ''
    const nextTrainFrag = s.nextTrain ? ` · 다음 <b>${_esc(s.nextTrain)}분 후</b>` : ''
    return `
    <div class="seg subway${s.willMiss?' miss-train':''}">
      <div class="seg-top">
        <span>${icon}</span>
        <span class="seg-name">${_esc(s.label)}</span>
        <span class="seg-time">${time}분</span>
      </div>
      ${missBlock}
      <div class="seg-sub">${_esc(s.startName)} → ${_esc(s.endName)} · ${_esc(s.stationCount)}정거장</div>
      <div class="seg-sub">${badge}${badge?' · ':''}대기 ${_esc(s.waitMin)}분${nextTrainFrag}</div>
      ${carBlock}
    </div>`
  }

  if (s.type === 'bus') {
    const crowdBadge = s.carLoad > 0
      ? `<span class="badge ${s.carLoad>=3?'high':s.carLoad>=2?'medium':'low'}">${_esc(s.crowdEmoji||'')} ${_esc(s.crowdLabel||'')}</span>` : ''
    return `
    <div class="seg bus">
      <div class="seg-top">
        <span>${icon}</span>
        <span class="seg-name">${_esc(s.label)}번</span>
        <span class="seg-time">${time}분</span>
      </div>
      <div class="seg-sub">${_esc(s.startName)} → ${_esc(s.endName)} · ${_esc(s.stationCount)}정거장</div>
      <div class="seg-sub">${_esc(s.arrmsg)}${crowdBadge?' · '+crowdBadge:''}</div>
    </div>`
  }
  return ''
}

// ── 오류 화면 ─────────────────────────────────────────────────────────
function showError(msg) {
  const el = $('sm-loading')
  if (el) el.classList.add('hidden')
  $('verdict-wrap').innerHTML = `
    <div class="vc2 late">
      <p class="vc2-msg">오류가 발생했어요</p>
      <div class="vc2-margin">
        <div class="vc2-mr"><span style="font-size:.88rem;opacity:.75">${_esc(msg)}</span></div>
      </div>
      <div class="vc2-actions">
        <button class="vc2-btn vc2-btn-sec" onclick="goStep(1)">처음으로</button>
        <button class="vc2-btn vc2-btn-pri" onclick="goStep(3)">다시 시도</button>
      </div>
    </div>`
  $('verdict-wrap').classList.remove('hidden')
}
