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
const PERSISTENT_DATA_FILE = path.join(__dirname, 'persistent_data.json');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.static(path.join(__dirname, 'public')));

// --- STATE ---
let users = {}; // { socketId: { name, avatar } }
let voiceState = {}; // { socketId: roomId }
let messageHistory = { 'global': [] };
let privateMessages = {}; // { userId: { targetUserId: [messages] } }
let friends = {}; // { userId: [friendUserIds] }
let friendRequests = {}; // { userId: [fromUserIds] }
let notifications = {}; // { userId: [notifications] }
let userProfiles = {}; // { userId: { name, avatar } }

// Load Persistent Data
function loadPersistentData() {
    if (fs.existsSync(PERSISTENT_DATA_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(PERSISTENT_DATA_FILE));
            friends = data.friends || {};
            friendRequests = data.friendRequests || {};
            notifications = data.notifications || {};
            privateMessages = data.privateMessages || {};
            userProfiles = data.userProfiles || {};
            console.log('Persistent data loaded successfully');
        } catch (e) {
            console.log('Error loading persistent data, starting fresh:', e);
        }
    }
}

// Save Persistent Data
function savePersistentData() {
    const data = {
        friends,
        friendRequests,
        notifications,
        privateMessages,
        userProfiles,
        lastSaved: Date.now()
    };
    fs.writeFile(PERSISTENT_DATA_FILE, JSON.stringify(data, null, 2), (err) => {
        if (err) console.error('Error saving persistent data:', err);
    });
}

// Load Message History
if (fs.existsSync(DATA_FILE)) {
    try { messageHistory = JSON.parse(fs.readFileSync(DATA_FILE)); } 
    catch (e) { console.log("History reset"); }
}

// Save Message History
function saveHistory() {
    fs.writeFile(DATA_FILE, JSON.stringify(messageHistory, null, 2), () => {});
}

