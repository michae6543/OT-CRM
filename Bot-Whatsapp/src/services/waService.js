const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');

const { updateJavaStatus, sendStatusUpdateToJava } = require('./webhookService');
// Importar la nueva cola de entrada
const { incomingQueue } = require('../queues/incomingQueue');
const { sessions, qrStore, reconnectState, msgRetryCounterCache, processedMsgIds } = require('./sessionStore');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const SESSION_FOLDER_NAME = process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'auth_info_v2')
    : path.join(__dirname, '../../auth_info_v2');

if (!fs.existsSync(SESSION_FOLDER_NAME)) fs.mkdirSync(SESSION_FOLDER_NAME, { recursive: true });

const MAX_RETRIES = 5;
const BACKOFF_DELAYS = [5000, 10000, 20000, 40000, 60000]; 

const getReconnectState = (sessionId) => {
    if (!reconnectState.has(sessionId)) {
        reconnectState.set(sessionId, { retries: 0, timer: null, healthTimer: null });
    }
    return reconnectState.get(sessionId);
};

const resetReconnectState = (sessionId) => {
    const state = reconnectState.get(sessionId);
    if (state) {
        if (state.timer) clearTimeout(state.timer);
        state.retries = 0;
        state.timer = null;
    }
};

const scheduleReconnect = (sessionId, io) => {
    const state = getReconnectState(sessionId);

    if (state.retries >= MAX_RETRIES) {
        logger.error({ sessionId, retries: state.retries }, '🚨 INTERVENCIÓN MANUAL REQUERIDA');
        updateJavaStatus(sessionId, 'ERROR');
        if(io) io.emit('bot_status', { sessionId, status: 'ERROR', message: 'Requiere intervención manual' });
        return;
    }

    const delayMs = BACKOFF_DELAYS[state.retries] || BACKOFF_DELAYS[BACKOFF_DELAYS.length - 1];
    state.retries++;

    logger.info({ sessionId, attempt: state.retries, maxRetries: MAX_RETRIES, delayMs }, `🔄 Reconexión programada`);

    state.timer = setTimeout(() => {
        logger.info({ sessionId, attempt: state.retries }, '🔄 Ejecutando reconexión...');
        sessions.delete(sessionId);
        startSession(sessionId, null, io);
    }, delayMs);
};

const startHealthCheck = (sessionId, io) => {
    const state = getReconnectState(sessionId);
    if (state.healthTimer) clearInterval(state.healthTimer);

    state.healthTimer = setInterval(async () => {
        const sock = sessions.get(sessionId);
        if (!sock || !sock.user) {
            clearInterval(state.healthTimer);
            state.healthTimer = null;
            scheduleReconnect(sessionId, io);
            return;
        }
        try {
            await sock.sendPresenceUpdate('available');
        } catch (err) {
            clearInterval(state.healthTimer);
            state.healthTimer = null;
            scheduleReconnect(sessionId, io);
        }
    }, 120000);
};

const stopHealthCheck = (sessionId) => {
    const state = reconnectState.get(sessionId);
    if (state?.healthTimer) {
        clearInterval(state.healthTimer);
        state.healthTimer = null;
    }
};

const safeRemoveSession = (sessionId) => {
    const authPath = path.join(SESSION_FOLDER_NAME, sessionId);
    try {
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
            logger.info({ sessionId }, '🗑️ Sesión eliminada del disco');
        }
    } catch (err) { logger.error({ err }, 'Error limpiando archivos'); }
};

const startSession = async (sessionId, phoneNumber = null, io = null) => {
    try {
        if (phoneNumber && sessions.has(sessionId)) {
            const oldSock = sessions.get(sessionId);
            oldSock.end(undefined);
            sessions.delete(sessionId);
            qrStore.del(sessionId);
            await new Promise(r => setTimeout(r, 1000));
        }

        const authPath = path.join(SESSION_FOLDER_NAME, sessionId);
        if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'error' }),
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            msgRetryCounterCache,
            mobile: false
        });

        sessions.set(sessionId, sock);
        qrStore.set(sessionId, "WAITING");

        if (phoneNumber && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    qrStore.set(sessionId, code);
                } catch (e) {
                    qrStore.set(sessionId, "ERROR");
                }
            }, 6000);
        }

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    const url = await qrcode.toDataURL(qr);
                    qrStore.set(sessionId, url);
                } catch (e) {}
            }

            if (connection === 'open') {
                logger.info({ sessionId }, '🚀 CONEXIÓN EXITOSA');
                qrStore.del(sessionId);
                resetReconnectState(sessionId);
                startHealthCheck(sessionId, io);
                const userPhone = sock.user ? sock.user.id.split(':')[0] : undefined;
                await updateJavaStatus(sessionId, 'CONNECTED', userPhone);
                if(io) io.emit('bot_status', { sessionId, status: 'CONNECTED' });
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                stopHealthCheck(sessionId);

                if (!shouldReconnect) {
                    sessions.delete(sessionId);
                    qrStore.del(sessionId);
                    safeRemoveSession(sessionId);
                    reconnectState.delete(sessionId);
                    await updateJavaStatus(sessionId, 'DISCONNECTED');
                    if(io) io.emit('bot_status', { sessionId, status: 'DISCONNECTED' });
                } else {
                    sessions.delete(sessionId);
                    await updateJavaStatus(sessionId, 'RECONNECTING');
                    if(io) io.emit('bot_status', { sessionId, status: 'RECONNECTING' });
                    scheduleReconnect(sessionId, io);
                }
            }
        });

        // FASE 4: AHORA ENCOLAMOS A BULLMQ EN LUGAR DE PROCESAR SINCRONAMENTE
        sock.ev.on('messages.upsert', async (m) => {
            for (const msg of m.messages) {
                if (msg.key.fromMe || !msg.message) continue;

                const msgId = msg.key.id;
                if (processedMsgIds.get(msgId)) continue;
                processedMsgIds.set(msgId, true);

                await incomingQueue.add('new_message', { msg, sessionId }, { removeOnComplete: true, attempts: 3 });
            }
        });

        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                if (!update.key.fromMe) continue;

                if (update.update.status) {
                    const statusMap = { 3: 'DELIVERED', 4: 'READ', 5: 'READ' };
                    const newStatus = statusMap[update.update.status];

                    if (newStatus) {
                        await sendStatusUpdateToJava(sessionId, {
                            whatsappId: update.key.id,
                            remoteJid: update.key.remoteJid,
                            status: newStatus
                        });
                    }
                }
            }
        });

    } catch (err) {
        logger.error({ err }, "🔥 Error fatal iniciando sesión");
        qrStore.set(sessionId, "ERROR");
    }
};

const restoreExistingSessions = (io = null) => {
    try {
        if (!fs.existsSync(SESSION_FOLDER_NAME)) return;

        const entries = fs.readdirSync(SESSION_FOLDER_NAME, { withFileTypes: true });
        const sessionIds = entries.filter(e => e.isDirectory()).map(e => e.name);

        if (sessionIds.length === 0) return;

        sessionIds.forEach((sessionId, index) => {
            setTimeout(() => {
                logger.info({ sessionId }, `♻️ Restaurando sesión [${index + 1}/${sessionIds.length}]`);
                startSession(sessionId, null, io);
            }, index * 2000);
        });
    } catch (err) { }
};

module.exports = {
    startSession,
    safeRemoveSession,
    restoreExistingSessions,
    SESSION_FOLDER_NAME
};
