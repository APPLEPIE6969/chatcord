const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the public folder
app.use(express.static(path.join(__dirname, 'public')));

// Store users
let users = {};

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 1. Join Server
    socket.on('join', (username) => {
        users[socket.id] = { name: username, channel: 'general' };
        socket.join('general');
        
        socket.emit('message', {
            user: 'System',
            text: `Welcome to Chatcord, ${username}!`,
            type: 'system'
        });

        socket.to('general').emit('message', {
            user: 'System',
            text: `${username} has joined the chat.`,
            type: 'system'
        });
    });

    // 2. Switch Channel
    socket.on('switchChannel', (newChannel) => {
        const user = users[socket.id];
        if (!user) return;

        const oldChannel = user.channel;
        socket.leave(oldChannel);
        socket.join(newChannel);
        user.channel = newChannel;

        socket.emit('channelSwitched', newChannel);
        
        socket.emit('message', {
            user: 'System',
            text: `You joined #${newChannel}`,
            type: 'system'
        });
    });

    // 3. Handle Chat Messages
    socket.on('chatMessage', (msg) => {
        const user = users[socket.id];
        if (user) {
            io.to(user.channel).emit('message', {
                user: user.name,
                text: msg,
                type: 'user',
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        }
    });

    // 4. Disconnect
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            io.to(user.channel).emit('message', {
                user: 'System',
                text: `${user.name} left Chatcord.`,
                type: 'system'
            });
            delete users[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
