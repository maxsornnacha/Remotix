// lib/socket.js
import { io } from "socket.io-client";

let socket;

export const getSocket = () => {
  if (!socket || socket.disconnected) {
    const socketUrl = process.env.NEXT_PUBLIC_API_URL;

    socket = io(socketUrl, {
      transports: ["websocket"],
      autoConnect: true,
      reconnection: true,
    });
  }

  return socket;
};
