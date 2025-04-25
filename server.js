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
  connectTimeout: 10000,
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

// Test database connection
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

// Auto-sync interval
const syncInterval = setInterval(() => {
  io.emit('chat_refresh_request');
}, 30000);

// Clean up on server shutdown
process.on('SIGTERM', () => {
  clearInterval(syncInterval);
  pool.end();
});

// ==================== API ENDPOINTS ====================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date(),
    dbStatus: pool.pool.config.connectionConfig.host ? 'configured' : 'missing'
  });
});

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
      database: rows[0]
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Database connection failed',
      error: error.message
    });
  }
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
    res.status(500).json({ available: false, error: error.message });
  }
});

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
    res.status(500).json({ 
      status: 'error', 
      message: error.message
    });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const { chat_id } = req.query;
    if (!chat_id) throw new Error('chat_id parameter required');

    const [messages] = await pool.query(`
      SELECT * FROM messages
      WHERE chat_id = ?
      ORDER BY created_at ASC
    `, [chat_id]);
    res.json({ status: 'success', messages });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message
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
      
      const [agents] = await pool.query('SELECT * FROM agents WHERE status = "online"');
      io.emit('agent_count', agents.length);
      
      callback({ status: 'success' });
    } catch (error) {
      callback({ status: 'error', message: error.message });
      socket.disconnect();
    }
  });

  socket.on('disconnect', async () => {
    const agent = activeConnections.get(socket.id);
    if (agent) {
      await pool.query(
        'UPDATE agents SET status = "offline", socket_id = NULL WHERE id = ?',
        [agent.agentId]
      );
      activeConnections.delete(socket.id);
      io.emit('agent_disconnected', agent.agentId);
    }
  });

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
      callback({ status: 'error', message: error.message });
    }
  });

  socket.on('send_manual_message', async ({ chat_id, agent_id, message }, callback) => {
    try {
      const [[chat]] = await pool.query(
        `SELECT u.phone FROM chats c
         JOIN users u ON c.user_id = u.id
         WHERE c.id = ?`, 
        [chat_id]
      );
      if (!chat) throw new Error('Chat not found');

      const [dbResult] = await pool.query(
        `INSERT INTO messages 
         (chat_id, sender_type, agent_id, content, direction, created_at)
         VALUES (?, 'agent', ?, ?, 'outgoing', UTC_TIMESTAMP())`,
        [chat_id, agent_id, message]
      );

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
        agent_id,
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
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
