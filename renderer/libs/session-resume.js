const SESSION_RESUME_KEY = 'remotix-last-session'
const DEFAULT_TTL_MS = 15 * 60 * 1000
const SESSION_RESUME_SCHEMA_VERSION = '1.1.0'

const toText = (value) => {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return ''
}

const createTokenId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `token-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const saveSessionResumeToken = (payload = {}, ttlMs = DEFAULT_TTL_MS) => {
  if (typeof window === 'undefined') return null
  const roomId = toText(payload.roomId)
  const role = toText(payload.role)
  if (!roomId || !role) return null
  const now = Date.now()
  const token = {
    schemaVersion: SESSION_RESUME_SCHEMA_VERSION,
    tokenId: toText(payload.tokenId) || createTokenId(),
    role,
    roomId,
    deviceId: toText(payload.deviceId),
    displayName: toText(payload.displayName),
    targetHostDeviceId: toText(payload.targetHostDeviceId),
    createdAt: Number(payload.createdAt) || now,
    updatedAt: now,
    expiresAt: now + Math.max(30_000, Number(ttlMs) || DEFAULT_TTL_MS),
  }
  window.localStorage.setItem(SESSION_RESUME_KEY, JSON.stringify(token))
  return token
}

export const readSessionResumeToken = () => {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(SESSION_RESUME_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || Date.now() > Number(parsed.expiresAt || 0)) {
      window.localStorage.removeItem(SESSION_RESUME_KEY)
      return null
    }
    return parsed
  } catch (_error) {
    window.localStorage.removeItem(SESSION_RESUME_KEY)
    return null
  }
}

export const clearSessionResumeToken = () => {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(SESSION_RESUME_KEY)
}

export const validateSessionResumeToken = (token, options = {}) => {
  const normalized = token && typeof token === 'object' ? token : null
  if (!normalized) return { ok: false, reason: 'missing-token' }
  const role = toText(normalized.role)
  const roomId = toText(normalized.roomId)
  const tokenId = toText(normalized.tokenId)
  const expiresAt = Number(normalized.expiresAt || 0)
  const expectedDeviceId = toText(options.expectedDeviceId)
  const tokenDeviceId = toText(normalized.deviceId)
  const now = Date.now()

  if (!role || !roomId || !tokenId) return { ok: false, reason: 'invalid-shape' }
  if (!(role === 'host' || role === 'client')) return { ok: false, reason: 'invalid-role' }
  if (!expiresAt || now > expiresAt) return { ok: false, reason: 'expired' }
  if (role === 'client' && !toText(normalized.targetHostDeviceId)) {
    return { ok: false, reason: 'missing-target-host' }
  }
  if (expectedDeviceId && tokenDeviceId && expectedDeviceId !== tokenDeviceId) {
    return { ok: false, reason: 'device-mismatch' }
  }
  return { ok: true, reason: 'ok' }
}

export const consumeSessionResumeToken = () => {
  clearSessionResumeToken()
}
