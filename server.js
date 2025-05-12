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
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true
  },
  pingInterval: 10000,
  pingTimeout: 5000
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

  // Add the request_chat_update handler INSIDE the connection callback
  socket.on('request_chat_update', async (chatId, callback) => {
    try {
      const [messages] = await pool.query(`
        SELECT * FROM messages 
        WHERE chat_id = ? 
        ORDER BY created_at ASC
      `, [chatId]);
      
      callback({ status: 'success', messages });
    } catch (error) {
      callback({ status: 'error', message: error.message });
    }
  });

  // Authentication handler
  socket.on('authenticate', async ({ agentId, name }, callback) => {
    try {
      // Dashboard connections should use agentId = 1
      const isDashboard = name === 'Dashboard User';
      const effectiveAgentId = isDashboard ? 1 : agentId;
  
      await pool.query(
        `INSERT INTO agents (id, name, status, socket_id, last_active)
         VALUES (?, ?, 'online', ?, NOW())
         ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         status = 'online',
         socket_id = VALUES(socket_id),
         last_active = NOW()`,
        [effectiveAgentId, name, socket.id]
      );
  
      activeConnections.set(socket.id, { agentId: effectiveAgentId, name });
      
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
// Add to your server.js
const checkDeliveryStatus = async (messageId, phone) => {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${messageId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    );
    
    const data = await response.json();
    return data.status === 'delivered';
  } catch (error) {
    console.error('Delivery check failed:', error);
    return false;
  }
};

// Then modify your send logic to include:
setTimeout(async () => {
  const isDelivered = await checkDeliveryStatus(responseData.messages[0].id, chat.phone);
  if (!isDelivered) {
    await connection.query(
      'UPDATE messages SET status = "failed", error = ? WHERE id = ?',
      ['Message not delivered to user', dbResult.insertId]
    );
    io.emit('message_status_update', {
      message_id: dbResult.insertId,
      status: 'failed',
      error: 'Message not delivered to user'
    });
  }
}, 30000); // Check after 30 seconds
socket.on('send_manual_message', async ({ chat_id, message }, callback) => {
  let dbResult;
  let connection;
  
  try {
    connection = await pool.getConnection();
    const fixedAgentId = 1; // Dashboard agent ID
    
    // 1. Get chat info including last message time
    const [[chat]] = await connection.query(
      `SELECT u.phone, c.is_ai_active, 
              MAX(m.created_at) as last_message_time
       FROM chats c
       JOIN users u ON c.user_id = u.id
       LEFT JOIN messages m ON m.chat_id = c.id
       WHERE c.id = ?
       GROUP BY c.id, u.phone, c.is_ai_active`, 
      [chat_id]
    );
    
    if (!chat) throw new Error('Chat not found');
    if (chat.is_ai_active) throw new Error('Cannot send manual message - chat is in AI mode');

    // 2. Determine message type based on 24-hour window
    const lastMessageTime = chat.last_message_time ? new Date(chat.last_message_time) : null;
    const isWithin24Hours = lastMessageTime && 
      (Date.now() - lastMessageTime < 24 * 60 * 60 * 1000);

    let payload;
    if (isWithin24Hours) {
      // Session message (within 24 hours)
      payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: chat.phone,
        type: "text",
        text: { body: message }
      };
    } else {
      // Template message (after 24 hours)
      payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: chat.phone,
        type: "template",
        template: {
          name: "human_reply", // Pre-approved template
          language: { code: "en" },
          components: [{
            type: "body",
            parameters: [{
              type: "text",
              text: message // Your dynamic message content
            }]
          }]
        }
      };
    }

    // 3. Insert message into database
    [dbResult] = await connection.query(
      `INSERT INTO messages 
       (chat_id, sender_type, agent_id, content, direction, status, created_at)
       VALUES (?, 'agent', ?, ?, 'outgoing', 'sending', UTC_TIMESTAMP())`,
      [chat_id, fixedAgentId, message]
    );

    // 4. Send via WhatsApp API
    const whatsappResponse = await fetch(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    const responseData = await whatsappResponse.json();
    
    if (!whatsappResponse.ok) {
      throw new Error(responseData.error?.message || 'WhatsApp API request failed');
    }

    // 5. Update message status
    const newStatus = isWithin24Hours ? 'delivered' : 'template_sent';
    await connection.query(
      `UPDATE messages 
       SET status = ?, 
           whatsapp_id = ?,
           updated_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [newStatus, responseData.messages[0].id, dbResult.insertId]
    );
    
    // 6. Prepare response
    const newMessage = {
      id: dbResult.insertId,
      chat_id,
      sender_type: 'agent',
      agent_id: fixedAgentId,
      content: message,
      direction: 'outgoing',
      status: newStatus,
      whatsapp_id: responseData.messages[0].id,
      created_at: new Date().toISOString(),
      is_template: !isWithin24Hours
    };
    
    // 7. Notify clients
    io.emit('new_manual_message', newMessage);
    callback({ status: 'success', message: newMessage });
    
  } catch (error) {
    console.error('Message send error:', error);
    // Error handling...
  } finally {
    if (connection) connection.release();
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
