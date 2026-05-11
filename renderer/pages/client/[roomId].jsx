import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import Peer from 'simple-peer'
import { getSocket } from '../../libs/socket';
import { useTheme } from '../../libs/theme'
import { api } from '../../libs/http'
import { attachRtcDiagnostics, getRtcConfig } from '../../libs/rtc'
import {
  clearSessionResumeToken,
  saveSessionResumeToken,
} from '../../libs/session-resume'
import {
  createSessionEngine,
  getConnectionQualityDescriptor,
  getSessionPhaseMessage,
  SESSION_PHASE,
  SESSION_RECOVERY,
} from '../../libs/session-engine'

const socket = getSocket();
const toPositiveInt = (value, fallback) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}
const QUALITY_SAMPLE_COUNT = toPositiveInt(process.env.NEXT_PUBLIC_QUALITY_SAMPLE_COUNT, 2)
const QUALITY_EMIT_COOLDOWN_MS = toPositiveInt(process.env.NEXT_PUBLIC_QUALITY_EMIT_COOLDOWN_MS, 6000)
const QUALITY_POOR_RTT_MS = toPositiveInt(process.env.NEXT_PUBLIC_QUALITY_POOR_RTT_MS, 240)
const QUALITY_FAIR_RTT_MS = toPositiveInt(process.env.NEXT_PUBLIC_QUALITY_FAIR_RTT_MS, 130)

