import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import Peer from 'simple-peer'
import { getSocket } from '../../libs/socket';
import { useTheme } from '../../libs/theme'
import { useAlerts } from '../../libs/alerts'

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
  const videoRef = useRef(null)
  const localStreamRef = useRef(null)
  const peerRef = useRef(null)
  const shareStartPromiseRef = useRef(null)
  const { isDark, toggleTheme } = useTheme()
  const { pushAlert } = useAlerts()

  const setNotice = (message, type = 'info') => {
    const text = toText(message)
    setSessionNotice(text)
    if (text) pushAlert(text, { type })
  }

  const setDbMessage = (message) => {
    const text = toText(message)
    setDbUnavailableMessage(text)
    if (text) pushAlert(text, { type: 'error' })
  }

  // Step 1: Join room & signaling
  useEffect(() => {
    if (!roomId) return

    if (typeof window !== 'undefined') {
      const policyConsent = window.localStorage.getItem('remotix-policy-consent')
      if (policyConsent !== 'accepted') {
        router.replace('/home')
        return
      }
    }

    socket.emit('join-room', {
      roomId,
      role: 'host',
      deviceId: deviceId || '',
      displayName: typeof name === 'string' ? decodeURIComponent(name) : 'Host Device',
    })

    socket.on('peer-joined', (peerId) => {
      if (!localStreamRef.current) {
        setNotice('Connection approved, but screen sharing is not ready yet.')
        return
      }
      setNotice('Client connected. Enable remote control only for trusted users.')
      const peer = new Peer({
        initiator: true,
        trickle: false,
        stream: localStreamRef.current,
      })

      peer.on('signal', (data) => {
        socket.emit('signal', { to: peerId, from: socket.id, data })
      })

      peerRef.current = peer
    })

    socket.on('signal', ({ from, data }) => {
      peerRef.current?.signal(data)
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
      setNotice('Cannot continue until database connection is restored.', 'error')
    })

    // Step 2: Listen for remote control events
    socket.on('mouse-move', ({ x, y }) => {
      if (allowControl) window.ipc.sendInput('mouse-move', { x, y })
    })

    socket.on('mouse-click', ({ button }) => {
      if (allowControl) window.ipc.sendInput('mouse-click', { button })
    })

    socket.on('key-down', ({ code }) => {
      if (allowControl) window.ipc.sendInput('key-down', { code })
    })
    
    socket.on('key-up', ({ code }) => {
      if (allowControl) window.ipc.sendInput('key-up', { code });
    });

    return () => {
      socket.off('peer-joined');
      socket.off('signal');
      socket.off('mouse-move');
      socket.off('mouse-click');
      socket.off('key-down');
      socket.off('key-up');
      socket.off('incoming-connection-request');
      socket.off('service-unavailable');
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

  const ensureScreenSharingStarted = async () => {
    if (localStreamRef.current) return true
    if (shareStartPromiseRef.current) return shareStartPromiseRef.current

    const sharingPromise = (async () => {
      setIsPreparingShare(true)
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        })

        localStreamRef.current = stream
        stream.getVideoTracks().forEach((track) => {
          track.onended = () => {
            localStreamRef.current = null
            setIsSharing(false)
            setNotice('Screen sharing stopped. Approve a request to start sharing again.')
          }
        })

        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play()
        }
        setIsSharing(true)
        setNotice('Screen sharing started. Waiting for approved client to connect.', 'success')
        return true
      } catch (error) {
        console.error('Screen share error:', error)
        setNotice('Screen sharing permission was not granted.', 'error')
        return false
      } finally {
        setIsPreparingShare(false)
        shareStartPromiseRef.current = null
      }
    })()

    shareStartPromiseRef.current = sharingPromise
    return sharingPromise
  }

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
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop())
    }

    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }

    router.push('/home')
  }

  const copyRoomId = async () => {
    if (!roomId || typeof navigator === 'undefined') return
    try {
      await navigator.clipboard.writeText(roomId)
      setNotice('Room ID copied. Share it only with users you trust.', 'success')
    } catch (error) {
      setNotice('Could not copy room ID. Please copy it manually.', 'error')
    }
  }

  const handleConnectionRequest = async (clientSocketId, approved) => {
    if (approved) {
      const isReady = await ensureScreenSharingStarted()
      if (!isReady) {
        setNotice('Approval cancelled because screen sharing did not start.', 'error')
        return
      }
    }

    socket.emit('respond-connection-request', { clientSocketId, approved })
    setIncomingRequests((prev) => prev.filter((item) => item.clientSocketId !== clientSocketId))
    setNotice(approved ? 'Connection approved. Client can now join securely.' : 'Connection rejected.', approved ? 'success' : 'error')
  }

  return (
    <div className={`min-h-screen relative overflow-hidden ${isDark ? 'bg-[#0b1020] text-white' : 'bg-slate-100 text-slate-900'}`}>
      <div className={`pointer-events-none absolute -top-16 right-0 h-64 w-64 rounded-full blur-3xl ${isDark ? 'bg-amber-500/10' : 'bg-amber-300/30'}`} />
      <div className={`relative z-10 w-full h-screen overflow-hidden grid grid-rows-[auto_auto_minmax(0,1fr)_auto] ${isDark ? 'bg-[#121a2c]' : 'bg-white'}`}>
        <div className={`px-6 py-4 border-b flex items-center justify-between ${isDark ? 'border-slate-800 bg-[#0f172a]' : 'border-slate-200 bg-slate-50'}`}>
          <div>
            <h1 className={`text-2xl font-bold tracking-tight ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>Host Control Center</h1>
            <p className={`text-xs font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Room ID: {toText(roomId)}</p>
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
            <span className={`text-xs px-2 py-1 rounded-full border ${isSharing
              ? (isDark ? 'bg-emerald-700/40 border-emerald-500/40 text-emerald-300' : 'bg-emerald-100 border-emerald-300 text-emerald-700')
              : (isDark ? 'bg-amber-700/40 border-amber-500/40 text-amber-300' : 'bg-amber-100 border-amber-300 text-amber-700')
            }`}>
              {isSharing ? 'Sharing Active' : isPreparingShare ? 'Preparing Share' : 'Awaiting Approval'}
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
              onClick={copyRoomId}
              className="bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg transition"
            >
              Copy Room ID
            </button>
            <button
              onClick={() => {
                const next = !allowControl
                setAllowControl(next)
                setNotice(next ? 'Remote control is enabled.' : 'Remote control is disabled.')
              }}
              className={`px-4 py-2 rounded-lg transition ${allowControl ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}
            >
              {allowControl ? 'Disable Control' : 'Enable Control'}
            </button>
            <button
              onClick={handleDisconnect}
              className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg transition"
            >
              Disconnect & Return
            </button>
          </div>

          <div className={`rounded-xl border p-3 text-sm flex items-center justify-between ${isDark ? 'border-slate-700 bg-[#18233b] text-slate-200' : 'border-slate-300 bg-slate-50 text-slate-700'}`}>
            <span>Control permission: {allowControl ? 'Allowed' : 'Blocked'}</span>
            <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Desktop shortcut: press C to toggle control</span>
          </div>

          <div className={`rounded-xl border p-3 space-y-2 ${isDark ? 'border-slate-700 bg-[#18233b]' : 'border-slate-300 bg-slate-50'}`}>
            <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Connection Requests</p>
            {incomingRequests.length === 0 ? (
              <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No pending requests. Screen will start only after you allow a request.</p>
            ) : (
              incomingRequests.map((request) => (
                <div
                  key={request.clientSocketId}
                  className={`rounded-md border px-3 py-2 flex items-center justify-between ${isDark ? 'border-slate-600 bg-[#0f172a]' : 'border-slate-300 bg-white'}`}
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
                      className="px-2 py-1 text-xs rounded-md bg-slate-600 hover:bg-slate-500 text-white"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConnectionRequest(request.clientSocketId, true)}
                      className="px-2 py-1 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 text-white"
                    >
                      Allow
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {isSharing ? (
            <div className="bg-black border border-gray-700 rounded-lg overflow-hidden">
              <video
                ref={videoRef}
                autoPlay
                muted
                className="w-full h-[38vh] lg:h-[46vh] object-contain"
              />
            </div>
          ) : (
            <div className={`rounded-lg border min-h-[260px] md:min-h-[320px] flex flex-col items-center justify-center text-center px-6 ${isDark ? 'border-slate-700 bg-[#0f172a]' : 'border-slate-300 bg-slate-50'}`}>
              <WifiSignalIcon isDark={isDark} />
              <p className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Waiting for incoming approval flow</p>
              <p className={`text-sm mt-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Screen preview starts only after you approve a request and confirm share permissions.
              </p>
            </div>
          )}
        </div>

        <div className="px-6 pb-6 space-y-2">
          <p className={`text-center text-sm ${isDark ? 'text-gray-400' : 'text-slate-600'}`}>
            {isSharing ? 'You are sharing your screen with approved clients.' : 'No active screen sharing until you approve a request.'}
          </p>
          <p className={`text-center text-sm ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
            {toText(sessionNotice) || 'Keep remote control off until you verify the client identity.'}
          </p>
        </div>
      </div>
    </div>
  )
}
