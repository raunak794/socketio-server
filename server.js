const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: [
    "https://demo.digeesell.ae",
    "https://whatsapp-socketio-8h4m.onrender.com"
  ],
  credentials: true
}));

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Enhanced Socket.IO configuration
const io = socketIo(server, {
  cors: {
    origin: [
      "https://demo.digeesell.ae",
      "https://whatsapp-socketio-8h4m.onrender.com"
    ],
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Store active agents and chats
const agents = new Set();
const activeChats = {};

  io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Authentication handler with callback check
  socket.on('authenticate', ({ role }, callback) => {
    console.log(`Authentication attempt as ${role}`);
    
    try {
      if (role === 'agent') {
        agents.add(socket.id);
        io.emit('agent_count', agents.size);
        console.log(`Agent ${socket.id} authenticated`);
        
        // Only call callback if provided
        if (typeof callback === 'function') {
          callback({ 
            status: 'success', 
            message: 'Authenticated as agent',
            agentId: socket.id
          });
        }
        
        // Alternative: emit an event back
        socket.emit('authentication_result', {
          status: 'success',
          agentId: socket.id
        });
      } else {
        if (typeof callback === 'function') {
          callback({ status: 'error', message: 'Invalid role' });
        }
      }
    } catch (error) {
      console.error('Authentication error:', error);
      if (typeof callback === 'function') {
        callback({ status: 'error', message: 'Internal server error' });
      }
    }
  });

  // ... rest of your server code
});

  // Message handling
  socket.on('send_message', (data) => {
    console.log('Received message:', data);
    if (!data.phone || !data.message) {
      return console.error('Invalid message format');
    }
    
    // Store message
    activeChats[data.phone] = activeChats[data.phone] || [];
    activeChats[data.phone].push({
      message: data.message,
      sender: 'agent',
      timestamp: new Date()
    });
    
    // Broadcast to all clients
    io.emit('new_message', {
      phone: data.phone,
      message: data.message,
      message_id: data.message_id || Date.now().toString(),
      direction: 'outgoing',
      timestamp: new Date().toISOString()
    });
  });

  // Ping test endpoint
  socket.on('ping', (callback) => {
    callback({
      status: 'success',
      serverTime: new Date().toISOString(),
      transport: socket.conn.transport.name,
      agentsOnline: agents.size
    });
  });

  // Disconnection handler
  socket.on('disconnect', () => {
    if (agents.has(socket.id)) {
      agents.delete(socket.id);
      io.emit('agent_count', agents.size);
    }
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// HTTP endpoint for PHP webhook
app.get('/notify', (req, res) => {
  const { type, phone, message, message_id } = req.query;
  console.log('Webhook notification:', { type, phone, message });
  
  if (!type || !phone || !message) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  
  io.emit(type, {
    phone,
    message,
    message_id: message_id || Date.now().toString(),
    timestamp: new Date().toISOString()
  });
  
  res.json({ success: true });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    connections: io.engine.clientsCount,
    agents: agents.size,
    uptime: process.uptime()
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
