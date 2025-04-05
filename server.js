const express = require('express');
const http = require('http');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS Configuration - Update with your exact frontend URL
const allowedOrigin = 'https://demo.digeesell.ae';
app.use(cors({
  origin: allowedOrigin,
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

const server = http.createServer(app);

// Enhanced Socket.IO Configuration
const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true
  },
  allowEIO3: true // For broader client compatibility
});

// Database Connection
const pool = mysql.createPool({
  host: 'localhost',
  user: 'digeesellse_whatsapp_bot',
  password: 'mTN{bdlv9$7R',
  database: 'digeesellse_whatsapp_bot',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Active Agents Store
const activeAgents = new Map();

// Middleware to Verify Callback Function
const verifyCallback = (socket, callback) => {
  if (typeof callback !== 'function') {
    console.error(`No callback provided from socket ${socket.id}`);
    socket.emit('authentication_error', { 
      message: 'Server requires a callback function' 
    });
    socket.disconnect(true);
    return false;
  }
  return true;
};

// Connection Handler
io.on('connection', (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);
  
  // Set timeout for authentication
  const authTimeout = setTimeout(() => {
    if (!activeAgents.has(socket.id)) {
      console.log(`⌛ Authentication timeout for ${socket.id}`);
      socket.emit('authentication_timeout');
      socket.disconnect(true);
    }
  }, 10000); // 10 seconds to authenticate

  // Authentication Handler
  socket.on('authenticate', async (data, callback) => {
    if (!verifyCallback(socket, callback)) return;

    try {
      const { agentId, name } = data;
      
      if (!agentId || !name) {
        throw new Error('Agent ID and name are required');
      }

      // Insert/update agent in database
      await pool.execute(
        `INSERT INTO agents (id, name, status, socket_id, last_active)
         VALUES (?, ?, 'online', ?, NOW())
         ON DUPLICATE KEY UPDATE 
         name = VALUES(name), 
         status = 'online', 
         socket_id = VALUES(socket_id), 
         last_active = NOW()`,
        [agentId, name, socket.id]
      );

      // Store active agent
      activeAgents.set(socket.id, { agentId, name });
      clearTimeout(authTimeout);
      
      // Notify all clients
      await updateAgentList();
      
      // Send success response
      callback({ 
        status: 'success', 
        agentId,
        message: 'Authentication successful'
      });
      
      console.log(`🔑 Authenticated: ${agentId} (${name})`);

    } catch (error) {
      console.error(`Authentication error (${socket.id}):`, error.message);
      callback({ 
        status: 'error',
        message: error.message || 'Authentication failed'
      });
      socket.disconnect(true);
    }
  });

  // Disconnection Handler
  socket.on('disconnect', async (reason) => {
    console.log(`❌ Client disconnected: ${socket.id} (Reason: ${reason})`);
    clearTimeout(authTimeout);
    
    const agent = activeAgents.get(socket.id);
    if (agent) {
      try {
        await pool.execute(
          `UPDATE agents SET status = 'offline', 
           socket_id = NULL, 
           last_active = NOW() 
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

  // Error Handler
  socket.on('error', (error) => {
    console.error(`Socket error (${socket.id}):`, error);
  });
});

// Update Agent List Function
async function updateAgentList() {
  try {
    const [agents] = await pool.execute(
      `SELECT id, name, status FROM agents 
       WHERE status = 'online' 
       ORDER BY last_active DESC`
    );
    
    io.emit('agent_list_update', { 
      status: 'success',
      agents,
      count: agents.length
    });
    
    console.log(`🔄 Updated agent list: ${agents.length} active agents`);
  } catch (error) {
    console.error('Agent list update error:', error);
  }
}

// Start Server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
}).on('error', (error) => {
  console.error('Server startup error:', error);
});

// Global Error Handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
