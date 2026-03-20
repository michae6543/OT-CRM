const { Queue } = require('bullmq');
const { redisConnection } = require('../config/redis');

const webhooksQueue = new Queue('webhooks_queue', { 
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 100
    }
});

module.exports = { webhooksQueue };
