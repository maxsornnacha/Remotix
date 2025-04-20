import { useEffect, useRef } from 'react'
import { useRouter } from 'next/router'
import Peer from 'simple-peer'
import { getSocket } from '../../libs/socket';

const socket = getSocket();

export default function ClientPage() {
  const router = useRouter()
  const { roomId } = router.query

  const videoRef = useRef(null)

  const requestPointerLock = () => {
    if (videoRef.current) {
      videoRef.current.requestPointerLock();
    }
  };

  useEffect(() => {
    const handlePointerLockChange = () => {
      const isLocked = document.pointerLockElement === videoRef.current;
      console.log('📌 Pointer Lock Active:', isLocked);
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

  useEffect(() => {
    if (!roomId) return;
  
    const handleJoin = () => {
      console.log('🟢 Client socket connected. Joining room:', roomId);
      socket.emit('join-room', roomId);
    };
  
    if (socket.connected) {
      handleJoin();
    } else {
      socket.once('connect', handleJoin);
    }
  
    socket.on('peer-joined', () => {
      console.log('✅ Peer joined');
      // client doesn't do anything yet here
    });
  
    socket.on('signal', ({ from, data }) => {
      if (!peerRef.current) {
        const peer = new Peer({
          initiator: false,
          trickle: false,
        });
  
        peer.on('signal', (signalData) => {
          socket.emit('signal', { to: from, from: socket.id, data: signalData });
        });
  
        peer.on('stream', (stream) => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play();
          }
        });
  
        peer.signal(data);
        peerRef.current = peer;
      } else {
        peerRef.current.signal(data);
      }
    });
  
    return () => {
      socket.off('connect', handleJoin);
      socket.off('peer-joined');
      socket.off('signal');
    };
    }, [roomId]);
  

  // Send remote input events
  useEffect(() => {
    const handleMouseMove = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      socket.emit('mouse-move', {
        x: e.movementX,
        y: e.movementY,
        roomId,
      });
    };    

    const handleClick = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      socket.emit('mouse-click', { button: e.button, roomId })
    }

    const handleKeyUp = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      socket.emit('key-up', { code: e.code, roomId });
    };

    const handleKeyDown = (e) => {
      if (document.pointerLockElement !== videoRef.current) return;
      socket.emit('key-down', { code: e.code, roomId })
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
  }, [])

  const handleDisconnect = () => {
    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }

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
            onClick={requestPointerLock}
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
