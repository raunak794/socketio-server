const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Update your server.js database configuration
const pool = mysql.createPool({
  host: 'localhost', // Replace with your shared hosting database server if different
  user: 'digeesellse_whatsapp_bot',
  password: 'mTN{bdlv9$7R',
  database: 'digeesellse_whatsapp_bot',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Store active agents
const activeAgents = new Map();

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  // Agent authentication
  socket.on('authenticate', async ({ agentId, name }, callback) => {
    try {
      // Update or create agent in database
      const [result] = await pool.execute(
        `INSERT INTO agents (id, name, status, socket_id, last_active) 
         VALUES (?, ?, 'online', ?, NOW())
         ON DUPLICATE KEY UPDATE 
         name = VALUES(name), status = 'online', socket_id = VALUES(socket_id), last_active = NOW()`,
        [agentId, name, socket.id]
      );

      activeAgents.set(socket.id, { agentId, name });
      
      // Notify all about new agent list
      await updateAgentList();
      
      callback({ status: 'success', agentId });
    } catch (error) {
      console.error('Authentication error:', error);
      callback({ status: 'error', message: 'Authentication failed' });
    }
  });

  // Handle chat takeover
  socket.on('take_over_chat', async ({ chat_id, agent_id }, callback) => {
    try {
      // Update chat in database
      await pool.execute(
        `UPDATE chats SET is_ai_active = FALSE, agent_id = ?, status = 'assigned', updated_at = NOW() 
         WHERE id = ?`,
        [agent_id, chat_id]
      );

      // Get chat details
      const [chats] = await pool.execute(
        `SELECT c.*, u.phone, u.profile_name FROM chats c
         JOIN users u ON c.user_id = u.id
         WHERE c.id = ?`,
        [chat_id]
      );

      if (chats.length === 0) {
        return callback({ status: 'error', message: 'Chat not found' });
      }

      const chat = chats[0];
      
      // Notify all clients about the takeover
      io.emit('chat_taken_over', {
        chat_id,
        phone: chat.phone,
        profile_name: chat.profile_name,
        agent_id,
        agent_name: activeAgents.get(socket.id)?.name
      });

      // Get chat history
      const [messages] = await pool.execute(
        `SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at`,
        [chat_id]
      );

      // Send chat history to the agent who took over
      socket.emit('chat_history', {
        chat_id,
        messages
      });

      callback({ status: 'success' });
    } catch (error) {
      console.error('Takeover error:', error);
      callback({ status: 'error', message: 'Takeover failed' });
    }
  });

  // Handle agent messages
  socket.on('send_agent_message', async ({ chat_id, agent_id, message }, callback) => {
    try {
      // Store message
      await pool.execute(
        `INSERT INTO messages (chat_id, sender_type, agent_id, content, direction) 
         VALUES (?, 'agent', ?, ?, 'outgoing')`,
        [chat_id, agent_id, message]
      );

      // Get chat details
      const [chats] = await pool.execute(
        `SELECT u.phone FROM chats c
         JOIN users u ON c.user_id = u.id
         WHERE c.id = ?`,
        [chat_id]
      );

      if (chats.length === 0) {
        return callback({ status: 'error', message: 'Chat not found' });
      }

      const phone = chats[0].phone;
      
      // Send to WhatsApp
      // (You would implement this function to actually send via WhatsApp API)
      sendWhatsAppMessage(phone, message);
      
      // Notify all clients
      io.emit('new_agent_message', {
        chat_id,
        agent_id,
        message,
        phone
      });

      callback({ status: 'success' });
    } catch (error) {
      console.error('Message send error:', error);
      callback({ status: 'error', message: 'Failed to send message' });
    }
  });

  // Disconnection handler
  socket.on('disconnect', async () => {
    const agent = activeAgents.get(socket.id);
    if (agent) {
      activeAgents.delete(socket.id);
      
      // Update agent status in database
      try {
        await pool.execute(
          `UPDATE agents SET status = 'offline', socket_id = NULL, last_active = NOW() 
           WHERE id = ?`,
          [agent.agentId]
        );
        
        // Notify all about updated agent list
        await updateAgentList();
      } catch (error) {
        console.error('Disconnection update error:', error);
      }
    }
  });

  // API endpoint to get initial chat state
  app.get('/chats', async (req, res) => {
    try {
      const [chats] = await pool.execute(
        `SELECT c.*, u.phone, u.profile_name FROM chats c
         JOIN users u ON c.user_id = u.id
         WHERE c.status != 'closed'
         ORDER BY c.updated_at DESC`
      );
      
      // Get messages for each chat
      for (const chat of chats) {
        const [messages] = await pool.execute(
          `SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at`,
          [chat.id]
        );
        chat.messages = messages;
      }
      
      res.json({ status: 'success', chats });
    } catch (error) {
      console.error('Error fetching chats:', error);
      res.status(500).json({ status: 'error', message: 'Failed to fetch chats' });
    }
  });
});

async function updateAgentList() {
  try {
    const [agents] = await pool.execute(
      `SELECT * FROM agents WHERE status = 'online' ORDER BY name`
    );
    
    io.emit('agent_list', agents);
    io.emit('agent_count', agents.length);
  } catch (error) {
    console.error('Error updating agent list:', error);
  }
}

server.listen(3000, () => {
  console.log('Server running on port 3000');
});
