const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- SETUP ---
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));

// --- STORAGE ---
let users = {}; // { socketId: { name, channel } }
let voiceUsers = {}; // { socketId: roomId }
let messageHistory = { 'general': [], 'clips': [], 'music': [], 'memes': [] };

// Cleanup Timer
setInterval(() => {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    Object.keys(messageHistory).forEach(channel => {
        messageHistory[channel] = messageHistory[channel].filter(msg => msg.timestamp > oneDayAgo);
    });
}, 1000 * 60 * 60);

// --- ROUTES ---
app.post('/upload', upload.single('file'), (req, res) => {
    if(req.file) res.json({ filename: req.file.filename, originalName: req.file.originalname });
    else res.status(400).send('No file uploaded');
});

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. TEXT CHAT
    socket.on('join', (username) => {
        users[socket.id] = { name: username, channel: 'general' };
        socket.join('general');
        socket.emit('loadHistory', messageHistory['general']);
        
        const sysMsg = { user: 'System', text: `Welcome back, ${username}!`, type: 'system', timestamp: Date.now() };
        socket.emit('message', sysMsg);
        socket.to('general').emit('message', { user: 'System', text: `${username} hopped in.`, type: 'system', timestamp: Date.now() });
    });

    socket.on('switchChannel', (newChannel) => {
        const user = users[socket.id];
        if (!user) return;
        socket.leave(user.channel);
        socket.join(newChannel);
        user.channel = newChannel;
        socket.emit('channelSwitched', { channel: newChannel, history: messageHistory[newChannel] || [] });
    });

    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (user) {
            const msgData = {
                user: user.name,
                text: data.text || "",
                file: data.file || null,
                type: 'user',
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                timestamp: Date.now()
            };
            if (!messageHistory[user.channel]) messageHistory[user.channel] = [];
            messageHistory[user.channel].push(msgData);
            io.to(user.channel).emit('message', msgData);
        }
    });

    // 2. VOICE CHAT SIGNALING
    socket.on('joinVoice', (roomId) => {
        if(voiceUsers[socket.id]) return; // Already in
        voiceUsers[socket.id] = roomId;
        
        // Get all other users in this voice room
        const others = Object.keys(voiceUsers).filter(id => voiceUsers[id] === roomId && id !== socket.id);
        
        // Tell current user who is already there
        socket.emit('voiceUsers', others);
    });

    socket.on('voiceSignal', (data) => {
        // Relay signal (offer/answer/ice) to specific user
        io.to(data.to).emit('voiceSignal', { from: socket.id, signal: data.signal });
    });

    socket.on('leaveVoice', () => {
        const room = voiceUsers[socket.id];
        if(room) {
            delete voiceUsers[socket.id];
            // Tell others I left
            Object.keys(voiceUsers).forEach(id => {
                if(voiceUsers[id] === room) {
                    io.to(id).emit('userLeftVoice', socket.id);
                }
            });
        }
    });

    // 3. DISCONNECT
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) delete users[socket.id];
        
        // Handle voice disconnect
        const room = voiceUsers[socket.id];
        if(room) {
            delete voiceUsers[socket.id];
            Object.keys(voiceUsers).forEach(id => {
                if(voiceUsers[id] === room) io.to(id).emit('userLeftVoice', socket.id);
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
