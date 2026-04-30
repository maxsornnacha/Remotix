import axios from 'axios'
import { randomUUID } from 'crypto'

const RATE_LIMIT_WINDOW_MS = Math.max(
  5_000,
  Number(process.env.RESUME_PREFLIGHT_RATE_WINDOW_MS || 60_000) || 60_000,
)
const RATE_LIMIT_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.RESUME_PREFLIGHT_RATE_MAX_ATTEMPTS || 12) || 12,
)
const RATE_LIMIT_COOLDOWN_MS = Math.max(
  1_000,
  Number(process.env.RESUME_PREFLIGHT_RATE_COOLDOWN_MS || 120_000) || 120_000,
)
const TELEMETRY_ENABLED = process.env.RESUME_PREFLIGHT_TELEMETRY_ENABLED !== '0'
const rateLimitStore = new Map()

const toText = (value) => {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return ''
}

const createRequestId = () => {
  try {
    return randomUUID()
  } catch (_error) {
    return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

const getClientIp = (req) => {
  const forwardedFor = toText(req.headers?.['x-forwarded-for'])
  if (forwardedFor) return forwardedFor.split(',')[0].trim()
  return toText(req.socket?.remoteAddress) || 'unknown-ip'
}

const getRateLimitKey = (req, payload) => {
  const ip = getClientIp(req)
  const deviceId = toText(payload.deviceId) || 'unknown-device'
  return `${ip}::${deviceId}`
}

const enforceRateLimit = (req, payload) => {
  const now = Date.now()
  const key = getRateLimitKey(req, payload)
  const current = rateLimitStore.get(key) || {
    startedAt: now,
    attempts: 0,
    cooldownUntil: 0,
  }

  if (current.cooldownUntil > now) {
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil((current.cooldownUntil - now) / 1000),
      attemptsLeft: 0,
    }
  }

  if (now - current.startedAt > RATE_LIMIT_WINDOW_MS) {
    current.startedAt = now
    current.attempts = 0
  }

  current.attempts += 1
  if (current.attempts > RATE_LIMIT_MAX_ATTEMPTS) {
    current.cooldownUntil = now + RATE_LIMIT_COOLDOWN_MS
    rateLimitStore.set(key, current)
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000),
      attemptsLeft: 0,
    }
  }

  rateLimitStore.set(key, current)
  return {
    blocked: false,
    retryAfterSeconds: 0,
    attemptsLeft: Math.max(0, RATE_LIMIT_MAX_ATTEMPTS - current.attempts),
  }
}

const cleanupRateLimitStore = () => {
  const now = Date.now()
  for (const [key, state] of rateLimitStore.entries()) {
    if (state.cooldownUntil > 0 && state.cooldownUntil > now) continue
    if (now - state.startedAt <= RATE_LIMIT_WINDOW_MS) continue
    rateLimitStore.delete(key)
  }
}

const emitPreflightTelemetry = (event, req, payload, extras = {}) => {
  if (!TELEMETRY_ENABLED) return
  const safePayload = payload && typeof payload === 'object' ? payload : {}
  const nowIso = new Date().toISOString()
  const telemetry = {
    at: nowIso,
    event: toText(event) || 'resume_preflight_unknown',
    ip: getClientIp(req),
    deviceId: toText(safePayload.deviceId),
    role: toText(safePayload.role),
    roomId: toText(safePayload.roomId),
    tokenId: toText(safePayload.tokenId),
    reasonCode: toText(extras.reasonCode),
    source: toText(extras.source),
    httpStatus: Number(extras.httpStatus || 0),
    upstreamStatus: Number(extras.upstreamStatus || 0),
    retryAfterSeconds: Number(extras.retryAfterSeconds || 0),
    requestId: toText(extras.requestId),
  }
  console.info('[resume-preflight-telemetry]', JSON.stringify(telemetry))
}

const sanitizeRequest = (payload = {}) => ({
  tokenId: toText(payload.tokenId),
  role: toText(payload.role).toLowerCase(),
  roomId: toText(payload.roomId),
  deviceId: toText(payload.deviceId),
  targetHostDeviceId: toText(payload.targetHostDeviceId),
})

const validatePayload = (payload) => {
  if (!payload.tokenId) return 'Missing tokenId.'
  if (!payload.roomId) return 'Missing roomId.'
  if (!payload.deviceId) return 'Missing deviceId.'
  if (payload.role !== 'host' && payload.role !== 'client') return 'Invalid role.'
  if (payload.role === 'client' && !payload.targetHostDeviceId) return 'Missing targetHostDeviceId for client role.'
  return ''
}

const getUpstreamUrl = () => {
  const configured = toText(process.env.RESUME_PREFLIGHT_UPSTREAM_URL)
  if (configured) return configured

  const apiBase = toText(process.env.NEXT_PUBLIC_API_URL).replace(/\/+$/, '')
  if (!apiBase) return ''
  return `${apiBase}/sessions/resume/preflight`
}

