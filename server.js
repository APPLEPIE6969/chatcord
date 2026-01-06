const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 1. SETUP STORAGE ---
const uploadDir = path.join(__dirname, 'public/uploads');
const DATA_FILE = path.join(__dirname, 'chat_data.json');

// Create uploads folder if missing
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Configure File Uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));

// --- 2. PERSISTENT DATA MANAGEMENT ---
let users = {}; 
let voiceUsers = {}; 
let messageHistory = { 'general': [], 'clips': [], 'music': [], 'memes': [] };

// LOAD DATA ON STARTUP
if (fs.existsSync(DATA_FILE)) {
    try {
        const raw = fs.readFileSync(DATA_FILE);
        messageHistory = JSON.parse(raw);
        console.log("Creating/Loading chat history...");
    } catch (e) {
        console.log("Error loading history, starting fresh.");
    }
}

// SAVE DATA FUNCTION
function saveHistory() {
    fs.writeFile(DATA_FILE, JSON.stringify(messageHistory, null, 2), (err) => {
        if (err) console.error("Error saving chat:", err);
    });
}

// CLEANUP (Keep only last 24h)
setInterval(() => {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    let changed = false;
    Object.keys(messageHistory).forEach(channel => {
        const initialLen = messageHistory[channel].length;
        messageHistory[channel] = messageHistory[channel].filter(msg => msg.timestamp > oneDayAgo);
        if(messageHistory[channel].length !== initialLen) changed = true;
    });
    if(changed) saveHistory();
}, 1000 * 60 * 60); // Run every hour

// --- 3. ROUTES ---
app.post('/upload', upload.single('file'), (req, res) => {
    if(req.file) res.json({ filename: req.file.filename, originalName: req.file.originalname });
    else res.status(400).send('No file uploaded');
});

// --- 4. SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // JOIN
    socket.on('join', (username) => {
        // Default to general
        users[socket.id] = { name: username, channel: 'general' };
        socket.join('general');
        
        // SEND SAVED HISTORY
        socket.emit('loadHistory', messageHistory['general'] || []);
        
        // Announce
        const joinMsg = { user: 'System', text: `Welcome back, ${username}!`, type: 'system', timestamp: Date.now() };
        socket.emit('message', joinMsg);
        socket.to('general').emit('message', { user: 'System', text: `${username} joined.`, type: 'system', timestamp: Date.now() });
    });

    // SWITCH CHANNEL
    socket.on('switchChannel', (newChannel) => {
        const user = users[socket.id];
        if (!user) return;
        
        socket.leave(user.channel);
        socket.join(newChannel);
        user.channel = newChannel;
        
        // Send history for new channel
        socket.emit('channelSwitched', { 
            channel: newChannel, 
            history: messageHistory[newChannel] || [] 
        });
    });

    // CHAT MESSAGE
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

            // Save to Memory & Disk
            if (!messageHistory[user.channel]) messageHistory[user.channel] = [];
            messageHistory[user.channel].push(msgData);
            saveHistory(); // <--- SAVES TO FILE

            io.to(user.channel).emit('message', msgData);
        }
    });

    // VOICE SIGNALING (WebRTC)
    socket.on('joinVoice', (roomId) => {
        voiceUsers[socket.id] = roomId;
        const others = Object.keys(voiceUsers).filter(id => voiceUsers[id] === roomId && id !== socket.id);
        socket.emit('voiceUsers', others);
    });

    socket.on('voiceSignal', (data) => {
        io.to(data.to).emit('voiceSignal', { from: socket.id, signal: data.signal });
    });

    socket.on('leaveVoice', () => {
        const room = voiceUsers[socket.id];
        if(room) {
            delete voiceUsers[socket.id];
            Object.keys(voiceUsers).forEach(id => {
                if(voiceUsers[id] === room) io.to(id).emit('userLeftVoice', socket.id);
            });
        }
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) delete users[socket.id];
        
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
