const { Queue } = require('bullmq');
const { redisConnection } = require('../config/redis');

const incomingQueue = new Queue('incoming_messages_queue', { connection: redisConnection });

module.exports = { incomingQueue };
