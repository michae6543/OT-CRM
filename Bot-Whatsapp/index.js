require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const axios = require('axios');

const apiRoutes = require('./src/routes/api.route');
const { RESTORE_SESSIONS_ON_START = true } = process.env;

require('./src/workers/mediaWorker');
require('./src/workers/senderWorker');
require('./src/workers/webhookWorker');

const { restoreExistingSessions } = require('./src/services/waService');
const { UPLOADS_FOLDER, PUBLIC_URL } = require('./src/services/webhookService');

const PORT = process.env.PORT || 8080;
if (!process.env.JAVA_BACKEND_URL || !process.env.BOT_SECRET_KEY) {
    console.error('ERROR: JAVA_BACKEND_URL o BOT_SECRET_KEY no esta configurada. Define las variables de entorno antes de iniciar.');
    process.exit(1);
}

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.set('io', io);

app.use((req, res, next) => {
    if (req.url.startsWith('/api/webhook/whatsapp')) {
        req.url = req.url.replace('/api/webhook/whatsapp', '');
        if (req.url === '') req.url = '/';
    }
    next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use('/uploads', express.static(UPLOADS_FOLDER));

let connectedUsers = [];
io.on('connection', (socket) => {
    socket.on('join_presence', (userData) => {
        connectedUsers = connectedUsers.filter(u => u.username !== userData.username);
        connectedUsers.push({
            id: socket.id,
            username: userData.username || 'Usuario',
            avatar: userData.avatar || '',
            status: 'online',
            connectedAt: Date.now()
        });
        io.emit('update_users', connectedUsers);
    });
    socket.on('disconnect', () => {
        connectedUsers = connectedUsers.filter(u => u.id !== socket.id);
        io.emit('update_users', connectedUsers);
    });
});

app.use('/', apiRoutes);

const KEEPALIVE_URL = PUBLIC_URL + '/health';
setInterval(() => { axios.get(KEEPALIVE_URL).catch(() => {}); }, 600000);

server.listen(PORT, '0.0.0.0', () => {
    logger.info(`✅ BOT SERVER LISTO EN PUERTO ${PORT}`);
    if (RESTORE_SESSIONS_ON_START) {
        restoreExistingSessions(io);
    }
});