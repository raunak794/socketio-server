const express = require('express');
const http = require('http');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS configuration - update with your exact frontend URL
const allowedOrigin = 'https://demo.digeesell.ae';
app.use(cors({
  origin: allowedOrigin,
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Create HTTP server
const server = http.createServer(app);

// Enhanced Socket.IO configuration
const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'], // Explicitly specify transports
  allowEIO3: true, // For Socket.IO v2 compatibility if needed
  pingTimeout: 60000,
  pingInterval: 25000
});

// Database connection
const pool = mysql.createPool({
  host: 'mysql.digeesell.ae',
  user: 'digeesellse_whatsapp_bot',
  password: 'mTN{bdlv9$7R',
  database: 'digeesellse_whatsapp_bot',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Active agents store
const activeAgents = new Map();

// Middleware to handle preflight requests
app.options('*', cors());

// Basic route
app.get('/', (req, res) => {
  res.send('WhatsApp WebSocket server is running...');
});

// Notification webhook
app.post('/notify', async (req, res) => {
  try {
    const { type, ...data } = req.body;
    io.emit(type, data);
    res.status(200).json({ status: 'success', message: 'Notification sent' });
  } catch (error) {
    console.error('Notification error:', error);
    res.status(500).json({ status: 'error', message: 'Notification failed' });
  }
});

// API endpoints...

// Handle socket connection
io.on('connection', (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);

  // Add heartbeat check
  socket.on('ping', (cb) => {
    if (typeof cb === 'function') {
      cb();
    }
  });

  // Authenticate agent with enhanced validation
  socket.on('authenticate', async (data, callback) => {
    try {
      if (typeof callback !== 'function') {
        throw new Error('No callback provided');
      }

      const { agentId, name } = data;
      if (!agentId || !name) {
        throw new Error('Missing required fields');
      }

      await pool.execute(
        `INSERT INTO agents (id, name, status, socket_id, last_active)
         VALUES (?, ?, 'online', ?, NOW())
         ON DUPLICATE KEY UPDATE 
         name = VALUES(name), status = 'online', socket_id = VALUES(socket_id), last_active = NOW()`,
        [agentId, name, socket.id]
      );

      activeAgents.set(socket.id, { agentId, name });
      await updateAgentList();
      
      callback({ status: 'success', agentId });
      console.log(`🔑 Authenticated: ${agentId} (${name})`);
    } catch (error) {
      console.error('Authentication error:', error.message);
      if (typeof callback === 'function') {
        callback({ status: 'error', message: error.message || 'Authentication failed' });
      }
      socket.disconnect(true);
    }
  });

  // Disconnect handler with cleanup
  socket.on('disconnect', async (reason) => {
    console.log(`❌ Client disconnected: ${socket.id} (Reason: ${reason})`);
    const agent = activeAgents.get(socket.id);
    if (agent) {
      try {
        await pool.execute(
          `UPDATE agents SET status = 'offline', socket_id = NULL, last_active = NOW()
           WHERE id = ?`,
          [agent.agentId]
        );
        activeAgents.delete(socket.id);
        await updateAgentList();
      } catch (error) {
        console.error('Disconnection update error:', error);
      }
    }
  });

  // Error handler
  socket.on('error', (error) => {
    console.error(`Socket error (${socket.id}):`, error);
  });
});

// Helper: update agent list
async function updateAgentList() {
  try {
    const [agents] = await pool.execute(
      `SELECT * FROM agents WHERE status = 'online' ORDER BY name`
    );
    io.emit('agent_list', agents);
    io.emit('agent_count', agents.length);
    console.log(`🔄 Updated agent list: ${agents.length} agents online`);
  } catch (error) {
    console.error('Error updating agent list:', error);
  }
}

// Start server with enhanced error handling
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
}).on('error', (error) => {
  console.error('Server error:', error);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
