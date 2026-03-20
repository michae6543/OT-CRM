const { Worker } = require('bullmq');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const path = require('path');
const { writeFile } = require('fs/promises');
const pino = require('pino');

const { redisConnection } = require('../config/redis');
const { sessions } = require('../services/sessionStore');
const { getRealNumber, getExtension, axiosWithRetry } = require('../utils/helpers');
const { UPLOADS_FOLDER, PUBLIC_URL } = require('../services/webhookService');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const JAVA_BACKEND_URL = process.env.JAVA_BACKEND_URL;
const SECRET_KEY = process.env.BOT_SECRET_KEY;

const restoreBuffers = (obj) => {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) return Buffer.from(obj.data);
    for (const key in obj) {
        obj[key] = restoreBuffers(obj[key]);
    }
    return obj;
};

const mediaWorker = new Worker('incoming_messages_queue', async (job) => {
    const { msg: rawMsg, sessionId } = job.data;
    const msg = restoreBuffers(rawMsg);
    const sock = sessions.get(sessionId);

    const remoteJid = msg.key.remoteJid;
    let numeroRaw = (remoteJid.includes('@lid')) ? msg.key.senderPn : (msg.key.senderPn || msg.key.participant || msg.key.remoteJid);
    const numeroReal = getRealNumber(numeroRaw);
    if (!numeroReal) return;

    const messageType = Object.keys(msg.message)[0];
    let texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || msg.message?.documentMessage?.caption || msg.message?.viewOnceMessage?.message?.imageMessage?.caption || msg.message?.viewOnceMessage?.message?.videoMessage?.caption || "";

    const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'viewOnceMessage'].includes(messageType);
    if (!texto && !isMedia) return;

    let mediaUrl = null;
    let mimeType = null;

    if (isMedia && sock) {
        try {
            logger.info({ messageType }, '🔽 Descargando media asincrónicamente en Worker');
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            if (buffer) {
                const mediaObject = messageType === 'viewOnceMessage' ? (msg.message.viewOnceMessage?.message?.imageMessage || msg.message.viewOnceMessage?.message?.videoMessage) : msg.message[messageType];
                mimeType = mediaObject?.mimetype || 'application/octet-stream';
                const ext = getExtension(mimeType);
                const fileName = `${sessionId}_${Date.now()}.${ext}`;
                const filePath = path.join(UPLOADS_FOLDER, fileName);
                
                await writeFile(filePath, buffer);
                mediaUrl = `${PUBLIC_URL}/uploads/${fileName}`;
                
                if (!texto) texto = `[${messageType.replace('Message', '')}]`;
            }
        } catch (err) {
            logger.error({ err: err.message }, '❌ Error descargando media en el worker');
        }
    }

    let profilePicUrl = "";
    try { if(sock) profilePicUrl = await sock.profilePictureUrl(remoteJid, 'image'); } catch (e) {}

    const payload = {
        sessionId,
        from: numeroReal,
        body: texto,
        name: msg.pushName || "Usuario",
        origen: "WHATSAPP",
        profilePicUrl: profilePicUrl,
        mediaUrl: mediaUrl,
        mimeType: mimeType
    };

    let baseUrl = JAVA_BACKEND_URL.replace(/\/$/, '');
    if (!baseUrl.includes('/api/webhook/whatsapp')) baseUrl += '/api/webhook/whatsapp';

    logger.info({ from: numeroReal, body: texto }, "📨 Worker enviando a Java CRM");

    await axiosWithRetry({
        method: 'post',
        url: `${baseUrl}/robot`,
        data: payload,
        headers: { 'X-Bot-Token': SECRET_KEY },
        timeout: 15000
    });
}, { connection: redisConnection, concurrency: 5 });

mediaWorker.on('failed', (job, err) => {
    logger.error({ jobId: job.id, err: err.message }, '❌ Error crítico en el mediaWorker');
});

module.exports = mediaWorker;
