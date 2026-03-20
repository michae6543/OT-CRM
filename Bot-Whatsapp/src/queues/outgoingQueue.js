const { Queue } = require('bullmq');
const { redisConnection } = require('../config/redis');

const outgoingQueue = new Queue('outgoing_messages_queue', { connection: redisConnection });

module.exports = { outgoingQueue };
