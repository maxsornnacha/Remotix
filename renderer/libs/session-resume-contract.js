const toText = (value) => {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return ''
}

const isProduction = process.env.NODE_ENV === 'production'
export const RESUME_PREFLIGHT_ENDPOINT =
  toText(process.env.NEXT_PUBLIC_RESUME_PREFLIGHT_ENDPOINT) ||
  '/api/sessions/resume/preflight'
export const RESUME_PREFLIGHT_MODE = (
  toText(process.env.NEXT_PUBLIC_RESUME_PREFLIGHT_MODE) || (isProduction ? 'strict' : 'allow_unavailable')
).toLowerCase()

export const buildResumePreflightRequest = (payload = {}) => ({
  tokenId: toText(payload.tokenId),
  role: toText(payload.role),
  roomId: toText(payload.roomId),
  deviceId: toText(payload.deviceId),
  targetHostDeviceId: toText(payload.targetHostDeviceId),
})

export const parseResumePreflightResponse = (payload) => {
  const normalized = payload && typeof payload === 'object' ? payload : {}
  const ok = normalized.ok !== false
  const message = toText(normalized.message) || (ok ? 'ok' : 'Resume preflight rejected.')
  const reasonCode = toText(normalized.reasonCode) || (ok ? 'OK' : 'REJECTED')
  const source = toText(normalized.source) || 'unknown'
  const upstreamStatus = Number(normalized.upstreamStatus || 0)
  const requestId = toText(normalized.requestId)
  const nextTokenId = toText(normalized.nextTokenId)
  const nextExpiresAt = Number(normalized.nextExpiresAt || 0)
  const consumeCurrentToken = normalized.consumeCurrentToken !== false
  return {
    ok,
    message,
    reasonCode,
    source,
    upstreamStatus,
    requestId,
    nextTokenId,
    nextExpiresAt,
    consumeCurrentToken,
  }
}

export const shouldBypassResumePreflightError = (error) => {
  if (RESUME_PREFLIGHT_MODE !== 'allow_unavailable') return false
  const status = Number(error?.response?.status || 0)
  const code = String(error?.code || '').toUpperCase()
  if (status === 404 || status === 501 || status === 503 || status === 504) return true
  if (code === 'ECONNABORTED' || code === 'ERR_NETWORK') return true
  return false
}

export const describeResumePreflightFailure = (error) => {
  const responsePayload = error?.response?.data && typeof error.response.data === 'object'
    ? error.response.data
    : {}
  const status = Number(error?.response?.status || 0)
  const code = String(error?.code || '').toUpperCase()
  const reasonCode = toText(responsePayload.reasonCode)
  const source = toText(responsePayload.source)
  const upstreamStatus = Number(responsePayload.upstreamStatus || 0)
  const requestId = toText(responsePayload.requestId)
  const message = toText(responsePayload.message) || toText(error?.message)
  return {
    status,
    code,
    reasonCode,
    source,
    upstreamStatus,
    requestId,
    message: message || 'Unknown preflight error',
  }
}
