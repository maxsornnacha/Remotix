import { useEffect, useRef } from 'react'
import { useRouter } from 'next/router'
import Peer from 'simple-peer'
import { io } from 'socket.io-client'

const socket = io(process.env.NEXT_PUBLIC_SOCKET_URL);

export default function ClientPage() {
  const router = useRouter()
  const { roomId } = router.query

  const videoRef = useRef(null)
  const peerRef = useRef(null)

  useEffect(() => {
    if (!roomId) return

    socket.emit('join-room', roomId)

    socket.on('peer-joined', () => {
      // Waiting for host signal
    })

    socket.on('signal', ({ from, data }) => {
      if (!peerRef.current) {
        const peer = new Peer({
          initiator: false,
          trickle: false,
        })

        peer.on('signal', (signalData) => {
          socket.emit('signal', { to: from, from: socket.id, data: signalData })
        })

        peer.on('stream', (stream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream
            videoRef.current.play()
          }
        })

        peer.signal(data)
        peerRef.current = peer
      } else {
        peerRef.current.signal(data)
      }
    })

    return () => {
      socket.disconnect()
    }
  }, [roomId])

  // Send remote input events
  useEffect(() => {
    const handleMouseMove = (e) => {
      socket.emit('mouse-move', { x: e.clientX, y: e.clientY, roomId })
    }

    const handleClick = (e) => {
      socket.emit('mouse-click', { button: e.button, roomId })
    }

    const handleKeyDown = (e) => {
      socket.emit('key-down', { key: e.key, roomId })
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const handleDisconnect = () => {
    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }

    socket.disconnect()

    if (videoRef.current?.srcObject) {
      const tracks = videoRef.current.srcObject.getTracks()
      tracks.forEach((track) => track.stop())
      videoRef.current.srcObject = null
    }

    router.push('/home')
  }

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white flex flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-4xl bg-[#1a1a1a] border border-gray-800 rounded-2xl shadow-xl p-6 space-y-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-blue-500 mb-1">Client View</h1>
          <p className="text-sm text-gray-400 font-mono">Room ID: {roomId}</p>
        </div>

        <div className="bg-black border border-gray-700 rounded-lg overflow-hidden">
          <video
            ref={videoRef}
            autoPlay
            className="w-full max-h-[70vh] object-contain"
          />
        </div>

        <p className="text-center text-sm text-gray-400">
          You are viewing and remotely controlling the host's screen.
        </p>

        <button
          onClick={handleDisconnect}
          className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-2 rounded-md transition"
        >
          🔌 Disconnect & Return to Home
        </button>
      </div>
    </div>
  )
}
