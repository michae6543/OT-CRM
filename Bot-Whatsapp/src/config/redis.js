const { Redis } = require('ioredis');
const pino = require('pino');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const redisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
};

const redisConnection = new Redis(redisConfig);

redisConnection.on('error', (err) => {
    logger.error({ err: err.message }, '❌ Error de conexión con Redis');
});

redisConnection.on('connect', () => {
    logger.info('✅ Conectado a Redis exitosamente');
});

module.exports = {
    redisConnection,
    redisConfig
};