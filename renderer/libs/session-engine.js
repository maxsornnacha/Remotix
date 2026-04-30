const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

export const SESSION_PHASE = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  JOINED: 'joined',
  HANDSHAKING: 'handshaking',
  LIVE: 'live',
  RECOVERING: 'recovering',
  ENDED: 'ended',
}

export const SESSION_RECOVERY = {
  SOCKET: 'socket',
  PEER: 'peer',
  STREAM: 'stream',
}

export const SESSION_ENGINE_POLICY = {
  socket: {
    baseMs: Number(process.env.NEXT_PUBLIC_SESSION_SOCKET_BASE_MS) || 600,
    factor: Number(process.env.NEXT_PUBLIC_SESSION_SOCKET_FACTOR) || 1.8,
    maxMs: Number(process.env.NEXT_PUBLIC_SESSION_SOCKET_MAX_MS) || 6000,
    maxAttempts: Number(process.env.NEXT_PUBLIC_SESSION_SOCKET_MAX_ATTEMPTS) || 10,
  },
  peer: {
    baseMs: Number(process.env.NEXT_PUBLIC_SESSION_PEER_BASE_MS) || 500,
    factor: Number(process.env.NEXT_PUBLIC_SESSION_PEER_FACTOR) || 1.6,
    maxMs: Number(process.env.NEXT_PUBLIC_SESSION_PEER_MAX_MS) || 5000,
    maxAttempts: Number(process.env.NEXT_PUBLIC_SESSION_PEER_MAX_ATTEMPTS) || 8,
  },
  stream: {
    baseMs: Number(process.env.NEXT_PUBLIC_SESSION_STREAM_BASE_MS) || 400,
    factor: Number(process.env.NEXT_PUBLIC_SESSION_STREAM_FACTOR) || 1.6,
    maxMs: Number(process.env.NEXT_PUBLIC_SESSION_STREAM_MAX_MS) || 4000,
    maxAttempts: Number(process.env.NEXT_PUBLIC_SESSION_STREAM_MAX_ATTEMPTS) || 8,
  },
}

export const getSessionPhaseMessage = (phase, role = 'client') => {
  const isHost = role === 'host'
  if (phase === SESSION_PHASE.REQUESTING) {
    return isHost
      ? 'Preparing remote session...'
      : 'Requesting remote access...'
  }
  if (phase === SESSION_PHASE.JOINED) {
    return isHost
      ? 'Connected to signaling service. Waiting for client...'
      : 'Connected to signaling service. Waiting for host approval...'
  }
  if (phase === SESSION_PHASE.HANDSHAKING) {
    return 'Establishing secure peer channel...'
  }
  if (phase === SESSION_PHASE.RECOVERING) {
    return 'Recovering session automatically...'
  }
  if (phase === SESSION_PHASE.LIVE) {
    return 'Remote session is live.'
  }
  if (phase === SESSION_PHASE.ENDED) {
    return 'Remote session ended.'
  }
  return 'Preparing secure session...'
}

export const getConnectionQualityDescriptor = (latencyMs, phase) => {
  if (phase === SESSION_PHASE.RECOVERING) {
    return { level: 'recovering', label: 'Recovering', tone: 'warning' }
  }
  if (phase === SESSION_PHASE.ENDED) {
    return { level: 'ended', label: 'Disconnected', tone: 'critical' }
  }
  if (typeof latencyMs !== 'number' || latencyMs <= 0) {
    return { level: 'measuring', label: 'Measuring', tone: 'neutral' }
  }
  if (latencyMs <= 90) return { level: 'excellent', label: 'Excellent', tone: 'healthy' }
  if (latencyMs <= 150) return { level: 'good', label: 'Good', tone: 'healthy' }
  if (latencyMs <= 240) return { level: 'fair', label: 'Fair', tone: 'warning' }
  return { level: 'poor', label: 'Poor', tone: 'critical' }
}

export const createBackoffController = (config = {}) => {
  const baseMs = clamp(Number(config.baseMs) || 500, 200, 3000)
  const factor = clamp(Number(config.factor) || 1.8, 1.2, 3)
  const maxMs = clamp(Number(config.maxMs) || 8000, 1000, 30000)
  const maxAttempts = clamp(Number(config.maxAttempts) || 8, 1, 30)
  let attempts = 0

  const nextDelay = () => {
    attempts += 1
    if (attempts > maxAttempts) return -1
    const raw = baseMs * factor ** (attempts - 1)
    return Math.min(maxMs, Math.round(raw))
  }

  const reset = () => {
    attempts = 0
  }

  const getAttempts = () => attempts

  return { nextDelay, reset, getAttempts }
}

