const express = require('express');
const http = require('http');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');

// Initialize Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS configuration
const allowedOrigin = 'https://demo.digeesell.ae'; // Your frontend
app.use(cors({
  origin: allowedOrigin,
  methods: ['GET', 'POST'],
  credentials: true
}));

// Create HTTP server
const server = http.createServer(app);

// Socket.IO server
const io = new Server(server, {
  cors: {
    origin: allowedOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  }
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

// Basic route
app.get('/', (req, res) => {
  res.send('WebSocket server is running...');
});

// Notification webhook
app.post('/notify', async (req, res) => {
  try {
    const { type, ...data } = req.body;
    io.emit(type, data);
    res.status(200).send('Notification sent');
  } catch (error) {
    console.error('Notification error:', error);
    res.status(500).send('Notification failed');
  }
});

// Get active chats
app.get('/chats', async (req, res) => {
  try {
    const [chats] = await pool.execute(`
      SELECT c.*, u.phone, u.profile_name FROM chats c
      JOIN users u ON c.user_id = u.id
      WHERE c.status != 'closed'
      ORDER BY c.updated_at DESC
    `);
    res.json({ status: 'success', chats });
  } catch (error) {
    console.error('Fetch chats error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch chats' });
  }
});

// Get messages for a chat
app.get('/messages', async (req, res) => {
  try {
    const { chat_id } = req.query;
    const [messages] = await pool.execute(`
      SELECT m.*, a.name AS agent_name FROM messages m
      LEFT JOIN agents a ON m.agent_id = a.id
      WHERE m.chat_id = ?
      ORDER BY m.created_at ASC
    `, [chat_id]);
    res.json({ status: 'success', messages });
  } catch (error) {
    console.error('Fetch messages error:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch messages' });
  }
});

// Handle socket connection
io.on('connection', (socket) => {
  console.log(`✅ Client connected: ${socket.id}`);

  // Authenticate agent
  socket.on('authenticate', async (data, callback) => {
    if (typeof callback !== 'function') return socket.disconnect(true);
    try {
      const { agentId, name } = data;
      await pool.execute(`
        INSERT INTO agents (id, name, status, socket_id, last_active)
        VALUES (?, ?, 'online', ?, NOW())
        ON DUPLICATE KEY UPDATE 
        name = VALUES(name), status = 'online', socket_id = VALUES(socket_id), last_active = NOW()
      `, [agentId, name, socket.id]);
      activeAgents.set(socket.id, { agentId, name });
      await updateAgentList();
      callback({ status: 'success', agentId });
    } catch (error) {
      console.error('Authentication error:', error);
      callback({ status: 'error', message: 'Authentication failed' });
      socket.disconnect(true);
    }
  });

  // Take over chat
  socket.on('take_over_chat', async (data, callback = () => {}) => {
    try {
      const { chat_id, agent_id } = data;
      await pool.execute(`
        UPDATE chats SET is_ai_active = FALSE, agent_id = ?, status = 'assigned', updated_at = NOW()
        WHERE id = ?
      `, [agent_id, chat_id]);

      const [chats] = await pool.execute(`
        SELECT c.*, u.phone, u.profile_name FROM chats c
        JOIN users u ON c.user_id = u.id
        WHERE c.id = ?
      `, [chat_id]);

      if (chats.length === 0) return callback({ status: 'error', message: 'Chat not found' });

      const chat = chats[0];
      io.emit('chat_taken_over', {
        chat_id,
        phone: chat.phone,
        profile_name: chat.profile_name,
        agent_id,
        agent_name: activeAgents.get(socket.id)?.name
      });

      callback({ status: 'success' });
    } catch (error) {
      console.error('Takeover error:', error);
      callback({ status: 'error', message: 'Takeover failed' });
    }
  });

  // Send agent message
  socket.on('send_agent_message', async (data, callback = () => {}) => {
    try {
      const { chat_id, agent_id, message } = data;
      await pool.execute(`
        INSERT INTO messages (chat_id, sender_type, agent_id, content, direction)
        VALUES (?, 'agent', ?, ?, 'outgoing')
      `, [chat_id, agent_id, message]);

      const [chats] = await pool.execute(`
        SELECT u.phone FROM chats c
        JOIN users u ON c.user_id = u.id
        WHERE c.id = ?
      `, [chat_id]);

      if (chats.length === 0) return callback({ status: 'error', message: 'Chat not found' });

      io.emit('agent_message_sent', {
        chat_id,
        agent_id,
        message,
        phone: chats[0].phone
      });

      callback({ status: 'success' });
    } catch (error) {
      console.error('Message send error:', error);
      callback({ status: 'error', message: 'Failed to send message' });
    }
  });

  // Disconnect handler
  socket.on('disconnect', async () => {
    const agent = activeAgents.get(socket.id);
    if (agent) {
      activeAgents.delete(socket.id);
      try {
        await pool.execute(`
          UPDATE agents SET status = 'offline', socket_id = NULL, last_active = NOW()
          WHERE id = ?
        `, [agent.agentId]);
        await updateAgentList();
      } catch (error) {
        console.error('Disconnection update error:', error);
      }
    }
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// Helper: update agent list
async function updateAgentList() {
  try {
    const [agents] = await pool.execute(`
      SELECT * FROM agents WHERE status = 'online' ORDER BY name
    `);
    io.emit('agent_list', agents);
    io.emit('agent_count', agents.length);
  } catch (error) {
    console.error('Error updating agent list:', error);
  }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
