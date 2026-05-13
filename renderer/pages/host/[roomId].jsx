import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import Peer from 'simple-peer'
import { getSocket } from '../../libs/socket';
import { useTheme } from '../../libs/theme'
import { attachRtcDiagnostics, getRtcConfig, runWebRtcLatencyWarmup } from '../../libs/rtc'
import { api } from '../../libs/http'
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
const QUALITY_APPLY_COOLDOWN_MS = toPositiveInt(process.env.NEXT_PUBLIC_QUALITY_APPLY_COOLDOWN_MS, 6000)
const QUALITY_URGENT_DOWNGRADE_LEVEL = String(
  process.env.NEXT_PUBLIC_QUALITY_URGENT_DOWNGRADE_LEVEL || 'poor',
)
  .trim()
  .toLowerCase()
const REQUEST_RISK_WINDOW_MS = 60_000
const REQUEST_RISK_BURST_THRESHOLD = 3
const HOST_AUDIT_MAX_ITEMS = 30
const HOST_AUDIT_ENDPOINT =
  (typeof process.env.NEXT_PUBLIC_HOST_AUDIT_ENDPOINT === 'string'
    ? process.env.NEXT_PUBLIC_HOST_AUDIT_ENDPOINT.trim()
    : '') || '/audit/host-connection-events'
const HOST_AUDIT_INGEST_KEY =
  typeof process.env.NEXT_PUBLIC_HOST_AUDIT_INGEST_KEY === 'string'
    ? process.env.NEXT_PUBLIC_HOST_AUDIT_INGEST_KEY.trim()
    : ''