const parseUpstream = (data) => {
  const normalized = data && typeof data === 'object' ? data : {}
  const ok = normalized.ok !== false
  const message = toText(normalized.message) || (ok ? 'ok' : 'Resume preflight rejected.')
  const reasonCode = toText(normalized.reasonCode) || (ok ? 'OK' : 'UPSTREAM_REJECTED')
  const nextTokenId = toText(normalized.nextTokenId)
  const nextExpiresAt = Number(normalized.nextExpiresAt || 0)
  const consumeCurrentToken = normalized.consumeCurrentToken !== false
  return { ok, message, reasonCode, nextTokenId, nextExpiresAt, consumeCurrentToken }
}

export default async function handler(req, res) {
  const requestId =
    toText(req.headers?.['x-request-id']) ||
    toText(req.headers?.['x-correlation-id']) ||
    createRequestId()
  res.setHeader('X-Request-Id', requestId)

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({
      ok: false,
      message: 'Method not allowed.',
      reasonCode: 'METHOD_NOT_ALLOWED',
      source: 'gateway',
      upstreamStatus: 0,
    })
  }

  const payload = sanitizeRequest(req.body)
  cleanupRateLimitStore()
  const validationError = validatePayload(payload)
  if (validationError) {
    emitPreflightTelemetry('resume_preflight_rejected', req, payload, {
      reasonCode: 'INVALID_REQUEST',
      source: 'gateway',
      httpStatus: 400,
      requestId,
    })
    return res.status(400).json({
      ok: false,
      message: validationError,
      reasonCode: 'INVALID_REQUEST',
      source: 'gateway',
      upstreamStatus: 0,
    })
  }
  const rateLimit = enforceRateLimit(req, payload)
  if (rateLimit.blocked) {
    emitPreflightTelemetry('resume_preflight_rate_limited', req, payload, {
      reasonCode: 'RATE_LIMITED',
      source: 'gateway',
      httpStatus: 429,
      upstreamStatus: 429,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
      requestId,
    })
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds))
    return res.status(429).json({
      ok: false,
      message: `Too many resume attempts. Retry in ${rateLimit.retryAfterSeconds}s.`,
      reasonCode: 'RATE_LIMITED',
      source: 'gateway',
      upstreamStatus: 429,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    })
  }

  const upstreamUrl = getUpstreamUrl()
  if (!upstreamUrl) {
    if (process.env.NODE_ENV === 'production') {
      emitPreflightTelemetry('resume_preflight_rejected', req, payload, {
        reasonCode: 'UPSTREAM_NOT_CONFIGURED',
        source: 'gateway',
        httpStatus: 503,
        requestId,
      })
      return res.status(503).json({
        ok: false,
        message: 'Resume preflight upstream is not configured.',
        reasonCode: 'UPSTREAM_NOT_CONFIGURED',
        source: 'gateway',
        upstreamStatus: 0,
      })
    }
    emitPreflightTelemetry('resume_preflight_fallback_ok', req, payload, {
      reasonCode: 'DEV_FALLBACK',
      source: 'gateway',
      httpStatus: 200,
      requestId,
    })
    return res.status(200).json({
      ok: true,
      message: 'Preflight passed in local development fallback mode.',
      reasonCode: 'DEV_FALLBACK',
      source: 'gateway',
      upstreamStatus: 0,
    })
  }

  try {
    const upstream = await axios.post(upstreamUrl, payload, {
      timeout: 4500,
      headers: {
        'x-request-id': requestId,
      },
    })
    const result = parseUpstream(upstream?.data)
    const upstreamStatus = Number(upstream?.status || 0)
    emitPreflightTelemetry(
      result.ok ? 'resume_preflight_ok' : 'resume_preflight_rejected',
      req,
      payload,
      {
        reasonCode: result.reasonCode,
        source: 'upstream',
        httpStatus: result.ok ? 200 : 409,
        upstreamStatus,
        requestId,
      },
    )
    return res.status(result.ok ? 200 : 409).json({
      ...result,
      source: 'upstream',
      upstreamStatus,
      requestId,
    })
  } catch (error) {
    const status = Number(error?.response?.status || 0)
    const upstreamReasonCode = toText(error?.response?.data?.reasonCode)
    const message =
      toText(error?.response?.data?.message) ||
      toText(error?.message) ||
      'Resume preflight upstream request failed.'
    const reasonCode =
      upstreamReasonCode ||
      (status ? 'UPSTREAM_REJECTED' : 'UPSTREAM_UNAVAILABLE')
    emitPreflightTelemetry('resume_preflight_error', req, payload, {
      reasonCode,
      source: 'upstream',
      httpStatus: status || 503,
      upstreamStatus: status || 0,
      requestId,
    })
    return res.status(status || 503).json({
      ok: false,
      message,
      reasonCode,
      source: 'upstream',
      upstreamStatus: status || 0,
      requestId,
    })
  }
}
