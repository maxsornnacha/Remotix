import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import Peer from 'simple-peer'
import { getSocket } from '../../libs/socket';
import { useTheme } from '../../libs/theme'
import { useAlerts } from '../../libs/alerts'
import { api } from '../../libs/http'

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
  const [sessionStatus, setSessionStatus] = useState('Connecting to host...')
  const [isPointerLocked, setIsPointerLocked] = useState(false)
  const [lastInputEvent, setLastInputEvent] = useState('No input yet')
  const [hasRemoteStream, setHasRemoteStream] = useState(false)
  const [hostMeta, setHostMeta] = useState(null)
  const hostMetaRef = useRef(null)
  const [approvedRoomId, setApprovedRoomId] = useState('')
  const [dbUnavailableMessage, setDbUnavailableMessage] = useState('')
  const joinedRoomRef = useRef('')
  const pendingSignalsRef = useRef([])
  const { isDark, toggleTheme } = useTheme()
  const { pushAlert } = useAlerts()
  const canControlSession = Boolean(approvedRoomId)

  const setStatus = (message, type = 'info') => {
    const text = toText(message)
    setSessionStatus(text)
    if (text) pushAlert(text, { type })
  }

  const setDbMessage = (message) => {
    const text = toText(message)
    setDbUnavailableMessage(text)
    if (text) pushAlert(text, { type: 'error' })
  }

  const requestPointerLock = () => {
    if (!canControlSession) return
    if (videoRef.current) {
      videoRef.current.requestPointerLock();
    }
  };

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

  const peerRef = useRef(null)

  const createPeerConnection = (peerSocketId, initiator = false) => {
    if (!peerSocketId) return
    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }

    const peer = new Peer({
      initiator,
      trickle: false,
    })

    peer.on('signal', (signalData) => {
      console.log('[client][signal] send', { to: peerSocketId, initiator })
      socket.emit('signal', { to: peerSocketId, from: socket.id, data: signalData })
    })

    peer.on('stream', (stream) => {
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play()
        setStatus('Live stream ready. Click on video to control.', 'success')
        setHasRemoteStream(true)
      }

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

    peerRef.current = peer
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
      console.log('[client][handshake] client-ready acknowledged', response)
      setStatus('Joined room. Waiting for host handshake start...')
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
      setStatus('Requesting host approval...')
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
      setStatus('Host found. Establishing secure peer connection...')
    });

    socket.on('connection-approved', (payload) => {
      const acceptedRoomId = payload?.roomId || roomId
      setApprovedRoomId(acceptedRoomId)
      setStatus('Host approved. Joining secure session...', 'success')
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
      createPeerConnection(peerSocketId, false)
      setStatus('Handshake started. Waiting for remote stream...')
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
  
    return () => {
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
    };
    }, [roomId, router, deviceId, name, targetHostDeviceId, preapproved]);
  

  // Send remote input events
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      socket.emit('mouse-move', {
        x: e.movementX,
        y: e.movementY,
        roomId: approvedRoomId || roomId,
      });
      setLastInputEvent('Mouse move')
    };    

    const handleClick = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      socket.emit('mouse-click', { button: e.button, roomId: approvedRoomId || roomId })
      setLastInputEvent(`Mouse click (${e.button})`)
    }

    const handleKeyUp = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      socket.emit('key-up', { code: e.code, roomId: approvedRoomId || roomId });
      setLastInputEvent(`Key up (${e.code})`)
    };

    const handleKeyDown = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      socket.emit('key-down', { code: e.code, roomId: approvedRoomId || roomId })
      setLastInputEvent(`Key down (${e.code})`)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('click', handleClick)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [roomId, approvedRoomId])

  const handleDisconnect = () => {
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

    router.push('/home')
  }

  const copyRoomId = async () => {
    if (!roomId || typeof navigator === 'undefined') return
    try {
      await navigator.clipboard.writeText(roomId)
      setStatus('Room ID copied to clipboard.', 'success')
    } catch (error) {
      setStatus('Could not copy room ID.', 'error')
    }
  }

  return (
    <div className={`min-h-screen relative overflow-hidden ${isDark ? 'bg-[#0b1020] text-white' : 'bg-slate-100 text-slate-900'}`}>
      <div className={`pointer-events-none absolute -top-16 left-0 h-64 w-64 rounded-full blur-3xl ${isDark ? 'bg-blue-500/10' : 'bg-blue-300/30'}`} />
      <div className={`relative z-10 w-full h-screen overflow-hidden grid grid-rows-[auto_auto_minmax(0,1fr)_auto] ${isDark ? 'bg-[#121a2c]' : 'bg-white'}`}>
        <div className={`px-6 py-4 border-b flex items-center justify-between ${isDark ? 'border-slate-800 bg-[#0f172a]' : 'border-slate-200 bg-slate-50'}`}>
          <div>
            <h1 className={`text-2xl font-bold tracking-tight ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>Remote Viewer</h1>
            <p className={`text-xs font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Room ID: {toText(roomId)}</p>
            {hostMeta?.hostDisplayName ? (
              <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Host: {toText(hostMeta.hostDisplayName)}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleTheme}
              className={`text-xs px-3 py-1.5 rounded-md border ${isDark ? 'border-slate-600 bg-slate-800 text-slate-200' : 'border-slate-300 bg-white text-slate-700'}`}
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              <ThemeGlyph isDark={isDark} />
            </button>
            <span className={`text-xs px-2 py-1 rounded-full border ${isPointerLocked
              ? (isDark ? 'bg-emerald-700/40 border-emerald-500/40 text-emerald-300' : 'bg-emerald-100 border-emerald-300 text-emerald-700')
              : (isDark ? 'bg-slate-700/50 border-slate-600 text-slate-300' : 'bg-slate-100 border-slate-300 text-slate-700')
            }`}>
              {isPointerLocked ? 'Control Active' : canControlSession ? 'Approved' : 'Pending Approval'}
            </span>
          </div>
        </div>

        {dbUnavailableMessage ? (
          <div className={`mx-6 mt-4 rounded-lg border px-4 py-3 text-sm ${isDark ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-red-300 bg-red-50 text-red-700'}`}>
            {toText(dbUnavailableMessage)}
          </div>
        ) : null}

        <div className="min-h-0 overflow-y-auto p-6 space-y-4">
          <div className="grid md:grid-cols-3 gap-3">
            <button
              onClick={togglePointerLock}
              disabled={!canControlSession}
              className={`px-4 py-2 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed ${isPointerLocked ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}
            >
              {isPointerLocked ? 'Exit Control' : 'Enter Control'}
            </button>
            <button
              onClick={copyRoomId}
              className="px-4 py-2 rounded-lg transition bg-slate-700 hover:bg-slate-600"
            >
              Copy Room ID
            </button>
            <button
              onClick={handleDisconnect}
              className="px-4 py-2 rounded-lg transition bg-red-600 hover:bg-red-700"
            >
              Disconnect
            </button>
          </div>

          {hasRemoteStream ? (
            <div className="bg-black border border-gray-700 rounded-lg overflow-hidden">
              <video
                ref={videoRef}
                autoPlay
                className="w-full h-[38vh] lg:h-[46vh] object-contain"
                onClick={requestPointerLock}
              />
            </div>
          ) : (
            <div className={`rounded-lg border min-h-[260px] md:min-h-[320px] flex flex-col items-center justify-center text-center px-6 ${isDark ? 'border-slate-700 bg-[#0f172a]' : 'border-slate-300 bg-slate-50'}`}>
              <WifiSignalIcon isDark={isDark} />
              <p className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Waiting for secure session</p>
              <p className={`text-sm mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Signaling in progress. Video will appear after host approval and connection setup.
              </p>
            </div>
          )}
        </div>

        <div className="px-6 pb-6 space-y-3">
          <div className={`rounded-xl border p-3 text-sm space-y-1 ${isDark ? 'border-slate-700 bg-[#18233b] text-gray-300' : 'border-slate-300 bg-slate-50 text-slate-700'}`}>
            <p>{toText(sessionStatus)}</p>
            <p>
              {isPointerLocked
                ? 'Control mode active (Esc to unlock).'
                : canControlSession
                  ? 'Host approved. Click video or use Enter Control to start input.'
                  : 'Waiting for host approval before entering the live session.'}
            </p>
            <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Last input: {toText(lastInputEvent)}</p>
          </div>

          <p className={`text-center text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Tip: Keep control mode off when you are only observing the host screen.
          </p>
        </div>
      </div>
    </div>
  )
}
