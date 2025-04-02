const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// Socket.IO Configuration - simplified for Render
const io = socketIo(server, {
  cors: {
    origin: [
      "https://demo.digeesell.ae", // Your main domain
      "https://whatsapp-socketio-8h4m.onrender.com", // Will be your Render URL
    ],
    methods: ["GET", "POST"],
  },
  // Remove the path specification as Render doesn't need it
  pingTimeout: 60000,
  pingInterval: 25000,
});

// [Keep all your existing socket logic...]

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
