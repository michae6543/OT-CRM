const { jidDecode } = require('@whiskeysockets/baileys');
const path = require('path');
const axios = require('axios');
const pino = require('pino');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const axiosWithRetry = async (config, retries = 3, baseDelay = 1000) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await axios(config);
        } catch (err) {
            const isLastAttempt = attempt === retries;
            const isTimeout = err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED';
            const isServerError = err.response?.status >= 500;
            if (isLastAttempt || (!isTimeout && !isServerError)) throw err;
            const delayMs = baseDelay * Math.pow(2, attempt - 1);
            logger.warn({ url: config.url, attempt, retryIn: delayMs }, `⚠️ Reintento en ${delayMs}ms`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
};


const formatToJid = (number) => {
    if (!number) return null;
    let clean = number.toString().replace(/\D/g, '');
    return `${clean}@s.whatsapp.net`;
};

const getRealNumber = (jid) => {
    if (!jid) return '';
    const decoded = jidDecode(jid);
    const user = decoded ? decoded.user : jid.split('@')[0];
    const baseNumber = user.split(':')[0];

    const digits = baseNumber.replace(/\D/g, '');
    if (digits.startsWith('54')) {
        let resto = digits.substring(2);
        while (resto.startsWith('0')) resto = resto.substring(1);
        if (resto.startsWith('9') && resto.length === 11) resto = resto.substring(1);
        if (resto.length === 10) return '549' + resto;
    }
    return digits || baseNumber;
};

const getExtension = (mimetype) => {
    if (!mimetype) return 'bin';
    const mt = mimetype.toLowerCase();
    if (mt.includes('image/jpeg')) return 'jpg';
    if (mt.includes('image/png')) return 'png';
    if (mt.includes('image/webp')) return 'webp';
    if (mt.includes('image/gif')) return 'gif';
    if (mt.includes('video/mp4')) return 'mp4';
    if (mt.includes('video/webm')) return 'webm';
    if (mt.includes('video/3gpp')) return '3gp';
    if (mt.includes('audio/ogg')) return 'ogg';
    if (mt.includes('audio/webm')) return 'webm';
    if (mt.includes('audio/mpeg') || mt.includes('audio/mp3')) return 'mp3';
    if (mt.includes('audio/mp4') || mt.includes('audio/m4a')) return 'm4a';
    if (mt.includes('audio')) return 'ogg'; 
    if (mt.includes('pdf')) return 'pdf';
    if (mt.includes('word') || mt.includes('docx')) return 'docx';
    if (mt.includes('excel') || mt.includes('xlsx') || mt.includes('spreadsheet')) return 'xlsx';
    if (mt.includes('zip')) return 'zip';
    return 'bin';
};

const getMimeFromFilename = (filename) => {
    if (!filename) return null;
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
        'pdf':  'application/pdf',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xls':  'application/vnd.ms-excel',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'doc':  'application/msword',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'ppt':  'application/vnd.ms-powerpoint',
        'txt':  'text/plain',
        'csv':  'text/csv',
        'zip':  'application/zip',
        'mp3':  'audio/mpeg',
        'mp4':  'video/mp4',
        'jpg':  'image/jpeg',
        'jpeg': 'image/jpeg',
        'png':  'image/png',
        'gif':  'image/gif',
        'webp': 'image/webp',
    };
    return map[ext] || null;
};

const getFileNameFromUrl = (url, mimetype) => {
    try {
        if (!url) return `archivo.${getExtension(mimetype)}`;
        const urlPath = new URL(url).pathname;
        const decoded = decodeURIComponent(path.basename(urlPath));
        if (decoded && decoded.includes('.')) return decoded;
    } catch (_) {}
    const ext = getExtension(mimetype);
    return `archivo.${ext}`;
};

module.exports = {
    axiosWithRetry,
    formatToJid,
    getRealNumber,
    getExtension,
    getMimeFromFilename,
    getFileNameFromUrl
};
