require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const activeRooms = new Set();

app.use(cors());
app.use(express.json());

app.get('/status', (req, res) => {
  res.json({ status: 'OK', rooms: activeRooms.size });
});

app.post('/sessions', (req, res) => {
  const { hostId } = req.body;
  activeRooms.add(hostId);
  res.json({ message: 'Session started', hostId });
});

// ✅ Room existence check
io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  socket.on('check-room', (roomId, callback) => {
    console.log("all the existing rooms :", activeRooms);
    console.log("join room :", roomId)
    const exists = activeRooms.has(roomId);
    callback(exists);
  });

  socket.on('join-room', (roomId) => {
    console.log('join-room :', roomId);
    socket.join(roomId);
    activeRooms.add(roomId);
    socket.to(roomId).emit('peer-joined', socket.id);
  });

  socket.on('signal', ({ to, from, data }) => {
    io.to(to).emit('signal', { from, data });
  });

  socket.on('mouse-move', (data) => {
    socket.to(data.roomId).emit('mouse-move', data);
  });

  socket.on('mouse-click', (data) => {
    socket.to(data.roomId).emit('mouse-click', data);
  });

  socket.on('key-down', (data) => {
    socket.to(data.roomId).emit('key-down', data);
  });

  socket.on('key-up', (data) => {
    socket.to(data.roomId).emit('key-up', data);
  });

  socket.on('disconnect', () => {
    console.log('❌ Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3010;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
