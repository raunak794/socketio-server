const express = require('express');
const http = require('http');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Configuration
const PORT = process.env.PORT || 10000;
const DB_CONFIG = {
  host: 'digeesell.ae',
  user: 'digeesellse_whatsapp_bot',
  password: 'mTN{bdlv9$7R',
  database: 'digeesellse_whatsapp_bot',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 10000, // 10 seconds timeout
  namedPlaceholders: true,
  timezone: '+00:00'
};

// Middleware
app.use(cors({
  origin: 'https://whatsapp.digeesell.ae',
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database pool
const pool = mysql.createPool(DB_CONFIG);

// Test database connection immediately
pool.getConnection()
  .then(conn => {
    console.log('✅ Database connected successfully');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  });

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: 'https://whatsapp.digeesell.ae',
    methods: ['GET', 'POST']
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 120000
  }
});

// Store active connections
const activeConnections = new Map();
// Replace with this proper server-side implementation:
const syncInterval = setInterval(() => {
  io.emit('chat_refresh_request');
}, 30000); // Every 30 seconds

// Clean up on server shutdown
process.on('SIGTERM', () => {
  clearInterval(syncInterval);
});

// ==================== API ENDPOINTS ====================
// Add this near your server startup
console.log('Server timezone:', Intl.DateTimeFormat().resolvedOptions().timeZone);
console.log('Current server time:', new Date());
console.log('Current UTC time:', new Date().toISOString());
// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date(),
    dbStatus: pool.pool.config.connectionConfig.host ? 'configured' : 'missing'
  });
});

// Database test endpoint
app.get('/test-db', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query(`
      SELECT 
        CONNECTION_ID() AS connection_id,
        DATABASE() AS current_database,
        USER() AS current_user,
        1+1 AS test_result,
        NOW() AS server_time
    `);
    connection.release();
    
    res.json({
      status: 'success',
      database: rows[0],
      connectionInfo: {
        host: DB_CONFIG.host,
        port: DB_CONFIG.port
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Database connection failed',
      error: {
        code: error.code,
        errno: error.errno,
        sqlState: error.sqlState,
        message: error.message
      },
      config: DB_CONFIG
    });
  }
});

