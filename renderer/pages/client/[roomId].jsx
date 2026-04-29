import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import Peer from 'simple-peer'
import { getSocket } from '../../libs/socket';
import { useTheme } from '../../libs/theme'
import { useAlerts } from '../../libs/alerts'
import { api } from '../../libs/http'
import { attachRtcDiagnostics, getRtcConfig } from '../../libs/rtc'

const socket = getSocket();

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
  const blackFrameCanvasRef = useRef(null)
  const [sessionStatus, setSessionStatus] = useState('Connecting to host...')
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
  const joinedRoomRef = useRef('')
  const pendingSignalsRef = useRef([])
  const handshakeRetryTimeoutRef = useRef(null)
  const streamTimeoutRef = useRef(null)
  const detachRtcDiagnosticsRef = useRef(null)
  const lastRemoteStreamRef = useRef(null)
  const lastNotifiedMessageRef = useRef('')
  const mouseDeltaRef = useRef({ x: 0, y: 0 })
  const mouseFrameRef = useRef(null)
  const pressedKeysRef = useRef(new Set())
  const blackFrameHitsRef = useRef(0)
  const blackRefreshRequestedRef = useRef(false)
  const noFrameHitsRef = useRef(0)
  const { isDark, toggleTheme } = useTheme()
  const { pushAlert } = useAlerts()
  const canControlSession = Boolean(approvedRoomId)
  const controlSensitivityMap = {
    slow: 0.7,
    normal: 1,
    fast: 1.35,
  }

  const shouldPushClientNotification = (text, type) => {
    if (!text) return false
    if (type === 'error') return true
    return (
      text.includes('Host approved') ||
      text.includes('Connection Ended')
    )
  }

  const setStatus = (message, type = 'info') => {
    const text = toText(message)
    setSessionStatus(text)
    if (!shouldPushClientNotification(text, type)) return
    if (lastNotifiedMessageRef.current === text) return
    lastNotifiedMessageRef.current = text
    pushAlert(text, { type })
  }

  const setDbMessage = (message) => {
    const text = toText(message)
    setDbUnavailableMessage(text)
    if (text) pushAlert(text, { type: 'error' })
  }

  const attachRemoteStream = async (stream) => {
    if (!videoRef.current) return false
    const videoTracks = stream?.getVideoTracks?.() || []
    const hasLiveVideoTrack = videoTracks.some((track) => track?.readyState === 'live')
    if (!hasLiveVideoTrack) {
      console.log('[client][stream] skip attach: no live video track yet')
      return false
    }
    lastRemoteStreamRef.current = stream
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
    const video = videoRef.current
    if (!video) return
    try {
      if (document.fullscreenElement === video) {
        await document.exitFullscreen()
        return
      }
      await video.requestFullscreen()
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

  const togglePointerLock = () => {
    if (document.pointerLockElement === videoRef.current) {
      document.exitPointerLock()
      return
    }
    requestPointerLock()
  }

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
      setIsFullscreen(document.fullscreenElement === videoRef.current)
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
      setHasRemoteStream(false)
      if (streamTimeoutRef.current) {
        window.clearTimeout(streamTimeoutRef.current)
        streamTimeoutRef.current = null
      }
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
          void attachRemoteStream(stream).then((ok) => {
            if (ok) setHasRemoteStream(true)
          })
        }
      }
      attachRemoteStream(stream).then((ok) => {
        if (ok) {
          setHasRemoteStream(true)
          setStatus('Live stream ready. Click on video to control.', 'success')
          return
        }
        setStatus('Stream received. Waiting for first video frames...', 'info')
      })

      if (hostMetaRef.current?.hostDeviceId && deviceId) {
        api.post('/pairings/save', {
          ownerDeviceId: deviceId,
          ownerLabel: typeof name === 'string' ? decodeURIComponent(name) : 'Client Device',
          peerDeviceId: hostMetaRef.current.hostDeviceId,
          peerLabel: hostMetaRef.current.hostDisplayName || 'Host Device',
          roomId: approvedRoomId || roomId,
        }).catch(() => {})
      }
    })

    peer.on('error', (error) => {
      console.error('[client][peer] error', error)
      setStatus(`Handshake error: ${error?.message || 'Unknown peer error'}`, 'error')
    })

    peer.on('close', () => {
      setIsPeerConnected(false)
      showSessionEnded('Host left the session.')
    })

    peer.on('connect', () => {
      setIsPeerConnected(true)
    })

    peerRef.current = peer
    detachRtcDiagnosticsRef.current = attachRtcDiagnostics(peer, 'client')
    if (streamTimeoutRef.current) {
      window.clearTimeout(streamTimeoutRef.current)
    }
    streamTimeoutRef.current = window.setTimeout(() => {
      if (!videoRef.current?.srcObject) {
        setStatus('Video took too long to arrive. Try Reconnect.', 'error')
      }
    }, 18000)

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
        setStatus(response?.message || 'Could not mark client handshake ready.', 'error')
        return
      }
      if (response?.pendingHost) {
        if (handshakeRetryTimeoutRef.current) {
          window.clearTimeout(handshakeRetryTimeoutRef.current)
        }
        handshakeRetryTimeoutRef.current = window.setTimeout(() => {
          announceClientReady(targetRoomId)
        }, 1200)
        setStatus(response?.message || 'Waiting for host readiness...')
        return
      }
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
        console.log('[client][join-room] success', response)
        announceClientReady(targetRoomId)
      })
    }

    const handleJoin = () => {
      const isPreapproved = preapproved === '1'
      if (isPreapproved) {
        setApprovedRoomId(roomId)
        setStatus('Joining approved session...')
        joinClientRoom(roomId)
        return
      }

      console.log('🟢 Client socket connected. Requesting access for room:', roomId);
      setStatus('Sending request to host...')
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
          targetHostDeviceId: typeof targetHostDeviceId === 'string' ? targetHostDeviceId : hostMetaRef.current?.hostDeviceId || '',
          clientDeviceId: deviceId || '',
          clientDisplayName: typeof name === 'string' ? decodeURIComponent(name) : 'Client Device',
        },
        (response) => {
          if (!response?.ok) {
            setStatus(response?.message || 'Could not send request to host.', 'error')
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
      joinClientRoom(acceptedRoomId)
    })

    socket.on('connection-rejected', (payload) => {
      setStatus(payload?.message || 'Connection request was rejected by host.', 'error')
    })

    socket.on('join-denied', (payload) => {
      setStatus(payload?.message || 'Join denied by host policy.', 'error')
    })

    socket.on('service-unavailable', (payload) => {
      const message = payload?.message || 'Cannot connect to database. Service is locked.'
      setDbMessage(message)
      setStatus(message, 'error')
    })

    socket.on('join-error', (payload) => {
      setStatus(payload?.message || 'Could not join room.', 'error')
    })

    socket.on('handshake-error', (payload) => {
      setStatus(payload?.message || 'Handshake error on client side.', 'error')
    })

    socket.on('start-handshake', (payload) => {
      const peerSocketId = toText(payload?.peerSocketId)
      if (!peerSocketId) {
        setStatus('Handshake failed: missing peer identity.', 'error')
        return
      }
      console.log('[client][handshake] start-handshake received', payload)
      setIsSignalingActive(true)
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
      showSessionEnded(payload?.message || 'Host ended the session.')
    })
  
    return () => {
      if (handshakeRetryTimeoutRef.current) {
        window.clearTimeout(handshakeRetryTimeoutRef.current)
      }
      if (streamTimeoutRef.current) {
        window.clearTimeout(streamTimeoutRef.current)
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
      socket.off('start-handshake');
      socket.off('session-ended');
    };
    }, [roomId, router, deviceId, name, targetHostDeviceId, preapproved]);
  

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
        const level = rttMs > 240 ? 'poor' : rttMs > 130 ? 'fair' : 'good'
        setLatencyMs(Math.round(rttMs))
        socket.emit('client-network-quality', { roomId: room, level, rttMs })
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

    router.push('/home')
  }

  const clientConnectionSteps = [
    { key: 'signaling', label: 'Signaling', done: isSignalingActive },
    { key: 'peer', label: 'Peer', done: isPeerConnected || hasRemoteStream },
    { key: 'stream', label: 'Stream', done: hasRemoteStream },
  ]
  const requiredClientSteps = clientConnectionSteps.filter((step) => step.key !== 'stream')
  const pendingClientStep = requiredClientSteps.find((step) => !step.done)?.label || 'Finalizing'
  const isClientDetailReady = requiredClientSteps.every((step) => step.done)

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
      <div className={`pointer-events-none absolute -top-16 left-0 h-64 w-64 rounded-full blur-3xl ${isDark ? 'bg-red-500/10' : 'bg-red-300/30'}`} />
      <div className={`relative z-10 w-full h-screen overflow-hidden grid grid-rows-[auto_minmax(0,1fr)_auto] ${isDark ? 'bg-[#171a22]' : 'bg-white'}`}>
        <div className={`px-5 py-3 border-b flex items-center justify-between ${isDark ? 'border-slate-700 bg-[#1c2029]' : 'border-slate-200 bg-slate-50'}`}>
          <div>
            <h1 className={`text-xl font-semibold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Remote Viewer</h1>
            <p className={`text-[11px] font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Desk ID: {toText(roomId)}</p>
            {hostMeta?.hostDisplayName ? (
              <p className={`text-[11px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Host: {toText(hostMeta.hostDisplayName)}</p>
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
          {isClientDetailReady ? (
            <div className="h-full grid lg:grid-cols-[minmax(0,1fr)_340px] gap-4">
            <section className={`rounded-xl border overflow-hidden flex flex-col ${isDark ? 'border-slate-700 bg-[#171b24]' : 'border-slate-300 bg-white'}`}>
              <div className={`px-4 py-2.5 text-xs border-b flex items-center justify-between ${isDark ? 'border-slate-700 text-slate-300 bg-[#202531]' : 'border-slate-200 text-slate-600 bg-slate-50'}`}>
                <span>Host Screen</span>
                <span className="font-mono">{hasRemoteStream ? 'live' : 'waiting'}</span>
              </div>
              <div className="flex-1 p-3">
                <div className="relative h-full bg-black border border-gray-700 rounded-lg overflow-hidden">
                  <video
                    ref={videoRef}
                    autoPlay
                    muted
                    playsInline
                    className={`w-full h-full object-cover ${hasRemoteStream ? 'opacity-100' : 'opacity-0'}`}
                    onClick={requestPointerLock}
                    onLoadedData={() => {
                      if (lastRemoteStreamRef.current) setHasRemoteStream(true)
                    }}
                    onCanPlay={() => {
                      if (lastRemoteStreamRef.current) setHasRemoteStream(true)
                    }}
                  />
                  {!hasRemoteStream ? (
                    <div className={`absolute inset-0 flex flex-col items-center justify-center text-center px-6 ${isDark ? 'bg-[#0f172a]' : 'bg-slate-50'}`}>
                      <WifiSignalIcon isDark={isDark} />
                      <p className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Waiting for secure session</p>
                      <p className={`text-sm mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        Video appears once peer handshake and stream delivery complete.
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            <aside className={`rounded-xl border p-3 overflow-y-auto space-y-3 ${isDark ? 'border-slate-700 bg-[#171b24]' : 'border-slate-300 bg-slate-50'}`}>
              <div className={`rounded-lg border p-3 ${isDark ? 'border-slate-600 bg-[#202531]' : 'border-slate-300 bg-white'}`}>
                <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Session Controls</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    onClick={togglePointerLock}
                    disabled={!canControlSession}
                    className={`col-span-2 px-3 py-2 rounded-md text-sm transition disabled:opacity-50 disabled:cursor-not-allowed ${isPointerLocked ? 'bg-red-700 hover:bg-red-600' : 'bg-red-600 hover:bg-red-500'}`}
                  >
                    {isPointerLocked ? 'Exit Control' : 'Enter Control'}
                  </button>
                  <button
                    onClick={reconnectSession}
                    className="col-span-2 px-3 py-2 rounded-md text-sm transition bg-[#3a404d] hover:bg-[#4a5160] text-white"
                  >
                    Reconnect
                  </button>
                  <button
                    onClick={toggleFullscreen}
                    className="col-span-2 px-3 py-2 rounded-md text-sm transition bg-[#3a404d] hover:bg-[#4a5160] text-white"
                  >
                    {isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
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

              <div className={`rounded-lg border p-3 text-sm ${isDark ? 'border-slate-600 bg-[#202531] text-slate-200' : 'border-slate-300 bg-white text-slate-700'}`}>
                <p>{toText(sessionStatus)}</p>
                <p className={`mt-1 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                  {isPointerLocked
                    ? 'Control mode active (Esc to unlock).'
                    : canControlSession
                      ? 'Approved. Click video or use Enter Control to start input.'
                      : 'Waiting for host approval before entering live control.'}
                </p>
                <p className={`mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Last input: {toText(lastInputEvent)}</p>
              </div>

              <div className={`rounded-lg border p-3 text-xs ${isDark ? 'border-slate-600 bg-[#202531] text-slate-400' : 'border-slate-300 bg-white text-slate-600'}`}>
                Tip: Keep control mode off when you are only observing the host screen.
              </div>
            </aside>
            </div>
          ) : (
            <div className={`h-full rounded-xl border flex flex-col items-center justify-center text-center px-6 ${isDark ? 'border-slate-700 bg-[#171b24]' : 'border-slate-300 bg-white'}`}>
              <div className="h-12 w-12 rounded-full border-4 border-slate-500/40 border-t-red-500 animate-spin" />
              <p className={`mt-4 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Preparing remote session...</p>
              <p className={`mt-2 text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Current step: {pendingClientStep}</p>
              <div className="mt-4 space-y-1 text-sm">
                {clientConnectionSteps.map((step) => (
                  <p key={step.key} className={step.done ? (isDark ? 'text-emerald-300' : 'text-emerald-700') : (isDark ? 'text-slate-400' : 'text-slate-500')}>
                    {step.done ? 'Done' : 'Waiting'} - {step.label}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className={`px-5 pb-4 pt-2 border-t ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
          {isClientDetailReady ? (
            <p className={`text-center text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              {hasRemoteStream ? 'Receiving host stream.' : 'Waiting for host stream.'}
            </p>
          ) : (
            <p className={`text-center text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              Connecting... please wait.
            </p>
          )}
        </div>
      </div>
      <canvas ref={blackFrameCanvasRef} className="hidden" />
    </div>
  )
}
