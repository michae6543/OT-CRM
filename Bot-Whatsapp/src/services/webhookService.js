const path = require('path');
const pino = require('pino');
const { webhooksQueue } = require('../queues/webhooksQueue');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const PORT = process.env.PORT || 3000;
const JAVA_BACKEND_URL = process.env.JAVA_BACKEND_URL;

const PUBLIC_URL = process.env.RAILWAY_STATIC_URL
    ? `https://${process.env.RAILWAY_STATIC_URL}`
    : `http://localhost:${PORT}`;

const UPLOADS_FOLDER = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'public', 'uploads')
    : path.join(__dirname, '../../public', 'uploads');

const updateJavaStatus = async (sessionId, status, phoneUser = null) => {
    const cleanPhone = phoneUser ? phoneUser.split(':')[0] : null;
    const payload = { sessionId, status, phone: cleanPhone, qr: null };

    let baseUrl = JAVA_BACKEND_URL.replace(/\/$/, '');
    if (!baseUrl.includes('/api/webhook/whatsapp')) baseUrl += '/api/webhook/whatsapp';

    await webhooksQueue.add('java_status', {
        url: `${baseUrl}/status`,
        payload
    });
};

const sendStatusUpdateToJava = async (sessionId, statusData) => {
    let baseUrl = JAVA_BACKEND_URL.replace(/\/$/, '');
    if (!baseUrl.includes('/api/webhook/whatsapp')) baseUrl += '/api/webhook/whatsapp';

    await webhooksQueue.add('message_status', {
        url: `${baseUrl}/message-status`,
        payload: { sessionId, ...statusData }
    });
};

module.exports = {
    updateJavaStatus,
    sendStatusUpdateToJava,
    UPLOADS_FOLDER,
    PUBLIC_URL
};
