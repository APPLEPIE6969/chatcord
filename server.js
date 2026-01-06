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
const DATA_FILE = path.join(__dirname, 'chat_data.json');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));

// --- STATE ---
let users = {}; // { socketId: { name, avatar, channel } }
let voiceState = {}; // { socketId: roomId }
let messageHistory = { 'general': [], 'clips': [], 'music': [], 'memes': [] };

// Load History
if (fs.existsSync(DATA_FILE)) {
    try { messageHistory = JSON.parse(fs.readFileSync(DATA_FILE)); } 
    catch (e) { console.log("History reset"); }
}
function saveHistory() {
    fs.writeFile(DATA_FILE, JSON.stringify(messageHistory, null, 2), () => {});
}

// Routes
app.post('/upload', upload.single('file'), (req, res) => {
    if(req.file) res.json({ filename: req.file.filename, originalName: req.file.originalname });
    else res.status(400).send('Error');
});

// Helper: Get users in a specific voice room
function getVoiceUsers(roomId) {
    return Object.keys(voiceState)
        .filter(id => voiceState[id] === roomId)
        .map(id => ({ id, name: users[id]?.name, avatar: users[id]?.avatar }));
}

io.on('connection', (socket) => {
    // 1. JOIN
    socket.on('join', (data) => {
        const name = typeof data === 'object' ? data.name : data;
        const avatar = typeof data === 'object' ? data.avatar : null;
        users[socket.id] = { name, avatar, channel: 'general' };
        socket.join('general');
        
        socket.emit('loadHistory', messageHistory['general'] || []);
        socket.emit('message', { user: 'System', text: `Welcome, ${name}!`, type: 'system' });
        
        // Refresh Voice UI for everyone (in case this user reconnects)
        io.emit('voiceUpdate', getVoiceStateFull());
    });

    // 2. PROFILE
    socket.on('updateProfile', (data) => {
        if(users[socket.id]) {
            users[socket.id].name = data.name;
            users[socket.id].avatar = data.avatar;
            // Update voice lists if they are in voice
            io.emit('voiceUpdate', getVoiceStateFull());
        }
    });

    // 3. CHAT
    socket.on('switchChannel', (newChannel) => {
        if (!users[socket.id]) return;
        socket.leave(users[socket.id].channel);
        socket.join(newChannel);
        users[socket.id].channel = newChannel;
        socket.emit('channelSwitched', { channel: newChannel, history: messageHistory[newChannel] || [] });
    });

    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (user) {
            const msg = {
                user: user.name, avatar: user.avatar,
                text: data.text || "", file: data.file || null,
                type: 'user', time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                timestamp: Date.now()
            };
            if (!messageHistory[user.channel]) messageHistory[user.channel] = [];
            messageHistory[user.channel].push(msg);
            saveHistory();
            io.to(user.channel).emit('message', msg);
        }
    });

    // 4. VOICE (DISCORD STYLE)
    socket.on('joinVoice', (roomId) => {
        // Leave old if any
        const oldRoom = voiceState[socket.id];
        if(oldRoom) {
            socket.leave(oldRoom);
            // Notify others in old room to remove peer
            const oldPeers = Object.keys(voiceState).filter(id => voiceState[id] === oldRoom && id !== socket.id);
            oldPeers.forEach(peerId => io.to(peerId).emit('userLeftVoice', socket.id));
        }

        // Join new
        voiceState[socket.id] = roomId;
        socket.join(roomId);

        // 1. Tell everyone to update sidebar UI
        io.emit('voiceUpdate', getVoiceStateFull());

        // 2. Tell existing users in room to connect to me
        const peers = Object.keys(voiceState).filter(id => voiceState[id] === roomId && id !== socket.id);
        socket.emit('voicePeers', peers); // Tell me who is there
    });

    socket.on('voiceSignal', (data) => io.to(data.to).emit('voiceSignal', { from: socket.id, signal: data.signal }));

    socket.on('leaveVoice', () => {
        const room = voiceState[socket.id];
        if(room) {
            delete voiceState[socket.id];
            socket.leave(room);
            // Notify peers
            const peers = Object.keys(voiceState).filter(id => voiceState[id] === room);
            peers.forEach(p => io.to(p).emit('userLeftVoice', socket.id));
            // Update UI
            io.emit('voiceUpdate', getVoiceStateFull());
        }
    });

    socket.on('disconnect', () => {
        const room = voiceState[socket.id];
        if(room) {
            delete voiceState[socket.id];
            const peers = Object.keys(voiceState).filter(id => voiceState[id] === room);
            peers.forEach(p => io.to(p).emit('userLeftVoice', socket.id));
        }
        delete users[socket.id];
        io.emit('voiceUpdate', getVoiceStateFull());
    });
});

function getVoiceStateFull() {
    // Returns { 'Lounge': [ {id, name, avatar}, ... ], 'Music': [] }
    const state = {};
    Object.keys(voiceState).forEach(socketId => {
        const room = voiceState[socketId];
        if(!state[room]) state[room] = [];
        if(users[socketId]) {
            state[room].push({
                id: socketId,
                name: users[socketId].name,
                avatar: users[socketId].avatar
            });
        }
    });
    return state;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
