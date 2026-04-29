import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import Peer from 'simple-peer'
import { getSocket } from '../../libs/socket';
import { useTheme } from '../../libs/theme'
import { useAlerts } from '../../libs/alerts'
import { attachRtcDiagnostics, getRtcConfig } from '../../libs/rtc'

const socket = getSocket();

function WifiSignalIcon({ isDark }) {
  return (
    <div className="relative w-16 h-16 mb-4 flex items-center justify-center">
      <span className={`absolute w-16 h-16 rounded-full animate-ping ${isDark ? 'bg-amber-400/20' : 'bg-amber-600/20'}`} />
      <svg viewBox="0 0 24 24" className={`relative w-10 h-10 ${isDark ? 'text-amber-300' : 'text-amber-600'}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 9.5a14.8 14.8 0 0 1 19 0" />
        <path d="M5.8 13a10 10 0 0 1 12.4 0" />
        <path d="M9.2 16.5a5.2 5.2 0 0 1 5.6 0" />
        <circle cx="12" cy="20" r="1.1" fill="currentColor" stroke="none" />
      </svg>
    </div>
  )
}

const toText = (value) => {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return ''
}

const isScreenSource = (sourceId) => toText(sourceId).startsWith('screen:')

const sortSourcesForStableShare = (sources, selectedId, primaryDisplayId) => {
  const normalizedSelected = toText(selectedId)
  const normalizedPrimary = toText(primaryDisplayId)
  const list = Array.isArray(sources) ? sources : []
  const screens = list.filter((item) => isScreenSource(item?.id))
  const windows = list.filter((item) => !isScreenSource(item?.id))
  const base = screens.length > 0 ? screens : [...screens, ...windows]

  return [
    ...base.filter((item) => toText(item.id) === normalizedSelected),
    ...base.filter(
      (item) =>
        toText(item.id) !== normalizedSelected &&
        toText(item.displayId) === normalizedPrimary,
    ),
    ...base.filter(
      (item) =>
        toText(item.id) !== normalizedSelected &&
        toText(item.displayId) !== normalizedPrimary,
    ),
  ]
}
function ThemeGlyph({ isDark }) {
  if (isDark) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2.2M12 19.8V22M4.22 4.22l1.56 1.56M18.22 18.22l1.56 1.56M2 12h2.2M19.8 12H22M4.22 19.78l1.56-1.56M18.22 5.78l1.56-1.56" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3c.5 0 .73.61.4 1A7 7 0 0 0 20 12.4c.39-.3 1 .02 1 .39Z" />
    </svg>
  )
}

export default function HostPage() {
  const router = useRouter()
  const { roomId, deviceId, name } = router.query

  const [allowControl, setAllowControl] = useState(false)
  const [sessionNotice, setSessionNotice] = useState('')
  const [isSharing, setIsSharing] = useState(false)
  const [isPreparingShare, setIsPreparingShare] = useState(false)
  const [incomingRequests, setIncomingRequests] = useState([])
  const [dbUnavailableMessage, setDbUnavailableMessage] = useState('')
  const [isReselectingShare, setIsReselectingShare] = useState(false)
  const [isSourcePickerOpen, setIsSourcePickerOpen] = useState(false)
  const [availableSources, setAvailableSources] = useState([])
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [sessionEndedReason, setSessionEndedReason] = useState('')
  const [isSignalingActive, setIsSignalingActive] = useState(false)
  const [isPeerConnected, setIsPeerConnected] = useState(false)
  const [latencyMs, setLatencyMs] = useState(null)
  const videoRef = useRef(null)
  const localStreamRef = useRef(null)
  const blackFrameCanvasRef = useRef(null)
  const peerRef = useRef(null)
  const pendingPeerIdRef = useRef('')
  const shareStartPromiseRef = useRef(null)
  const hasJoinedRoomRef = useRef(false)
  const hasAnnouncedReadyRef = useRef(false)
  const peerHealthTimeoutRef = useRef(null)
  const detachRtcDiagnosticsRef = useRef(null)
  const streamHealthIntervalRef = useRef(null)
  const blackFrameHitsRef = useRef(0)
  const streamDebugIntervalRef = useRef(null)
  const blackRecoveryInFlightRef = useRef(false)
  const lastNotifiedMessageRef = useRef('')
  const isManualDisconnectRef = useRef(false)
  const appliedQualityLevelRef = useRef('')
  const { isDark, toggleTheme } = useTheme()
  const { pushAlert } = useAlerts()
  const logDebug = (stage, payload = {}) => {
    console.log(`[host][debug] ${stage}`, payload)
  }

  const stopStreamDebugMonitor = () => {
    if (!streamDebugIntervalRef.current) return
    window.clearInterval(streamDebugIntervalRef.current)
    streamDebugIntervalRef.current = null
  }

  const startStreamDebugMonitor = (stream) => {
    stopStreamDebugMonitor()
    const track = stream?.getVideoTracks?.()[0]
    streamDebugIntervalRef.current = window.setInterval(() => {
      logDebug('preview-health', {
        trackReadyState: track?.readyState || 'unknown',
        trackMuted: Boolean(track?.muted),
        videoReadyState: videoRef.current?.readyState ?? -1,
        paused: Boolean(videoRef.current?.paused),
        currentTime: Number(videoRef.current?.currentTime || 0).toFixed(3),
        videoWidth: videoRef.current?.videoWidth || 0,
        videoHeight: videoRef.current?.videoHeight || 0,
      })
    }, 2000)
  }


  const shouldPushHostNotification = (text, type) => {
    if (!text) return false
    if (type === 'error') return true
    return (
      text.includes('Incoming request') ||
      text.includes('Connection approved') ||
      text.includes('Connection rejected') ||
      text.includes('Remote session ended')
    )
  }

  const setNotice = (message, type = 'info') => {
    const text = toText(message)
    setSessionNotice(text)
    if (!shouldPushHostNotification(text, type)) return
    if (lastNotifiedMessageRef.current === text) return
    lastNotifiedMessageRef.current = text
    pushAlert(text, { type })
  }

  const setDbMessage = (message) => {
    const text = toText(message)
    setDbUnavailableMessage(text)
    if (text) pushAlert(text, { type: 'error' })
  }

  const showSessionEnded = (reason) => {
    if (isManualDisconnectRef.current) return
    const text = toText(reason) || 'Remote session ended.'
    setSessionEndedReason(text)
    setSessionNotice(text)
    setIsSharing(false)
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
    }
    stopStreamHealthMonitor()
    stopStreamDebugMonitor()
    setIsPeerConnected(false)
    setIsSignalingActive(false)
  }

  const attachStreamToPreview = async (stream) => {
    if (!videoRef.current) return false
    const track = stream?.getVideoTracks?.()[0]
    logDebug('attach-preview-start', {
      trackLabel: track?.label || 'unknown',
      trackReadyState: track?.readyState || 'unknown',
      trackMuted: Boolean(track?.muted),
      trackSettings: track?.getSettings?.() || {},
    })

    videoRef.current.onloadedmetadata = () => {
      logDebug('video-event-loadedmetadata', {
        width: videoRef.current?.videoWidth || 0,
        height: videoRef.current?.videoHeight || 0,
        readyState: videoRef.current?.readyState ?? -1,
      })
    }
    videoRef.current.onplaying = () => {
      logDebug('video-event-playing', {
        currentTime: Number(videoRef.current?.currentTime || 0).toFixed(3),
        readyState: videoRef.current?.readyState ?? -1,
      })
    }
    videoRef.current.onpause = () => {
      logDebug('video-event-pause', {
        currentTime: Number(videoRef.current?.currentTime || 0).toFixed(3),
      })
    }
    videoRef.current.onerror = () => {
      logDebug('video-event-error', {
        mediaErrorCode: videoRef.current?.error?.code || null,
      })
    }

    videoRef.current.srcObject = stream
    try {
      await videoRef.current.play()
      startStreamDebugMonitor(stream)
      logDebug('attach-preview-success', {
        currentTime: Number(videoRef.current?.currentTime || 0).toFixed(3),
        width: videoRef.current?.videoWidth || 0,
        height: videoRef.current?.videoHeight || 0,
      })
      return true
    } catch (error) {
      console.error('[host][preview] video play failed', error)
      logDebug('attach-preview-failed', {
        errorMessage: toText(error?.message) || 'unknown',
      })
      setNotice('Preview is not showing. Please choose a screen again.', 'error')
      return false
    }
  }

  const applyStreamQualityProfile = async (level = 'good') => {
    const stream = localStreamRef.current
    const track = stream?.getVideoTracks?.()[0]
    if (!track || typeof track.applyConstraints !== 'function') return

    const profileMap = {
      good: { width: 1920, height: 1080, frameRate: 30 },
      fair: { width: 1280, height: 720, frameRate: 24 },
      poor: { width: 960, height: 540, frameRate: 15 },
    }
    const target = profileMap[level] || profileMap.good
    if (appliedQualityLevelRef.current === level) return

    try {
      await track.applyConstraints({
        width: { ideal: target.width, max: target.width },
        height: { ideal: target.height, max: target.height },
        frameRate: { ideal: target.frameRate, max: target.frameRate },
      })
      appliedQualityLevelRef.current = level
      setSessionNotice(`Connection quality: ${level}. Stream optimized automatically.`)
    } catch (error) {
      console.warn('[host][quality] applyConstraints failed', error)
    }
  }

  const createPeerConnection = (peerId) => {
    if (!peerId || !localStreamRef.current) return
    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }
    if (detachRtcDiagnosticsRef.current) {
      detachRtcDiagnosticsRef.current()
      detachRtcDiagnosticsRef.current = null
    }

    const peer = new Peer({
      initiator: true,
      trickle: false,
      stream: localStreamRef.current,
      config: getRtcConfig(),
    })

    peer.on('signal', (data) => {
      console.log('[host][signal] send offer/answer', { to: peerId })
      socket.emit('signal', { to: peerId, from: socket.id, data })
    })

    peer.on('connect', () => {
      if (peerHealthTimeoutRef.current) {
        window.clearTimeout(peerHealthTimeoutRef.current)
        peerHealthTimeoutRef.current = null
      }
      setIsPeerConnected(true)
      setNotice('Secure peer channel established.', 'success')
    })

    peer.on('close', () => {
      setIsPeerConnected(false)
      showSessionEnded('Client disconnected from this room.')
    })

    peer.on('error', (error) => {
      console.error('[host][peer] error', error)
      setNotice(`Handshake error: ${error?.message || 'Unknown peer error'}`, 'error')
    })

    peerRef.current = peer
    detachRtcDiagnosticsRef.current = attachRtcDiagnostics(peer, 'host')
    pendingPeerIdRef.current = ''

    if (peerHealthTimeoutRef.current) {
      window.clearTimeout(peerHealthTimeoutRef.current)
    }
    peerHealthTimeoutRef.current = window.setTimeout(() => {
      setNotice('Connection timed out. Check your network and press Restart Share.', 'error')
    }, 15000)
  }

  const stopStreamHealthMonitor = () => {
    if (!streamHealthIntervalRef.current) return
    window.clearInterval(streamHealthIntervalRef.current)
    streamHealthIntervalRef.current = null
    blackFrameHitsRef.current = 0
  }

  const startStreamHealthMonitor = () => {
    stopStreamHealthMonitor()
    streamHealthIntervalRef.current = window.setInterval(() => {
      const video = videoRef.current
      const canvas = blackFrameCanvasRef.current
      if (!video || !canvas) return
      if (video.videoWidth === 0 || video.videoHeight === 0) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      canvas.width = 32
      canvas.height = 18
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let sum = 0
      for (let i = 0; i < frame.length; i += 4) {
        sum += frame[i] + frame[i + 1] + frame[i + 2]
      }
      const avgBrightness = sum / (frame.length / 4) / 3
      logDebug('black-frame-sample', {
        avgBrightness: Number(avgBrightness).toFixed(2),
        blackHits: blackFrameHitsRef.current,
      })
      if (avgBrightness < 4) {
        blackFrameHitsRef.current += 1
      } else {
        blackFrameHitsRef.current = 0
      }

      if (blackFrameHitsRef.current >= 3) {
        stopStreamHealthMonitor()
        if (blackRecoveryInFlightRef.current) return
        blackRecoveryInFlightRef.current = true
        const currentId = toText(selectedSourceId)
        const fallback = availableSources.find((item) => toText(item.id) && toText(item.id) !== currentId)
        if (!fallback?.id) {
          setNotice('Black screen detected. Please choose a different screen.', 'error')
          blackRecoveryInFlightRef.current = false
          return
        }
        setNotice(`Black screen detected. Switching to ${toText(fallback.name) || 'another screen'}...`, 'error')
        setSelectedSourceId(fallback.id)
        ensureScreenSharingStarted(true).finally(() => {
          blackRecoveryInFlightRef.current = false
        })
      }
    }, 1200)
  }

  const validateStreamHasVisibleFrames = async (stream) => {
    const probeVideo = document.createElement('video')
    probeVideo.muted = true
    probeVideo.playsInline = true
    probeVideo.srcObject = stream
    try {
      await probeVideo.play()
    } catch (error) {
      return false
    }

    const probeCanvas = document.createElement('canvas')
    probeCanvas.width = 32
    probeCanvas.height = 18
    const ctx = probeCanvas.getContext('2d')
    if (!ctx) return false

    // Sample a few frames to avoid false negatives.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 220))
      if (probeVideo.videoWidth === 0 || probeVideo.videoHeight === 0) continue
      ctx.drawImage(probeVideo, 0, 0, probeCanvas.width, probeCanvas.height)
      const frame = ctx.getImageData(0, 0, probeCanvas.width, probeCanvas.height).data
      let sum = 0
      for (let i = 0; i < frame.length; i += 4) {
        sum += frame[i] + frame[i + 1] + frame[i + 2]
      }
      const avgBrightness = sum / (frame.length / 4) / 3
      if (avgBrightness >= 4) return true
    }
    return false
  }

  const captureViaDisplayMedia = async () => {
    console.log('[host][screen-share] trying getDisplayMedia')
    return navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'monitor',
      },
      audio: false,
    })
  }

  const captureViaDesktopSource = async (sourceId) => {
    if (!toText(sourceId)) throw new Error('Missing desktop source id')
    
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: 1280,
          maxWidth: 1920,
          minHeight: 720,
          maxHeight: 1080,
          maxFrameRate: 30
        }
      }
    };
  
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // Fallback to standard capture constraints.
      return await navigator.mediaDevices.getDisplayMedia({
        video: { deviceId: sourceId ? { exact: sourceId } : undefined }
      });
    }
  }

  const fetchScreenSources = async () => {
    if (!window.ipc?.invoke) return { sources: [], primaryDisplayId: '' }
    const sourceResult = await window.ipc.invoke('desktop:screen-sources')
    const sources = Array.isArray(sourceResult?.sources) ? sourceResult.sources : []
    const normalized = sources.map((item) => ({
      id: toText(item?.id),
      name: toText(item?.name) || 'Unknown Screen',
      displayId: toText(item?.displayId),
      thumbnail: toText(item?.thumbnail),
    }))
    setAvailableSources(normalized)
    return {
      primaryDisplayId: toText(sourceResult?.primaryDisplayId),
      sources: normalized,
    }
  }

  const openSourcePicker = async () => {
    if (!window.ipc?.invoke) {
      setNotice('Source picker is unavailable in this environment.', 'error')
      return
    }
    try {
      await fetchScreenSources()
      setIsSourcePickerOpen(true)
    } catch (error) {
      setNotice('Could not load screen list.', 'error')
    }
  }

  const resolvePreferredSourceId = async () => {
    if (!window.ipc?.invoke) return ''
    try {
      const { primaryDisplayId, sources: normalized } = await fetchScreenSources()
      const ordered = sortSourcesForStableShare(normalized, selectedSourceId, primaryDisplayId)
      const preferred =
        ordered[0] ||
        normalized.find((item) => toText(item.id) === toText(selectedSourceId)) ||
        normalized.find((item) => toText(item.displayId) === primaryDisplayId) ||
        normalized[0]
      return toText(preferred?.id)
    } catch (_error) {
      return ''
    }
  }

  const announceHandshakeReady = () => {
    if (!roomId || !hasJoinedRoomRef.current || !localStreamRef.current) return
    if (hasAnnouncedReadyRef.current) return
    hasAnnouncedReadyRef.current = true
    socket.emit('host-handshake-ready', { roomId }, (response) => {
      if (!response?.ok) {
        hasAnnouncedReadyRef.current = false
        setNotice(response?.message || 'Could not start connection.', 'error')
        return
      }
      console.log('[host][handshake] host-ready acknowledged', { roomId })
      setNotice('Host is ready. Waiting for client handshake...', 'info')
    })
  }

  // Step 1: Join room & signaling
  useEffect(() => {
    if (!roomId) return

    if (typeof window !== 'undefined') {
      const policyConsent = window.localStorage.getItem('remotix-policy-consent')
      // Only block explicit rejection. Missing value can happen during cross-device
      // routing or stale local storage sync and should not hard-bounce the host page.
      if (policyConsent === 'rejected') {
        setNotice('Please accept the usage policy before starting a session.', 'error')
        router.replace('/home')
        return
      }
    }

    socket.emit('join-room', {
      roomId,
      role: 'host',
      deviceId: deviceId || '',
      displayName: typeof name === 'string' ? decodeURIComponent(name) : 'Host Device',
    }, (response) => {
      if (!response?.ok) {
        setNotice(response?.message || 'Could not join host room.', 'error')
        return
      }
      hasJoinedRoomRef.current = true
      setIsSignalingActive(true)
      console.log('[host][join-room] success', response)
      if (localStreamRef.current) {
        announceHandshakeReady()
      } else {
        setNotice('Preparing screen share automatically. You can still change source anytime.')
        ensureScreenSharingStarted().then((ok) => {
          if (!ok) openSourcePicker().catch(() => {})
        })
      }
    })

    socket.on('start-handshake', (payload) => {
      const peerId = toText(payload?.peerSocketId)
      if (!peerId) {
        setNotice('Handshake failed: missing peer identity.', 'error')
        return
      }
      console.log('[host][handshake] start-handshake received', payload)
      setIsSignalingActive(true)
      if (!localStreamRef.current) {
        pendingPeerIdRef.current = peerId
        setNotice('A client joined. Please choose a screen to start sharing.')
        openSourcePicker().catch(() => {})
        return
      }
      createPeerConnection(peerId)
      setNotice('Handshake started. Exchanging secure signaling...', 'info')
    })

    socket.on('signal', ({ from, data }) => {
      console.log('[host][signal] received', { from })
      peerRef.current?.signal(data)
    })

    socket.on('join-error', (payload) => {
      setNotice(payload?.message || 'Could not join host room.', 'error')
    })

    socket.on('handshake-error', (payload) => {
      setNotice(payload?.message || 'Host connection has an issue.', 'error')
    })

    socket.on('incoming-connection-request', (request) => {
      setIncomingRequests((prev) => {
        const withoutDup = prev.filter((item) => item.clientSocketId !== request.clientSocketId)
        return [...withoutDup, request]
      })
      setNotice(`Incoming request from ${request.clientDisplayName || 'Unknown Client'}.`)
    })

    socket.on('service-unavailable', (payload) => {
      setDbMessage(payload?.message || 'Cannot connect to database. Service is locked.')
      setNotice('Service is unavailable because the database is not ready.', 'error')
    })

    socket.on('session-ended', (payload) => {
      showSessionEnded(payload?.message || 'Client ended the session.')
    })

    socket.on('client-network-quality', ({ level, rttMs }) => {
      applyStreamQualityProfile(level).catch(() => {})
      if (typeof rttMs === 'number' && rttMs > 0) {
        setLatencyMs(Math.round(rttMs))
      }
    })

    // Step 2: Listen for remote control events
    socket.on('mouse-move', ({ x, y }) => {
      if (allowControl) window.ipc.sendInput('mouse-move', { x, y })
    })

    socket.on('mouse-click', ({ button }) => {
      if (allowControl) window.ipc.sendInput('mouse-click', { button })
    })

    socket.on('mouse-down', ({ button }) => {
      if (allowControl) window.ipc.sendInput('mouse-down', { button })
    })

    socket.on('mouse-up', ({ button }) => {
      if (allowControl) window.ipc.sendInput('mouse-up', { button })
    })

    socket.on('mouse-scroll', ({ deltaX, deltaY }) => {
      if (allowControl) window.ipc.sendInput('mouse-scroll', { deltaX, deltaY })
    })

    socket.on('key-down', ({ code }) => {
      if (allowControl) window.ipc.sendInput('key-down', { code })
    })
    
    socket.on('key-up', ({ code }) => {
      if (allowControl) window.ipc.sendInput('key-up', { code });
    });

    return () => {
      if (peerHealthTimeoutRef.current) {
        window.clearTimeout(peerHealthTimeoutRef.current)
      }
      socket.off('start-handshake');
      socket.off('signal');
      socket.off('join-error');
      socket.off('handshake-error');
      socket.off('mouse-move');
      socket.off('mouse-click');
      socket.off('mouse-down');
      socket.off('mouse-up');
      socket.off('mouse-scroll');
      socket.off('key-down');
      socket.off('key-up');
      socket.off('incoming-connection-request');
      socket.off('service-unavailable');
      socket.off('session-ended');
      socket.off('client-network-quality');
    }
  }, [roomId, allowControl, router])

  useEffect(() => {
    if (!deviceId) return
    const emitHeartbeat = () => {
      socket.emit('host-heartbeat', {
        deviceId: typeof deviceId === 'string' ? deviceId : '',
        displayName: typeof name === 'string' ? decodeURIComponent(name) : 'Host Device',
      })
    }

    if (socket.connected) {
      emitHeartbeat()
    } else {
      socket.once('connect', emitHeartbeat)
    }

    const heartbeatId = window.setInterval(emitHeartbeat, 8000)
    return () => {
      window.clearInterval(heartbeatId)
      socket.off('connect', emitHeartbeat)
    }
  }, [deviceId, name])

  const ensureScreenSharingStarted = async (forceReselect = false) => {
    if (localStreamRef.current && !forceReselect) return true
    if (shareStartPromiseRef.current) return shareStartPromiseRef.current

    const sharingPromise = (async () => {
      setIsPreparingShare(true)
      if (forceReselect) setIsReselectingShare(true)
      try {
        const previousStream = localStreamRef.current
        if (forceReselect && previousStream) {
          previousStream.getTracks().forEach((track) => track.stop())
          localStreamRef.current = null
          setIsSharing(false)
        }

        const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '')
        const preferredSourceId = await resolvePreferredSourceId()
        const finalSourceId = toText(selectedSourceId) || preferredSourceId
        const hasExplicitSource = Boolean(finalSourceId)
        if (isMac && !hasExplicitSource) {
          setNotice('Choose a screen source first, then sharing will start automatically.', 'info')
          setIsSourcePickerOpen(true)
          return false
        }
        if (!toText(selectedSourceId) && finalSourceId) {
          setSelectedSourceId(finalSourceId)
        }
        if (window.ipc?.invoke) {
          await window.ipc.invoke('desktop:set-selected-source', {
            sourceId: finalSourceId,
          })
        }
        const { primaryDisplayId, sources } = await fetchScreenSources()
        const orderedSources = sortSourcesForStableShare(sources, finalSourceId, primaryDisplayId)

        let stream = null
        let resolvedSourceId = ''
        let lastCaptureError = null

        for (const source of orderedSources) {
          try {
            const candidate = await captureViaDesktopSource(source.id)
            if (!candidate) continue
            const hasVisibleFrame = await validateStreamHasVisibleFrames(candidate)
            if (!hasVisibleFrame) {
              candidate.getTracks().forEach((track) => track.stop())
              console.warn('[host][screen-share] desktop source produced black frames, trying next source', source.id)
              continue
            }
            stream = candidate
            resolvedSourceId = source.id
            break
          } catch (captureError) {
            lastCaptureError = captureError
          }
        }

        if (!stream) {
          try {
            const candidate = await captureViaDisplayMedia()
            if (candidate) {
              const hasVisibleFrame = await validateStreamHasVisibleFrames(candidate)
              if (hasVisibleFrame) {
                stream = candidate
                resolvedSourceId = finalSourceId
              } else {
                candidate.getTracks().forEach((track) => track.stop())
              }
            }
          } catch (captureError) {
            lastCaptureError = captureError
          }
        }

        if (!stream) {
          throw lastCaptureError || new Error('No valid screen source could be captured')
        }

        if (resolvedSourceId) {
          setSelectedSourceId(resolvedSourceId)
          if (window.ipc?.invoke) {
            await window.ipc.invoke('desktop:set-selected-source', {
              sourceId: resolvedSourceId,
            })
          }
        }

        localStreamRef.current = stream
        appliedQualityLevelRef.current = ''
        await applyStreamQualityProfile('good')
        const track = stream.getVideoTracks()[0]
        const settings = track?.getSettings?.() || {}
        console.log('[host][screen-share] selected-source', {
          label: track?.label || 'unknown',
          displaySurface: settings.displaySurface || 'unknown',
          width: settings.width || 'unknown',
          height: settings.height || 'unknown',
          readyState: track?.readyState || 'unknown',
          muted: Boolean(track?.muted),
        })
        logDebug('capture-stream-created', {
          trackCount: stream.getVideoTracks().length,
          settings,
        })
        track?.addEventListener?.('mute', () => {
          console.warn('[host][screen-share] video track muted')
          logDebug('track-event-mute')
        })
        track?.addEventListener?.('unmute', () => {
          console.log('[host][screen-share] video track unmuted')
          logDebug('track-event-unmute')
        })

        if (forceReselect && previousStream && peerRef.current?.replaceTrack) {
          const previousTrack = previousStream.getVideoTracks()[0]
          if (previousTrack && track) {
            try {
              peerRef.current.replaceTrack(previousTrack, track, stream)
              setNotice('Screen source updated successfully.', 'success')
            } catch (error) {
              setNotice('Could not switch video track. If screen stays black, press Restart Share.', 'error')
            }
          }
        }

        stream.getVideoTracks().forEach((track) => {
          track.onended = () => {
            localStreamRef.current = null
            setIsSharing(false)
            stopStreamHealthMonitor()
            setNotice('Screen sharing stopped. Approve a request to start sharing again.')
          }
        })

        await attachStreamToPreview(stream)
        setIsSharing(true)
        startStreamHealthMonitor()
        announceHandshakeReady()
        if (pendingPeerIdRef.current) {
          createPeerConnection(pendingPeerIdRef.current)
          setNotice('Client connected. Secure stream is now live.', 'success')
        } else {
          setNotice('Screen sharing started. Waiting for approved client to connect.', 'success')
        }
        return true
      } catch (error) {
        console.error('Screen share error:', error)
        const safeMessage = toText(error?.message) || 'Screen sharing permission was not granted.'
        setNotice(`Could not start screen sharing: ${safeMessage}`, 'error')
        return false
      } finally {
        setIsPreparingShare(false)
        setIsReselectingShare(false)
        shareStartPromiseRef.current = null
      }
    })()

    shareStartPromiseRef.current = sharingPromise
    return sharingPromise
  }

  useEffect(() => {
    if (isSharing && localStreamRef.current && videoRef.current) {
      void attachStreamToPreview(localStreamRef.current)
    }
  }, [isSharing])

  useEffect(() => {
    const handleShortcut = (event) => {
      if (event.key.toLowerCase() === 'c') {
        const next = !allowControl
        setAllowControl(next)
        setNotice(next ? 'Remote control enabled (shortcut C).' : 'Remote control disabled (shortcut C).')
      }
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [allowControl])

  const handleDisconnect = () => {
    isManualDisconnectRef.current = true
    socket.emit('leave-session', {
      roomId: toText(roomId),
      message: 'Host ended the session.',
    })
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop())
    }
    stopStreamHealthMonitor()
    stopStreamDebugMonitor()

    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }
    if (detachRtcDiagnosticsRef.current) {
      detachRtcDiagnosticsRef.current()
      detachRtcDiagnosticsRef.current = null
    }
    setIsPeerConnected(false)
    setIsSignalingActive(false)
    setLatencyMs(null)

    router.push('/home')
  }

  const handleRestartShare = async () => {
    const ok = await ensureScreenSharingStarted(true)
    if (!ok) {
      setNotice('Restart Share failed. Please choose a screen again.', 'error')
      openSourcePicker().catch(() => {})
      return
    }
    setNotice('Screen sharing restarted.', 'success')
  }

  const handleConnectionRequest = async (clientSocketId, approved) => {
    if (approved) {
      const isReady = await ensureScreenSharingStarted()
      if (!isReady) {
        setNotice('Approval failed because screen sharing is not started yet.', 'error')
        return
      }
    }

    socket.emit('respond-connection-request', { clientSocketId, approved }, (response) => {
      if (!response?.ok) {
        setNotice(response?.message || 'Could not process connection request.', 'error')
        return
      }
      if (approved && response?.roomId) {
        console.log('[host][request] approved', response)
      }
    })
    setIncomingRequests((prev) => prev.filter((item) => item.clientSocketId !== clientSocketId))
    setNotice(approved ? 'Connection approved. Client can now join securely.' : 'Connection rejected.', approved ? 'success' : 'error')
  }

  const hostConnectionSteps = [
    { key: 'signaling', label: 'Signaling', done: isSignalingActive },
    { key: 'peer', label: 'Peer', done: isPeerConnected || incomingRequests.length === 0 },
    { key: 'stream', label: 'Stream', done: isSharing },
  ]
  const requiredHostSteps = hostConnectionSteps.filter((step) => step.key !== 'peer')
  const pendingHostStep = requiredHostSteps.find((step) => !step.done)?.label || 'Finalizing'
  const isHostDetailReady = requiredHostSteps.every((step) => step.done)

  if (sessionEndedReason) {
    return (
      <div className={`min-h-screen flex items-center justify-center p-6 ${isDark ? 'bg-[#111318] text-white' : 'bg-slate-100 text-slate-900'}`}>
        <div className={`w-full max-w-lg rounded-xl border p-8 text-center ${isDark ? 'border-slate-600 bg-[#171b24]' : 'border-slate-300 bg-white'}`}>
          <h2 className={`text-2xl font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Connection Ended</h2>
          <p className={`mt-3 text-base ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{toText(sessionEndedReason)}</p>
          <button
            type="button"
            onClick={() => router.push('/home')}
            className="mt-6 px-5 py-2.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm"
          >
            Back to Home
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`min-h-screen relative overflow-hidden ${isDark ? 'bg-[#111318] text-white' : 'bg-slate-100 text-slate-900'}`}>
      <div className={`pointer-events-none absolute -top-16 right-0 h-64 w-64 rounded-full blur-3xl ${isDark ? 'bg-red-500/10' : 'bg-red-300/30'}`} />
      <div className={`relative z-10 w-full h-screen overflow-hidden grid grid-rows-[auto_minmax(0,1fr)_auto] ${isDark ? 'bg-[#171a22]' : 'bg-white'}`}>
        <div className={`px-5 py-3 border-b flex items-center justify-between ${isDark ? 'border-slate-700 bg-[#1c2029]' : 'border-slate-200 bg-slate-50'}`}>
          <div>
            <h1 className={`text-xl font-semibold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Remote Session</h1>
            <p className={`text-[11px] font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Desk ID: {toText(roomId)}</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={toggleTheme}
              className={`px-2.5 py-1.5 rounded-md border ${isDark ? 'border-slate-600 bg-slate-800 text-slate-200' : 'border-slate-300 bg-white text-slate-700'}`}
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              <ThemeGlyph isDark={isDark} />
            </button>
            <span className={`px-2 py-1 rounded-full border ${isSharing
              ? (isDark ? 'bg-emerald-700/40 border-emerald-500/40 text-emerald-300' : 'bg-emerald-100 border-emerald-300 text-emerald-700')
              : (isDark ? 'bg-amber-700/40 border-amber-500/40 text-amber-300' : 'bg-amber-100 border-amber-300 text-amber-700')
            }`}>
              {isSharing ? 'Online' : isPreparingShare ? 'Preparing' : 'Idle'}
            </span>
            {typeof latencyMs === 'number' ? (
              <span className={`${isDark ? 'text-slate-400' : 'text-slate-500'} text-[11px]`}>
                {latencyMs} ms
              </span>
            ) : null}
          </div>
        </div>

        {dbUnavailableMessage ? (
          <div className={`mx-5 mt-3 rounded-lg border px-4 py-3 text-sm ${isDark ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-red-300 bg-red-50 text-red-700'}`}>
            {toText(dbUnavailableMessage)}
          </div>
        ) : null}

        <div className="min-h-0 overflow-hidden p-5">
          {isHostDetailReady ? (
            <div className="h-full grid lg:grid-cols-[minmax(0,1fr)_340px] gap-4">
            <section className={`rounded-xl border overflow-hidden flex flex-col ${isDark ? 'border-slate-700 bg-[#171b24]' : 'border-slate-300 bg-white'}`}>
              <div className={`px-4 py-2.5 text-xs border-b flex items-center justify-between ${isDark ? 'border-slate-700 text-slate-300 bg-[#202531]' : 'border-slate-200 text-slate-600 bg-slate-50'}`}>
                <span>Remote Desk Preview</span>
                <span className="font-mono">{toText(selectedSourceId) || 'auto-source'}</span>
              </div>
              <div className="flex-1 p-3">
                {isSharing ? (
                  <div className="h-full bg-black border border-gray-700 rounded-lg overflow-hidden">
                    <video
                      ref={videoRef}
                      autoPlay
                      muted
                      playsInline
                      className="w-full h-full object-cover"
                    />
                  </div>
                ) : (
                  <div className={`h-full rounded-lg border min-h-[260px] md:min-h-[320px] flex flex-col items-center justify-center text-center px-6 ${isDark ? 'border-slate-700 bg-[#0f172a]' : 'border-slate-300 bg-slate-50'}`}>
                    <WifiSignalIcon isDark={isDark} />
                    <p className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Waiting for remote request</p>
                    <p className={`text-sm mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      Preview starts as soon as session share is ready.
                    </p>
                  </div>
                )}
              </div>
            </section>

            <aside className={`rounded-xl border p-3 overflow-y-auto space-y-3 ${isDark ? 'border-slate-700 bg-[#171b24]' : 'border-slate-300 bg-slate-50'}`}>
              <div className={`rounded-lg border p-3 ${isDark ? 'border-slate-600 bg-[#202531]' : 'border-slate-300 bg-white'}`}>
                <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Session Controls</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => openSourcePicker()}
                    disabled={isPreparingShare || isReselectingShare}
                    className="col-span-2 bg-[#3a404d] hover:bg-[#4a5160] text-white px-3 py-2 rounded-md text-sm transition disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isReselectingShare ? 'Selecting Screen...' : 'Choose Screen'}
                  </button>
                  <button
                    onClick={handleRestartShare}
                    disabled={isPreparingShare || isReselectingShare}
                    className="col-span-2 bg-[#3a404d] hover:bg-[#4a5160] text-white px-3 py-2 rounded-md text-sm transition disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    Restart Share
                  </button>
                  <button
                    onClick={() => {
                      const next = !allowControl
                      setAllowControl(next)
                      setNotice(next ? 'Remote control is enabled.' : 'Remote control is disabled.')
                    }}
                    className={`col-span-2 px-3 py-2 rounded-md text-sm transition ${allowControl ? 'bg-red-700 hover:bg-red-600' : 'bg-red-600 hover:bg-red-500'}`}
                  >
                    {allowControl ? 'Control On' : 'Enable Ctrl'}
                  </button>
                  <button
                    onClick={handleDisconnect}
                    className="col-span-2 bg-red-700 hover:bg-red-600 text-white px-3 py-2 rounded-md text-sm transition"
                  >
                    End Session
                  </button>
                </div>
              </div>

              <div className={`rounded-lg border p-3 text-sm ${isDark ? 'border-slate-600 bg-[#202531] text-slate-200' : 'border-slate-300 bg-white text-slate-700'}`}>
                <p>Control permission: <span className="font-semibold">{allowControl ? 'Allowed' : 'Blocked'}</span></p>
                <p className={`mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Shortcut: press C to toggle control</p>
              </div>

              {incomingRequests.length > 0 ? (
                <div className={`rounded-lg border p-3 space-y-2 ${isDark ? 'border-slate-600 bg-[#202531]' : 'border-slate-300 bg-white'}`}>
                  <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Connection Requests ({incomingRequests.length})</p>
                  {incomingRequests.map((request) => (
                    <div
                      key={request.clientSocketId}
                      className={`rounded-md border px-3 py-2 space-y-2 ${isDark ? 'border-slate-600 bg-[#262d3a]' : 'border-slate-300 bg-slate-50'}`}
                    >
                      <div>
                        <p className="text-sm">{toText(request.clientDisplayName) || 'Unknown Client'}</p>
                        <p className={`text-xs font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                          {toText(request.clientDeviceId) || toText(request.clientSocketId)}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleConnectionRequest(request.clientSocketId, false)}
                          className="flex-1 px-2 py-1.5 text-xs rounded-md bg-[#495063] hover:bg-[#596176] text-white"
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          onClick={() => handleConnectionRequest(request.clientSocketId, true)}
                          className="flex-1 px-2 py-1.5 text-xs rounded-md bg-red-600 hover:bg-red-500 text-white"
                        >
                          Accept
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </aside>
            </div>
          ) : (
            <div className={`h-full rounded-xl border flex flex-col items-center justify-center text-center px-6 ${isDark ? 'border-slate-700 bg-[#171b24]' : 'border-slate-300 bg-white'}`}>
              <div className={`h-12 w-12 rounded-full border-4 border-slate-500/40 border-t-red-500 animate-spin`} />
              <p className={`mt-4 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Preparing remote session...</p>
              <p className={`mt-2 text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Current step: {pendingHostStep}</p>
              <div className="mt-4 space-y-1 text-sm">
                {hostConnectionSteps.map((step) => (
                  <p key={step.key} className={step.done ? (isDark ? 'text-emerald-300' : 'text-emerald-700') : (isDark ? 'text-slate-400' : 'text-slate-500')}>
                    {step.done ? 'Done' : 'Waiting'} - {step.label}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className={`px-5 pb-4 pt-2 border-t space-y-1.5 ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          {isHostDetailReady ? (
            <p className={`text-center text-sm ${isDark ? 'text-gray-400' : 'text-slate-600'}`}>
              {isSharing ? 'You are sharing your screen with approved clients.' : 'No active screen sharing until you approve a request.'}
            </p>
          ) : (
            <p className={`text-center text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              Connecting... please wait.
            </p>
          )}
          <p className={`text-center text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
            {toText(sessionNotice) || 'Keep remote control off until you verify the client identity.'}
          </p>
        </div>
      </div>
      {isSourcePickerOpen ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-4">
          <div className={`w-full max-w-md rounded-xl border p-4 ${isDark ? 'border-slate-600 bg-[#101a2f]' : 'border-slate-300 bg-white'}`}>
            <h3 className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Choose Screen Source</h3>
            <p className={`mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Pick the screen that should be shared to remote clients.</p>
            <div className="mt-3 space-y-2 max-h-72 overflow-y-auto">
              {availableSources.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  onClick={async () => {
                    if (!isScreenSource(source.id)) {
                      setNotice('Window sharing can freeze when minimized. Please choose an entire screen.', 'info')
                      return
                    }
                    setSelectedSourceId(source.id)
                    setIsSourcePickerOpen(false)
                    await ensureScreenSharingStarted(true)
                  }}
                  className={`w-full text-left rounded-md border px-3 py-2 ${isDark ? 'border-slate-600 bg-[#0f172a] hover:bg-slate-700' : 'border-slate-300 bg-slate-50 hover:bg-slate-100'}`}
                >
                  {toText(source.thumbnail) ? (
                    <img
                      src={source.thumbnail}
                      alt={source.name}
                      className="mb-2 h-24 w-full rounded object-cover border border-slate-500/30"
                    />
                  ) : null}
                  <p className="text-sm font-medium">{source.name}</p>
                  <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    {source.id}
                    {!isScreenSource(source.id) ? ' (window capture: may freeze when minimized)' : ''}
                  </p>
                </button>
              ))}
            </div>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => setIsSourcePickerOpen(false)}
                className={`px-3 py-1.5 rounded border text-xs ${isDark ? 'border-slate-600 text-slate-200' : 'border-slate-300 text-slate-700'}`}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <canvas ref={blackFrameCanvasRef} className="hidden" />
    </div>
  )
}
