// lib/socket.js
import { io } from 'socket.io-client';

let socket;

export const getSocket = () => {
    if (!socket || socket.disconnected) {
      socket = io(process.env.NEXT_PUBLIC_SOCKET_URL, {
        transports: ['websocket'], // optional: force WebSocket
        autoConnect: true,
        reconnection: true,
      });
    }
  
    return socket;
  };
