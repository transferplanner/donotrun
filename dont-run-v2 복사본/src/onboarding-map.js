// onboarding-map.js — STEP 1·2 Leaflet 지도 + 주소 박스 + 내 위치 버튼
// session.js 의 state / $ / _esc 에 의존.

const _obMaps  = {}
let   _gpsMarker = null

function initObMap(step) {
  const container = $(`ob-map-${step}`)
  if (!container) return
  if (_obMaps[step]) { _obMaps[step].invalidateSize(); return }

  const initLat = step === 2 && state.start?.y ? state.start.y : 37.5665
  const initLng = step === 2 && state.start?.x ? state.start.x : 126.978

  const map = L.map(container, { center: [initLat, initLng], zoom: 16, zoomControl: false, attributionControl: false })
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd' }).addTo(map)
  _obMaps[step] = map

  const pin = $(`ob-pin-${step}`)
  map.on('movestart', () => { pin?.classList.add('dragging'); _setAddrLoading(step) })
  map.on('moveend',   () => {
    pin?.classList.remove('dragging')
    const c = map.getCenter()
    _doReverseGeocode(c.lat, c.lng, step)
  })
  _doReverseGeocode(initLat, initLng, step)
}

// ── 주소 UI 헬퍼 ────────────────────────────────────────────────────────
const _ADDR_ICO = `<svg class="ob-addr-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="10" r="3"/><path d="M12 2a8 8 0 0 0-8 8c0 5.4 7 12 8 12s8-6.6 8-12a8 8 0 0 0-8-8z"/></svg>`

function _setAddrLoading(step) {
  const box = $(`ob-addr-${step}`)
  if (!box) return
  box.classList.remove('filled','filled-end')
  box.innerHTML = `${_ADDR_ICO}<span class="ob-addr-loading">주소 찾는 중...</span>`
}

function _applyAddress(step, lat, lng, name, sub) {
  const box = $(`ob-addr-${step}`)
  if (!box) return
  const filledCls = step === 1 ? 'filled' : 'filled-end'
  box.className = `ob-addr-box ${filledCls}`
  const safeName = _esc(name)
  const safeSub  = _esc(sub)
  box.innerHTML = `${_ADDR_ICO}<div>
    <div class="ob-addr-name">${safeName}</div>
    ${sub ? `<div class="ob-addr-sub">${safeSub}</div>` : ''}
  </div>`
  const place = { name, address: sub, x: lng, y: lat }
  if (step === 1) { state.start = place; $('start-input').value = name; $('ob-1-next').disabled = false }
  else            { state.end   = place; $('end-input').value   = name; $('ob-2-next').disabled = false }
}

async function _doReverseGeocode(lat, lng, step) {
  _setAddrLoading(step)
  try {
    const addr = await reverseGeocode(lat, lng)
    if (addr) _applyAddress(step, lat, lng, addr, '')
    else      _applyAddress(step, lat, lng, `${lat.toFixed(5)}, ${lng.toFixed(5)}`, '')
  } catch(e) {
    _applyAddress(step, lat, lng, `${lat.toFixed(5)}, ${lng.toFixed(5)}`, '')
  }
}

// ── 내 위치 ───────────────────────────────────────────────────────────
function useMyLocation(step) {
  if (!navigator.geolocation) { alert('이 브라우저는 위치 정보를 지원하지 않아요.'); return }
  const btn = document.querySelector(`#ob-${step} .ob-map-search-btn--gps`)
  if (btn) { btn.classList.add('loading'); btn.disabled = true }
  _setAddrLoading(step)
  navigator.geolocation.getCurrentPosition(
    pos => {
      if (btn) { btn.classList.remove('loading'); btn.disabled = false }
      const { latitude: lat, longitude: lng } = pos.coords
      const map = _obMaps[step]
      if (map) {
        map.setView([lat, lng], 17)
        if (_gpsMarker) _gpsMarker.setLatLng([lat, lng]).addTo(map)
        else _gpsMarker = L.circleMarker([lat, lng], {
          radius: 9, color: '#fff', weight: 3, fillColor: '#3b82f6', fillOpacity: 1,
        }).addTo(map)
      }
      _doReverseGeocode(lat, lng, step)
    },
    err => {
      if (btn) { btn.classList.remove('loading'); btn.disabled = false }
      const msgs = { 1:'위치 권한을 허용해주세요', 2:'위치를 가져올 수 없어요', 3:'위치 요청 시간 초과' }
      const box = $(`ob-addr-${step}`)
      if (box) {
        box.innerHTML = `${_ADDR_ICO}<span class="ob-addr-hint" style="color:#e74c3c"></span>`
        const hint = box.querySelector('.ob-addr-hint')
        if (hint) hint.textContent = msgs[err.code] || '위치 오류'
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  )
}