export const createSessionEngine = ({ onPhaseChange, onTelemetry, policy } = {}) => {
  let phase = SESSION_PHASE.IDLE
  const timers = new Set()
  const namedTimers = new Map()
  const mergedPolicy = {
    socket: { ...SESSION_ENGINE_POLICY.socket, ...(policy?.socket || {}) },
    peer: { ...SESSION_ENGINE_POLICY.peer, ...(policy?.peer || {}) },
    stream: { ...SESSION_ENGINE_POLICY.stream, ...(policy?.stream || {}) },
  }
  const socketRecovery = createBackoffController(mergedPolicy.socket)
  const peerRecovery = createBackoffController(mergedPolicy.peer)
  const streamRecovery = createBackoffController(mergedPolicy.stream)
  const telemetryHandler = typeof onTelemetry === 'function' ? onTelemetry : null

  const trackTelemetry = (event, payload = {}) => {
    if (!telemetryHandler) return
    telemetryHandler({
      event,
      phase,
      timestamp: Date.now(),
      ...payload,
    })
  }

  const setPhase = (nextPhase) => {
    if (!nextPhase || phase === nextPhase) return
    const previous = phase
    phase = nextPhase
    trackTelemetry('phase-change', { previous, next: nextPhase })
    if (typeof onPhaseChange === 'function') onPhaseChange(nextPhase)
  }

  const pickRecoveryController = (kind) => {
    if (kind === SESSION_RECOVERY.SOCKET) return socketRecovery
    if (kind === SESSION_RECOVERY.STREAM) return streamRecovery
    return peerRecovery
  }

  const scheduleRecovery = (kind, task) => {
    if (typeof task !== 'function') return false
    const controller = pickRecoveryController(kind)
    const delay = controller.nextDelay()
    if (delay < 0) {
      trackTelemetry('recovery-exhausted', { kind, attempts: controller.getAttempts() })
      return false
    }
    setPhase(SESSION_PHASE.RECOVERING)
    trackTelemetry('recovery-scheduled', { kind, attempts: controller.getAttempts(), delay })
    const timerId = window.setTimeout(() => {
      timers.delete(timerId)
      trackTelemetry('recovery-fired', { kind, attempts: controller.getAttempts() })
      task()
    }, delay)
    timers.add(timerId)
    return true
  }

  const markHealthy = () => {
    socketRecovery.reset()
    peerRecovery.reset()
    streamRecovery.reset()
    trackTelemetry('recovery-reset')
    setPhase(SESSION_PHASE.LIVE)
  }

  const setTimeoutTask = (key, delay, task) => {
    if (!key || typeof task !== 'function') return null
    const timerKey = String(key)
    if (namedTimers.has(timerKey)) {
      window.clearTimeout(namedTimers.get(timerKey))
      namedTimers.delete(timerKey)
    }
    const timerId = window.setTimeout(() => {
      timers.delete(timerId)
      namedTimers.delete(timerKey)
      trackTelemetry('timeout-fired', { key: timerKey, delay })
      task()
    }, delay)
    timers.add(timerId)
    namedTimers.set(timerKey, timerId)
    trackTelemetry('timeout-scheduled', { key: timerKey, delay })
    return timerId
  }

  const clearTimeoutTask = (key) => {
    const timerKey = String(key)
    if (!namedTimers.has(timerKey)) return
    const timerId = namedTimers.get(timerKey)
    window.clearTimeout(timerId)
    timers.delete(timerId)
    namedTimers.delete(timerKey)
    trackTelemetry('timeout-cleared', { key: timerKey })
  }

  const clearTimers = () => {
    timers.forEach((timerId) => window.clearTimeout(timerId))
    timers.clear()
    namedTimers.clear()
  }

  const destroy = () => {
    clearTimers()
  }

  return {
    getPhase: () => phase,
    setPhase,
    scheduleRecovery,
    markHealthy,
    setTimeoutTask,
    clearTimeoutTask,
    clearTimers,
    destroy,
  }
}