const HOST_APPROVAL_POLICY_KEY = 'remotix-host-approval-policy'
const HOST_APPROVAL_POLICY = {
  ALWAYS_ASK: 'always_ask',
  ASK_NEW_ONLY: 'ask_new_only',
  AUTO_APPROVE_TRUSTED: 'auto_approve_trusted',
}

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
const formatRelativeTime = (value) => {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return ''
  const diffMs = Date.now() - timestamp
  if (diffMs < 0) return 'just now'
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
const toNormalizedLower = (value) => toText(value).trim().toLowerCase()

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

  const [allowControl, setAllowControl] = useState(true)
  const [sessionNotice, setSessionNotice] = useState('')
  const [isSharing, setIsSharing] = useState(false)
  const [isPreparingShare, setIsPreparingShare] = useState(false)
  const [incomingRequests, setIncomingRequests] = useState([])
  const [hasAcceptedPolicy, setHasAcceptedPolicy] = useState(false)
  const [isPolicyConsentPromptOpen, setIsPolicyConsentPromptOpen] = useState(false)
  const [dbUnavailableMessage, setDbUnavailableMessage] = useState('')
  const [isReselectingShare, setIsReselectingShare] = useState(false)
  const [isSourcePickerOpen, setIsSourcePickerOpen] = useState(false)
  const [availableSources, setAvailableSources] = useState([])
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [approvalPolicy, setApprovalPolicy] = useState(HOST_APPROVAL_POLICY.ALWAYS_ASK)
  const [knownPairings, setKnownPairings] = useState([])
  const [requestDeviceInfo, setRequestDeviceInfo] = useState({})
  const [riskConfirmRequest, setRiskConfirmRequest] = useState(null)
  const [hostAuditTrail, setHostAuditTrail] = useState([])
  const [sessionEndedReason, setSessionEndedReason] = useState('')
  /** Join-room succeeded; used with tray mode (Electron) right after entering the host session. */
  const [hostSessionJoined, setHostSessionJoined] = useState(false)
  const [isSignalingActive, setIsSignalingActive] = useState(false)
  const [isPeerConnected, setIsPeerConnected] = useState(false)
  const [latencyMs, setLatencyMs] = useState(null)
  const [sessionPhase, setSessionPhase] = useState(SESSION_PHASE.IDLE)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [permissionGate, setPermissionGate] = useState({
    checking: true,
    allGranted: false,
  })
  const videoRef = useRef(null)
  const localStreamRef = useRef(null)
  const blackFrameCanvasRef = useRef(null)
  const peerRef = useRef(null)
  const pendingPeerIdRef = useRef('')
  const shareStartPromiseRef = useRef(null)
  const hasJoinedRoomRef = useRef(false)
  const hasAnnouncedReadyRef = useRef(false)
  const peerHealthTimeoutRef = useRef(null)
  const autoExitTimeoutRef = useRef(null)
  const hasTriggeredExitRef = useRef(false)
  const detachRtcDiagnosticsRef = useRef(null)
  const streamHealthIntervalRef = useRef(null)
  const blackFrameHitsRef = useRef(0)
  const streamDebugIntervalRef = useRef(null)
  const blackRecoveryInFlightRef = useRef(false)
  const isManualDisconnectRef = useRef(false)
  const appliedQualityLevelRef = useRef('')
  const approvalPolicyRef = useRef(HOST_APPROVAL_POLICY.ALWAYS_ASK)
  const hasAcceptedPolicyRef = useRef(false)
  const requestHistoryRef = useRef({})
  const sessionEngineRef = useRef(null)
  const lastPhaseToastRef = useRef('')
  const lastQualityApplyAtRef = useRef(0)
  const { isDark, toggleTheme } = useTheme()
  const logDebug = (stage, payload = {}) => {
    console.log(`[host][debug] ${stage}`, payload)
  }

  const buildRequestRiskSummary = (request) => {
    const safeRequest = request && typeof request === 'object' ? request : {}
    const clientDeviceId = toText(safeRequest.clientDeviceId).trim()
    const requestLabel = toText(safeRequest.clientDisplayName).trim()
    const pairing = knownPairings.find(
      (item) => toText(item?.peerDeviceId).trim() === clientDeviceId,
    )
    const status = requestDeviceInfo[clientDeviceId]
    const reasons = []
    const isTrusted = Boolean(pairing)
    const pairingLabel = toText(pairing?.peerLabel).trim()
    if (
      isTrusted &&
      pairingLabel &&
      requestLabel &&
      toNormalizedLower(pairingLabel) !== toNormalizedLower(requestLabel)
    ) {
      reasons.push('Trusted device label changed from previous pairing.')
    }
    const historyKey = clientDeviceId || toText(safeRequest.clientSocketId).trim() || 'unknown'
    const history = Array.isArray(requestHistoryRef.current[historyKey])
      ? requestHistoryRef.current[historyKey]
      : []
    if (history.length >= REQUEST_RISK_BURST_THRESHOLD) {
      reasons.push('Multiple connection requests in a short time window.')
    }
    if (isTrusted && status && status.exists && status.isOnline === false) {
      reasons.push('Trusted device reported offline in device registry.')
    }
    return {
      isTrusted,
      reasons,
      level: reasons.length > 0 ? 'warning' : 'normal',
    }
  }

  useEffect(() => {
    sessionEngineRef.current = createSessionEngine({
      onPhaseChange: (phase) => {
        setSessionPhase(phase)
        if (phase === SESSION_PHASE.RECOVERING) {
          setNotice('Session is recovering automatically...', 'error')
        }
        if (
          phase !== lastPhaseToastRef.current &&
          (phase === SESSION_PHASE.RECOVERING ||
            phase === SESSION_PHASE.LIVE ||
            phase === SESSION_PHASE.ENDED)
        ) {
          lastPhaseToastRef.current = phase
          const phaseMessage = getSessionPhaseMessage(phase, 'host')
          console.log('[host][phase]', { phase, message: phaseMessage })
        }
      },
      onTelemetry: (entry) => {
        console.log('[host][session-engine]', entry)
      },
    })
    sessionEngineRef.current.setPhase(SESSION_PHASE.JOINED)
    return () => {
      sessionEngineRef.current?.destroy()
      sessionEngineRef.current = null
    }
  }, [])

  const stopStreamDebugMonitor = () => {
    if (!streamDebugIntervalRef.current) return
    window.clearInterval(streamDebugIntervalRef.current)
    streamDebugIntervalRef.current = null
  }

  useEffect(() => {
    if (!window.ipc?.invoke) return () => {}
    window.ipc.invoke('session:keep-awake', { enabled: true }).catch(() => {})
    return () => {
      window.ipc.invoke('session:keep-awake', { enabled: false }).catch(() => {})
    }
  }, [])

  useEffect(() => {
    approvalPolicyRef.current = approvalPolicy
  }, [approvalPolicy])

  useEffect(() => {
    hasAcceptedPolicyRef.current = hasAcceptedPolicy
  }, [hasAcceptedPolicy])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const saved = toText(window.localStorage.getItem(HOST_APPROVAL_POLICY_KEY)).toLowerCase()
    if (
      saved === HOST_APPROVAL_POLICY.ALWAYS_ASK ||
      saved === HOST_APPROVAL_POLICY.ASK_NEW_ONLY ||
      saved === HOST_APPROVAL_POLICY.AUTO_APPROVE_TRUSTED
    ) {
      setApprovalPolicy(saved)
      approvalPolicyRef.current = saved
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(HOST_APPROVAL_POLICY_KEY, approvalPolicy)
  }, [approvalPolicy])

  useEffect(() => {
    const activeRoomId = toText(roomId)
    if (!activeRoomId) return
    const writeToken = () => {
      saveSessionResumeToken({
        role: 'host',
        roomId: activeRoomId,
        deviceId: toText(deviceId),
        displayName: typeof name === 'string' ? decodeURIComponent(name) : 'Host Device',
      })
    }
    writeToken()
    const tokenInterval = window.setInterval(writeToken, 25_000)
    return () => window.clearInterval(tokenInterval)
  }, [roomId, deviceId, name])

  useEffect(() => {
    checkPermissions()
  }, [])

  useEffect(() => {
    if (permissionGate.checking) return
    if (!permissionGate.allGranted) {
      setAllowControl(false)
      setNotice('Control is disabled until required OS permissions are granted.', 'error')
    }
  }, [permissionGate.checking, permissionGate.allGranted])

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
    }, 6000)
  }


  const setNotice = (message, type = 'info') => {
    const text = toText(message)
    setSessionNotice(text)
    if (text) {
      console.log('[host][notice]', { type, message: text })
    }
  }

  const setDbMessage = (message) => {
    const text = toText(message)
    setDbUnavailableMessage(text)
    if (text) console.warn('[host][db]', text)
  }

  const appendHostAuditEvent = (eventName, payload = {}) => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      event: toText(eventName) || 'host_event',
      requestId: toText(payload.requestId),
      policyMode: toText(payload.policyMode || approvalPolicyRef.current),
      clientDeviceId: toText(payload.clientDeviceId),
      clientDisplayName: toText(payload.clientDisplayName),
      clientSocketId: toText(payload.clientSocketId),
      reason: toText(payload.reason),
      riskReasons: Array.isArray(payload.riskReasons)
        ? payload.riskReasons.map((item) => toText(item)).filter(Boolean)
        : [],
      approved: Boolean(payload.approved),
      roomId: toText(payload.roomId || roomId),
      at: new Date().toISOString(),
    }
    setHostAuditTrail((prev) => [entry, ...prev].slice(0, HOST_AUDIT_MAX_ITEMS))

    api.post(HOST_AUDIT_ENDPOINT, entry, {
      headers: HOST_AUDIT_INGEST_KEY
        ? { 'x-audit-ingest-key': HOST_AUDIT_INGEST_KEY }
        : undefined,
    }).catch(() => {
      // Optional remote audit endpoint; local trail remains source of truth.
    })
  }

  const copyDiagnosticsSnapshot = async () => {
    const snapshot = {
      schemaVersion: '1.0.0',
      role: 'host',
      phase: sessionPhase,
      roomId: toText(roomId),
      approvedRoomId: '',
      signalingConnected: isSignalingActive,
      peerConnected: isPeerConnected,
      streamActive: isSharing,
      allowControl,
      pointerLocked: false,
      fullscreen: false,
      controlProfile: '',
      sourceId: toText(selectedSourceId),
      latencyMs,
      status: toText(sessionNotice),
      auditTrail: hostAuditTrail.slice(0, 20),
      timestamp: new Date().toISOString(),
    }

    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      setNotice('Clipboard API is unavailable in this environment.', 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2))
      setNotice('Diagnostics snapshot copied.', 'success')
    } catch (_error) {
      setNotice('Could not copy diagnostics snapshot.', 'error')
    }
  }

  const downloadDiagnosticsSnapshot = () => {
    const snapshot = {
      schemaVersion: '1.0.0',
      role: 'host',
      phase: sessionPhase,
      roomId: toText(roomId),
      approvedRoomId: '',
      signalingConnected: isSignalingActive,
      peerConnected: isPeerConnected,
      streamActive: isSharing,
      allowControl,
      pointerLocked: false,
      fullscreen: false,
      controlProfile: '',
      sourceId: toText(selectedSourceId),
      latencyMs,
      status: toText(sessionNotice),
      auditTrail: hostAuditTrail.slice(0, 20),
      timestamp: new Date().toISOString(),
    }
    try {
      const payload = JSON.stringify(snapshot, null, 2)
      const blob = new Blob([payload], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `remotix-host-snapshot-${Date.now()}.json`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      setNotice('Diagnostics snapshot downloaded.', 'success')
    } catch (_error) {
      setNotice('Could not download diagnostics snapshot.', 'error')
    }
  }

  const updatePhaseFromEvent = (eventName) => {
    const engine = sessionEngineRef.current
    if (!engine) return
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
      return
    }
    if (eventName === 'recovering') {
      engine.setPhase(SESSION_PHASE.RECOVERING)
    }
  }

  const checkPermissions = async () => {
    if (typeof window === 'undefined' || !window.ipc?.invoke) {
      setPermissionGate({ checking: false, allGranted: false })
      return
    }
    try {
      const result = await window.ipc.invoke('permissions:status')
      setPermissionGate({
        checking: false,
        allGranted: Boolean(result?.allGranted),
      })
    } catch (_error) {
      setPermissionGate({ checking: false, allGranted: false })
    }
  }

  const ensurePolicyAccepted = () => {
    if (hasAcceptedPolicy) return true
    setIsPolicyConsentPromptOpen(true)
    setNotice('Please accept the usage policy before approving remote access.', 'error')
    return false
  }

  const acceptPolicyConsent = () => {
    setHasAcceptedPolicy(true)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('remotix-policy-consent', 'accepted')
    }
    setIsPolicyConsentPromptOpen(false)
    setNotice('Policy accepted. You can now approve incoming requests.', 'success')
  }

  const showSessionEnded = (reason) => {
    if (isManualDisconnectRef.current) return
    const text = toText(reason) || 'Remote session ended.'
    setSessionEndedReason(text)
    setSessionNotice(text)
    setHostSessionJoined(false)
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

  const exitSessionFlow = (reason, delayMs = 1400) => {
    if (hasTriggeredExitRef.current) return
    hasTriggeredExitRef.current = true
    setHostSessionJoined(false)
    if (peerHealthTimeoutRef.current) {
      window.clearTimeout(peerHealthTimeoutRef.current)
      peerHealthTimeoutRef.current = null
    }
    setNotice(reason || 'Could not complete host connection flow.', 'error')
    setSessionEndedReason(reason || 'Could not complete host connection flow.')
    autoExitTimeoutRef.current = window.setTimeout(() => {
      router.push('/home')
    }, delayMs)
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
      // Slightly below 1080p30 default: less encode + network backlog while still sharp for remote desktop.
      good: { width: 1600, height: 900, frameRate: 28 },
      fair: { width: 1280, height: 720, frameRate: 24 },
      poor: { width: 960, height: 540, frameRate: 15 },
    }
    const target = profileMap[level] || profileMap.good
    if (appliedQualityLevelRef.current === level) return
    const now = Date.now()
    const withinCooldown = now - lastQualityApplyAtRef.current < QUALITY_APPLY_COOLDOWN_MS
    const isUrgentDowngrade =
      level === QUALITY_URGENT_DOWNGRADE_LEVEL &&
      (appliedQualityLevelRef.current === 'good' || appliedQualityLevelRef.current === 'fair')
    if (withinCooldown && !isUrgentDowngrade) return

    try {
      await track.applyConstraints({
        width: { ideal: target.width, max: target.width },
        height: { ideal: target.height, max: target.height },
        frameRate: { ideal: target.frameRate, max: target.frameRate },
      })
      appliedQualityLevelRef.current = level
      lastQualityApplyAtRef.current = now
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
      sessionEngineRef.current?.clearTimeoutTask('peer-health-timeout')
      setIsPeerConnected(true)
      updatePhaseFromEvent('handshake-start')
      setNotice('Secure peer channel established.', 'success')
      runWebRtcLatencyWarmup(peer, 'host')
    })

    peer.on('close', () => {
      setIsPeerConnected(false)
      if (isManualDisconnectRef.current) return
      const didSchedule = sessionEngineRef.current?.scheduleRecovery(
        SESSION_RECOVERY.PEER,
        () => {
          hasAnnouncedReadyRef.current = false
          announceHandshakeReady()
        },
      )
      if (!didSchedule) {
        showSessionEnded('Connection dropped repeatedly. Please reconnect from home.')
        return
      }
      setNotice('Client connection dropped. Waiting for automatic reconnect...', 'error')
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
    peerHealthTimeoutRef.current = sessionEngineRef.current?.setTimeoutTask('peer-health-timeout', 15000, () => {
      setNotice('Connection timed out. Check your network and press Restart Share.', 'error')
    })
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

      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      const vw = video.videoWidth
      const vh = video.videoHeight
      const sw = 28
      const sh = 16
      const sx = Math.max(0, Math.floor((vw - sw) / 2))
      const sy = Math.max(0, Math.floor((vh - sh) / 2))
      canvas.width = sw
      canvas.height = sh
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh)
      const frame = ctx.getImageData(0, 0, sw, sh).data
      let sum = 0
      for (let i = 0; i < frame.length; i += 4) {
        sum += frame[i] + frame[i + 1] + frame[i + 2]
      }
      const avgBrightness = sum / (frame.length / 4) / 3
      logDebug('black-frame-sample', {
        avgBrightness: Number(avgBrightness).toFixed(2),
        blackHits: blackFrameHitsRef.current,
      })
      if (avgBrightness < 5) {
        blackFrameHitsRef.current += 1
      } else {
        blackFrameHitsRef.current = 0
      }

      if (blackFrameHitsRef.current >= 6) {
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
    }, 2800)
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
    const ctx = probeCanvas.getContext('2d', { willReadFrequently: true })
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
      if (avgBrightness >= 5) return true
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
      setHasAcceptedPolicy(policyConsent === 'accepted')
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
        exitSessionFlow(response?.message || 'Could not join host room.')
        return
      }
      hasJoinedRoomRef.current = true
      setHostSessionJoined(true)
      setIsSignalingActive(true)
      updatePhaseFromEvent('room-joined')
      console.log('[host][join-room] success', response)
      if (localStreamRef.current) {
        announceHandshakeReady()
        if (window.ipc?.invoke) {
          setNotice(
            'แชร์อยู่แล้ว — เชื่อมห้องสำเร็จ ในแอปเดสก์ท็อปหน้าต่างจะพับไปที่ไอคอนริมจอ (tray) ในไม่ช้า แอปยังทำงานอยู่ คลิกไอคอน Remotix ที่เมนูบาร์หรือทาสก์บาร์เพื่อเปิดกลับ / Sharing already on; the window will move to the tray shortly — the app is still running.',
            'info',
          )
        }
      } else {
        setNotice(
          `Preparing screen share automatically. You can still change source anytime.${
            window.ipc?.invoke
              ? ' ในแอปเดสก์ท็อป หลังปิดตัวเลือกจอและไม่ busy แล้ว หน้าต่างจะพับไปที่ tray — แอปยังทำงานอยู่ (ดูไอคอน Remotix ริมจอ + การแจ้งเตือนระบบ) / Desktop: window folds to tray when idle; app keeps running.'
              : ''
          }`,
        )
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
      exitSessionFlow(payload?.message || 'Could not join host room.')
    })

    socket.on('handshake-error', (payload) => {
      exitSessionFlow(payload?.message || 'Host connection has an issue.')
    })

    socket.on('incoming-connection-request', (request) => {
      const safeRequest = request && typeof request === 'object' ? request : {}
      const clientDeviceId = toText(safeRequest.clientDeviceId).trim()
      const historyKey = clientDeviceId || toText(safeRequest.clientSocketId).trim() || 'unknown'
      const now = Date.now()
      const prevHistory = Array.isArray(requestHistoryRef.current[historyKey])
        ? requestHistoryRef.current[historyKey]
        : []
      requestHistoryRef.current[historyKey] = [...prevHistory, now].filter(
        (timestamp) => now - Number(timestamp || 0) <= REQUEST_RISK_WINDOW_MS,
      )
      const isTrusted = Boolean(
        clientDeviceId &&
        knownPairings.some((item) => toText(item?.peerDeviceId).trim() === clientDeviceId),
      )
      const risk = buildRequestRiskSummary(safeRequest)
      const policyMode = approvalPolicyRef.current
      const shouldAutoApproveTrusted =
        (policyMode === HOST_APPROVAL_POLICY.ASK_NEW_ONLY ||
          policyMode === HOST_APPROVAL_POLICY.AUTO_APPROVE_TRUSTED) &&
        isTrusted

      if (!hasAcceptedPolicyRef.current) {
        setIsPolicyConsentPromptOpen(true)
      }
      if (!hasAcceptedPolicyRef.current || !shouldAutoApproveTrusted || risk.level === 'warning') {
        setIncomingRequests((prev) => {
          const withoutDup = prev.filter((item) => item.clientSocketId !== safeRequest.clientSocketId)
          return [...withoutDup, safeRequest]
        })
        appendHostAuditEvent('request_received', {
          requestId: toText(safeRequest.requestId),
          clientDeviceId,
          clientDisplayName: toText(safeRequest.clientDisplayName),
          clientSocketId: toText(safeRequest.clientSocketId),
          riskReasons: risk.reasons,
          reason: risk.level === 'warning' ? 'risk_signal' : 'manual_review',
          approved: false,
        })
        setNotice(
          risk.level === 'warning'
            ? `Incoming request from ${safeRequest.clientDisplayName || 'Unknown Client'} requires extra verification.`
            : `Incoming request from ${safeRequest.clientDisplayName || 'Unknown Client'}.`,
        )
        return
      }

      appendHostAuditEvent('request_auto_approved', {
        requestId: toText(safeRequest.requestId),
        clientDeviceId,
        clientDisplayName: toText(safeRequest.clientDisplayName),
        clientSocketId: toText(safeRequest.clientSocketId),
        approved: true,
        reason: 'trusted_policy',
      })
      setNotice(`Trusted device ${safeRequest.clientDisplayName || clientDeviceId || 'Unknown Client'} was approved automatically.`, 'success')
      handleConnectionRequest(safeRequest.clientSocketId, true)
    })

    socket.on('service-unavailable', (payload) => {
      setDbMessage(payload?.message || 'Cannot connect to database. Service is locked.')
      exitSessionFlow('Service is unavailable because the database is not ready.')
    })

    socket.on('disconnect', () => {
      setNotice('Connection lost. Waiting for network recovery...', 'error')
      setIsSignalingActive(false)
      updatePhaseFromEvent('recovering')
    })

    socket.on('connect_error', () => {
      setNotice('Network error while connecting to signaling server.', 'error')
    })

    socket.on('reconnect', () => {
      setNotice('Connection restored. Rejoining host session...', 'success')
      setIsSignalingActive(true)
      updatePhaseFromEvent('room-joined')
      hasAnnouncedReadyRef.current = false
      announceHandshakeReady()
    })

    socket.on('session-ended', (payload) => {
      updatePhaseFromEvent('session-ended')
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
      if (autoExitTimeoutRef.current) {
        window.clearTimeout(autoExitTimeoutRef.current)
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
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off('reconnect');
      socket.off('session-ended');
      socket.off('client-network-quality');
      setHostSessionJoined(false)
    }
  }, [roomId, allowControl, router, knownPairings])

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

    const heartbeatId = window.setInterval(emitHeartbeat, 12_000)
    return () => {
      window.clearInterval(heartbeatId)
      socket.off('connect', emitHeartbeat)
    }
  }, [deviceId, name])

  useEffect(() => {
    const hostDeviceId = toText(deviceId).trim()
    if (!hostDeviceId) return
    let cancelled = false
    const loadPairings = async () => {
      try {
        const { data } = await api.get(`/pairings/${encodeURIComponent(hostDeviceId)}`)
        const items = Array.isArray(data?.items) ? data.items : []
        if (!cancelled) setKnownPairings(items)
      } catch (_error) {
        if (!cancelled) setKnownPairings([])
      }
    }
    loadPairings()
    return () => {
      cancelled = true
    }
  }, [deviceId])

  useEffect(() => {
    const candidates = incomingRequests
      .map((request) => toText(request?.clientDeviceId).trim())
      .filter(Boolean)
      .filter((value, index, list) => list.indexOf(value) === index)
      .filter((value) => !requestDeviceInfo[value])
    if (candidates.length === 0) return
    let cancelled = false
    Promise.all(
      candidates.map(async (candidateId) => {
        try {
          const { data } = await api.get(`/devices/${encodeURIComponent(candidateId)}/status`)
          return [candidateId, data]
        } catch (_error) {
          return [candidateId, null]
        }
      }),
    ).then((results) => {
      if (cancelled) return
      setRequestDeviceInfo((prev) => {
        const next = { ...prev }
        results.forEach(([candidateId, data]) => {
          next[candidateId] = data
        })
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [incomingRequests, requestDeviceInfo])

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
        const capTrack = stream.getVideoTracks?.()[0]
        if (capTrack && 'contentHint' in capTrack) {
          try {
            capTrack.contentHint = 'motion'
          } catch (_e) {
            // ignore
          }
        }
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
            if (isManualDisconnectRef.current) return
            localStreamRef.current = null
            setIsSharing(false)
            stopStreamHealthMonitor()
            const didSchedule = sessionEngineRef.current?.scheduleRecovery(
              SESSION_RECOVERY.STREAM,
              () => {
                ensureScreenSharingStarted(true).catch(() => {})
              },
            )
            if (!didSchedule) {
              setNotice('Screen capture recovery exceeded retry limit.', 'error')
              return
            }
            setNotice('Screen capture stopped. Recovering screen share automatically...', 'error')
          }
        })

        await attachStreamToPreview(stream)
        setIsSharing(true)
        sessionEngineRef.current?.markHealthy()
        console.info(
          '[host][performance] Sharing a display that includes this Remotix window causes very high CPU/GPU (recursive capture). Prefer another monitor or a window that does not show Remotix.',
        )
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

  /** ขอสิทธิ์การแจ้งเตือนล่วงหน้า เพื่อให้ main process แจ้งได้เมื่อพับไป tray (บางระบบต้องได้รับอนุญาตจากผู้ใช้) */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.ipc?.invoke) return undefined
    if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') {
      return undefined
    }
    void Notification.requestPermission().catch(() => {})
    return undefined
  }, [])

  /**
   * Electron: after join-room succeeds, hide the main window to the tray as soon as blocking UI is gone
   * (no source picker, not mid capture prep). Stays off while in session; disabled when session ends or leaving.
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.ipc?.invoke) return undefined
    const sessionEnded = Boolean(toText(sessionEndedReason))
    const trayEligible =
      hostSessionJoined &&
      !sessionEnded &&
      !isSourcePickerOpen &&
      !isPreparingShare
    if (!trayEligible) {
      void window.ipc.invoke('host-session:tray-mode', { enabled: false }).catch(() => {})
      return undefined
    }
    const delayMs = isSharing ? 700 : 500
    const timeoutId = window.setTimeout(() => {
      void window.ipc.invoke('host-session:tray-mode', { enabled: true }).catch(() => {})
    }, delayMs)
    return () => {
      window.clearTimeout(timeoutId)
      void window.ipc.invoke('host-session:tray-mode', { enabled: false }).catch(() => {})
    }
  }, [
    hostSessionJoined,
    sessionEndedReason,
    isSourcePickerOpen,
    isPreparingShare,
    isSharing,
  ])

  useEffect(() => {
    const handleShortcut = (event) => {
      if (event.key.toLowerCase() === 'c') {
        if (!permissionGate.allGranted) {
          setNotice('Control is blocked until required OS permissions are granted.', 'error')
          return
        }
        const next = !allowControl
        setAllowControl(next)
        setNotice(next ? 'Remote control enabled (shortcut C).' : 'Remote control disabled (shortcut C).')
      }
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [allowControl, permissionGate.allGranted])

  const handleDisconnect = () => {
    isManualDisconnectRef.current = true
    setHostSessionJoined(false)
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
    clearSessionResumeToken()

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
      const target = incomingRequests.find((item) => item.clientSocketId === clientSocketId)
      const risk = buildRequestRiskSummary(target)
      if (risk.level === 'warning' && !riskConfirmRequest) {
        appendHostAuditEvent('request_risk_confirmation_required', {
          clientDeviceId: toText(target?.clientDeviceId),
          clientDisplayName: toText(target?.clientDisplayName),
          clientSocketId,
          riskReasons: risk.reasons,
          approved: false,
          reason: 'risk_confirm',
        })
        setRiskConfirmRequest({
          clientSocketId,
          clientDisplayName: toText(target?.clientDisplayName) || 'Unknown Client',
          reasons: risk.reasons,
        })
        setNotice('Risk signal detected. Please confirm before approving access.', 'error')
        return
      }
    }
    if (approved && !ensurePolicyAccepted()) {
      return
    }
    if (approved) {
      const isReady = await ensureScreenSharingStarted()
      if (!isReady) {
        setNotice('Approval failed because screen sharing is not started yet.', 'error')
        return
      }
    }

    socket.emit('respond-connection-request', { clientSocketId, approved }, (response) => {
      if (!response?.ok) {
        appendHostAuditEvent('request_respond_failed', {
          clientSocketId,
          approved,
          reason: toText(response?.message) || 'respond_failed',
          roomId: toText(response?.roomId),
        })
        setNotice(response?.message || 'Could not process connection request.', 'error')
        return
      }
      appendHostAuditEvent(approved ? 'request_approved' : 'request_rejected', {
        clientSocketId,
        approved,
        reason: approved ? 'host_approved' : 'host_rejected',
        roomId: toText(response?.roomId),
      })
      if (approved && response?.roomId) {
        console.log('[host][request] approved', response)
      }
    })
    setIncomingRequests((prev) => prev.filter((item) => item.clientSocketId !== clientSocketId))
    setRiskConfirmRequest(null)
    setNotice(approved ? 'Connection approved. Client can now join securely.' : 'Connection rejected.', approved ? 'success' : 'error')
  }

  const hostConnectionSteps = [
    { key: 'signaling', label: 'Signaling', done: isSignalingActive },
    { key: 'peer', label: 'Peer', done: isPeerConnected || incomingRequests.length === 0 },
    { key: 'stream', label: 'Stream', done: isSharing },
  ]
  const requiredHostSteps = hostConnectionSteps.filter((step) => step.key !== 'peer')
  const isHostDetailReady = requiredHostSteps.every((step) => step.done)
  const sessionPhaseLabel = getSessionPhaseMessage(sessionPhase, 'host')
  const effectiveHostNotice = toText(sessionNotice) || sessionPhaseLabel
  const quality = getConnectionQualityDescriptor(latencyMs, sessionPhase)
  const qualityClass = 'bg-slate-800 border-slate-600 text-white'

  useEffect(() => {
    const engine = sessionEngineRef.current
    if (!engine || !roomId || isHostDetailReady) {
      engine?.clearTimeoutTask('connect-timeout')
      return
    }
    engine.setTimeoutTask('connect-timeout', 25000, () => {
      exitSessionFlow('Connection timed out. Returning to home.')
    })
    return () => {
      engine.clearTimeoutTask('connect-timeout')
    }
  }, [roomId, isHostDetailReady])

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
      <div className={`relative z-10 w-full h-screen overflow-hidden grid grid-rows-[auto_minmax(0,1fr)] ${isDark ? 'bg-[#171a22]' : 'bg-white'}`}>
        <div className={`px-4 py-2 border-b flex items-center justify-between ${isDark ? 'border-slate-700 bg-[#1c2029]' : 'border-slate-200 bg-slate-50'}`}>
          <div>
            <h1 className={`text-lg font-semibold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Remote Session</h1>
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
            <span className="px-2 py-1 rounded-full border bg-slate-800 border-slate-600 text-white">
              {isSharing ? 'Online' : isPreparingShare ? 'Preparing' : 'Idle'}
            </span>
            <span className={`text-[11px] px-2 py-1 rounded-full border ${qualityClass}`}>
              {quality.label}
              {typeof latencyMs === 'number' && latencyMs > 0 ? ` - ${latencyMs} ms` : ''}
            </span>
          </div>
        </div>

        {typeof window !== 'undefined' && window.ipc?.invoke && hostSessionJoined ? (
          <div
            className={`mx-4 mt-1 rounded-md border px-3 py-1.5 text-[11px] leading-snug ${
              isDark ? 'border-cyan-800/60 bg-cyan-950/40 text-cyan-100/95' : 'border-cyan-200 bg-cyan-50 text-cyan-900'
            }`}
            role="status"
          >
            <span className="font-semibold">โหมดโฮสต์ (แอปเดสก์ท็อป):</span>{' '}
            หน้าต่างอาจถูก<strong>พับไปที่ไอคอน Remotix ริมจอ (tray)</strong> แอปยังทำงานอยู่ — ดูการแจ้งเตือนของระบบ
            หรือชี้ที่ไอคอนเพื่ออ่านคำอธิบาย / The window may fold to the <strong>tray</strong>; the app is still running — check the system notification or hover the tray icon.
          </div>
        ) : null}

        {dbUnavailableMessage ? (
          <div className={`mx-5 mt-3 rounded-lg border px-4 py-3 text-sm ${isDark ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-red-300 bg-red-50 text-red-700'}`}>
            {toText(dbUnavailableMessage)}
          </div>
        ) : null}

        <div className="min-h-0 overflow-hidden p-0">
          {isHostDetailReady ? (
            <div className="h-full grid lg:grid-cols-[minmax(0,1fr)_260px] xl:grid-cols-[minmax(0,1fr)_280px] gap-0">
            <section className={`overflow-hidden flex flex-col ${isDark ? 'bg-[#171b24]' : 'bg-white'}`}>
              <div className={`px-3 py-2 text-xs flex items-center justify-between ${isDark ? 'text-slate-300 bg-[#202531]' : 'text-slate-600 bg-slate-50'}`}>
                <span>Remote Desk Preview</span>
                <span className="font-mono">{toText(selectedSourceId) || 'auto-source'}</span>
              </div>
              <div className="flex-1 p-0">
                {isSharing ? (
                  <div className="h-full bg-black overflow-hidden">
                    <video
                      ref={videoRef}
                      autoPlay
                      muted
                      playsInline
                      className="w-full h-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="h-full min-h-[260px] md:min-h-[320px] flex items-center justify-center bg-black">
                    <div className={`h-16 w-16 rounded-full border-4 border-t-transparent animate-spin ${
                      isDark ? 'border-slate-500' : 'border-slate-300'
                    }`} />
                  </div>
                )}
              </div>
            </section>

            <aside className={`p-2 overflow-y-auto space-y-2 ${isDark ? 'bg-[#171b24]' : 'bg-slate-50'}`}>
              <div className={`rounded-lg border p-2.5 ${isDark ? 'border-slate-600 bg-[#202531]' : 'border-slate-300 bg-white'}`}>
                <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Session Controls</p>
                <div className="mt-2">
                  <label className={`text-[11px] ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                    Approval Policy
                  </label>
                  <select
                    value={approvalPolicy}
                    onChange={(event) => {
                      const next = toText(event.target.value).toLowerCase()
                      setApprovalPolicy(next || HOST_APPROVAL_POLICY.ALWAYS_ASK)
                      setNotice(
                        next === HOST_APPROVAL_POLICY.ALWAYS_ASK
                          ? 'Host policy: always ask before approving.'
                          : next === HOST_APPROVAL_POLICY.ASK_NEW_ONLY
                            ? 'Host policy: ask only for new devices.'
                            : 'Host policy: auto-approve trusted devices.',
                        'info',
                      )
                    }}
                    className={`mt-1 w-full rounded-md border px-2 py-1.5 text-xs ${isDark ? 'border-slate-600 bg-[#0f172a] text-slate-200' : 'border-slate-300 bg-white text-slate-700'}`}
                  >
                    <option value={HOST_APPROVAL_POLICY.ALWAYS_ASK}>Always ask</option>
                    <option value={HOST_APPROVAL_POLICY.ASK_NEW_ONLY}>Ask new devices only</option>
                    <option value={HOST_APPROVAL_POLICY.AUTO_APPROVE_TRUSTED}>Auto-approve trusted</option>
                  </select>
                </div>
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
                    onClick={() => setShowDiagnostics((current) => !current)}
                    className="col-span-2 bg-[#3a404d] hover:bg-[#4a5160] text-white px-3 py-2 rounded-md text-sm transition"
                  >
                    {showDiagnostics ? 'Hide Diagnostics' : 'Show Diagnostics'}
                  </button>
                  <button
                    onClick={() => {
                      if (!permissionGate.allGranted) {
                        setNotice('Control is blocked until required OS permissions are granted.', 'error')
                        return
                      }
                      const next = !allowControl
                      setAllowControl(next)
                      setNotice(next ? 'Remote control is enabled.' : 'Remote control is disabled.')
                    }}
                    disabled={permissionGate.checking || !permissionGate.allGranted}
                    className={`col-span-2 px-3 py-2 rounded-md text-sm text-white transition ${
                      allowControl ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-cyan-600 hover:bg-cyan-500'
                    }`}
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

              <div className={`rounded-lg border p-2.5 text-sm ${isDark ? 'border-slate-600 bg-[#202531] text-slate-200' : 'border-slate-300 bg-white text-slate-700'}`}>
                <p>Control permission: <span className="font-semibold">{allowControl ? 'Allowed' : 'Blocked'}</span></p>
                <p className={`mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Shortcut: press C to toggle control</p>
              </div>

              {showDiagnostics ? (
                <div className={`rounded-lg border p-2.5 text-xs ${isDark ? 'border-slate-600 bg-[#202531] text-slate-300' : 'border-slate-300 bg-white text-slate-700'}`}>
                  <p>Phase: {sessionPhase}</p>
                  <p>Signaling: {isSignalingActive ? 'connected' : 'waiting'}</p>
                  <p>Peer: {isPeerConnected ? 'connected' : 'waiting'}</p>
                  <p>Sharing: {isSharing ? 'active' : 'stopped'}</p>
                  <p>Source: {toText(selectedSourceId) || 'auto'}</p>
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
                  <div className="mt-3 space-y-1">
                    <p className="font-semibold">Recent Audit Events</p>
                    {hostAuditTrail.slice(0, 5).map((entry) => (
                      <p key={entry.id} className={`${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                        {entry.event} - {entry.clientDisplayName || entry.clientDeviceId || entry.clientSocketId || 'unknown'} - {formatRelativeTime(entry.at)}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}

              {incomingRequests.length > 0 ? (
                <div className={`rounded-lg border p-3 space-y-2 ${isDark ? 'border-slate-600 bg-[#202531]' : 'border-slate-300 bg-white'}`}>
                  <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Connection Requests ({incomingRequests.length})</p>
                  {incomingRequests.map((request) => (
                    (() => {
                      const clientDeviceId = toText(request.clientDeviceId).trim()
                      const pairing = knownPairings.find(
                        (item) => toText(item?.peerDeviceId).trim() === clientDeviceId,
                      )
                      const isTrusted = Boolean(pairing)
                      const status = requestDeviceInfo[clientDeviceId]
                      const lastConnectedText = formatRelativeTime(pairing?.lastConnectedAt)
                      const lastSeenText = formatRelativeTime(status?.lastSeenAt)
                      const risk = buildRequestRiskSummary(request)
                      return (
                    <div
                      key={request.clientSocketId}
                      className={`rounded-md border px-3 py-2 space-y-2 ${isDark ? 'border-slate-600 bg-[#262d3a]' : 'border-slate-300 bg-slate-50'}`}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm">{toText(request.clientDisplayName) || toText(status?.displayName) || 'Unknown Client'}</p>
                          <span className="text-[10px] px-2 py-0.5 rounded-full border bg-slate-800 border-slate-600 text-white">
                            {isTrusted ? 'Trusted Device' : 'New Device'}
                          </span>
                        </div>
                        <p className={`text-xs font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                          {toText(request.clientDeviceId) || toText(request.clientSocketId)}
                        </p>
                        <div className={`mt-1 text-[11px] ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                          <p>Last room: {toText(pairing?.lastRoomId) || 'none'}</p>
                          <p>Last connected: {lastConnectedText || 'first time'}</p>
                          <p>Last seen: {lastSeenText || 'unknown'}</p>
                          {risk.level === 'warning' ? (
                            <p className={`${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                              Risk: {risk.reasons.join(' ')}
                            </p>
                          ) : null}
                        </div>
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
                      )
                    })()
                  ))}
                </div>
              ) : null}
            </aside>
            </div>
          ) : (
            <div className={`h-full backdrop-blur-sm flex flex-col items-center justify-center text-center px-6 ${isDark ? 'bg-[#171b24]/90' : 'bg-white/95'}`}>
              <div className="relative">
                <div className={`h-16 w-16 rounded-full border-4 animate-spin ${isDark ? 'border-slate-600 border-t-red-400' : 'border-slate-300 border-t-red-500'}`} />
                <div className={`absolute inset-0 m-auto h-7 w-7 rounded-full animate-pulse ${isDark ? 'bg-red-500/30' : 'bg-red-400/40'}`} />
              </div>
              <p className={`mt-5 text-xl font-semibold tracking-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Connecting to remote device...</p>
              <p className={`mt-2 text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{sessionPhaseLabel}</p>
            </div>
          )}
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
      {riskConfirmRequest ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className={`w-full max-w-md rounded-xl border p-4 ${isDark ? 'border-amber-500/40 bg-[#101a2f] text-slate-100' : 'border-amber-300 bg-white text-slate-800'}`}>
            <h3 className="text-base font-semibold">Security Check Required</h3>
            <p className={`mt-1 text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
              {riskConfirmRequest.clientDisplayName} triggered risk signals:
            </p>
            <ul className={`mt-2 text-xs space-y-1 ${isDark ? 'text-amber-200' : 'text-amber-700'}`}>
              {riskConfirmRequest.reasons.map((reason, index) => (
                <li key={`${riskConfirmRequest.clientSocketId}-${index}`}>- {reason}</li>
              ))}
            </ul>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setRiskConfirmRequest(null)}
                className="flex-1 px-3 py-2 rounded-md bg-[#495063] hover:bg-[#596176] text-white text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleConnectionRequest(riskConfirmRequest.clientSocketId, true)}
                className="flex-1 px-3 py-2 rounded-md bg-red-600 hover:bg-red-500 text-white text-sm"
              >
                Approve Anyway
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <canvas ref={blackFrameCanvasRef} className="hidden" />
      {isPolicyConsentPromptOpen ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
          <div className={`w-full max-w-md rounded-xl border p-5 shadow-2xl ${isDark ? 'border-slate-600 bg-[#101a2f]' : 'border-slate-300 bg-white'}`}>
            <p className={`text-xs uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Policy Required</p>
            <h3 className={`mt-2 text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
              Accept policy before approving access
            </h3>
            <p className={`mt-3 text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Host must accept the Remote Access Policy once before allowing client connections.
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
          </div>
        </div>
      ) : null}
    </div>
  )
}
