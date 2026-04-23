// modal-search.js — 장소 검색 모달 (Kakao + Nominatim)
// session.js (_session / _esc / state / $) + onboarding-map.js (_applyAddress / _obMaps) 에 의존.

let _searching = null

function openModal(type) {
  _searching = type
  $('modal-title').textContent = type === 'start' ? '출발지 검색' : '도착지 검색'
  $('modal-input').value = ''
  $('modal-list').innerHTML = ''
  $('modal').classList.remove('hidden')
  $('backdrop').classList.remove('hidden')
  setTimeout(() => $('modal-input').focus(), 150)
}

function closeModal() {
  $('modal').classList.add('hidden')
  $('backdrop').classList.add('hidden')
}

// DOM 이 준비된 뒤에만 리스너 부착 — 스크립트 로드 순서가 <body> 끝이라 안전.
$('modal-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') searchPlace() })

async function searchPlace() {
  const q = $('modal-input').value.trim()
  if (!q) return
  $('modal-list').innerHTML = '<div class="modal-msg">검색 중...</div>'
  let results = await searchKakaoPlace(q)
  if (!results.length) results = await nominatimSearch(q)
  if (!results.length) { $('modal-list').innerHTML = '<div class="modal-msg">결과가 없어요.</div>'; return }

  _session.searchResults = results
  $('modal-list').innerHTML = results.map((r, i) => `
    <div class="modal-item" onclick="selectPlace(${i})">
      <div class="modal-item-name">${_esc(r.name)}</div>
      <div class="modal-item-addr">${_esc(r.address)}</div>
    </div>`).join('')
}

function selectPlace(i) {
  const place = _session.searchResults[i]
  if (!place) return
  const type  = _searching
  state[type === 'start' ? 'start' : 'end'] = place
  const step = type === 'start' ? 1 : 2
  _applyAddress(step, place.y, place.x, place.name, place.address)
  const map = _obMaps[step]
  if (map) map.setView([place.y, place.x], 16)
  closeModal()
}
