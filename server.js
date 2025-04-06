const express = require('express');
const http = require('http');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configuration - Match these with your actual credentials
const PORT = process.env.PORT || 10000;
const DB_CONFIG = {
  host: 'localhost',
  user: 'digeesellse_whatsapp_bot',
  password: 'mTN{bdlv9$7R',
  database: 'digeesellse_whatsapp_bot',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10
};

// Middleware
app.use(cors({
  origin: 'https://demo.digeesell.ae',
  methods: ['GET', 'POST']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database pool
const pool = mysql.createPool(DB_CONFIG);

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: 'https://demo.digeesell.ae',
    methods: ['GET', 'POST']
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 120000
  }
});

// Store active connections
const activeConnections = new Map();

// API Endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

app.post('/notify', async (req, res) => {
  try {
    const { type, ...data } = req.body;
    io.emit(type, data);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/human_available', async (req, res) => {
  try {
    const [result] = await pool.query(
      'SELECT COUNT(*) as count FROM agents WHERE status = "online"'
    );
    res.json({ available: result[0].count > 0 });
  } catch (error) {
    res.status(500).json({ available: false });
  }
});

// Socket.io Events
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on('authenticate', async ({ agentId, name }, callback) => {
    try {
      if (!agentId || !name) throw new Error('Missing credentials');
      
      await pool.query(
        `INSERT INTO agents (id, name, status, socket_id, last_active)
         VALUES (?, ?, 'online', ?, NOW())
         ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         status = 'online',
         socket_id = VALUES(socket_id),
         last_active = NOW()`,
        [agentId, name, socket.id]
      );

      activeConnections.set(socket.id, { agentId, name });
      callback({ status: 'success' });
      
      const [agents] = await pool.query('SELECT * FROM agents WHERE status = "online"');
      io.emit('agent_count', agents.length);
      
    } catch (error) {
      callback({ status: 'error', message: error.message });
      socket.disconnect();
    }
  });

  socket.on('disconnect', async () => {
    const connection = activeConnections.get(socket.id);
    if (connection) {
      await pool.query(
        'UPDATE agents SET status = "offline" WHERE id = ?',
        [connection.agentId]
      );
      activeConnections.delete(socket.id);
      
      const [agents] = await pool.query('SELECT * FROM agents WHERE status = "online"');
      io.emit('agent_count', agents.length);
    }
  });

  // Custom events for chat handling
  socket.on('take_over_chat', async ({ chat_id, agent_id }, callback) => {
    try {
      await pool.query(
        'UPDATE chats SET is_ai_active = 0, agent_id = ? WHERE id = ?',
        [agent_id, chat_id]
      );
      io.emit('chat_taken_over', { chat_id, agent_id });
      callback({ status: 'success' });
    } catch (error) {
      callback({ status: 'error', message: error.message });
    }
  });

  socket.on('send_message', async ({ chat_id, agent_id, message }, callback) => {
    try {
      await pool.query(
        'INSERT INTO messages (chat_id, sender_type, agent_id, content, direction) VALUES (?, "agent", ?, ?, "outgoing")',
        [chat_id, agent_id, message]
      );
      io.emit('new_agent_message', { chat_id, message, agent_id });
      callback({ status: 'success' });
    } catch (error) {
      callback({ status: 'error', message: error.message });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
