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

// Enable JSON parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Store active agents and chats
const agents = new Map(); // Map of socket.id to agent info
const activeChats = {};   // Map of phone numbers to chat data

// Helper function to broadcast chat updates
function broadcastChatUpdate(phone) {
  if (activeChats[phone]) {
    io.emit('chat_update', {
      phone: phone,
      chat: activeChats[phone]
    });
  }
}

// Helper function to get basic chat info for listing
function getChatList() {
  return Object.keys(activeChats).map(phone => ({
    phone: phone,
    lastMessage: activeChats[phone].messages.slice(-1)[0]?.text || '',
    timestamp: activeChats[phone].messages.slice(-1)[0]?.timestamp || Date.now(),
    unread: activeChats[phone].unread || 0,
    takenOver: activeChats[phone].takenOver || false
  }));
}

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);
  
  // Set default transport for logging
  socket.conn.on('upgrade', () => {
    console.log(`Transport upgraded to: ${socket.conn.transport.name}`);
  });

  // Authentication handler
  socket.on('authenticate', ({ role, agentId, name }, callback) => {
    console.log(`Authentication attempt as ${role}`);
    
    try {
      if (role === 'agent') {
        agents.set(socket.id, {
          id: agentId || socket.id,
          name: name || `Agent-${socket.id.substring(0, 5)}`,
          socketId: socket.id,
          available: true
        });
        
        io.emit('agent_count', agents.size);
        console.log(`Agent ${socket.id} authenticated`);
        
        // Send success response
        const response = { 
          status: 'success', 
          message: 'Authenticated as agent',
          agentId: socket.id,
          agentCount: agents.size,
          chatList: getChatList()
        };
        
        if (typeof callback === 'function') {
          callback(response);
        }
        
        // Also emit the response for other clients
        socket.emit('authentication_result', response);
      } else {
        const error = { status: 'error', message: 'Invalid role' };
        if (typeof callback === 'function') {
          callback(error);
        }
        socket.emit('authentication_error', error);
      }
    } catch (error) {
      console.error('Authentication error:', error);
      const errResponse = { 
        status: 'error', 
        message: 'Internal server error',
        error: error.message 
      };
      if (typeof callback === 'function') {
        callback(errResponse);
      }
      socket.emit('authentication_error', errResponse);
    }
  });

  // Initial state request
  socket.on('request_initial_state', (callback) => {
    console.log('Initial state requested by:', socket.id);
    try {
      const response = {
        status: 'success',
        agentCount: agents.size,
        chats: activeChats,
        chatList: getChatList()
      };
      
      if (typeof callback === 'function') {
        callback(response);
      } else {
        socket.emit('initial_state', response);
      }
    } catch (error) {
      console.error('Error sending initial state:', error);
      if (typeof callback === 'function') {
        callback({ status: 'error', message: error.message });
      }
    }
  });

  // Message handling
  socket.on('send_message', (data, callback) => {
    console.log('Received message from:', socket.id, 'data:', data);
    
    try {
      if (!data.phone || !data.message) {
        throw new Error('Phone and message are required');
      }
      
      // Initialize chat if not exists
      if (!activeChats[data.phone]) {
        activeChats[data.phone] = {
          phone: data.phone,
          messages: [],
          unread: 0,
          takenOver: true, // Human is taking over
          profileName: data.profile_name || 'Customer',
          lastActivity: new Date().toISOString()
        };
      }
      
      // Create message object
      const message = {
        id: data.message_id || Date.now().toString(),
        text: data.message,
        direction: 'outgoing',
        timestamp: new Date().toISOString(),
        source: 'human',
        sender: agents.get(socket.id)?.name || 'Agent'
      };
      
      // Add to chat
      activeChats[data.phone].messages.push(message);
      activeChats[data.phone].lastActivity = new Date().toISOString();
      
      // Broadcast to all clients
      io.emit('new_message', {
        phone: data.phone,
        message: message,
        chat: activeChats[data.phone]
      });
      
      // Send success response
      const response = { 
        status: 'success', 
        message: 'Message sent',
        message_id: message.id
      };
      
      if (typeof callback === 'function') {
        callback(response);
      }
      
      // Also broadcast chat update
      broadcastChatUpdate(data.phone);
    } catch (error) {
      console.error('Message handling error:', error);
      const errorResponse = { 
        status: 'error', 
        message: error.message 
      };
      if (typeof callback === 'function') {
        callback(errorResponse);
      }
      socket.emit('message_error', errorResponse);
    }
  });

  // Chat takeover handling
  socket.on('take_over_chat', (data, callback) => {
    console.log('Take over chat request:', data);
    
    try {
      if (!data.phone) {
        throw new Error('Phone number is required');
      }
      
      // Initialize chat if not exists
      if (!activeChats[data.phone]) {
        activeChats[data.phone] = {
          phone: data.phone,
          messages: [],
          unread: 0,
          takenOver: true,
          profileName: data.profile_name || 'Customer',
          lastActivity: new Date().toISOString()
        };
      } else {
        activeChats[data.phone].takenOver = true;
      }
      
      // Set the agent as the handler
      activeChats[data.phone].handler = agents.get(socket.id)?.name || 'Agent';
      
      // Broadcast update
      io.emit('chat_taken_over', {
        phone: data.phone,
        chat: activeChats[data.phone],
        agent: agents.get(socket.id)
      });
      
      // Send success response
      const response = { 
        status: 'success', 
        message: 'Chat taken over',
        chat: activeChats[data.phone]
      };
      
      if (typeof callback === 'function') {
        callback(response);
      }
      
      // Broadcast chat update
      broadcastChatUpdate(data.phone);
    } catch (error) {
      console.error('Takeover error:', error);
      const errorResponse = { 
        status: 'error', 
        message: error.message 
      };
      if (typeof callback === 'function') {
        callback(errorResponse);
      }
      socket.emit('takeover_error', errorResponse);
    }
  });

  // Ping test endpoint
  socket.on('ping', (callback) => {
    const response = {
      status: 'success',
      serverTime: new Date().toISOString(),
      transport: socket.conn.transport.name,
      agentsOnline: agents.size,
      activeChats: Object.keys(activeChats).length
    };
    callback(response);
  });

  // Disconnection handler
  socket.on('disconnect', (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
    
    if (agents.has(socket.id)) {
      agents.delete(socket.id);
      io.emit('agent_count', agents.size);
      console.log(`Agent ${socket.id} removed`);
    }
    
    // Check if any chats were being handled by this agent
    Object.keys(activeChats).forEach(phone => {
      if (activeChats[phone].handler === socket.id) {
        activeChats[phone].takenOver = false;
        activeChats[phone].handler = null;
        broadcastChatUpdate(phone);
      }
    });
  });
});

