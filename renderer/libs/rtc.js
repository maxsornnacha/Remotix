const toText = (value) => {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  return ''
}

export const getRtcConfig = () => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]

  const turnUrl = toText(process.env.NEXT_PUBLIC_TURN_URL)
  const turnUsername = toText(process.env.NEXT_PUBLIC_TURN_USERNAME)
  const turnCredential = toText(process.env.NEXT_PUBLIC_TURN_CREDENTIAL)
  const turnRealm = toText(process.env.NEXT_PUBLIC_TURN_REALM)

  if (turnUrl && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential,
      ...(turnRealm ? { realm: turnRealm } : {}),
    })
  }

  return {
    iceServers,
  }
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
