const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 1. SETUP FILE UPLOADS ---
// Create 'uploads' folder if it doesn't exist
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// --- 2. DATA STORAGE (RAM) ---
let users = {};
let messageHistory = {
    'general': [],
    'clips': [],
    'music': [],
    'memes': []
};

// --- 3. CLEANUP TIMER (24 HOURS) ---
// Runs every hour to delete old messages
setInterval(() => {
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    Object.keys(messageHistory).forEach(channel => {
        messageHistory[channel] = messageHistory[channel].filter(msg => msg.timestamp > oneDayAgo);
    });
}, 1000 * 60 * 60);

// --- 4. ROUTES ---
// Upload Endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    if(req.file) {
        res.json({ filename: req.file.filename, originalName: req.file.originalname });
    } else {
        res.status(400).send('No file uploaded');
    }
});

// --- 5. SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Join & Restore
    socket.on('join', (username) => {
        users[socket.id] = { name: username, channel: 'general' };
        socket.join('general');
        
        // 1. Send History for General
        socket.emit('loadHistory', messageHistory['general']);

        // 2. Announce Join
        const sysMsg = {
            user: 'System',
            text: `Welcome back, ${username}!`,
            type: 'system',
            timestamp: Date.now()
        };
        socket.emit('message', sysMsg);
        
        socket.to('general').emit('message', {
            user: 'System',
            text: `${username} hopped in.`,
            type: 'system',
            timestamp: Date.now()
        });
    });

    // Switch Channel
    socket.on('switchChannel', (newChannel) => {
        const user = users[socket.id];
        if (!user) return;

        socket.leave(user.channel);
        socket.join(newChannel);
        user.channel = newChannel;

        // Clear chat UI and load new history
        socket.emit('channelSwitched', { channel: newChannel, history: messageHistory[newChannel] || [] });
    });

    // Handle Messages & Files
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (user) {
            const msgData = {
                user: user.name,
                text: data.text || "",
                file: data.file || null, // If it's a file
                type: 'user',
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                timestamp: Date.now()
            };

            // Save to memory
            if (!messageHistory[user.channel]) messageHistory[user.channel] = [];
            messageHistory[user.channel].push(msgData);

            // Broadcast
            io.to(user.channel).emit('message', msgData);
        }
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            delete users[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
