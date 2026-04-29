const toText = (value) => {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return ''
}

const toBool = (value) => {
  const normalized = toText(value).toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

const parseTurnUrls = (value) =>
  toText(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

export const getRtcConfig = () => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]

  const turnUrls = parseTurnUrls(process.env.NEXT_PUBLIC_TURN_URL)
  const turnUsername = toText(process.env.NEXT_PUBLIC_TURN_USERNAME)
  const turnCredential = toText(process.env.NEXT_PUBLIC_TURN_CREDENTIAL)
  const turnRealm = toText(process.env.NEXT_PUBLIC_TURN_REALM)
  const forceRelay = toBool(process.env.NEXT_PUBLIC_FORCE_RELAY)

  if (turnUrls.length > 0 && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
      username: turnUsername,
      credential: turnCredential,
      ...(turnRealm ? { realm: turnRealm } : {}),
    })
  }

  const config = {
    iceServers,
  }

  if (forceRelay) {
    config.iceTransportPolicy = 'relay'
  }

  return config
}

const pickSelectedCandidatePair = (statsEntries) => {
  const candidatePairs = statsEntries.filter((entry) => entry.type === 'candidate-pair')
  const selectedPair =
    candidatePairs.find((pair) => pair.selected) ||
    candidatePairs.find((pair) => pair.nominated && pair.state === 'succeeded') ||
    null
  if (!selectedPair) return null

  const local = statsEntries.find(
    (entry) => entry.type === 'local-candidate' && entry.id === selectedPair.localCandidateId,
  )
  const remote = statsEntries.find(
    (entry) => entry.type === 'remote-candidate' && entry.id === selectedPair.remoteCandidateId,
  )

  return {
    pairId: selectedPair.id,
    state: selectedPair.state,
    localType: local?.candidateType || 'unknown',
    remoteType: remote?.candidateType || 'unknown',
    protocol: local?.protocol || remote?.protocol || 'unknown',
    relayUsed:
      local?.candidateType === 'relay' || remote?.candidateType === 'relay',
  }
}

export const attachRtcDiagnostics = (peer, label = 'rtc') => {
  if (!peer) return () => {}

  let stopped = false
  let intervalId = null

  const logSelectedRoute = async () => {
    if (stopped) return
    const pc = peer._pc
    if (!pc || typeof pc.getStats !== 'function') return
    try {
      const statsMap = await pc.getStats()
      const entries = Array.from(statsMap.values())
      const selected = pickSelectedCandidatePair(entries)
      if (!selected) return
      console.log(`[${label}] selected-candidate`, selected)
      if (selected.relayUsed) {
        console.log(`[${label}] TURN relay connection is active`)
      } else {
        console.log(`[${label}] direct route active (TURN not required)`)
      }
      if (intervalId) {
        window.clearInterval(intervalId)
        intervalId = null
      }
    } catch (error) {
      console.warn(`[${label}] getStats failed`, error)
    }
  }

  const onIceStateChange = () => {
    const pc = peer._pc
    const state = pc?.iceConnectionState || 'unknown'
    console.log(`[${label}] ice-state`, state)
    if (state === 'connected' || state === 'completed') {
      logSelectedRoute()
    }
  }

  const onPeerConnect = () => {
    logSelectedRoute()
  }

  intervalId = window.setInterval(logSelectedRoute, 2000)
  peer.on('connect', onPeerConnect)

  const initialPc = peer._pc
  if (initialPc?.addEventListener) {
    initialPc.addEventListener('iceconnectionstatechange', onIceStateChange)
  }

  return () => {
    stopped = true
    peer.off('connect', onPeerConnect)
    if (intervalId) window.clearInterval(intervalId)
    const pc = peer._pc
    if (pc?.removeEventListener) {
      pc.removeEventListener('iceconnectionstatechange', onIceStateChange)
    }
  }
}
