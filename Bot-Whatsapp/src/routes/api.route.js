const express = require('express');
const pino = require('pino');

const { sessions, qrStore, reconnectState } = require('../services/sessionStore');
const { startSession } = require('../services/waService');
const { formatToJid } = require('../utils/helpers');
const { outgoingQueue } = require('../queues/outgoingQueue');
const { updateJavaStatus } = require('../services/webhookService');

const router = express.Router();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

router.get('/health', (req, res) => {
    const sessionList = Array.from(sessions.entries()).map(([id, sock]) => ({
        sessionId: id,
        connected: !!sock?.user,
        reconnectRetries: reconnectState.get(id)?.retries || 0
    }));
    res.json({ status: 'OK', uptime: process.uptime(), sessions: sessionList.length, details: sessionList });
});

router.get('/sessions', (req, res) => {
    const list = Array.from(sessions.entries()).map(([id, sock]) => ({
        sessionId: id,
        connected: !!sock?.user,
        phone: sock?.user?.id?.split(':')[0] || null
    }));
    res.json({ sessions: list, count: list.length });
});

router.post('/session/reset', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).send("Falta sessionId");

    const sock = sessions.get(sessionId);
    if (sock) {
        try { await sock.logout(); } catch (e) { }
        try { sock.end(undefined); } catch (e) { }
        sessions.delete(sessionId);
    }
    const { safeRemoveSession } = require('../services/waService');
    safeRemoveSession(sessionId);
    qrStore.del(sessionId);
    await updateJavaStatus(sessionId, 'DISCONNECTED');
    res.json({ status: "RESET_COMPLETE" });
});

router.get('/session/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sock = sessions.get(sessionId);
    if (sock?.user) return res.json({ status: 'CONNECTED', phone: sock.user.id.split(':')[0] });

    if (qrStore.has(sessionId)) {
        const data = qrStore.get(sessionId);
        if (data === 'WAITING') return res.json({ status: 'WAITING' });
        if (data === 'ERROR') return res.json({ status: 'DISCONNECTED' });
        const isQr = data.startsWith && data.startsWith('data:');
        return res.json({ status: isQr ? 'SCAN_QR' : 'PAIRING_CODE' });
    }
    res.json({ status: 'DISCONNECTED' });
});

router.post('/session/start', (req, res) => {
    const { sessionId } = req.body;
    reconnectState.delete(sessionId);
    startSession(sessionId, null, req.app.get('io'));
    res.json({ status: 'STARTING' });
});

router.get('/qr/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const qr = qrStore.get(sessionId);
    if (sessions.get(sessionId)?.user) return res.json({ status: 'CONNECTED' });
    if (qr && qr.startsWith && qr.startsWith('data:')) return res.json({ status: 'SCAN_QR', qr });
    res.json({ status: 'WAITING' });
});

router.post('/session/pair-code', async (req, res) => {
    const { sessionId, phoneNumber } = req.body;
    if (!sessionId || !phoneNumber) return res.status(400).json({ error: 'Faltan datos' });
    const cleanNumber = phoneNumber.toString().replace(/\D/g, '');
    await startSession(sessionId, cleanNumber, req.app.get('io'));
    
    let attempts = 0;
    const checkCode = setInterval(() => {
        const code = qrStore.get(sessionId);
        attempts++;
        if (code && typeof code === 'string' && !code.startsWith('data:') && code !== 'WAITING' && code !== 'ERROR') {
            clearInterval(checkCode);
            return res.json({ status: 'PAIRING', code: code });
        }
        if (attempts >= 40) {
            clearInterval(checkCode);
            return res.status(504).json({ error: 'Timeout' });
        }
    }, 500);
});

router.post('/chat/read', async (req, res) => {
    const { sessionId, number, messageIds } = req.body;
    const sock = sessions.get(sessionId);
    if (!sock) return res.status(404).json({ error: 'Sesión no activa' });

    try {
        const jid = formatToJid(number);
        if (messageIds && Array.isArray(messageIds) && messageIds.length > 0) {
            const keys = messageIds.map(id => ({ remoteJid: jid, id, fromMe: false }));
            await sock.readMessages(keys);
        }
        res.json({ status: 'READ_EMITTED' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/send-message', async (req, res) => {
    const { sessionId, number, message } = req.body;
    const sock = sessions.get(sessionId);
    if (!sock) return res.status(404).json({ error: 'Sesión no activa' });

    try {
        await outgoingQueue.add('send_text', { sessionId, number, message }, { removeOnComplete: true });
        res.status(202).json({ status: 'QUEUED', message: 'Mensaje encolado para envío' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/send-media', async (req, res) => {
    const { sessionId, number, message, url, type, filename, base64, mimetype } = req.body;
    const sock = sessions.get(sessionId);
    if (!sock) return res.status(404).json({ error: 'Sesión no activa' });

    try {
        if(!base64 && !url) return res.status(400).json({ error: 'url o base64 es requerido' });

        await outgoingQueue.add('send_media', { 
            sessionId, 
            number, 
            message,
            mediaConfig: { url, type, filename, base64, mimetype }
        }, { removeOnComplete: true });
        res.status(202).json({ status: 'QUEUED', message: 'Multimedia encolada para envío' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