// HTTP endpoint for PHP webhook
app.post('/notify', (req, res) => {
  try {
    const { type, phone, message, message_id, profile_name } = req.body;
    console.log('Webhook notification:', { type, phone, message });
    
    if (!type || !phone || !message) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Missing parameters: type, phone, and message are required' 
      });
    }
    
    // Initialize chat if not exists
    if (!activeChats[phone]) {
      activeChats[phone] = {
        phone: phone,
        messages: [],
        unread: 0,
        takenOver: false,
        profileName: profile_name || 'Customer',
        lastActivity: new Date().toISOString()
      };
    }
    
    // Create message object
    const messageObj = {
      id: message_id || Date.now().toString(),
      text: message,
      direction: type === 'ai_response' ? 'outgoing' : 'incoming',
      timestamp: new Date().toISOString(),
      source: type === 'ai_response' ? 'ai' : 'user'
    };
    
    // Add to chat
    activeChats[phone].messages.push(messageObj);
    activeChats[phone].lastActivity = new Date().toISOString();
    
    // Increment unread count if not current chat
    if (type !== 'ai_response') {
      activeChats[phone].unread++;
    }
    
    // Emit to all clients
    io.emit(type, {
      phone: phone,
      message: messageObj,
      chat: activeChats[phone]
    });
    
    // Also broadcast chat update
    broadcastChatUpdate(phone);
    
    res.json({ 
      status: 'success', 
      message: 'Notification processed',
      message_id: messageObj.id
    });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// Human availability endpoint
app.get('/human_available', (req, res) => {
  try {
    const available = agents.size > 0;
    res.json({
      status: 'success',
      available: available,
      agentCount: agents.size
    });
  } catch (error) {
    console.error('Human availability error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// Get active chats endpoint
app.get('/active_chats', (req, res) => {
  try {
    res.json({
      status: 'success',
      count: Object.keys(activeChats).length,
      chats: getChatList()
    });
  } catch (error) {
    console.error('Active chats error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// Get chat details endpoint
app.get('/chat/:phone', (req, res) => {
  try {
    const { phone } = req.params;
    if (!activeChats[phone]) {
      return res.status(404).json({ 
        status: 'error', 
        message: 'Chat not found' 
      });
    }
    
    res.json({
      status: 'success',
      chat: activeChats[phone]
    });
  } catch (error) {
    console.error('Chat details error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    connections: io.engine.clientsCount,
    agents: agents.size,
    activeChats: Object.keys(activeChats).length,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server available at ws://localhost:${PORT}`);
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});
