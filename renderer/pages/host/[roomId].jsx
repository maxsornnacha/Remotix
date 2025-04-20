import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import Peer from 'simple-peer'
import { getSocket } from '../../libs/socket';

const socket = getSocket();

export default function HostPage() {
  const router = useRouter()
  const { roomId } = router.query

  const [allowControl, setAllowControl] = useState(false)
  const videoRef = useRef(null)
  const localStreamRef = useRef(null)
  const peerRef = useRef(null)

  // Step 1: Join room & signaling
  useEffect(() => {
    if (!roomId) return

    socket.emit('join-room', roomId)

    socket.on('peer-joined', (peerId) => {
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

    // Step 2: Listen for remote control events
    socket.on('mouse-move', ({ x, y }) => {
      if (allowControl) window.ipc.sendInput('mouse-move', { x, y })
    })

    socket.on('mouse-click', ({ button }) => {
      if (allowControl) window.ipc.sendInput('mouse-click', { button })
    })

    socket.on('key-down', ({ key }) => {
      if (allowControl) window.ipc.sendInput('key-down', { key })
    })

    return () => {
      socket.off('peer-joined');
      socket.off('signal');
      socket.off('mouse-move');
      socket.off('mouse-click');
      socket.off('key-down');
    }
  }, [roomId, allowControl])

  // Step 3: Start screen sharing
  useEffect(() => {
    const startSharing = async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        })

        localStreamRef.current = stream

        if (videoRef.current) {
          videoRef.current.srcObject = stream
          videoRef.current.play()
        }
      } catch (error) {
        console.error('Screen share error:', error)
      }
    }

    startSharing()
  }, [])

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

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white flex flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-4xl bg-[#1a1a1a] border border-gray-800 rounded-2xl shadow-xl p-6 space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-blue-500 mb-2">Hosting Room</h1>
          <p className="text-sm text-gray-400 font-mono">Room ID: {roomId}</p>
        </div>

        <div className="flex items-center justify-between bg-[#111] p-4 rounded-lg border border-gray-700">
          <label className="inline-flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={allowControl}
              onChange={() => setAllowControl(!allowControl)}
              className="form-checkbox h-5 w-5 text-blue-600"
            />
            Allow remote control
          </label>

          <button
            onClick={handleDisconnect}
            className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-md transition"
          >
            🔌 Disconnect & Return
          </button>
        </div>

        <div className="bg-black border border-gray-700 rounded-lg overflow-hidden">
          <video
            ref={videoRef}
            autoPlay
            muted
            className="w-full max-h-[70vh] object-contain"
          />
        </div>

        <p className="text-center text-sm text-gray-500">
          You are sharing your screen with connected clients.
        </p>
      </div>
    </div>
  )
}
