const NodeCache = require('node-cache');

const sessions = new Map();
const reconnectState = new Map();

// Caches con TTL preventivo
const qrStore = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const msgRetryCounterCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const processedMsgIds = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const verifiedJids = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const sendTimestamps = new NodeCache({ stdTTL: 5, checkperiod: 5 });

module.exports = {
    sessions,
    qrStore,
    reconnectState,
    msgRetryCounterCache,
    processedMsgIds,
    verifiedJids,
    sendTimestamps
};
