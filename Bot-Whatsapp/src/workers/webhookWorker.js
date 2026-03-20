const { Worker } = require('bullmq');
const axios = require('axios');
const pino = require('pino');
const { redisConnection } = require('../config/redis');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const SECRET_KEY = process.env.BOT_SECRET_KEY;

const webhookWorker = new Worker('webhooks_queue', async (job) => {
    const { url, payload } = job.data;
    
    await axios({
        method: 'post',
        url: url,
        data: payload,
        headers: { 'X-Bot-Token': SECRET_KEY },
        timeout: 10000
    });
    
}, { connection: redisConnection, concurrency: 10 }); 

webhookWorker.on('failed', (job, err) => {
    logger.warn({ jobId: job.id, attempts: job.attemptsMade, err: err.message }, '⚠️ Reintentando Webhook Java');
});

module.exports = webhookWorker;