// Notification endpoint
app.post('/notify', async (req, res) => {
  try {
    const { type, ...data } = req.body;
    io.emit(type, data);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Agent availability check
app.get('/human_available', async (req, res) => {
  try {
    const [result] = await pool.query(
      'SELECT COUNT(*) as count FROM agents WHERE status = "online"'
    );
    res.json({ available: result[0].count > 0 });
  } catch (error) {
    res.status(500).json({ available: false, error: error.message });
  }
});
// In server.js, add this to the socket.io handlers:
socket.on('set_chat_mode', async ({ chat_id, is_ai_active, agent_id }, callback) => {
  try {
      await pool.query(
          'UPDATE chats SET is_ai_active = ?, agent_id = ? WHERE id = ?',
          [is_ai_active, is_ai_active ? null : agent_id, chat_id]
      );
      
      io.emit('chat_mode_changed', { 
          chat_id, 
          is_ai_active: Boolean(is_ai_active),
          agent_id: is_ai_active ? null : agent_id
      });
      
      callback({ status: 'success' });
  } catch (error) {
      console.error('Error changing chat mode:', error);
      callback({ status: 'error', message: error.message });
  }
});
// Add this to setupSocketEvents():
this.socket.on('chat_mode_changed', (data) => {
  const chatKey = `chat_${data.chat_id}`;
  if (this.chats[chatKey]) {
      this.chats[chatKey].is_ai_active = data.is_ai_active;
      this.chats[chatKey].agent_id = data.agent_id;
      
      if (this.currentChat === chatKey) {
          this.updateModeUI();
      }
      
      this.updateChatListItem(chatKey);
  }
});
// Get all active chats
app.get('/api/chats', async (req, res) => {
  try {
    const [chats] = await pool.query(`
      SELECT 
        c.id, c.user_id, u.phone, u.profile_name, 
        c.is_ai_active, c.agent_id, c.status,
        MAX(m.created_at) as last_message_time
      FROM chats c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN messages m ON m.chat_id = c.id
      WHERE c.status != 'closed'
      GROUP BY c.id
      ORDER BY last_message_time DESC
    `);
    res.json({ status: 'success', chats });
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      query: 'SELECT chats with users and last message time'
    });
  }
});

// Get messages for a chat
app.get('/api/messages', async (req, res) => {
  try {
    const { chat_id } = req.query;
    if (!chat_id) throw new Error('chat_id parameter required');

    const [messages] = await pool.query(`
      SELECT 
        id, chat_id, sender_type, agent_id, 
        content, direction, created_at
      FROM messages
      WHERE chat_id = ?
      ORDER BY created_at ASC
    `, [chat_id]);

    res.json({ status: 'success', messages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      query: 'SELECT messages for chat'
    });
  }
});

// ==================== SOCKET.IO HANDLERS ====================

io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);

  // Authentication handler
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
      
      // Broadcast updated agent count
      const [agents] = await pool.query('SELECT * FROM agents WHERE status = "online"');
      io.emit('agent_count', agents.length);
      
    } catch (error) {
      console.error('Authentication error:', error);
      callback({ status: 'error', message: error.message });
      socket.disconnect();
    }
  });

  // Disconnection handler
  socket.on('disconnect', async () => {
    const agent = activeConnections.get(socket.id);
    if (agent) {
      await pool.query(
        'UPDATE agents SET status = "offline", socket_id = NULL WHERE id = ?',
        [agent.id]
      );
      activeConnections.delete(socket.id);
      io.emit('agent_disconnected', agent.id);
    }
  });

  // Chat takeover handler
  socket.on('take_over_chat', async ({ chat_id, agent_id }, callback) => {
    try {
      await pool.query(
        'UPDATE chats SET is_ai_active = 0, agent_id = ? WHERE id = ?',
        [agent_id, chat_id]
      );
      io.emit('chat_taken_over', { chat_id, agent_id });
      callback({ status: 'success' });
    } catch (error) {
      console.error('Chat takeover error:', error);
      callback({ status: 'error', message: error.message });
    }
  });

 // Enhanced message handling
 socket.on('send_manual_message', async ({ chat_id, agent_id, message }, callback) => {
  try {
    // Use fixed agent ID 1
    const fixedAgentId = 1;
    
    const [[chat]] = await pool.query(
      `SELECT u.phone FROM chats c
       JOIN users u ON c.user_id = u.id
       WHERE c.id = ?`, 
      [chat_id]
    );
    
    if (!chat) throw new Error('Chat not found');

    // Insert message with fixed agent_id
    const [dbResult] = await pool.query(
      `INSERT INTO messages 
       (chat_id, sender_type, agent_id, content, direction, created_at)
       VALUES (?, 'agent', ?, ?, 'outgoing', UTC_TIMESTAMP())`,
      [chat_id, fixedAgentId, message]
    );

    // Send via WhatsApp API
    const whatsappResponse = await fetch(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: chat.phone,
          text: { body: message }
        })
      }
    );

    if (!whatsappResponse.ok) {
      throw new Error('WhatsApp API request failed');
    }

    const newMessage = {
      id: dbResult.insertId,
      chat_id,
      sender_type: 'agent',
      agent_id: fixedAgentId,
      content: message,
      direction: 'outgoing',
      created_at: new Date().toISOString()
    };

    io.emit('new_manual_message', newMessage);
    callback({ status: 'success', message: newMessage });
  } catch (error) {
    callback({ 
      status: 'error', 
      message: error.message
    });
  }
});
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 Test DB connection: http://localhost:${PORT}/test-db`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});

// Error handling
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
