import { useRouter } from 'next/router'
import { useEffect, useRef, useState } from 'react'
import { getSocket } from '../libs/socket'
import { useTheme } from '../libs/theme'
import { getOrCreateDeviceProfile, regenerateDeviceProfile, saveDeviceProfile } from '../libs/device'
import { useAlerts } from '../libs/alerts'
import { api } from '../libs/http'

const socket = getSocket()
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
function PanelGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  )
}
function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}
function CircleLoader({ className = '' }) {
  return <span className={`inline-block h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin ${className}`} aria-hidden="true" />
}
const toStringList = (value) => {
  if (!Array.isArray(value)) return []
  return value.map((item) => toText(item)).filter(Boolean)
}
const normalizePairings = (items) => {
  if (!Array.isArray(items)) return []
  return items
    .map((item) => ({
      ownerDeviceId: toText(item?.ownerDeviceId),
      ownerLabel: toText(item?.ownerLabel),
      peerDeviceId: toText(item?.peerDeviceId),
      peerLabel: toText(item?.peerLabel),
      roomId: toText(item?.roomId),
    }))
    .filter((item) => item.peerDeviceId)
}

export default function HomePage() {
  const [roomId, setRoomId] = useState('')
  const [isCheckingRoom, setIsCheckingRoom] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [hasAcceptedPolicy, setHasAcceptedPolicy] = useState(false)
  const [recentRooms, setRecentRooms] = useState([])
  const [deviceId, setDeviceId] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [pairings, setPairings] = useState([])
  const [isLoadingPairings, setIsLoadingPairings] = useState(false)
  const [isServiceLocked, setIsServiceLocked] = useState(false)
  const [activeSection, setActiveSection] = useState('news')
  const [isSessionDrawerOpen, setIsSessionDrawerOpen] = useState(false)
  const [incomingRequest, setIncomingRequest] = useState(null)
  const [isRespondingRequest, setIsRespondingRequest] = useState(false)
  const [pendingOutboundAddress, setPendingOutboundAddress] = useState('')
  const [isPolicyModalOpen, setIsPolicyModalOpen] = useState(false)
  const [isRegeneratingDeviceId, setIsRegeneratingDeviceId] = useState(false)
  const outboundRequestTimeoutRef = useRef(null)
  const pendingOutboundAddressRef = useRef('')
  const router = useRouter()
  const { isDark, toggleTheme } = useTheme()
  const { pushAlert } = useAlerts()

  const notify = (message, type = 'info') => {
    const text = toText(message)
    if (!text) return
    pushAlert(text, { type })
  }

  const setFeedbackWithAlert = (message, type = 'info', options = {}) => {
    const text = toText(message)
    setFeedback(text)
    if (!options.silent) {
      notify(text, type)
    }
  }

  const clearOutboundRequestTimeout = () => {
    if (!outboundRequestTimeoutRef.current) return
    window.clearTimeout(outboundRequestTimeoutRef.current)
    outboundRequestTimeoutRef.current = null
  }

  const resetOutboundRequestState = () => {
    clearOutboundRequestTimeout()
    pendingOutboundAddressRef.current = ''
    setPendingOutboundAddress('')
    setIsCheckingRoom(false)
  }

  useEffect(() => {
    pendingOutboundAddressRef.current = toText(pendingOutboundAddress)
  }, [pendingOutboundAddress])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const policyConsent = window.localStorage.getItem('remotix-policy-consent')
    const savedRecentRooms = window.localStorage.getItem('remotix-recent-rooms')
    const profile = getOrCreateDeviceProfile()
    setDeviceId(toText(profile.deviceId))
    setDeviceName(toText(profile.displayName))
    setHasAcceptedPolicy(policyConsent === 'accepted')

    if (!savedRecentRooms) return
    try {
      const parsed = JSON.parse(savedRecentRooms)
      setRecentRooms(toStringList(parsed))
    } catch (error) {
      setRecentRooms([])
    }
  }, [])

  useEffect(() => {
    if (!deviceId || isServiceLocked) return
    const payload = {
      deviceId,
      displayName: deviceName || 'Host Device',
    }

    api.post('/devices/register', {
        deviceId: payload.deviceId,
        displayName: payload.displayName,
        isOnline: true,
      }).catch(() => {})

    const registerHost = () => {
      socket.emit('register-host', payload, (response) => {
        if (response?.ok) return
        setFeedbackWithAlert(response?.message || 'Could not register this address in system.', 'error')
      })
    }

    if (socket.connected) {
      registerHost()
    } else {
      socket.once('connect', registerHost)
    }

    return () => {
      socket.off('connect', registerHost)
    }
  }, [deviceId, deviceName, isServiceLocked])

  useEffect(() => {
    if (!deviceId || isServiceLocked) return
    const emitHeartbeat = () => {
      socket.emit('host-heartbeat', {
        deviceId,
        displayName: deviceName || 'Host Device',
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
  }, [deviceId, deviceName, isServiceLocked])

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const { data: result } = await api.get('/status')
        const locked = result?.dbConnected === false
        setIsServiceLocked(locked)
        if (locked) {
          setFeedbackWithAlert('Service is locked because database is unavailable.', 'error')
        }
      } catch (error) {
        setIsServiceLocked(true)
        setFeedbackWithAlert('Service is locked because backend status could not be verified.', 'error')
      }
    }

    checkStatus()

    const onServiceUnavailable = (payload) => {
      setIsServiceLocked(true)
      setFeedbackWithAlert(payload?.message || 'Database unavailable. Service is locked.', 'error')
    }

    socket.on('service-unavailable', onServiceUnavailable)
    return () => {
      socket.off('service-unavailable', onServiceUnavailable)
    }
  }, [])

  useEffect(() => {
    const fetchPairings = async () => {
      if (!deviceId || isServiceLocked) return
      setIsLoadingPairings(true)
      try {
        const { data: result } = await api.get(`/pairings/${deviceId}`)
        setPairings(normalizePairings(result.items))
      } catch (error) {
        setPairings([])
      } finally {
        setIsLoadingPairings(false)
      }
    }

    fetchPairings()
  }, [deviceId, isServiceLocked])

  useEffect(() => {
    const onIncomingRequest = (request) => {
      setIncomingRequest({
        clientSocketId: toText(request?.clientSocketId),
        clientDeviceId: toText(request?.clientDeviceId),
        clientDisplayName: toText(request?.clientDisplayName),
        roomId: toText(request?.roomId),
      })
      setFeedback('')
    }

    const onHostConnectionApproved = (payload) => {
      const roomIdForHost = toText(payload?.roomId)
      const fallbackDeviceId = toText(getOrCreateDeviceProfile()?.deviceId)
      const safeDeviceId = toText(deviceId) || fallbackDeviceId
      if (!roomIdForHost || !safeDeviceId) return
      const encodedName = encodeURIComponent(deviceName || 'Host Device')
      router.push(`/host/${roomIdForHost}?deviceId=${safeDeviceId}&name=${encodedName}`)
    }

    const onConnectionApproved = (payload) => {
      const approvedRoomId = toText(payload?.roomId)
      const hostDeviceId = toText(payload?.hostDeviceId) || toText(pendingOutboundAddressRef.current)
      const fallbackDeviceId = toText(getOrCreateDeviceProfile()?.deviceId)
      const safeDeviceId = toText(deviceId) || fallbackDeviceId
      if (!approvedRoomId || !safeDeviceId) return
      rememberRoom(hostDeviceId)
      resetOutboundRequestState()
      const encodedName = encodeURIComponent(deviceName || 'Client Device')
      router.push(`/client/${approvedRoomId}?deviceId=${safeDeviceId}&name=${encodedName}&targetHostDeviceId=${hostDeviceId}&preapproved=1`)
    }

    const onConnectionRejected = (payload) => {
      resetOutboundRequestState()
      setFeedbackWithAlert(payload?.message || 'Connection request was rejected by host.', 'error')
    }

    socket.on('incoming-connection-request', onIncomingRequest)
    socket.on('host-connection-approved', onHostConnectionApproved)
    socket.on('connection-approved', onConnectionApproved)
    socket.on('connection-rejected', onConnectionRejected)

    return () => {
      socket.off('incoming-connection-request', onIncomingRequest)
      socket.off('host-connection-approved', onHostConnectionApproved)
      socket.off('connection-approved', onConnectionApproved)
      socket.off('connection-rejected', onConnectionRejected)
    }
  }, [deviceId, deviceName, router])

  useEffect(() => {
    return () => {
      clearOutboundRequestTimeout()
    }
  }, [])

  const persistRecentRooms = (nextRooms) => {
    const normalized = toStringList(nextRooms).slice(0, 5)
    setRecentRooms(normalized)
    window.localStorage.setItem('remotix-recent-rooms', JSON.stringify(normalized))
  }

  const rememberRoom = (id) => {
    if (typeof window === 'undefined') return
    const normalizedId = toText(id).trim()
    if (!normalizedId) return
    const safeRecentRooms = toStringList(recentRooms)
    const nextRooms = [normalizedId, ...safeRecentRooms.filter((item) => item !== normalizedId)].slice(0, 5)
    persistRecentRooms(nextRooms)
  }

  const ensurePolicyAccepted = () => {
    if (hasAcceptedPolicy) return true
    setFeedbackWithAlert('Please accept the usage policy before starting a session.', 'error')
    return false
  }

  const requestConnectionToAddress = (targetAddress) => {
    if (isServiceLocked) return
    if (!ensurePolicyAccepted()) return
    const targetHostDeviceId = toText(targetAddress).trim()
    if (!targetHostDeviceId) {
      setFeedbackWithAlert('Please enter a remote address.', 'error')
      return
    }
    if (targetHostDeviceId === deviceId) {
      setFeedback('')
      notify('You cannot connect to your own address.', 'error')
      return
    }

    setIsCheckingRoom(true)
    setPendingOutboundAddress(targetHostDeviceId)
    setFeedbackWithAlert('Checking address in database...', 'info', { silent: true })

    api.get(`/devices/${encodeURIComponent(targetHostDeviceId)}/status`)
      .then(({ data }) => {
        if (!data?.exists) {
          resetOutboundRequestState()
          setFeedbackWithAlert('Address not found in system.', 'error')
          return
        }
        if (!data?.isOnline) {
          resetOutboundRequestState()
          setFeedbackWithAlert('Address is currently offline.', 'error')
          return
        }

        setFeedbackWithAlert('Sending connection request. Waiting for host approval...')
        clearOutboundRequestTimeout()
        outboundRequestTimeoutRef.current = window.setTimeout(() => {
          resetOutboundRequestState()
          setFeedbackWithAlert('Request timed out. Host did not respond in time.', 'error')
        }, 15000)
        socket.emit('request-connection', {
          targetHostDeviceId,
          clientDeviceId: deviceId,
          clientDisplayName: deviceName || 'Client Device',
        }, (response) => {
          if (response?.ok) return
          resetOutboundRequestState()
          const fallbackMessage = targetHostDeviceId
            ? 'Address not found in system.'
            : 'Could not send connection request.'
          setFeedbackWithAlert(response?.message || fallbackMessage, 'error')
        })
      })
      .catch((error) => {
        resetOutboundRequestState()
        const message = error?.response?.data?.message || 'Could not verify address in database.'
        setFeedbackWithAlert(message, 'error')
      })
  }

  const joinRoom = () => requestConnectionToAddress(roomId)

  const clearRecentRooms = () => {
    if (typeof window === 'undefined') return
    persistRecentRooms([])
  }

  const saveProfile = () => {
    if (!deviceId) return
    const cleanName = deviceName.trim() || 'My Device'
    setDeviceName(cleanName)
    saveDeviceProfile({ deviceId, displayName: cleanName })
    setFeedbackWithAlert('Device profile updated.', 'success')
  }

  const regenerateDeviceId = async () => {
    if (isRegeneratingDeviceId) return
    setIsRegeneratingDeviceId(true)
    const currentDeviceId = toText(deviceId).trim()
    const currentDisplayName = deviceName.trim() || 'My Device'
    const nextProfile = regenerateDeviceProfile(currentDisplayName)
    const nextDeviceId = toText(nextProfile.deviceId).trim()

    try {
      if (currentDeviceId && nextDeviceId) {
        await api.post('/devices/change-id', {
          oldDeviceId: currentDeviceId,
          newDeviceId: nextDeviceId,
          displayName: currentDisplayName,
        })
      }
      setDeviceId(nextDeviceId)
      setDeviceName(toText(nextProfile.displayName))
      setPairings([])
      setRecentRooms([])
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('remotix-recent-rooms')
      }
      setFeedbackWithAlert('Device address updated successfully.', 'success')
    } catch (error) {
      saveDeviceProfile({ deviceId: currentDeviceId, displayName: currentDisplayName })
      const message = error?.response?.data?.message || 'Could not update device address.'
      setFeedbackWithAlert(message, 'error')
    } finally {
      setIsRegeneratingDeviceId(false)
    }
  }

  const connectToPairedDevice = (peerDeviceId) => {
    if (isServiceLocked) return
    const safePeerDeviceId = toText(peerDeviceId).trim()
    if (!safePeerDeviceId) {
      setFeedbackWithAlert('Invalid paired device identifier.', 'error')
      return
    }
    requestConnectionToAddress(safePeerDeviceId)
  }

  const respondIncomingRequest = (approved) => {
    if (!incomingRequest?.clientSocketId) return
    setIsRespondingRequest(true)
    const requestClientSocketId = incomingRequest.clientSocketId
    const fallbackDeviceId = toText(getOrCreateDeviceProfile()?.deviceId)
    const safeDeviceId = toText(deviceId) || fallbackDeviceId
    const approvedRoomIdFromRequest = toText(incomingRequest?.roomId)

    if (approved && safeDeviceId && approvedRoomIdFromRequest) {
      const encodedName = encodeURIComponent(deviceName || 'Host Device')
      router.push(`/host/${approvedRoomIdFromRequest}?deviceId=${safeDeviceId}&name=${encodedName}`)
    }

    socket.emit('respond-connection-request', {
      clientSocketId: requestClientSocketId,
      approved,
    }, (response) => {
      if (!response?.ok) {
        setFeedbackWithAlert(response?.message || 'Could not process connection request.', 'error')
        setIsRespondingRequest(false)
        return
      }
      if (approved && response?.roomId) {
        if (safeDeviceId) {
          const encodedName = encodeURIComponent(deviceName || 'Host Device')
          router.push(`/host/${toText(response.roomId)}?deviceId=${safeDeviceId}&name=${encodedName}`)
        }
      }
      setIsRespondingRequest(false)
    })
    if (!approved) {
      setFeedbackWithAlert('Connection request rejected.', 'error')
    } else {
      setFeedbackWithAlert('Connection approved. Opening session...', 'success')
    }
    setIncomingRequest((current) => {
      if (!current?.clientSocketId) return null
      return current.clientSocketId === requestClientSocketId ? null : current
    })
  }

  const copyDeviceId = async () => {
    if (!deviceId || typeof navigator === 'undefined') return
    try {
      await navigator.clipboard.writeText(deviceId)
      setFeedbackWithAlert('Address copied to clipboard.', 'success')
    } catch (error) {
      setFeedbackWithAlert('Could not copy address.', 'error')
    }
  }

  const newsTiles = [
    {
      title: 'Always Ready',
      body: 'Your device listens on this address and asks for approval before any remote access.',
      action: 'Copy Address',
      onClick: copyDeviceId,
      tone: 'orange',
    },
    {
      title: 'Pairing Security',
      body: 'Requests require host approval before entering session.',
      action: 'Open Policy',
      onClick: () => setIsPolicyModalOpen(true),
      tone: 'blue',
    },
    {
      title: 'Database Status',
      body: isServiceLocked ? 'Database unavailable. Service locked.' : 'Database connected. Pairing is enabled.',
      action: isServiceLocked ? 'Locked' : 'Healthy',
      onClick: () => {},
      tone: isServiceLocked ? 'gray' : 'green',
      disabled: true,
    },
  ]
  const sectionItems = ['news', 'trusted', 'recent'].map((item) => toText(item)).filter(Boolean)

  const tileToneClass = (tone) => {
    if (tone === 'orange') return 'from-rose-500 to-pink-400'
    if (tone === 'green') return 'from-teal-500 to-cyan-400'
    if (tone === 'gray') return 'from-slate-500 to-slate-400'
    return 'from-indigo-500 to-violet-400'
  }

  return (
    <div className={`h-screen relative overflow-hidden ${isDark ? 'bg-[#0b1020] text-white' : 'bg-slate-100 text-slate-900'}`}>
      <div className={`pointer-events-none absolute -top-20 -left-20 h-72 w-72 rounded-full blur-3xl ${isDark ? 'bg-blue-500/15' : 'bg-blue-300/40'}`} />
      <div className={`pointer-events-none absolute -bottom-24 -right-20 h-80 w-80 rounded-full blur-3xl ${isDark ? 'bg-emerald-500/10' : 'bg-emerald-300/30'}`} />
      <div className={`relative z-10 w-full h-full overflow-hidden grid grid-rows-[auto_auto_minmax(0,1fr)] ${isDark ? 'bg-[#121a2c]/95' : 'bg-white/95'}`}>
        <header className={`px-6 py-4 border-b flex items-center justify-between ${isDark ? 'border-slate-800 bg-[#0f172a]/90' : 'border-slate-200 bg-slate-50/90'}`}>
          <div className="flex items-center gap-2">
            <h1 className={`text-xl md:text-2xl font-bold tracking-tight ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>Remotix</h1>
            <span className={`text-[11px] px-2 py-0.5 rounded-full border ${isDark ? 'border-slate-600 text-slate-300' : 'border-slate-300 text-slate-600'}`}>
              Desktop
            </span>
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
            <button
              type="button"
              onClick={() => setIsSessionDrawerOpen(true)}
              className={`text-xs px-3 py-1.5 rounded-md border ${isDark ? 'border-slate-600 bg-slate-800 text-slate-200' : 'border-slate-300 bg-white text-slate-700'}`}
              title="Open session controls"
            >
              <PanelGlyph />
            </button>
            <span className={`text-xs px-2.5 py-1 rounded-full border ${isServiceLocked
              ? (isDark ? 'bg-red-700/40 text-red-300 border-red-500/40' : 'bg-red-100 text-red-700 border-red-300')
              : (isDark ? 'bg-emerald-700/40 text-emerald-300 border-emerald-500/40' : 'bg-emerald-100 text-emerald-700 border-emerald-300')
            }`}>
              {isServiceLocked ? 'Service Locked' : 'System Ready'}
            </span>
          </div>
        </header>

        <div className={`px-6 py-3 border-b grid grid-cols-[auto_1fr_auto] items-center gap-4 ${isDark ? 'border-slate-800 bg-[#0f172a]/70' : 'border-slate-200 bg-slate-50/80'}`}>
          <span className={`text-xs uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Your Address</span>
          <div className="flex items-center gap-3 min-w-0">
            <p className={`font-mono text-xl md:text-2xl truncate ${isDark ? 'text-red-300' : 'text-red-600'}`}>{toText(deviceId) || 'Loading...'}</p>
            <button
              type="button"
              onClick={copyDeviceId}
              className={`text-xs px-2.5 py-1 rounded border ${isDark ? 'border-slate-600 bg-slate-800' : 'border-slate-300 bg-white'}`}
            >
              Copy
            </button>
            <button
              type="button"
              onClick={regenerateDeviceId}
              disabled={isCheckingRoom || isRegeneratingDeviceId}
              className={`text-xs px-2.5 py-1 rounded border ${
                isDark
                  ? 'border-slate-500 bg-slate-700 hover:bg-slate-600 text-slate-100'
                  : 'border-slate-300 bg-slate-100 hover:bg-slate-200 text-slate-700'
              } disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-2`}
            >
              {isRegeneratingDeviceId ? (
                <>
                  <CircleLoader className="h-3.5 w-3.5" />
                  Regenerating...
                </>
              ) : 'Regenerate'}
            </button>
          </div>
          <div className="flex gap-2">
            {sectionItems.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setActiveSection(item)}
                className={`text-xs px-2 py-1 rounded-md border ${
                  activeSection === item
                    ? 'bg-blue-600 text-white border-blue-500'
                    : isDark
                      ? 'border-slate-600 text-slate-300'
                      : 'border-slate-300 text-slate-600'
                }`}
              >
                {item === 'news' ? 'News' : item === 'trusted' ? 'Trusted' : 'Recent'}
              </button>
            ))}
          </div>
        </div>

        <main className="min-h-0 overflow-hidden px-6 py-5">
          <section className="min-h-0 overflow-y-auto pr-1 space-y-4">
            {activeSection === 'news' ? (
              <div className="grid md:grid-cols-3 gap-4">
                {newsTiles.map((tile) => (
                  <div key={tile.title} className={`rounded-xl p-4 text-white bg-gradient-to-br ${tileToneClass(tile.tone)}`}>
                    <p className="font-semibold text-sm">{toText(tile.title)}</p>
                    <p className="text-xs mt-2 opacity-90 min-h-[50px]">{toText(tile.body)}</p>
                    <button
                      type="button"
                      onClick={tile.onClick}
                      disabled={tile.disabled || isServiceLocked}
                      className="mt-3 text-xs font-semibold underline underline-offset-2 disabled:opacity-60"
                    >
                      {toText(tile.action)}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {activeSection === 'trusted' ? (
              <div className={`rounded-2xl border p-4 ${isDark ? 'border-slate-700 bg-[#18233b]' : 'border-slate-200 bg-slate-50'}`}>
                <h3 className={`text-sm font-semibold mb-3 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Trusted Devices</h3>
                {isLoadingPairings ? (
                  <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Loading paired devices...</p>
                ) : pairings.length === 0 ? (
                  <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No paired devices yet. Connect once to create pairing.</p>
                ) : (
                  <div className="space-y-2">
                    {pairings.map((item) => (
                      <div
                        key={`${item.ownerDeviceId}-${item.peerDeviceId}`}
                        className={`rounded-md border px-3 py-2 flex items-center justify-between ${isDark ? 'border-slate-600 bg-[#0f172a]' : 'border-slate-300 bg-white'}`}
                      >
                        <div>
                          <p className="text-sm">{toText(item.peerLabel) || toText(item.peerDeviceId)}</p>
                          <p className={`text-xs font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{toText(item.peerDeviceId)}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => connectToPairedDevice(item.peerDeviceId)}
                          disabled={isServiceLocked || isCheckingRoom}
                          className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
                        >
                          {isCheckingRoom && pendingOutboundAddress === toText(item.peerDeviceId).trim() ? (
                            <>
                              <CircleLoader className="h-3.5 w-3.5" />
                              Requesting...
                            </>
                          ) : 'Connect'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {activeSection === 'recent' ? (
              <div className={`rounded-2xl border p-4 ${isDark ? 'border-slate-700 bg-[#18233b]' : 'border-slate-200 bg-slate-50'}`}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Recent Sessions</h3>
                  <button
                    type="button"
                    onClick={clearRecentRooms}
                    className={`text-xs ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    Clear
                  </button>
                </div>
                {recentRooms.length === 0 ? (
                  <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No recent rooms yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {recentRooms.map((recentRoom) => (
                      <button
                        key={recentRoom}
                        type="button"
                        onClick={() => setRoomId(toText(recentRoom))}
                        className={`px-3 py-1 text-xs rounded-md border ${isDark ? 'border-slate-600 bg-[#0f172a] hover:bg-slate-700' : 'border-slate-300 bg-white hover:bg-slate-100'}`}
                      >
                        {toText(recentRoom)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </section>

        </main>
      </div>

      <div className={`fixed inset-0 z-20 transition-opacity duration-300 ${isSessionDrawerOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
        <button
          type="button"
          onClick={() => setIsSessionDrawerOpen(false)}
          className="absolute inset-0 bg-black/45"
          aria-label="Close session drawer overlay"
        />
        <aside
          className={`absolute right-0 top-0 h-full w-full max-w-md border-l shadow-2xl p-5 overflow-y-auto transition-transform duration-300 ease-out ${isSessionDrawerOpen ? 'translate-x-0' : 'translate-x-full'} ${isDark ? 'border-slate-700 bg-[#101a2f]' : 'border-slate-300 bg-white'}`}
          onClick={(e) => e.stopPropagation()}
        >
            <div className="flex items-center justify-between mb-4">
              <h3 className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Session Control</h3>
              <button
                type="button"
                onClick={() => setIsSessionDrawerOpen(false)}
                className={`p-2 rounded-md border ${isDark ? 'border-slate-600 text-slate-200' : 'border-slate-300 text-slate-700'}`}
              >
                <CloseGlyph />
              </button>
            </div>

            <div className="space-y-2">
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(toText(e.target.value))}
                placeholder="Enter remote device address"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') joinRoom()
                }}
                className={`w-full px-4 py-2 rounded-md border focus:ring-2 focus:ring-blue-500 focus:outline-none ${isDark ? 'bg-[#0f172a] text-white border-slate-600' : 'bg-white text-slate-900 border-slate-300'}`}
              />
              <div className="grid grid-cols-1 gap-2">
                <button
                  onClick={joinRoom}
                  disabled={isCheckingRoom || isServiceLocked}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2 rounded-lg transition-all disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
                >
                  {isCheckingRoom ? (
                    <>
                      <CircleLoader />
                      Requesting...
                    </>
                  ) : 'Connect'}
                </button>
              </div>
              <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Host must allow your request before both devices enter the detail session.
              </p>
            </div>

            <div className="space-y-2 mt-5">
              <label className={`text-xs ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Device Name</label>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <input
                  type="text"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="Device name"
                  className={`px-4 py-2 rounded-md border focus:ring-2 focus:ring-blue-500 focus:outline-none ${isDark ? 'bg-[#0f172a] text-white border-slate-600' : 'bg-white text-slate-900 border-slate-300'}`}
                />
                <button
                  type="button"
                  onClick={saveProfile}
                  className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm"
                >
                  Save
                </button>
              </div>
            </div>

            <label className={`flex items-start gap-3 text-sm mt-5 ${isDark ? 'text-gray-300' : 'text-slate-700'}`}>
              <input
                type="checkbox"
                checked={hasAcceptedPolicy}
                onChange={(e) => {
                  const checked = e.target.checked
                  setHasAcceptedPolicy(checked)
                  window.localStorage.setItem('remotix-policy-consent', checked ? 'accepted' : 'rejected')
                }}
                className="mt-1 h-4 w-4 rounded border-gray-500 bg-[#2a2a2a]"
              />
              <span>
                I accept the{' '}
                <button
                  type="button"
                  onClick={() => setIsPolicyModalOpen(true)}
                  className="text-blue-400 underline underline-offset-2"
                >
                  Remote Access Policy
                </button>
                .
              </span>
            </label>

        </aside>
      </div>

      {isPolicyModalOpen ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-4 animate-[modalBackdropIn_220ms_ease-out]">
          <div className={`w-full max-w-2xl rounded-xl border p-5 shadow-2xl animate-[modalPanelIn_260ms_cubic-bezier(0.2,0.8,0.2,1)] ${isDark ? 'border-slate-600 bg-[#101a2f]' : 'border-slate-300 bg-white'}`}>
            <div className="flex items-center justify-between gap-3">
              <h3 className={`text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Remote Access Policy</h3>
              <button
                type="button"
                onClick={() => setIsPolicyModalOpen(false)}
                className={`p-2 rounded-md border ${isDark ? 'border-slate-600 text-slate-200' : 'border-slate-300 text-slate-700'}`}
              >
                <CloseGlyph />
              </button>
            </div>
            <p className={`mt-3 text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Remotix gives remote screen viewing and control. Use it only with clear consent from both host and client.
            </p>
            <ul className={`mt-3 space-y-2 text-sm list-disc pl-5 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              <li>Share address and session access only with trusted users.</li>
              <li>Allow remote control only when necessary and disable it when finished.</li>
              <li>Do not access private or sensitive data without explicit permission.</li>
              <li>Disconnect immediately if any behavior looks suspicious.</li>
            </ul>
            <p className={`mt-3 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              By continuing, you confirm you understand these rules and accept responsibility for session security.
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setIsPolicyModalOpen(false)}
                className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {incomingRequest ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-4 animate-[modalBackdropIn_220ms_ease-out]">
          <div className={`w-full max-w-md rounded-xl border p-5 shadow-2xl animate-[modalPanelIn_260ms_cubic-bezier(0.2,0.8,0.2,1)] ${isDark ? 'border-slate-600 bg-[#101a2f]' : 'border-slate-300 bg-white'}`}>
            <p className={`text-xs uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Incoming Connection</p>
            <h3 className={`mt-2 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
              {toText(incomingRequest.clientDisplayName) || 'Unknown Client'} wants to connect
            </h3>
            <p className={`mt-2 text-sm font-mono ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
              {toText(incomingRequest.clientDeviceId) || toText(incomingRequest.clientSocketId)}
            </p>
            <p className={`mt-3 text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Allowing this request will open detail session for both devices.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => respondIncomingRequest(false)}
                disabled={isRespondingRequest}
                className="px-3 py-2 rounded-md bg-slate-600 hover:bg-slate-500 text-white text-sm disabled:opacity-60"
              >
                Reject
              </button>
              <button
                type="button"
                onClick={() => respondIncomingRequest(true)}
                disabled={isRespondingRequest}
                className="px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm disabled:opacity-60"
              >
                Allow
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <style jsx global>{`
        @keyframes modalBackdropIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes modalPanelIn {
          from {
            opacity: 0;
            transform: translateY(-56px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>
  )
}
