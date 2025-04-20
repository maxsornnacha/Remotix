import { useRouter } from 'next/router'
import { useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { getSocket } from '../libs/socket';

const socket = getSocket();

export default function HomePage() {
  const [roomId, setRoomId] = useState('')
  const router = useRouter()

  const createRoom = () => {
    const newRoomId = uuidv4().replace(/-/g, '')
    router.push(`/host/${newRoomId}`)
  }

  const joinRoom = () => {
    const id = roomId.trim()
    if (!id) return

    socket.emit('check-room', id, (exists) => {
      if (exists) {
        router.push(`/client/${id}`)
      } else {
        alert('❌ Room does not exist.')
      }
    })
  }

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-md bg-[#1a1a1a] rounded-xl shadow-lg p-8 space-y-6 border border-gray-800">
        <h1 className="text-4xl font-bold text-center text-blue-500">Remotix</h1>
        <p className="text-center text-sm text-gray-400">
          Peer-to-peer remote desktop access with screen sharing and control.
        </p>

        <button
          onClick={createRoom}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg transition-all"
        >
          🎬 Host a New Session
        </button>

        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="Enter Room ID"
            className="w-full px-4 py-2 rounded-md bg-[#2a2a2a] text-white border border-gray-600 focus:ring-2 focus:ring-blue-500 focus:outline-none"
          />
          <button
            onClick={joinRoom}
            className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2 rounded-lg transition-all"
          >
            🔗 Join Session
          </button>
        </div>

        <div className="text-center text-xs text-gray-500 pt-2">
          Powered by <span className="font-semibold text-blue-400">Sornnacha Buranapongwattana</span>
        </div>
      </div>
    </div>
  )
}
