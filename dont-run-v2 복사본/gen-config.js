// gen-config.js — .env 파일을 읽어 src/config.js 를 자동 생성
// ★ 보안: 프록시 대상 키(서버 전용)는 절대 클라이언트로 내보내지 않는다.
//   서버로 옮긴 키들은 Firebase Functions(.env / Secrets)에만 존재해야 함.
const fs   = require('fs')
const path = require('path')

// v2 는 부모 디렉토리의 .env 를 공유
const envPath    = path.join(__dirname, '..', 'dont-run', '.env')
const outputPath = path.join(__dirname, 'src', 'config.js')

// ── 서버 전용 (Functions 프록시 뒤) — 클라이언트로 내보내지 않음 ─────
const SERVER_ONLY_KEYS = new Set([
  'TMAP_TRANSPORTATION',
  'SEOUL_BUS_ARRIVAIL_KEY',
  'SEOUL_BUS_ARRIVAL_KEY',
  'SUBWAY_SEOUL_NOW_KEY',
  'SUBWAY_CROWD_API',
  'SINHODUNG_KEY',
  'KAKAO_REST_API_KEY',
])

// ── 클라이언트 허용 키 (도메인 제한 걸려있거나 공개 전제) ───────────
// Firebase 퍼블릭 설정 + Kakao JS SDK 키(도메인 제한) 만 허용.
const CLIENT_ALLOW_KEYS = new Set([
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID',
  'KAKAO_MAP_API_KEY',   // Kakao Maps JS SDK — 도메인 제한 필수
])

if (!fs.existsSync(envPath)) {
  console.error('[gen-config] .env 파일이 없습니다:', envPath)
  process.exit(1)
}

const env = {}
fs.readFileSync(envPath, 'utf-8')
  .split('\n')
  .forEach(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) return
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    env[key] = val
  })

// 서버 키는 제거, 화이트리스트만 남김
const filtered = Object.fromEntries(
  Object.entries(env).filter(([k]) =>
    CLIENT_ALLOW_KEYS.has(k) && !SERVER_ONLY_KEYS.has(k)
  )
)

// 참고용: 제외된 서버 키 목록을 로그로 표시 (값은 찍지 않음)
const stripped = Object.keys(env).filter(k => SERVER_ONLY_KEYS.has(k))
if (stripped.length) {
  console.log('[gen-config] 서버 전용 키 제외:', stripped.join(', '))
}

const keys = Object.keys(filtered)
const maxLen = keys.length ? Math.max(...keys.map(k => k.length)) : 0
const lines  = Object.entries(filtered)
  .map(([k, v]) => `  ${k.padEnd(maxLen)}: "${v}",`)
  .join('\n')

const output = `// config.js — .env 에서 자동 생성 (절대 커밋 금지)
// ★ 서버 전용 키(TMAP/Subway/Bus/Signal/Kakao REST)는 포함되지 않음.
//   외부 API 호출은 /api/** 프록시(Firebase Functions) 경유.
const CONFIG = {
${lines}
}
`

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, output, 'utf-8')
console.log(`[gen-config] src/config.js 생성 완료 (클라이언트 키 ${keys.length}개)`)