// Clean up old messages (7 days)
function cleanupOldMessages() {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let cleanedCount = 0;
    
    // Clean global messages
    const originalLength = messageHistory['global'].length;
    messageHistory['global'] = messageHistory['global'].filter(msg => msg.timestamp > sevenDaysAgo);
    cleanedCount += originalLength - messageHistory['global'].length;
    
    // Clean private messages
    Object.keys(privateMessages).forEach(userId => {
        Object.keys(privateMessages[userId]).forEach(targetId => {
            const originalLength = privateMessages[userId][targetId].length;
            privateMessages[userId][targetId] = privateMessages[userId][targetId].filter(msg => msg.timestamp > sevenDaysAgo);
            cleanedCount += originalLength - privateMessages[userId][targetId].length;
        });
    });
    
    if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} expired messages`);
        saveHistory();
        savePersistentData();
    }
}

// Load data on startup
loadPersistentData();

// Run cleanup every hour
setInterval(cleanupOldMessages, 60 * 60 * 1000);

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
        
        // Load user profile if exists
        const existingProfile = userProfiles[socket.id];
        if (existingProfile) {
            users[socket.id] = { 
                name: existingProfile.name || name, 
                avatar: existingProfile.avatar || avatar 
            };
        } else {
            users[socket.id] = { name, avatar };
            // Save new profile
            userProfiles[socket.id] = { name, avatar };
        }
        
        socket.join('global');
        
        socket.emit('loadHistory', messageHistory['global'] || []);
        socket.emit('message', { user: 'System', text: `Welcome, ${users[socket.id].name}!`, type: 'system' });
        
        // Send friends list
        const userFriends = friends[socket.id] || [];
        const friendsList = userFriends.map(id => ({
            id,
            name: users[id]?.name || userProfiles[id]?.name || 'Unknown',
            avatar: users[id]?.avatar || userProfiles[id]?.avatar || null,
            online: !!users[id]
        }));
        socket.emit('friendsUpdate', friendsList);
        
        // Send notifications
        socket.emit('notificationsUpdate', notifications[socket.id] || []);
        
        // Refresh Voice UI for everyone (in case this user reconnects)
        io.emit('voiceUpdate', getVoiceStateFull());
    });

    // 2. PROFILE
    socket.on('updateProfile', (data) => {
        if(users[socket.id]) {
            users[socket.id].name = data.name;
            users[socket.id].avatar = data.avatar;
            
            // Update persistent profile
            userProfiles[socket.id] = { name: data.name, avatar: data.avatar };
            savePersistentData();
            
            // Update voice lists if they are in voice
            io.emit('voiceUpdate', getVoiceStateFull());
        }
    });

    // 3. FRIENDS SYSTEM
    socket.on('sendFriendRequest', (targetName) => {
        const sender = users[socket.id];
        if (!sender) return;
        
        // Find target user by name
        const targetSocketId = Object.keys(users).find(id => users[id].name === targetName);
        if (!targetSocketId || targetSocketId === socket.id) {
            socket.emit('friendRequestError', 'User not found or cannot add yourself');
            return;
        }
        
        // Initialize arrays if needed
        if (!friendRequests[targetSocketId]) friendRequests[targetSocketId] = [];
        if (!notifications[targetSocketId]) notifications[targetSocketId] = [];
        
        // Check if already sent
        if (friendRequests[targetSocketId].includes(socket.id)) {
            socket.emit('friendRequestError', 'Friend request already sent');
            return;
        }
        
        // Add request and notification
        friendRequests[targetSocketId].push(socket.id);
        notifications[targetSocketId].push({
            type: 'friend_request',
            from: socket.id,
            fromName: sender.name,
            fromAvatar: sender.avatar,
            timestamp: Date.now()
        });
        
        // Save persistent data
        savePersistentData();
        
        // Notify target user
        io.to(targetSocketId).emit('notification', {
            type: 'friend_request',
            from: socket.id,
            fromName: sender.name,
            fromAvatar: sender.avatar
        });
        io.to(targetSocketId).emit('notificationsUpdate', notifications[targetSocketId]);
        
        socket.emit('friendRequestSent', targetName);
    });

    socket.on('acceptFriendRequest', (fromSocketId) => {
        if (!friendRequests[socket.id] || !friendRequests[socket.id].includes(fromSocketId)) return;
        
        // Remove from requests
        friendRequests[socket.id] = friendRequests[socket.id].filter(id => id !== fromSocketId);
        
        // Add to friends list for both users
        if (!friends[socket.id]) friends[socket.id] = [];
        if (!friends[fromSocketId]) friends[fromSocketId] = [];
        
        if (!friends[socket.id].includes(fromSocketId)) friends[socket.id].push(fromSocketId);
        if (!friends[fromSocketId].includes(socket.id)) friends[fromSocketId].push(socket.id);
        
        // Save persistent data
        savePersistentData();
        
        // Notify both users
        socket.emit('friendAccepted', {
            id: fromSocketId,
            name: users[fromSocketId].name,
            avatar: users[fromSocketId].avatar
        });
        
        io.to(fromSocketId).emit('friendAccepted', {
            id: socket.id,
            name: users[socket.id].name,
            avatar: users[socket.id].avatar
        });
        
        // Update friends lists
        socket.emit('friendsUpdate', friends[socket.id].map(id => ({
            id,
            name: users[id].name,
            avatar: users[id].avatar,
            online: true
        })));
        
        io.to(fromSocketId).emit('friendsUpdate', friends[fromSocketId].map(id => ({
            id,
            name: users[id].name,
            avatar: users[id].avatar,
            online: true
        })));
    });

    socket.on('rejectFriendRequest', (fromSocketId) => {
        if (friendRequests[socket.id]) {
            friendRequests[socket.id] = friendRequests[socket.id].filter(id => id !== fromSocketId);
            savePersistentData();
        }
        socket.emit('friendRequestRejected', fromSocketId);
    });

    socket.on('getFriendsList', () => {
        const userFriends = friends[socket.id] || [];
        const friendsList = userFriends.map(id => ({
            id,
            name: users[id]?.name || userProfiles[id]?.name || 'Unknown',
            avatar: users[id]?.avatar || userProfiles[id]?.avatar || null,
            online: !!users[id]
        }));
        socket.emit('friendsUpdate', friendsList);
    });

    socket.on('getNotifications', () => {
        socket.emit('notificationsUpdate', notifications[socket.id] || []);
    });
    // 4. PRIVATE MESSAGING
    socket.on('privateMessage', (data) => {
        const sender = users[socket.id];
        const targetId = data.targetId;
        
        if (!sender || !targetId || !users[targetId]) return;
        
        // Check if they are friends
        const userFriends = friends[socket.id] || [];
        if (!userFriends.includes(targetId)) {
            socket.emit('privateMessageError', 'You can only message friends');
            return;
        }
        
        const msg = {
            from: socket.id,
            to: targetId,
            user: sender.name,
            avatar: sender.avatar,
            text: data.text || "",
            file: data.file || null,
            type: 'private',
            time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
            timestamp: Date.now()
        };
        
        // Store message history for both users
        if (!privateMessages[socket.id]) privateMessages[socket.id] = {};
        if (!privateMessages[socket.id][targetId]) privateMessages[socket.id][targetId] = [];
        if (!privateMessages[targetId]) privateMessages[targetId] = {};
        if (!privateMessages[targetId][socket.id]) privateMessages[targetId][socket.id] = [];
        
        privateMessages[socket.id][targetId].push(msg);
        privateMessages[targetId][socket.id].push(msg);
        
        // Save persistent data
        savePersistentData();
        
        // Send to both users
        socket.emit('privateMessage', msg);
        io.to(targetId).emit('privateMessage', msg);
    });

    socket.on('getPrivateMessages', (targetId) => {
        const userFriends = friends[socket.id] || [];
        if (!userFriends.includes(targetId)) {
            socket.emit('privateMessageError', 'You can only view messages with friends');
            return;
        }
        
        const messages = (privateMessages[socket.id] && privateMessages[socket.id][targetId]) || [];
        socket.emit('privateMessagesHistory', { targetId, messages });
    });

    // 5. CHAT
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (user) {
            const msg = {
                user: user.name, avatar: user.avatar,
                text: data.text || "", file: data.file || null,
                type: 'user', time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                timestamp: Date.now()
            };
            messageHistory['global'].push(msg);
            saveHistory();
            io.to('global').emit('message', msg);
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
        
        // Save persistent data on disconnect
        savePersistentData();
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
