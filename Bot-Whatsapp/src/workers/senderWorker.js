const { Worker } = require('bullmq');
const pino = require('pino');
const { redisConnection } = require('../config/redis');
const { sessions, verifiedJids, sendTimestamps } = require('../services/sessionStore');
const { formatToJid, getFileNameFromUrl, getMimeFromFilename } = require('../utils/helpers');
const axios = require('axios');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const waitForRateLimit = async (numero) => {
    const lastSend = sendTimestamps.get(numero) || 0;
    const elapsed = Date.now() - lastSend;
    const MIN_INTERVAL = 1000;

    if (elapsed < MIN_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
    }
    sendTimestamps.set(numero, Date.now());
};

const senderWorker = new Worker('outgoing_messages_queue', async (job) => {
    const { sessionId, number, message, mediaConfig } = job.data;
    const sock = sessions.get(sessionId);

    if (!sock) {
        throw new Error('Sesión no activa o desconectada');
    }

    const jid = formatToJid(number);
    let finalJid;
    const cachedJid = verifiedJids.get(number);

    if (cachedJid) {
        finalJid = cachedJid;
    } else {
        const [result] = await sock.onWhatsApp(jid);
        if (!result?.exists) {
            throw new Error(`Número no encontrado en WhatsApp: ${jid}`);
        }
        finalJid = result.jid;
        verifiedJids.set(number, finalJid);
    }

    let payload = {};

    if (!mediaConfig) {
        payload = { text: message };
    } else {
        const { url, type, filename, base64, mimetype } = mediaConfig;
        
        let buffer, contentType;
        if (base64) {
            buffer = Buffer.from(base64, 'base64');
            contentType = mimetype || 'application/octet-stream';
        } else {
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            buffer = Buffer.from(response.data, 'binary');
            contentType = response.headers['content-type'] || '';
        }

        if (type === 'IMAGEN') {
            const imgMime = contentType.split(';')[0].trim() || 'image/jpeg';
            payload = { image: buffer, mimetype: imgMime, caption: message || '' };
        } else if (type === 'VIDEO') {
            const vidMime = contentType.split(';')[0].trim() || 'video/mp4';
            payload = { video: buffer, mimetype: vidMime, caption: message || '' };
        } else if (type === 'AUDIO') {
            const isOgg = contentType.includes('ogg') || (url && url.endsWith('.ogg'));
            if (isOgg) {
                payload = { audio: buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true };
            } else {
                const audMime = contentType.split(';')[0].trim() || 'audio/mpeg';
                payload = { audio: buffer, mimetype: audMime, ptt: false };
            }
        } else {
            const rawMime = contentType.split(';')[0].trim();
            const fileName = filename || getFileNameFromUrl(url, rawMime);
            const docMime = (rawMime === 'application/octet-stream' || !rawMime)
                ? (getMimeFromFilename(fileName) || rawMime || 'application/octet-stream')
                : rawMime;
            payload = { document: buffer, mimetype: docMime, fileName: fileName, caption: message || '' };
        }
    }

    await waitForRateLimit(number);
    logger.info({ sessionId, finalJid, esMedia: !!mediaConfig }, '📤 Enviando mensaje a WhatsApp desde Worker');
    const sent = await sock.sendMessage(finalJid, payload);
    return sent.key.id;

}, { connection: redisConnection, concurrency: 5 });

senderWorker.on('failed', (job, err) => {
    logger.error({ jobId: job.id, session: job.data.sessionId, num: job.data.number, err: err.message }, '❌ Error enviando mensaje (SenderWorker)');
});

module.exports = senderWorker;