function WifiSignalIcon({ isDark }) {
  return (
    <div className="relative w-16 h-16 mb-4 flex items-center justify-center">
      <span className={`absolute w-16 h-16 rounded-full animate-ping ${isDark ? 'bg-blue-400/20' : 'bg-blue-600/20'}`} />
      <svg viewBox="0 0 24 24" className={`relative w-10 h-10 ${isDark ? 'text-blue-300' : 'text-blue-600'}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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

/** Next.js `router.query` values may be `string | string[]`. */
const firstQueryString = (value) => {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value) && value.length) {
    const first = value[0]
    if (typeof first === 'string' || typeof first === 'number') return String(first)
  }
  return ''
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

export default function ClientPage() {
  const router = useRouter()
  const { roomId, deviceId, name, targetHostDeviceId, preapproved } = router.query

  const videoRef = useRef(null)
  const remoteViewportRef = useRef(null)
  const blackFrameCanvasRef = useRef(null)
  const [sessionStatus, setSessionStatus] = useState('')
  const [isPointerLocked, setIsPointerLocked] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [lastInputEvent, setLastInputEvent] = useState('No input yet')
  const [hasRemoteStream, setHasRemoteStream] = useState(false)
  const [isSignalingActive, setIsSignalingActive] = useState(false)
  const [isPeerConnected, setIsPeerConnected] = useState(false)
  const [controlProfile, setControlProfile] = useState('normal')
  const [latencyMs, setLatencyMs] = useState(null)
  const [sessionEndedReason, setSessionEndedReason] = useState('')
  const [hostMeta, setHostMeta] = useState(null)
  const hostMetaRef = useRef(null)
  const [approvedRoomId, setApprovedRoomId] = useState('')
  const [dbUnavailableMessage, setDbUnavailableMessage] = useState('')
  const [remoteStreamRevision, setRemoteStreamRevision] = useState(0)
  const [sessionPhase, setSessionPhase] = useState(SESSION_PHASE.IDLE)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const joinedRoomRef = useRef('')
  const pendingSignalsRef = useRef([])
  const handshakeRetryCountRef = useRef(0)
  const autoExitTimeoutRef = useRef(null)
  const hasTriggeredExitRef = useRef(false)
  const detachRtcDiagnosticsRef = useRef(null)
  const lastRemoteStreamRef = useRef(null)
  const mouseDeltaRef = useRef({ x: 0, y: 0 })
  const mouseFrameRef = useRef(null)
  const pressedKeysRef = useRef(new Set())
  const blackFrameHitsRef = useRef(0)
  const blackRefreshRequestedRef = useRef(false)
  const noFrameHitsRef = useRef(0)
  const sessionEngineRef = useRef(null)
  const lastPhaseToastRef = useRef('')
  const qualityCandidateRef = useRef('')
  const qualityCandidateHitsRef = useRef(0)
  const lastEmittedQualityRef = useRef('')
  const lastQualityEmitAtRef = useRef(0)
  const { isDark, toggleTheme } = useTheme()
  const canControlSession = Boolean(approvedRoomId)
  const isWaitingForHostApproval =
    !canControlSession &&
    preapproved !== '1' &&
    !sessionEndedReason &&
    !dbUnavailableMessage
  const controlSensitivityMap = {
    slow: 0.7,
    normal: 1,
    fast: 1.35,
  }

  useEffect(() => {
    sessionEngineRef.current = createSessionEngine({
      onPhaseChange: (phase) => {
        setSessionPhase(phase)
        if (phase === SESSION_PHASE.RECOVERING) {
          setStatus('Connection interrupted. Recovering automatically...')
        }
        if (
          phase !== lastPhaseToastRef.current &&
          (phase === SESSION_PHASE.RECOVERING ||
            phase === SESSION_PHASE.LIVE ||
            phase === SESSION_PHASE.ENDED)
        ) {
          lastPhaseToastRef.current = phase
          const phaseMessage = getSessionPhaseMessage(phase, 'client')
          console.log('[client][phase]', { phase, message: phaseMessage })
        }
      },
      onTelemetry: (entry) => {
        console.log('[client][session-engine]', entry)
      },
    })
    sessionEngineRef.current.setPhase(SESSION_PHASE.REQUESTING)
    return () => {
      sessionEngineRef.current?.destroy()
      sessionEngineRef.current = null
    }
  }, [])

  const setStatus = (message, type = 'info') => {
    const text = toText(message)
    setSessionStatus(text)
    if (text) {
      console.log('[client][status]', { type, message: text })
    }
  }

  const setDbMessage = (message) => {
    const text = toText(message)
    setDbUnavailableMessage(text)
    if (text) console.warn('[client][db]', text)
  }

  const copyDiagnosticsSnapshot = async () => {
    const snapshot = {
      schemaVersion: '1.0.0',
      role: 'client',
      phase: sessionPhase,
      roomId: toText(roomId),
      approvedRoomId: toText(approvedRoomId),
      signalingConnected: isSignalingActive,
      peerConnected: isPeerConnected,
      streamActive: hasRemoteStream,
      allowControl: canControlSession,
      pointerLocked: isPointerLocked,
      fullscreen: isFullscreen,
      controlProfile: toText(controlProfile),
      sourceId: '',
      latencyMs,
      status: toText(sessionStatus),
      timestamp: new Date().toISOString(),
    }

    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      setStatus('Clipboard API is unavailable in this environment.', 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2))
      setStatus('Diagnostics snapshot copied.', 'success')
    } catch (_error) {
      setStatus('Could not copy diagnostics snapshot.', 'error')
    }
  }

  const downloadDiagnosticsSnapshot = () => {
    const snapshot = {
      schemaVersion: '1.0.0',
      role: 'client',
      phase: sessionPhase,
      roomId: toText(roomId),
      approvedRoomId: toText(approvedRoomId),
      signalingConnected: isSignalingActive,
      peerConnected: isPeerConnected,
      streamActive: hasRemoteStream,
      allowControl: canControlSession,
      pointerLocked: isPointerLocked,
      fullscreen: isFullscreen,
      controlProfile: toText(controlProfile),
      sourceId: '',
      latencyMs,
      status: toText(sessionStatus),
      timestamp: new Date().toISOString(),
    }
    try {
      const payload = JSON.stringify(snapshot, null, 2)
      const blob = new Blob([payload], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `remotix-client-snapshot-${Date.now()}.json`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      setStatus('Diagnostics snapshot downloaded.', 'success')
    } catch (_error) {
      setStatus('Could not download diagnostics snapshot.', 'error')
    }
  }

  const updatePhaseFromEvent = (eventName) => {
    const engine = sessionEngineRef.current
    if (!engine) return
    if (eventName === 'request-sent') {
      engine.setPhase(SESSION_PHASE.REQUESTING)
      return
    }
    if (eventName === 'room-joined') {
      engine.setPhase(SESSION_PHASE.JOINED)
      return
    }
    if (eventName === 'handshake-start') {
      engine.setPhase(SESSION_PHASE.HANDSHAKING)
      return
    }
    if (eventName === 'session-ended') {
      engine.setPhase(SESSION_PHASE.ENDED)
    }
  }

  const attachRemoteStream = async (stream) => {
    if (!videoRef.current) return false
    lastRemoteStreamRef.current = stream
    const videoTracks = stream?.getVideoTracks?.() || []
    const hasLiveVideoTrack = videoTracks.some((track) => track?.readyState === 'live')
    if (!hasLiveVideoTrack) {
      console.log('[client][stream] no live video track yet, waiting for track readiness')
      return false
    }
    videoRef.current.srcObject = stream
    try {
      await videoRef.current.play()
      const renderReady = await new Promise((resolve) => {
        const startedAt = Date.now()
        const check = () => {
          const video = videoRef.current
          if (!video) return resolve(false)
          const hasFrame = video.videoWidth > 0 && video.videoHeight > 0
          const hasPlaybackProgress = Number(video.currentTime || 0) > 0
          if (hasFrame || hasPlaybackProgress) {
            resolve(true)
            return
          }
          if (Date.now() - startedAt > 2400) {
            resolve(false)
            return
          }
          window.setTimeout(check, 120)
        }
        check()
      })
      window.setTimeout(() => {
        const video = videoRef.current
        const track = stream?.getVideoTracks?.()[0]
        console.log('[client][stream][diagnostics]', {
          trackReadyState: track?.readyState || 'unknown',
          trackMuted: Boolean(track?.muted),
          videoWidth: video?.videoWidth || 0,
          videoHeight: video?.videoHeight || 0,
          videoCurrentTime: Number(video?.currentTime || 0).toFixed(3),
          videoReadyState: video?.readyState ?? -1,
        })
      }, 1000)
      return renderReady
    } catch (error) {
      console.error('[client][stream] video play failed', error)
      setStatus('Connected, but video playback is blocked. Click Enter Control and try again.', 'error')
      return false
    }
  }

  const reconnectSession = () => {
    const activeRoomId = toText(approvedRoomId || joinedRoomRef.current || roomId)
    if (!activeRoomId) {
      setStatus('Reconnect is not available yet.', 'error')
      return
    }
    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }
    pendingSignalsRef.current = []
    setHasRemoteStream(false)
    setStatus('Reconnecting...')
    announceClientReady(activeRoomId)
  }

  const requestPointerLock = () => {
    if (!canControlSession) return
    if (videoRef.current) {
      videoRef.current.requestPointerLock();
    }
  };

  const toggleFullscreen = async () => {
    const viewport = remoteViewportRef.current
    if (!viewport) return
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
        return
      }
      await viewport.requestFullscreen()
    } catch (_error) {
      setStatus('Could not toggle fullscreen mode.', 'error')
    }
  }

  const showSessionEnded = (reason) => {
    const text = toText(reason) || 'The remote session has ended.'
    setSessionEndedReason(text)
    setStatus(text, 'error')
    if (document.pointerLockElement) {
      document.exitPointerLock()
    }
    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }
    if (videoRef.current?.srcObject) {
      const tracks = videoRef.current.srcObject.getTracks()
      tracks.forEach((track) => track.stop())
      videoRef.current.srcObject = null
    }
    setHasRemoteStream(false)
    setIsPeerConnected(false)
    setIsSignalingActive(false)
  }

  const exitSessionFlow = (reason, delayMs = 1400) => {
    if (hasTriggeredExitRef.current) return
    hasTriggeredExitRef.current = true
    sessionEngineRef.current?.clearTimeoutTask('handshake-retry')
    sessionEngineRef.current?.clearTimeoutTask('stream-timeout')
    setStatus(reason || 'Could not complete connection. Returning to home.', 'error')
    setSessionEndedReason(reason || 'Could not complete connection. Returning to home.')
    autoExitTimeoutRef.current = window.setTimeout(() => {
      router.push('/home')
    }, delayMs)
  }

  const togglePointerLock = () => {
    if (document.pointerLockElement === videoRef.current) {
      document.exitPointerLock()
      return
    }
    requestPointerLock()
  }

  useEffect(() => {
    if (!window.ipc?.invoke) return () => {}
    window.ipc.invoke('session:keep-awake', { enabled: true }).catch(() => {})
    return () => {
      window.ipc.invoke('session:keep-awake', { enabled: false }).catch(() => {})
    }
  }, [])

  useEffect(() => {
    const activeRoomId = toText(approvedRoomId || roomId)
    if (!activeRoomId) return
    const writeToken = () => {
      saveSessionResumeToken({
        role: 'client',
        roomId: activeRoomId,
        deviceId: toText(deviceId),
        displayName: typeof name === 'string' ? decodeURIComponent(name) : 'Client Device',
        targetHostDeviceId: toText(targetHostDeviceId),
      })
    }
    writeToken()
    const tokenInterval = window.setInterval(writeToken, 10_000)
    return () => window.clearInterval(tokenInterval)
  }, [approvedRoomId, roomId, deviceId, name, targetHostDeviceId])

  useEffect(() => {
    const handlePointerLockChange = () => {
      const isLocked = document.pointerLockElement === videoRef.current;
      setIsPointerLocked(isLocked)
      document.body.style.cursor = isLocked ? 'none' : 'default';
    };
  
    const handlePointerLockError = () => {
      console.error('❌ Pointer Lock failed');
    };
  
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    document.addEventListener('pointerlockerror', handlePointerLockError);
  
    return () => {
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      document.removeEventListener('pointerlockerror', handlePointerLockError);
    };
  }, []);  

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  const peerRef = useRef(null)

  const createPeerConnection = (peerSocketId, initiator = false) => {
    if (!peerSocketId) return
    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }
    if (detachRtcDiagnosticsRef.current) {
      detachRtcDiagnosticsRef.current()
      detachRtcDiagnosticsRef.current = null
    }

    const peer = new Peer({
      initiator,
      trickle: false,
      config: getRtcConfig(),
    })

    peer.on('signal', (signalData) => {
      console.log('[client][signal] send', { to: peerSocketId, initiator })
      socket.emit('signal', { to: peerSocketId, from: socket.id, data: signalData })
    })

    peer.on('stream', (stream) => {
      // Keep loading UI active until we can attach and render frames.
      setHasRemoteStream(false)
      lastRemoteStreamRef.current = stream
      setRemoteStreamRevision((current) => current + 1)
      sessionEngineRef.current?.clearTimeoutTask('stream-timeout')
      const videoTrack = stream.getVideoTracks?.()[0]
      const settings = videoTrack?.getSettings?.() || {}
      console.log('[client][stream] received', {
        trackLabel: videoTrack?.label || 'unknown',
        width: settings.width || 'unknown',
        height: settings.height || 'unknown',
        readyState: videoTrack?.readyState || 'unknown',
        muted: Boolean(videoTrack?.muted),
      })
      if (videoTrack) {
        videoTrack.onunmute = () => {
          console.log('[client][stream] video track unmuted, retry attach')
          setRemoteStreamRevision((current) => current + 1)
          void attachRemoteStream(stream).then((ok) => {
            if (ok) setHasRemoteStream(true)
          })
        }
      }
      attachRemoteStream(stream).then((ok) => {
        if (ok) {
          setHasRemoteStream(true)
          sessionEngineRef.current?.markHealthy()
          setStatus('Live stream ready. Click on video to control.', 'success')
          return
        }
        setHasRemoteStream(false)
        setStatus('Stream received. Waiting for first video frames...', 'info')
      })

      const ownerDeviceId = firstQueryString(deviceId).trim()
      const peerDeviceId =
        toText(hostMetaRef.current?.hostDeviceId).trim() ||
        firstQueryString(targetHostDeviceId).trim()
      const activeRoom = firstQueryString(approvedRoomId).trim() || firstQueryString(roomId).trim()
      if (peerDeviceId && ownerDeviceId && activeRoom) {
        api
          .post('/pairings/save', {
            ownerDeviceId,
            ownerLabel: typeof name === 'string' ? decodeURIComponent(name) : 'Client Device',
            peerDeviceId,
            peerLabel: hostMetaRef.current?.hostDisplayName || 'Host Device',
            roomId: activeRoom,
          })
          .catch((err) => {
            console.warn('[client][pairings] save failed', err?.message || err)
          })
      }
    })

    peer.on('track', (_track, stream) => {
      if (!stream) return
      lastRemoteStreamRef.current = stream
      setRemoteStreamRevision((current) => current + 1)
    })

    peer.on('error', (error) => {
      console.error('[client][peer] error', error)
      setStatus(`Handshake error: ${error?.message || 'Unknown peer error'}`, 'error')
    })

    peer.on('close', () => {
      setIsPeerConnected(false)
      const didSchedule = sessionEngineRef.current?.scheduleRecovery(
        SESSION_RECOVERY.PEER,
        reconnectSession,
      )
      if (!didSchedule) {
        exitSessionFlow('Connection dropped repeatedly. Returning to home.')
      }
    })

    peer.on('connect', () => {
      setIsPeerConnected(true)
      sessionEngineRef.current?.setPhase(SESSION_PHASE.HANDSHAKING)
    })

    peerRef.current = peer
    detachRtcDiagnosticsRef.current = attachRtcDiagnostics(peer, 'client')
    sessionEngineRef.current?.setTimeoutTask('stream-timeout', 18000, () => {
      if (!videoRef.current?.srcObject) {
        const didSchedule = sessionEngineRef.current?.scheduleRecovery(
          SESSION_RECOVERY.STREAM,
          reconnectSession,
        )
        if (!didSchedule) {
          exitSessionFlow('Video stream recovery exceeded retry limit.')
          return
        }
        setStatus('Video took too long to arrive. Reconnecting automatically...', 'error')
      }
    })

    if (pendingSignalsRef.current.length > 0) {
      pendingSignalsRef.current.forEach((signalPayload) => {
        peerRef.current?.signal(signalPayload)
      })
      pendingSignalsRef.current = []
    }
  }

  const announceClientReady = (targetRoomId) => {
    if (!targetRoomId) return
    socket.emit('client-handshake-ready', { roomId: targetRoomId }, (response) => {
      if (!response?.ok) {
        exitSessionFlow(response?.message || 'Could not mark client handshake ready.')
        return
      }
      if (response?.pendingHost) {
        handshakeRetryCountRef.current += 1
        if (handshakeRetryCountRef.current > 8) {
          exitSessionFlow('Host is not ready for this room. Returning to home.')
          return
        }
        sessionEngineRef.current?.setTimeoutTask('handshake-retry', 1200, () => {
          announceClientReady(targetRoomId)
        })
        setStatus(response?.message || 'Waiting for host readiness...')
        return
      }
      handshakeRetryCountRef.current = 0
      sessionEngineRef.current?.clearTimeoutTask('handshake-retry')
      console.log('[client][handshake] client-ready acknowledged', response)
      setStatus('Joined room. Waiting for host to start connection...')
    })
  }

  useEffect(() => {
    if (!roomId) return;

    if (typeof window !== 'undefined') {
      const policyConsent = window.localStorage.getItem('remotix-policy-consent')
      if (policyConsent !== 'accepted') {
        router.replace('/home')
        return
      }
    }
  
    const joinClientRoom = (targetRoomId) => {
      socket.emit('join-room', {
        roomId: targetRoomId,
        role: 'client',
        deviceId: deviceId || '',
        displayName: typeof name === 'string' ? decodeURIComponent(name) : 'Client Device',
      }, (response) => {
        if (!response?.ok) {
          setStatus(response?.message || 'Could not join room.', 'error')
          return
        }
        joinedRoomRef.current = targetRoomId
        setIsSignalingActive(true)
        updatePhaseFromEvent('room-joined')
        console.log('[client][join-room] success', response)
        announceClientReady(targetRoomId)
      })
    }

    const handleJoin = () => {
      const isPreapproved = preapproved === '1'
      if (isPreapproved) {
        setApprovedRoomId(roomId)
        setStatus('Joining approved session...')
        const th = firstQueryString(targetHostDeviceId).trim()
        if (th) {
          const meta = {
            exists: true,
            hostDeviceId: th,
            hostDisplayName: '',
            roomId: firstQueryString(roomId),
          }
          hostMetaRef.current = meta
          setHostMeta(meta)
        }
        joinClientRoom(roomId)
        return
      }

      console.log('🟢 Client socket connected. Requesting access for room:', roomId);
      setStatus('Sending request to host...')
      updatePhaseFromEvent('request-sent')
      socket.emit('get-room-host-meta', roomId, (meta) => {
        if (meta?.exists) {
          setHostMeta(meta)
          hostMetaRef.current = meta
        }
      });
      socket.emit(
        'request-connection',
        {
          roomId,
          targetHostDeviceId:
            firstQueryString(targetHostDeviceId).trim() ||
            toText(hostMetaRef.current?.hostDeviceId).trim() ||
            '',
          clientDeviceId: firstQueryString(deviceId),
          clientDisplayName: typeof name === 'string' ? decodeURIComponent(name) : 'Client Device',
        },
        (response) => {
          if (!response?.ok) {
            exitSessionFlow(response?.message || 'Could not send request to host.')
            return
          }
          setStatus(response.message)
        }
      )
    };
  
    if (socket.connected) {
      handleJoin();
    } else {
      socket.once('connect', handleJoin);
    }
  
    socket.on('peer-joined', () => {
      console.log('✅ Peer joined');
      setStatus('Host found. Connecting...')
    });

    socket.on('connection-approved', (payload) => {
      const acceptedRoomId = payload?.roomId || roomId
      setApprovedRoomId(acceptedRoomId)
      setStatus('Host approved. Opening remote screen...', 'success')
      updatePhaseFromEvent('room-joined')
      joinClientRoom(acceptedRoomId)
    })

    socket.on('connection-rejected', (payload) => {
      exitSessionFlow(payload?.message || 'Connection request was rejected by host.')
    })

    socket.on('join-denied', (payload) => {
      exitSessionFlow(payload?.message || 'Join denied by host policy.')
    })

    socket.on('service-unavailable', (payload) => {
      const message = payload?.message || 'Cannot connect to database. Service is locked.'
      setDbMessage(message)
      exitSessionFlow(message)
    })

    socket.on('join-error', (payload) => {
      exitSessionFlow(payload?.message || 'Could not join room.')
    })

    socket.on('handshake-error', (payload) => {
      exitSessionFlow(payload?.message || 'Handshake error on client side.')
    })

    socket.on('disconnect', () => {
      setIsSignalingActive(false)
      const didSchedule = sessionEngineRef.current?.scheduleRecovery(
        SESSION_RECOVERY.SOCKET,
        reconnectSession,
      )
      if (!didSchedule) {
        exitSessionFlow('Socket connection dropped repeatedly. Returning to home.')
        return
      }
      setStatus('Connection lost. Attempting automatic recovery...', 'error')
    })

    socket.on('connect_error', () => {
      setStatus('Network error while connecting to signaling server.', 'error')
    })

    socket.on('reconnect', () => {
      setStatus('Connection restored. Rejoining session...', 'success')
      setIsSignalingActive(true)
      updatePhaseFromEvent('room-joined')
      reconnectSession()
    })

    socket.on('start-handshake', (payload) => {
      const peerSocketId = toText(payload?.peerSocketId)
      if (!peerSocketId) {
        setStatus('Handshake failed: missing peer identity.', 'error')
        return
      }
      console.log('[client][handshake] start-handshake received', payload)
      setIsSignalingActive(true)
      updatePhaseFromEvent('handshake-start')
      createPeerConnection(peerSocketId, false)
      setStatus('Receiving host screen...')
    })
  
    socket.on('signal', ({ from, data }) => {
      console.log('[client][signal] received', { from })
      if (!peerRef.current) {
        pendingSignalsRef.current.push(data)
        setStatus('Signaling received before handshake start. Waiting for handshake...')
        return
      }
      peerRef.current.signal(data)
    });

    socket.on('session-ended', (payload) => {
      updatePhaseFromEvent('session-ended')
      showSessionEnded(payload?.message || 'Host ended the session.')
    })
  
    return () => {
      sessionEngineRef.current?.clearTimeoutTask('handshake-retry')
      sessionEngineRef.current?.clearTimeoutTask('stream-timeout')
      if (autoExitTimeoutRef.current) {
        window.clearTimeout(autoExitTimeoutRef.current)
      }
      socket.off('connect', handleJoin);
      socket.off('peer-joined');
      socket.off('signal');
      socket.off('connection-approved');
      socket.off('connection-rejected');
      socket.off('join-denied');
      socket.off('service-unavailable');
      socket.off('join-error');
      socket.off('handshake-error');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off('reconnect');
      socket.off('start-handshake');
      socket.off('session-ended');
    };
    }, [roomId, router, deviceId, name, targetHostDeviceId, preapproved]);

  useEffect(() => {
    const leaveCurrentSession = () => {
      const activeRoomId = toText(approvedRoomId || joinedRoomRef.current || roomId)
      if (!activeRoomId) return
      socket.emit('leave-session', {
        roomId: activeRoomId,
        message: 'Client left the session.',
      })
    }
    window.addEventListener('beforeunload', leaveCurrentSession)
    window.addEventListener('pagehide', leaveCurrentSession)
    return () => {
      window.removeEventListener('beforeunload', leaveCurrentSession)
      window.removeEventListener('pagehide', leaveCurrentSession)
    }
  }, [approvedRoomId, roomId])
  

  // Send remote input events
  useEffect(() => {
    const activeRoomId = () => approvedRoomId || roomId

    const flushMouseDelta = () => {
      mouseFrameRef.current = null
      if (document.pointerLockElement !== videoRef.current) return
      const room = activeRoomId()
      if (!room) return
      const sensitivity = controlSensitivityMap[controlProfile] || 1
      const dx = Math.round(mouseDeltaRef.current.x * sensitivity)
      const dy = Math.round(mouseDeltaRef.current.y * sensitivity)
      mouseDeltaRef.current = { x: 0, y: 0 }
      if (!dx && !dy) return
      socket.emit('mouse-move', {
        x: dx,
        y: dy,
        roomId: room,
      })
    }

    const scheduleMouseFlush = () => {
      if (mouseFrameRef.current) return
      mouseFrameRef.current = window.requestAnimationFrame(flushMouseDelta)
    }

    const handleMouseMove = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      mouseDeltaRef.current.x += e.movementX
      mouseDeltaRef.current.y += e.movementY
      scheduleMouseFlush()
    };

    const handleClick = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      const room = activeRoomId()
      if (!room) return
      socket.emit('mouse-click', { button: e.button, roomId: room })
      setLastInputEvent(`Mouse click (${e.button})`)
    }

    const handleMouseDown = (e) => {
      if (document.pointerLockElement !== videoRef.current) return
      const room = activeRoomId()
      if (!room) return
      socket.emit('mouse-down', { button: e.button, roomId: room })
      setLastInputEvent(`Mouse down (${e.button})`)
    }

    const handleMouseUp = (e) => {
      if (document.pointerLockElement !== videoRef.current) return
      const room = activeRoomId()
      if (!room) return
      socket.emit('mouse-up', { button: e.button, roomId: room })
      setLastInputEvent(`Mouse up (${e.button})`)
    }

    const handleWheel = (e) => {
      if (document.pointerLockElement !== videoRef.current) return
      const room = activeRoomId()
      if (!room) return
      socket.emit('mouse-scroll', {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        roomId: room,
      })
      setLastInputEvent('Mouse scroll')
    }

    const handleKeyUp = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      const room = activeRoomId()
      if (!room) return
      pressedKeysRef.current.delete(e.code)
      socket.emit('key-up', { code: e.code, roomId: room });
      setLastInputEvent(`Key up (${e.code})`)
    };

    const handleKeyDown = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      const room = activeRoomId()
      if (!room) return
      if (pressedKeysRef.current.has(e.code)) return
      pressedKeysRef.current.add(e.code)
      socket.emit('key-down', { code: e.code, roomId: room })
      setLastInputEvent(`Key down (${e.code})`)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('click', handleClick)
    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('wheel', handleWheel, { passive: true })
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      if (mouseFrameRef.current) {
        window.cancelAnimationFrame(mouseFrameRef.current)
        mouseFrameRef.current = null
      }
      mouseDeltaRef.current = { x: 0, y: 0 }
      pressedKeysRef.current.clear()
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('click', handleClick)
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('wheel', handleWheel)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [roomId, approvedRoomId, controlProfile])

  useEffect(() => {
    if (!lastRemoteStreamRef.current || !videoRef.current) return
    let retryCount = 0
    let retryTimer = null
    const tryAttach = () => {
      void attachRemoteStream(lastRemoteStreamRef.current).then((ok) => {
        if (ok) {
          setHasRemoteStream(true)
          return
        }
        if (retryCount >= 8) return
        retryCount += 1
        retryTimer = window.setTimeout(tryAttach, 250)
      })
    }
    tryAttach()
    return () => {
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [remoteStreamRevision])

  useEffect(() => {
    if (!hasRemoteStream) {
      if (videoRef.current && !lastRemoteStreamRef.current) {
        videoRef.current.pause()
        videoRef.current.srcObject = null
      }
      return
    }
    if (!videoRef.current || !lastRemoteStreamRef.current) return
    void attachRemoteStream(lastRemoteStreamRef.current)
  }, [hasRemoteStream])

  useEffect(() => {
    if (!hasRemoteStream) return
    const intervalId = window.setInterval(() => {
      const video = videoRef.current
      const canvas = blackFrameCanvasRef.current
      if (!video || !canvas) return
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        noFrameHitsRef.current += 1
        if (noFrameHitsRef.current >= 5 && !blackRefreshRequestedRef.current) {
          blackRefreshRequestedRef.current = true
          noFrameHitsRef.current = 0
          const activeRoomId = toText(approvedRoomId || roomId)
          if (!activeRoomId) return
          setStatus('Stream connected but no video frames yet. Requesting host refresh...')
          socket.emit('client-request-stream-refresh', {
            roomId: activeRoomId,
            reason: 'client-no-frame',
          })
        }
        return
      }
      noFrameHitsRef.current = 0

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

      if (avgBrightness < 4) {
        blackFrameHitsRef.current += 1
      } else {
        blackFrameHitsRef.current = 0
        blackRefreshRequestedRef.current = false
        noFrameHitsRef.current = 0
      }

      if (blackFrameHitsRef.current >= 3 && !blackRefreshRequestedRef.current) {
        blackRefreshRequestedRef.current = true
        blackFrameHitsRef.current = 0
        const activeRoomId = toText(approvedRoomId || roomId)
        if (!activeRoomId) return
        setStatus('Black screen detected. Requesting host refresh...')
        socket.emit('client-request-stream-refresh', {
          roomId: activeRoomId,
          reason: 'client-black-frame',
        })
      }
    }, 1200)

    return () => window.clearInterval(intervalId)
  }, [hasRemoteStream, approvedRoomId, roomId])

  useEffect(() => {
    if (hasRemoteStream) return
    if (!lastRemoteStreamRef.current || !videoRef.current) return
    const timer = window.setTimeout(() => {
      void attachRemoteStream(lastRemoteStreamRef.current).then((ok) => {
        if (ok) setHasRemoteStream(true)
      })
    }, 600)
    return () => window.clearTimeout(timer)
  }, [hasRemoteStream, sessionStatus])

  useEffect(() => {
    if (hasRemoteStream) return
    const video = videoRef.current
    if (!video) return
    // Prevent stale frame playback before new stream is actually attached.
    video.pause()
    if (!lastRemoteStreamRef.current) {
      video.srcObject = null
    }
  }, [hasRemoteStream])

  useEffect(() => {
    if (!hasRemoteStream) return
    const video = videoRef.current
    if (!video?.srcObject) return

    let attempts = 0
    const retryTimer = window.setInterval(() => {
      const currentVideo = videoRef.current
      if (!currentVideo?.srcObject) return
      if (!currentVideo.paused) {
        window.clearInterval(retryTimer)
        return
      }
      attempts += 1
      void currentVideo.play().catch(() => {})
      if (attempts >= 6) {
        window.clearInterval(retryTimer)
      }
    }, 700)

    return () => window.clearInterval(retryTimer)
  }, [hasRemoteStream])

  useEffect(() => {
    const room = toText(approvedRoomId || roomId)
    if (!room) return

    const detectConnectionLevel = async () => {
      const pc = peerRef.current?._pc
      if (!pc || typeof pc.getStats !== 'function') return
      try {
        const stats = await pc.getStats()
        const entries = Array.from(stats.values())
        const candidatePairs = entries.filter((entry) => entry.type === 'candidate-pair')
        const selected =
          candidatePairs.find((pair) => pair.nominated && pair.state === 'succeeded') ||
          candidatePairs.find((pair) => pair.selected)
        const rttSeconds = Number(selected?.currentRoundTripTime || 0)
        if (!rttSeconds) return
        const rttMs = rttSeconds * 1000
        const level = rttMs > QUALITY_POOR_RTT_MS ? 'poor' : rttMs > QUALITY_FAIR_RTT_MS ? 'fair' : 'good'
        setLatencyMs(Math.round(rttMs))
        if (qualityCandidateRef.current === level) {
          qualityCandidateHitsRef.current += 1
        } else {
          qualityCandidateRef.current = level
          qualityCandidateHitsRef.current = 1
        }

        const isWorseningToPoor = level === 'poor' && lastEmittedQualityRef.current !== 'poor'
        const hasEnoughSamples = qualityCandidateHitsRef.current >= QUALITY_SAMPLE_COUNT
        const now = Date.now()
        const cooldownPassed = now - lastQualityEmitAtRef.current >= QUALITY_EMIT_COOLDOWN_MS

        if (!isWorseningToPoor && !hasEnoughSamples) return
        if (!cooldownPassed && level === lastEmittedQualityRef.current) return
        if (!cooldownPassed && !isWorseningToPoor) return

        socket.emit('client-network-quality', { roomId: room, level, rttMs })
        lastEmittedQualityRef.current = level
        lastQualityEmitAtRef.current = now
      } catch (_error) {
        // Ignore stats error and retry next interval.
      }
    }

    const timer = window.setInterval(detectConnectionLevel, 4000)
    return () => window.clearInterval(timer)
  }, [approvedRoomId, roomId, isPeerConnected, hasRemoteStream])

  const handleDisconnect = () => {
    socket.emit('leave-session', {
      roomId: toText(approvedRoomId || roomId),
      message: 'Client ended the session.',
    })
    if (document.pointerLockElement) {
      document.exitPointerLock()
    }

    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }
    if (detachRtcDiagnosticsRef.current) {
      detachRtcDiagnosticsRef.current()
      detachRtcDiagnosticsRef.current = null
    }

    if (videoRef.current?.srcObject) {
      const tracks = videoRef.current.srcObject.getTracks()
      tracks.forEach((track) => track.stop())
      videoRef.current.srcObject = null
    }
    setHasRemoteStream(false)
    setIsPeerConnected(false)
    setIsSignalingActive(false)
    setLatencyMs(null)
    blackFrameHitsRef.current = 0
    blackRefreshRequestedRef.current = false
    noFrameHitsRef.current = 0
    clearSessionResumeToken()

    router.push('/home')
  }

  const handleCancelPendingRequest = () => {
    const pendingRoomId = toText(roomId)
    if (pendingRoomId) {
      socket.emit('leave-session', {
        roomId: pendingRoomId,
        message: 'Client cancelled connection request.',
      })
    }
    router.push('/home')
  }

  const clientConnectionSteps = [
    { key: 'signaling', label: 'Signaling', done: isSignalingActive },
    { key: 'peer', label: 'Peer', done: isPeerConnected || hasRemoteStream },
    { key: 'stream', label: 'Stream', done: hasRemoteStream },
  ]
  const requiredClientSteps = clientConnectionSteps.filter((step) => step.key !== 'stream')
  const isClientDetailReady = requiredClientSteps.every((step) => step.done)
  const sessionPhaseLabel = getSessionPhaseMessage(sessionPhase, 'client')
  const effectiveSessionStatus = toText(sessionStatus) || sessionPhaseLabel
  const quality = getConnectionQualityDescriptor(latencyMs, sessionPhase)
  const qualityClass = quality.tone === 'healthy'
    ? (isDark ? 'bg-emerald-700/30 border-emerald-500/40 text-emerald-200' : 'bg-emerald-100 border-emerald-300 text-emerald-700')
    : quality.tone === 'warning'
      ? (isDark ? 'bg-amber-700/30 border-amber-500/40 text-amber-200' : 'bg-amber-100 border-amber-300 text-amber-700')
      : quality.tone === 'critical'
        ? (isDark ? 'bg-red-700/30 border-red-500/40 text-red-200' : 'bg-red-100 border-red-300 text-red-700')
        : (isDark ? 'bg-slate-700/40 border-slate-500/40 text-slate-300' : 'bg-slate-100 border-slate-300 text-slate-700')

  useEffect(() => {
    const engine = sessionEngineRef.current
    if (!engine || !roomId || isClientDetailReady) {
      engine?.clearTimeoutTask('connect-timeout')
      return
    }
    engine.setTimeoutTask('connect-timeout', 25000, () => {
      exitSessionFlow('Connection timed out. Returning to home.')
    })
    return () => {
      engine.clearTimeoutTask('connect-timeout')
    }
  }, [roomId, isClientDetailReady])

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

  if (isWaitingForHostApproval) {
    return (
      <div className={`min-h-screen relative overflow-hidden ${isDark ? 'bg-[#1b1730] text-white' : 'bg-slate-100 text-slate-900'}`}>
        <div className={`pointer-events-none absolute inset-0 ${isDark ? 'bg-[radial-gradient(circle_at_center,rgba(120,100,220,0.20),rgba(20,20,35,0.95))]' : 'bg-[radial-gradient(circle_at_center,rgba(99,102,241,0.18),rgba(241,245,249,0.92))]'}`} />
        <div className="relative z-10 min-h-screen flex items-center justify-center p-6">
          <div className={`w-full max-w-md rounded-2xl border shadow-2xl px-6 py-5 ${isDark ? 'border-slate-600 bg-[#2b2f3a]/95' : 'border-slate-300 bg-white/95'}`}>
            <h2 className={`text-2xl font-semibold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Connecting...</h2>
            <p className={`mt-3 text-base leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Please wait for the remote side to accept your session request.
            </p>
            <div className="mt-5 flex items-center justify-between">
              <span className={`inline-flex h-5 w-5 rounded-full border-2 border-current border-t-transparent animate-spin ${isDark ? 'text-blue-300' : 'text-blue-600'}`} aria-hidden="true" />
              <button
                type="button"
                onClick={handleCancelPendingRequest}
                className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`min-h-screen relative overflow-hidden ${isDark ? 'bg-[#111318] text-white' : 'bg-slate-100 text-slate-900'}`}>
      <div className={`pointer-events-none absolute -top-16 left-0 h-64 w-64 rounded-full blur-3xl ${isDark ? 'bg-red-500/10' : 'bg-red-300/30'}`} />
      <div className={`relative z-10 w-full h-screen overflow-hidden grid grid-rows-[auto_minmax(0,1fr)] ${isDark ? 'bg-[#171a22]' : 'bg-white'}`}>
        <div className={`px-4 py-2 border-b flex items-center justify-between ${isDark ? 'border-slate-700 bg-[#1c2029]' : 'border-slate-200 bg-slate-50'}`}>
          <div>
            <h1 className={`text-lg font-semibold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Remote Viewer</h1>
            {hostMeta?.hostDisplayName ? (
              <p className={`text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Host: {toText(hostMeta.hostDisplayName)}</p>
            ) : null}
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
            <span className={`px-2 py-1 rounded-full border ${isPointerLocked
              ? (isDark ? 'bg-emerald-700/40 border-emerald-500/40 text-emerald-300' : 'bg-emerald-100 border-emerald-300 text-emerald-700')
              : (isDark ? 'bg-slate-700/50 border-slate-600 text-slate-300' : 'bg-slate-100 border-slate-300 text-slate-700')
            }`}>
              {isPointerLocked ? 'Control On' : canControlSession ? 'Approved' : 'Pending'}
            </span>
            <span className={`text-[11px] px-2 py-1 rounded-full border ${qualityClass}`}>
              {quality.label}
              {typeof latencyMs === 'number' && latencyMs > 0 ? ` - ${latencyMs} ms` : ''}
            </span>
          </div>
        </div>

        {dbUnavailableMessage ? (
          <div className={`mx-5 mt-3 rounded-lg border px-4 py-3 text-sm ${isDark ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-red-300 bg-red-50 text-red-700'}`}>
            {toText(dbUnavailableMessage)}
          </div>
        ) : null}

        <div className="min-h-0 overflow-hidden p-0">
          {isClientDetailReady ? (
            <div className={`h-full grid ${isFullscreen ? 'grid-cols-1' : 'lg:grid-cols-[minmax(0,1fr)_260px] xl:grid-cols-[minmax(0,1fr)_280px]'} gap-0`}>
            <section
              ref={remoteViewportRef}
              className={`overflow-hidden flex flex-col ${isDark ? 'bg-[#171b24]' : 'bg-white'}`}
            >
              <div className={`px-3 py-2 text-xs flex items-center justify-between ${isDark ? 'text-slate-300 bg-[#202531]' : 'text-slate-600 bg-slate-50'}`}>
                <span>Host Screen</span>
                <span className="font-mono">{hasRemoteStream ? 'live' : 'waiting'}</span>
              </div>
              <div className="flex-1 p-0">
                <div className="relative h-full bg-black overflow-hidden">
                  <video
                    ref={videoRef}
                    autoPlay
                    muted
                    playsInline
                    className={`w-full h-full object-contain ${hasRemoteStream ? 'opacity-100' : 'opacity-0'}`}
                    onClick={requestPointerLock}
                    onLoadedData={() => {
                      if (lastRemoteStreamRef.current) setHasRemoteStream(true)
                    }}
                    onCanPlay={() => {
                      if (lastRemoteStreamRef.current) setHasRemoteStream(true)
                    }}
                  />
                  {!hasRemoteStream ? (
                    <div className="absolute inset-0 flex items-center justify-center bg-black">
                      <div className={`h-12 w-12 rounded-full border-4 border-t-transparent animate-spin ${
                        isDark ? 'border-slate-500' : 'border-slate-300'
                      }`} />
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            {!isFullscreen ? (
            <aside className={`p-2 overflow-y-auto space-y-2 ${isDark ? 'bg-[#171b24]' : 'bg-slate-50'}`}>
              <div className={`rounded-lg border p-2.5 ${isDark ? 'border-slate-600 bg-[#202531]' : 'border-slate-300 bg-white'}`}>
                <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Session Controls</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    onClick={togglePointerLock}
                    disabled={!canControlSession}
                    className={`col-span-2 px-3 py-2 rounded-md text-sm text-white transition disabled:opacity-50 disabled:cursor-not-allowed ${isPointerLocked ? 'bg-amber-600 hover:bg-amber-500' : 'bg-cyan-600 hover:bg-cyan-500'}`}
                  >
                    {isPointerLocked ? 'Exit Control' : 'Enter Control'}
                  </button>
                  <button
                    onClick={toggleFullscreen}
                    className="col-span-2 px-3 py-2 rounded-md text-sm transition bg-[#3a404d] hover:bg-[#4a5160] text-white"
                  >
                    {isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
                  </button>
                  <button
                    onClick={() => setShowDiagnostics((current) => !current)}
                    className="col-span-2 px-3 py-2 rounded-md text-sm transition bg-[#3a404d] hover:bg-[#4a5160] text-white"
                  >
                    {showDiagnostics ? 'Hide Diagnostics' : 'Show Diagnostics'}
                  </button>
                  <label className="col-span-2 text-xs text-left">
                    <span className={`${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Control sensitivity</span>
                    <select
                      value={controlProfile}
                      onChange={(event) => setControlProfile(event.target.value)}
                      className={`mt-1 w-full rounded-md border px-2 py-2 text-sm ${isDark ? 'border-slate-600 bg-[#2a3040] text-slate-100' : 'border-slate-300 bg-white text-slate-800'}`}
                    >
                      <option value="slow">Slow</option>
                      <option value="normal">Normal</option>
                      <option value="fast">Fast</option>
                    </select>
                  </label>
                  <button
                    onClick={handleDisconnect}
                    className="col-span-2 px-3 py-2 rounded-md text-sm transition bg-red-700 hover:bg-red-600 text-white"
                  >
                    End Session
                  </button>
                </div>
              </div>

              <div className={`rounded-lg border p-2.5 text-sm ${isDark ? 'border-slate-600 bg-[#202531] text-slate-200' : 'border-slate-300 bg-white text-slate-700'}`}>
                <p>{effectiveSessionStatus}</p>
                <p className={`mt-1 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                  {isPointerLocked
                    ? 'Control mode active (Esc to unlock).'
                    : canControlSession
                      ? 'Approved. Click video or use Enter Control to start input.'
                      : 'Waiting for host approval before entering live control.'}
                </p>
                <p className={`mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Last input: {toText(lastInputEvent)}</p>
              </div>

              {showDiagnostics ? (
                <div className={`rounded-lg border p-2.5 text-xs ${isDark ? 'border-slate-600 bg-[#202531] text-slate-300' : 'border-slate-300 bg-white text-slate-700'}`}>
                  <p>Phase: {sessionPhase}</p>
                  <p>Signaling: {isSignalingActive ? 'connected' : 'waiting'}</p>
                  <p>Peer: {isPeerConnected ? 'connected' : 'waiting'}</p>
                  <p>Remote stream: {hasRemoteStream ? 'present' : 'missing'}</p>
                  <p>Room: {toText(approvedRoomId || roomId) || '-'}</p>
                  <button
                    type="button"
                    onClick={copyDiagnosticsSnapshot}
                    className="mt-2 px-2.5 py-1 rounded border border-slate-500/50 text-xs"
                  >
                    Copy Snapshot
                  </button>
                  <button
                    type="button"
                    onClick={downloadDiagnosticsSnapshot}
                    className="mt-2 ml-2 px-2.5 py-1 rounded border border-slate-500/50 text-xs"
                  >
                    Download Snapshot
                  </button>
                </div>
              ) : null}

              <div className={`rounded-lg border p-2.5 text-xs ${isDark ? 'border-slate-600 bg-[#202531] text-slate-400' : 'border-slate-300 bg-white text-slate-600'}`}>
                Tip: Keep control mode off when you are only observing the host screen.
              </div>
            </aside>
            ) : null}
            </div>
          ) : (
            <div className={`h-full backdrop-blur-sm flex flex-col items-center justify-center text-center px-6 ${isDark ? 'bg-[#171b24]/90' : 'bg-white/95'}`}>
              <div className="relative">
                <div className={`h-16 w-16 rounded-full border-4 animate-spin ${isDark ? 'border-slate-600 border-t-blue-400' : 'border-slate-300 border-t-blue-500'}`} />
                <div className={`absolute inset-0 m-auto h-7 w-7 rounded-full animate-pulse ${isDark ? 'bg-blue-500/30' : 'bg-blue-400/40'}`} />
              </div>
              <p className={`mt-5 text-xl font-semibold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Connecting to remote device...</p>
              <p className={`mt-2 text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{sessionPhaseLabel}</p>
            </div>
          )}
        </div>

      </div>
      <canvas ref={blackFrameCanvasRef} className="hidden" />
    </div>
  )
}
