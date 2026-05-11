import { useRouter } from 'next/router'
import { useEffect, useRef, useState } from 'react'
import { getSocket } from '../libs/socket'
import { useTheme } from '../libs/theme'
import { getOrCreateDeviceProfile, regenerateDeviceProfile, saveDeviceProfile } from '../libs/device'
import { api } from '../libs/http'
import { createSessionEngine, SESSION_PHASE } from '../libs/session-engine'
import {
  consumeSessionResumeToken,
  readSessionResumeToken,
  saveSessionResumeToken,
  validateSessionResumeToken,
} from '../libs/session-resume'
import {
  buildResumePreflightRequest,
  describeResumePreflightFailure,
  RESUME_PREFLIGHT_MODE,
  parseResumePreflightResponse,
  RESUME_PREFLIGHT_ENDPOINT,
  shouldBypassResumePreflightError,
} from '../libs/session-resume-contract'

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
function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}
function SettingsGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .69.28 1.31.73 1.77.46.46 1.08.73 1.77.73H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
function CircleLoader({ className = '' }) {
  return <span className={`inline-block h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin ${className}`} aria-hidden="true" />
}
const formatRemainingTime = (remainingMs) => {
  const safe = Math.max(0, Number(remainingMs) || 0)
  const totalSeconds = Math.floor(safe / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
const getResumeTone = (remainingMs) => {
  const safe = Math.max(0, Number(remainingMs) || 0)
  if (safe <= 60_000) return 'critical'
  if (safe <= 3 * 60_000) return 'warning'
  return 'healthy'
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
  const [feedbackModal, setFeedbackModal] = useState({
    open: false,
    message: '',
    detail: '',
    type: 'info',
  })
  const [addressCopiedFlash, setAddressCopiedFlash] = useState(false)
  const [hasAcceptedPolicy, setHasAcceptedPolicy] = useState(false)
  const [deviceId, setDeviceId] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [pairings, setPairings] = useState([])
  const [isLoadingPairings, setIsLoadingPairings] = useState(false)
  const [isServiceLocked, setIsServiceLocked] = useState(false)
  const [incomingRequest, setIncomingRequest] = useState(null)
  const [isRespondingRequest, setIsRespondingRequest] = useState(false)
  const [pendingOutboundAddress, setPendingOutboundAddress] = useState('')
  const [isPolicyModalOpen, setIsPolicyModalOpen] = useState(false)
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [isPolicyConsentPromptOpen, setIsPolicyConsentPromptOpen] = useState(false)
  const [isRegeneratingDeviceId, setIsRegeneratingDeviceId] = useState(false)
  const [permissionGate, setPermissionGate] = useState({
    checking: true,
    allGranted: false,
    requirements: [],
    error: '',
  })
  const [resumeToken, setResumeToken] = useState(null)
  const [resumeRemainingMs, setResumeRemainingMs] = useState(0)
  const [showResumeExpiredHint, setShowResumeExpiredHint] = useState(false)
  const [isValidatingResume, setIsValidatingResume] = useState(false)
  const [lastResumeBypassReason, setLastResumeBypassReason] = useState('')
  const outboundRequestTimeoutRef = useRef(null)
  const sessionEngineRef = useRef(null)
  const pendingOutboundAddressRef = useRef('')
  const hasConnectionApprovedRef = useRef(false)
  const resumeExpiryWarnedRef = useRef(false)
  const resumeHintTimeoutRef = useRef(null)
  const hadResumeTokenRef = useRef(false)
  const sessionAddressInputRef = useRef(null)
  const addressCopyFlashTimeoutRef = useRef(null)
  const router = useRouter()
  const { isDark, toggleTheme } = useTheme()
  const resumeTone = getResumeTone(resumeRemainingMs)
  const resumeToneLabel = resumeTone === 'critical'
    ? 'Rejoin expiring soon'
    : resumeTone === 'warning'
      ? 'Rejoin window limited'
      : 'Rejoin ready'

  useEffect(() => {
    sessionEngineRef.current = createSessionEngine({
      onTelemetry: (entry) => {
        console.log('[home][session-engine]', entry)
      },
    })
    sessionEngineRef.current.setPhase(SESSION_PHASE.IDLE)
    return () => {
      sessionEngineRef.current?.destroy()
      sessionEngineRef.current = null
    }
  }, [])

  const openFeedbackModal = (message, type = 'info', detail = '') => {
    const text = toText(message).trim()
    if (!text) return
    setFeedbackModal({
      open: true,
      message: text,
      detail: toText(detail).trim(),
      type: type === 'error' ? 'error' : type === 'success' ? 'success' : 'info',
    })
  }

  const setFeedbackWithAlert = (message, type = 'info', options = {}) => {
    const text = toText(message)
    setFeedback(text)
    if (!options.silent) {
      openFeedbackModal(text, type)
    }
  }

  const checkPermissions = async () => {
    if (typeof window === 'undefined' || !window.ipc?.invoke) {
      setPermissionGate({
        checking: false,
        allGranted: false,
        requirements: [],
        error: 'Native permission bridge is not available.',
      })
      return
    }
    try {
      const result = await window.ipc.invoke('permissions:status')
      setPermissionGate({
        checking: false,
        allGranted: Boolean(result?.allGranted),
        requirements: Array.isArray(result?.requirements) ? result.requirements : [],
        error: '',
      })
    } catch (error) {
      setPermissionGate({
        checking: false,
        allGranted: false,
        requirements: [],
        error: 'Could not verify required permissions.',
      })
    }
  }

  const requestPermission = async (key) => {
    if (typeof window === 'undefined' || !window.ipc?.invoke) return
    try {
      await window.ipc.invoke('permissions:request', { key })
    } catch (error) {
      // Ignore and re-check below to surface latest status.
    }
    await checkPermissions()
  }

  const clearOutboundRequestTimeout = () => {
    sessionEngineRef.current?.clearTimeoutTask('outbound-request-timeout')
    if (!outboundRequestTimeoutRef.current) return
    outboundRequestTimeoutRef.current = null
  }

  const resetOutboundRequestState = () => {
    clearOutboundRequestTimeout()
    pendingOutboundAddressRef.current = ''
    setPendingOutboundAddress('')
    setIsCheckingRoom(false)
    sessionEngineRef.current?.setPhase(SESSION_PHASE.IDLE)
  }

  useEffect(() => {
    pendingOutboundAddressRef.current = toText(pendingOutboundAddress)
  }, [pendingOutboundAddress])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const policyConsent = window.localStorage.getItem('remotix-policy-consent')
    const profile = getOrCreateDeviceProfile()
    setDeviceId(toText(profile.deviceId))
    setDeviceName(toText(profile.displayName))
    setHasAcceptedPolicy(policyConsent === 'accepted')
    const token = readSessionResumeToken()
    setResumeToken(token)
    setResumeRemainingMs(Math.max(0, Number(token?.expiresAt || 0) - Date.now()))

  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return () => {}
    const tick = () => {
      const token = readSessionResumeToken()
      if (!token) {
        if (hadResumeTokenRef.current) {
          setShowResumeExpiredHint(true)
          if (resumeHintTimeoutRef.current) {
            window.clearTimeout(resumeHintTimeoutRef.current)
          }
          resumeHintTimeoutRef.current = window.setTimeout(() => {
            setShowResumeExpiredHint(false)
          }, 4000)
        }
        hadResumeTokenRef.current = false
        setResumeToken(null)
        setResumeRemainingMs(0)
        return
      }
      hadResumeTokenRef.current = true
      setShowResumeExpiredHint(false)
      setResumeToken(token)
      setResumeRemainingMs(Math.max(0, Number(token.expiresAt || 0) - Date.now()))
    }
    tick()
    const intervalId = window.setInterval(tick, 1000)
    return () => {
      window.clearInterval(intervalId)
      if (resumeHintTimeoutRef.current) {
        window.clearTimeout(resumeHintTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!resumeToken) {
      resumeExpiryWarnedRef.current = false
      return
    }
    if (resumeRemainingMs > 60_000) {
      resumeExpiryWarnedRef.current = false
      return
    }
    if (resumeRemainingMs <= 0) return
    if (resumeExpiryWarnedRef.current) return
    resumeExpiryWarnedRef.current = true
    console.warn('[home][resume] token expires in less than 1 minute')
  }, [resumeToken, resumeRemainingMs])

  useEffect(() => {
    checkPermissions()
  }, [])

  useEffect(() => {
    return () => {
      if (addressCopyFlashTimeoutRef.current) {
        window.clearTimeout(addressCopyFlashTimeoutRef.current)
      }
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
      hasConnectionApprovedRef.current = true
      const roomIdForHost = toText(payload?.roomId)
      const fallbackDeviceId = toText(getOrCreateDeviceProfile()?.deviceId)
      const safeDeviceId = toText(deviceId) || fallbackDeviceId
      if (!roomIdForHost || !safeDeviceId) return
      const encodedName = encodeURIComponent(deviceName || 'Host Device')
      router.push(`/host/${roomIdForHost}?deviceId=${safeDeviceId}&name=${encodedName}`)
    }

    const onConnectionApproved = (payload) => {
      hasConnectionApprovedRef.current = true
      const approvedRoomId = toText(payload?.roomId)
      const hostDeviceId = toText(payload?.hostDeviceId) || toText(pendingOutboundAddressRef.current)
      const fallbackDeviceId = toText(getOrCreateDeviceProfile()?.deviceId)
      const safeDeviceId = toText(deviceId) || fallbackDeviceId
      if (!approvedRoomId || !safeDeviceId) return
      resetOutboundRequestState()
      const encodedName = encodeURIComponent(deviceName || 'Client Device')
      router.push(`/client/${approvedRoomId}?deviceId=${safeDeviceId}&name=${encodedName}&targetHostDeviceId=${hostDeviceId}&preapproved=1`)
    }

    const onConnectionRejected = (payload) => {
      resetOutboundRequestState()
      handleConnectionFailure(
        payload?.message || 'Connection request was rejected by host.',
        'The remote host denied the request.',
      )
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

  const ensurePolicyAccepted = () => {
    if (hasAcceptedPolicy) return true
    setIsPolicyConsentPromptOpen(true)
    setFeedbackWithAlert('Please accept the usage policy before starting a session.', 'error')
    return false
  }

  const acceptPolicyConsent = () => {
    setHasAcceptedPolicy(true)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('remotix-policy-consent', 'accepted')
    }
    setIsPolicyConsentPromptOpen(false)
    setFeedbackWithAlert('Policy accepted. You can continue the connection flow.', 'success')
  }

  const openConnectionErrorPage = (message, detail = '') => {
    const safeMessage = toText(message).trim() || 'Connection failed.'
    const safeDetail = toText(detail).trim()
    const query = new URLSearchParams({
      message: safeMessage,
      ...(safeDetail ? { detail: safeDetail } : {}),
    })
    router.push(`/connection-error?${query.toString()}`)
  }

  const handleConnectionFailure = (message, detail = '') => {
    if (hasConnectionApprovedRef.current) {
      openConnectionErrorPage(message, detail)
      return
    }
    openFeedbackModal(message, 'error', detail)
  }

  const requestConnectionToAddress = (targetAddress) => {
    if (!permissionGate.allGranted) {
      setFeedbackWithAlert('Required permissions are not granted yet.', 'error')
      return
    }
    if (isServiceLocked) return
    if (!ensurePolicyAccepted()) return
    const targetHostDeviceId = toText(targetAddress).trim()
    if (!targetHostDeviceId) {
      setFeedbackWithAlert('Please enter a remote address.', 'error')
      return
    }
    if (targetHostDeviceId === deviceId) {
      setFeedback('')
      setFeedbackWithAlert('You cannot connect to your own address.', 'error')
      return
    }

    setIsCheckingRoom(true)
    setPendingOutboundAddress(targetHostDeviceId)
    hasConnectionApprovedRef.current = false
    sessionEngineRef.current?.setPhase(SESSION_PHASE.REQUESTING)
    console.log('[home][connect] checking device status', { targetHostDeviceId })

    api.get(`/devices/${encodeURIComponent(targetHostDeviceId)}/status`)
      .then(({ data }) => {
        if (!data?.exists) {
          resetOutboundRequestState()
          handleConnectionFailure(
            'Address not found in system.',
            `No device is registered with address ${targetHostDeviceId}.`,
          )
          return
        }
        if (!data?.isOnline) {
          resetOutboundRequestState()
          handleConnectionFailure(
            'Address is currently offline.',
            `Device ${targetHostDeviceId} is not online right now.`,
          )
          return
        }

        console.log('[home][connect] sending request', { targetHostDeviceId })
        clearOutboundRequestTimeout()
        outboundRequestTimeoutRef.current = sessionEngineRef.current?.setTimeoutTask('outbound-request-timeout', 15000, () => {
          resetOutboundRequestState()
          handleConnectionFailure(
            'Request timed out.',
            'Host did not respond in time. Please try again.',
          )
        })
        socket.emit('request-connection', {
          targetHostDeviceId,
          clientDeviceId: deviceId,
          clientDisplayName: deviceName || 'Client Device',
        }, (response) => {
          if (response?.ok) return
          sessionEngineRef.current?.setPhase(SESSION_PHASE.ENDED)
          resetOutboundRequestState()
          const fallbackMessage = targetHostDeviceId
            ? 'Address not found in system.'
            : 'Could not send connection request.'
          handleConnectionFailure(
            response?.message || fallbackMessage,
            'The request could not be sent to the remote host.',
          )
        })
      })
      .catch((error) => {
        sessionEngineRef.current?.setPhase(SESSION_PHASE.ENDED)
        resetOutboundRequestState()
        const message = error?.response?.data?.message || 'Could not verify address in database.'
        handleConnectionFailure(
          message,
          'Failed while verifying remote address status.',
        )
      })
  }

  const joinRoom = () => requestConnectionToAddress(roomId)

  const rejoinLastSession = () => {
    if (isValidatingResume) return
    const token = readSessionResumeToken()
    if (!token) {
      setResumeToken(null)
      setFeedbackWithAlert('No active session to rejoin.', 'error')
      return
    }
    const fallbackDeviceId = toText(getOrCreateDeviceProfile()?.deviceId)
    const safeDeviceId = toText(deviceId) || fallbackDeviceId
    const validation = validateSessionResumeToken(token, { expectedDeviceId: safeDeviceId })
    if (!validation.ok) {
      consumeSessionResumeToken()
      setResumeToken(null)
      setResumeRemainingMs(0)
      setFeedbackWithAlert('Last session cannot be resumed. Please start a new session.', 'error')
      return
    }
    setIsValidatingResume(true)
    const run = async () => {
      try {
        const requestPayload = buildResumePreflightRequest({
          tokenId: token.tokenId,
          role: token.role,
          roomId: token.roomId,
          deviceId: safeDeviceId,
          targetHostDeviceId: token.targetHostDeviceId,
        })
        try {
          const { data } = await api.post(RESUME_PREFLIGHT_ENDPOINT, requestPayload)
          const preflight = parseResumePreflightResponse(data)
          if (!preflight.ok) {
            throw new Error(preflight.message || 'Resume preflight was rejected by server.')
          }
          // One-time token behavior: remove current token immediately after approval.
          if (preflight.consumeCurrentToken) {
            consumeSessionResumeToken()
            if (preflight.nextTokenId) {
              const nextExpiresAt = Number(preflight.nextExpiresAt || 0)
              const ttlMs = Math.max(30_000, nextExpiresAt - Date.now())
              saveSessionResumeToken(
                {
                  ...token,
                  tokenId: preflight.nextTokenId,
                  createdAt: Date.now(),
                },
                ttlMs,
              )
            }
          }
          if (preflight.reasonCode === 'DEV_FALLBACK') {
            setLastResumeBypassReason(
              `Bypassed preflight (${preflight.reasonCode} via ${preflight.source}${preflight.requestId ? `, request ${preflight.requestId}` : ''})`,
            )
          } else {
            setLastResumeBypassReason('')
          }
        } catch (preflightError) {
          if (!shouldBypassResumePreflightError(preflightError)) {
            const message =
              toText(preflightError?.response?.data?.message) ||
              toText(preflightError?.message) ||
              'Resume preflight was rejected by server.'
            throw new Error(message)
          }
          const details = describeResumePreflightFailure(preflightError)
          setLastResumeBypassReason(
            `Bypassed preflight (${details.reasonCode || details.status || details.code || 'unavailable'} via ${details.source || 'unknown'}${details.upstreamStatus ? `, upstream ${details.upstreamStatus}` : ''}${details.requestId ? `, request ${details.requestId}` : ''}): ${details.message}`,
          )
          setFeedbackWithAlert(
            'Resume preflight endpoint is unavailable. Continuing in compatibility mode.',
            'error',
          )
        }

        if (token.role === 'client') {
          const targetHostDeviceId = toText(token.targetHostDeviceId)
          const { data } = await api.get(`/devices/${encodeURIComponent(targetHostDeviceId)}/status`)
          if (!data?.exists) throw new Error('Host device does not exist anymore.')
          if (!data?.isOnline) throw new Error('Host device is offline now.')
        }

        setResumeToken(token)
        setResumeRemainingMs(Math.max(0, Number(token.expiresAt || 0) - Date.now()))
        const encodedName = encodeURIComponent(deviceName || (token.role === 'host' ? 'Host Device' : 'Client Device'))
        if (token.role === 'host') {
          router.push(`/host/${toText(token.roomId)}?deviceId=${safeDeviceId}&name=${encodedName}&resume=1`)
          return
        }
        router.push(
          `/client/${toText(token.roomId)}?deviceId=${safeDeviceId}&name=${encodedName}&targetHostDeviceId=${toText(token.targetHostDeviceId)}&preapproved=1&resume=1`,
        )
      } catch (error) {
        consumeSessionResumeToken()
        setResumeToken(null)
        setResumeRemainingMs(0)
        const message = toText(error?.message) || 'Last session cannot be resumed right now.'
        setFeedbackWithAlert(message, 'error')
      } finally {
        setIsValidatingResume(false)
      }
    }
    run()
  }

  const createNewSession = () => {
    setShowResumeExpiredHint(false)
    setRoomId('')
    setFeedback('')
    sessionAddressInputRef.current?.focus?.()
  }

  const saveProfile = () => {
    if (!deviceId) return
    const cleanName = deviceName.trim() || 'My Device'
    setDeviceName(cleanName)
    saveDeviceProfile({ deviceId, displayName: cleanName })
    setFeedbackWithAlert('Device profile updated.', 'success')
    setIsSettingsModalOpen(false)
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
    if (!permissionGate.allGranted) {
      setFeedbackWithAlert('Required permissions are not granted yet.', 'error')
      return
    }
    if (approved && !ensurePolicyAccepted()) {
      return
    }
    if (!incomingRequest?.clientSocketId) return
    setIsRespondingRequest(true)
    const requestClientSocketId = incomingRequest.clientSocketId
    const fallbackDeviceId = toText(getOrCreateDeviceProfile()?.deviceId)
    const safeDeviceId = toText(deviceId) || fallbackDeviceId

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
      console.log('[home][incoming-request] rejected by host')
    } else {
      console.log('[home][incoming-request] approved, opening host room')
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
      setAddressCopiedFlash(true)
      if (addressCopyFlashTimeoutRef.current) {
        window.clearTimeout(addressCopyFlashTimeoutRef.current)
      }
      addressCopyFlashTimeoutRef.current = window.setTimeout(() => {
        setAddressCopiedFlash(false)
        addressCopyFlashTimeoutRef.current = null
      }, 2200)
    } catch (error) {
      setAddressCopiedFlash(false)
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
        <header
          className={`px-3 sm:px-5 py-2 border-b flex items-center justify-between ${isDark ? 'border-slate-800 bg-[#0f172a]/90' : 'border-slate-200 bg-slate-50/90'}`}
        >
          <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
            <div className="flex items-center gap-2 shrink-0">
              <h1 className={`text-lg sm:text-xl md:text-2xl font-bold tracking-tight ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>
                Remotix
              </h1>
            </div>

            <div
              className={`flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5 rounded-lg px-1.5 py-1 sm:px-2 ${
                isDark ? 'bg-slate-900/50' : 'bg-white/80'
              }`}
              title="Connect to a remote address. Host must approve before the session opens."
            >
              <input
                ref={sessionAddressInputRef}
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(toText(e.target.value))}
                placeholder="Enter Remote address"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') joinRoom()
                }}
                className={`min-w-28 flex-1 text-xs py-1.5 px-2 rounded border focus:ring-1 focus:ring-blue-500 focus:outline-none ${
                  isDark ? 'bg-[#0f172a] text-white border-slate-600' : 'bg-white text-slate-900 border-slate-300'
                }`}
              />
              <button
                type="button"
                onClick={joinRoom}
                disabled={isCheckingRoom || isServiceLocked}
                className="shrink-0 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 inline-flex items-center gap-1.5"
              >
                {isCheckingRoom ? (
                  <>
                    <CircleLoader className="h-3 w-3" />
                  </>
                ) : (
                  'Connect'
                )}
              </button>
              <span
                className={`hidden md:block h-5 w-px shrink-0 ${isDark ? 'bg-slate-600' : 'bg-slate-300'}`}
                aria-hidden="true"
              />

              <label
                className={`flex shrink-0 cursor-pointer items-center gap-1 text-[10px] sm:text-[11px] ${isDark ? 'text-slate-300' : 'text-slate-600'}`}
                title="Accept the Remote Access Policy before connecting"
              >
                <input
                  type="checkbox"
                  checked={hasAcceptedPolicy}
                  onChange={(e) => {
                    const checked = e.target.checked
                    setHasAcceptedPolicy(checked)
                    window.localStorage.setItem('remotix-policy-consent', checked ? 'accepted' : 'rejected')
                  }}
                  className={`h-3.5 w-3.5 shrink-0 rounded border ${isDark ? 'border-slate-500 bg-[#0f172a]' : 'border-slate-400 bg-white'}`}
                />
                <span className="select-none whitespace-nowrap">Accept</span>
              </label>
              <button
                type="button"
                onClick={() => setIsPolicyModalOpen(true)}
                className={`shrink-0 px-0.5 text-[10px] sm:text-[11px] underline underline-offset-2 ${isDark ? 'text-blue-300' : 'text-blue-600'}`}
              >
                Policy
              </button>

              <span
                className={`hidden sm:block h-5 w-px shrink-0 ${isDark ? 'bg-slate-600' : 'bg-slate-300'}`}
                aria-hidden="true"
              />
              <button
                type="button"
                onClick={() => setIsSettingsModalOpen(true)}
                className={`shrink-0 rounded-md border px-2.5 py-1.5 text-xs ${isDark ? 'border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
                title="Settings"
                aria-haspopup="dialog"
                aria-expanded={isSettingsModalOpen}
              >
                <SettingsGlyph />
              </button>
              <button
                type="button"
                onClick={toggleTheme}
                className={`shrink-0 rounded-md border px-2.5 py-1.5 text-xs ${isDark ? 'border-slate-600 bg-slate-800 text-slate-200' : 'border-slate-300 bg-white text-slate-700'}`}
                title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                <ThemeGlyph isDark={isDark} />
              </button>
              {isServiceLocked ? (
                <span className="shrink-0 rounded-full border border-slate-600 bg-slate-800 px-2 py-1 text-[10px] sm:text-xs text-white">
                  Locked
                </span>
              ) : null}
            </div>
          </div>
        </header>

        <div
          className={`px-6 py-3 border-b ${isDark ? 'border-slate-800 bg-[#0f172a]/70' : 'border-slate-200 bg-slate-50/80'}`}
        >
          <div className="flex min-w-0 w-full flex-wrap items-center gap-x-3 gap-y-2">
            <span className={`text-xs uppercase tracking-wider shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Your Address
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={copyDeviceId}
                className={`text-xs px-2.5 py-1 rounded border transition-colors duration-200 ${
                  addressCopiedFlash
                    ? isDark
                      ? 'border-emerald-500/80 bg-emerald-950/50 text-emerald-200'
                      : 'border-emerald-500 bg-emerald-50 text-emerald-800'
                    : isDark
                      ? 'border-slate-600 bg-slate-800'
                      : 'border-slate-300 bg-white'
                }`}
              >
                {addressCopiedFlash ? 'Copied!' : 'Copy'}
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
                ) : (
                  'Regenerate'
                )}
              </button>
            </div>
            <p
              className={`min-w-0 max-w-full flex-1 basis-0 font-mono text-lg sm:text-xl md:text-2xl truncate ${isDark ? 'text-red-300' : 'text-red-600'}`}
            >
              {toText(deviceId) || 'Loading...'}
            </p>
          </div>
        </div>

        <main className="min-h-0 overflow-y-auto px-6 py-5">
          <section className="space-y-6 pr-1">
            <div className="grid md:grid-cols-3 gap-4">
              {newsTiles.map((tile) => (
                <div key={tile.title} className={`rounded-xl p-4 text-white bg-gradient-to-br ${tileToneClass(tile.tone)}`}>
                  <p className="font-semibold text-sm">{toText(tile.title)}</p>
                  <p className="text-xs mt-2 opacity-90 min-h-[50px]">{toText(tile.body)}</p>
                  <button
                    type="button"
                    onClick={tile.onClick}
                    disabled={tile.disabled || isServiceLocked}
                    className={`mt-3 text-xs font-semibold underline underline-offset-2 transition-colors disabled:opacity-60 ${
                      tile.title === 'Always Ready' && addressCopiedFlash ? 'decoration-emerald-200 text-emerald-100' : ''
                    }`}
                  >
                    {tile.title === 'Always Ready' && addressCopiedFlash ? 'Copied!' : toText(tile.action)}
                  </button>
                </div>
              ))}
            </div>

            <div className={`rounded-2xl`}>
              <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Trusted Devices</h3>
              <p className={`mt-1 mb-3 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Devices you have connected to before. Use Connect to request again without typing the address.
              </p>
              {isLoadingPairings ? (
                <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Loading paired devices...</p>
              ) : pairings.length === 0 ? (
                <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No paired devices yet. Complete a session once to save a pairing here.</p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {pairings.map((item) => {
                    const peerId = toText(item.peerDeviceId).trim()
                    const isRequesting = isCheckingRoom && pendingOutboundAddress === peerId
                    return (
                      <div
                        key={`${item.ownerDeviceId}-${item.peerDeviceId}`}
                        className="group relative overflow-hidden rounded-2xl border-2 border-blue-500/90 bg-[#0b1020] p-3 shadow-[0_8px_22px_rgba(0,0,0,0.34)]"
                      >
                        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#0c1018] via-[#101625] to-[#21091a]" />
                        <div className="pointer-events-none absolute -left-20 top-24 h-44 w-80 rotate-[-33deg] rounded-[50%] border border-[#d6d8ff]/60 bg-gradient-to-r from-[#9ea8ff]/55 via-[#bda6ff]/30 to-transparent blur-[0.2px]" />
                        <div className="pointer-events-none absolute left-20 top-[-52px] h-52 w-[24rem] rotate-[-16deg] rounded-[50%] border border-[#f0d0ff]/50 bg-gradient-to-r from-[#a14cc8]/65 via-[#b22082]/55 to-[#e64f88]/70" />
                        <div className="pointer-events-none absolute left-20 top-24 h-52 w-[24rem] rotate-[-8deg] rounded-[50%] border border-[#ffd4ef]/35 bg-gradient-to-r from-[#0a0420]/80 via-[#2f0d45]/85 to-[#6b0f3f]/80" />

                        <div className="relative z-10 flex min-h-[180px] flex-col justify-between">
                          <div>
                            <div className="mb-2">
                              <span className="inline-flex rounded-lg bg-slate-900/75 px-2 py-1 text-[11px] font-semibold text-slate-200">
                                Remote Connection
                              </span>
                            </div>
                          </div>

                          <div>
                            <p className="max-w-full break-all text-[1.02rem] font-semibold leading-tight tracking-tight text-white sm:text-[1.12rem]">
                              {peerId || '-'}
                            </p>
                            <p className="mt-1 truncate text-xl font-semibold text-slate-100">
                              {toText(item.peerLabel) || 'Unknown device'}
                            </p>
                          </div>

                          <div className="mt-3.5">
                            <button
                              type="button"
                              onClick={() => connectToPairedDevice(item.peerDeviceId)}
                              disabled={isServiceLocked || isCheckingRoom}
                              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {isRequesting ? (
                                <>
                                  <CircleLoader className="h-3.5 w-3.5" />
                                  Requesting...
                                </>
                              ) : (
                                'Connect'
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </section>

        </main>
      </div>

      {feedbackModal.open ? (
        <div
          className="absolute inset-0 z-[34] flex items-center justify-center bg-black/55 p-4 animate-[modalBackdropIn_220ms_ease-out]"
          onClick={() => setFeedbackModal((current) => ({ ...current, open: false }))}
          role="presentation"
        >
          <div
            className={`w-full max-w-md rounded-xl border p-5 shadow-2xl animate-[modalPanelIn_260ms_cubic-bezier(0.2,0.8,0.2,1)] ${
              isDark ? 'border-slate-600 bg-[#101a2f]' : 'border-slate-300 bg-white'
            }`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="home-feedback-title"
          >
            <h3
              id="home-feedback-title"
              className={`text-base font-semibold ${
                feedbackModal.type === 'success'
                  ? (isDark ? 'text-emerald-200' : 'text-emerald-700')
                  : feedbackModal.type === 'error'
                    ? (isDark ? 'text-red-300' : 'text-red-700')
                    : (isDark ? 'text-slate-100' : 'text-slate-900')
              }`}
            >
              {feedbackModal.type === 'success'
                  ? 'Action Complete'
                  : feedbackModal.type === 'error'
                    ? 'Action Failed'
                    : 'Notice'}
            </h3>
            <p className={`mt-2 text-sm ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              {toText(feedbackModal.message)}
            </p>
            {toText(feedbackModal.detail) ? (
              <p className={`mt-2 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {toText(feedbackModal.detail)}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setFeedbackModal((current) => ({ ...current, open: false }))}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!permissionGate.allGranted ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div className={`w-full max-w-2xl rounded-2xl border shadow-2xl overflow-hidden ${isDark ? 'border-slate-600 bg-[#101a2f]' : 'border-slate-300 bg-white'}`}>
            <div className={`px-5 py-3 border-b flex items-center justify-between ${isDark ? 'border-slate-700 bg-[#0f172a]' : 'border-slate-200 bg-slate-50'}`}>
              <div>
                <h3 className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                  Remotix Permissions
                </h3>
                <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Required before desktop remote control can start
                </p>
              </div>
            </div>

            <div className="px-5 py-4">
              <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Please grant all required OS permissions. The app will stay locked until everything below is granted.
              </p>
            {permissionGate.error ? (
              <p className="mt-2 text-sm text-red-500">{toText(permissionGate.error)}</p>
            ) : null}
              <div className="mt-4 space-y-2">
              {permissionGate.checking ? (
                <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Checking permissions...</p>
              ) : permissionGate.requirements.length === 0 ? (
                <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>No permission requirements were reported.</p>
              ) : (
                permissionGate.requirements.map((item) => (
                  <div
                    key={toText(item?.key)}
                    className={`rounded-lg border px-3 py-3 flex items-center justify-between ${isDark ? 'border-slate-600 bg-[#0f172a]' : 'border-slate-300 bg-slate-50'}`}
                  >
                    <div>
                      <p className="text-sm font-medium">{toText(item?.label) || toText(item?.key)}</p>
                      <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                        Status: {toText(item?.status) || 'unknown'}
                      </p>
                    </div>
                    {item?.granted ? (
                      <span className="text-xs px-2 py-1 rounded bg-emerald-600 text-white">Granted</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => requestPermission(toText(item?.key))}
                        className="text-xs px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white"
                      >
                        Open Settings
                      </button>
                    )}
                  </div>
                ))
              )}
              </div>
            </div>

            <div className={`px-5 py-3 border-t flex items-center justify-between ${isDark ? 'border-slate-700 bg-[#0f172a]/60' : 'border-slate-200 bg-slate-50/80'}`}>
              <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Tip: After changing macOS permissions, return to app and click recheck.
              </p>
              <button
                type="button"
                onClick={checkPermissions}
                className={`px-3 py-2 rounded-md text-sm ${isDark ? 'bg-slate-700 hover:bg-slate-600 text-slate-100' : 'bg-slate-200 hover:bg-slate-300 text-slate-800'}`}
              >
                Recheck Permissions
              </button>
            </div>
          </div>
        </div>
      ) : null}

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

      {isSettingsModalOpen ? (
        <div
          className="absolute inset-0 z-[32] flex items-center justify-center bg-black/55 p-4 animate-[modalBackdropIn_220ms_ease-out]"
          onClick={() => setIsSettingsModalOpen(false)}
          role="presentation"
        >
          <div
            className={`w-full max-w-md rounded-xl border p-5 shadow-2xl animate-[modalPanelIn_260ms_cubic-bezier(0.2,0.8,0.2,1)] ${isDark ? 'border-slate-600 bg-[#101a2f]' : 'border-slate-300 bg-white'}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-modal-title"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 id="settings-modal-title" className={`text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                Settings
              </h3>
              <button
                type="button"
                onClick={() => setIsSettingsModalOpen(false)}
                className={`p-2 rounded-md border ${isDark ? 'border-slate-600 text-slate-200' : 'border-slate-300 text-slate-700'}`}
                aria-label="Close settings"
              >
                <CloseGlyph />
              </button>
            </div>
            <p className={`mt-2 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              Device address (read-only)
            </p>
            <p className={`mt-1 font-mono text-xs break-all ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{toText(deviceId) || '—'}</p>

            <label className={`mt-5 block text-xs font-medium ${isDark ? 'text-slate-300' : 'text-slate-700'}`} htmlFor="settings-device-name">
              Display name
            </label>
            <p className={`mt-1 text-[11px] ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
              Shown to others when you connect or host a session.
            </p>
            <input
              id="settings-device-name"
              type="text"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="My device"
              className={`mt-2 w-full rounded-md border px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none ${
                isDark ? 'border-slate-600 bg-[#0f172a] text-white' : 'border-slate-300 bg-white text-slate-900'
              }`}
            />

            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsSettingsModalOpen(false)}
                className={`rounded-md border px-4 py-2 text-sm ${isDark ? 'border-slate-600 text-slate-200 hover:bg-slate-800' : 'border-slate-300 text-slate-800 hover:bg-slate-50'}`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveProfile}
                disabled={!deviceId}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save name
              </button>
            </div>

            <div className={`mt-6 border-t pt-4 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
              <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>More</p>
              <button
                type="button"
                onClick={() => {
                  setIsSettingsModalOpen(false)
                  setIsPolicyModalOpen(true)
                }}
                className={`mt-2 text-sm underline underline-offset-2 ${isDark ? 'text-blue-300' : 'text-blue-600'}`}
              >
                Remote Access Policy
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

      {isPolicyConsentPromptOpen ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/55 p-4 animate-[modalBackdropIn_220ms_ease-out]">
          <div className={`w-full max-w-md rounded-xl border p-5 shadow-2xl animate-[modalPanelIn_260ms_cubic-bezier(0.2,0.8,0.2,1)] ${isDark ? 'border-slate-600 bg-[#101a2f]' : 'border-slate-300 bg-white'}`}>
            <p className={`text-xs uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Policy Required</p>
            <h3 className={`mt-2 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
              Accept policy before approving remote access
            </h3>
            <p className={`mt-3 text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              A client is requesting remote access. You must accept the Remote Access Policy first.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setIsPolicyConsentPromptOpen(false)}
                className="px-3 py-2 rounded-md bg-slate-600 hover:bg-slate-500 text-white text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={acceptPolicyConsent}
                className="px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm"
              >
                I Accept
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setIsPolicyConsentPromptOpen(false)
                setIsPolicyModalOpen(true)
              }}
              className="mt-3 text-xs text-blue-400 underline underline-offset-2"
            >
              Read full policy
            </button>
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
