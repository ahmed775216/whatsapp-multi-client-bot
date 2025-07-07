const pino = require('pino');
const path = require('path');
const fs = require('fs');

// A cache to hold logger instances so we don't re-create them for the same client.
const loggerCache = new Map();

/**
 * Creates and returns a Pino logger instance for a specific client ID.
 * Logs are written to /Logs/{clientId}/processing.log.
 *
 * @param {string} clientId The unique identifier for the client instance.
 * @returns {pino.Logger} The configured Pino logger instance.
 */
function createLogger(clientId) {
    // If a logger for this client already exists in our cache, return it immediately.
    if (loggerCache.has(clientId)) {
        return loggerCache.get(clientId);
    }

    // Define the base directory for all logs, relative to the project root.
    // eslint-disable-next-line no-undef
    const logsBaseDir = path.join(__dirname, '..', '..', 'Logs');
    const clientLogDir = path.join(logsBaseDir, clientId);
    const logFilePath = path.join(clientLogDir, 'processing.log');

    // Ensure the specific client's log directory exists.
    try {
        if (!fs.existsSync(clientLogDir)) {
            fs.mkdirSync(clientLogDir, { recursive: true });
        }
    } catch (error) {
        // Fallback to console if we can't create the log directory.
        console.error(`[LOGGER_FATAL] Could not create log directory for ${clientId} at ${clientLogDir}. Falling back to console logging. Error: ${error.message}`);
        // eslint-disable-next-line no-undef
        return pino({ level: process.env.LOG_LEVEL || 'info' });
    }

    // Pino transport configuration to write to a file and also to the console.
    // This allows logs to be saved permanently while also being visible in PM2.
    const transport = pino.transport({
        targets: [
            {
                level: 'info',
                target: 'pino/file', // Use pino's built-in file transport
                options: {
                    destination: logFilePath, 
                    mkdir: true,
                    colorize: true,
                    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
                    ignore: 'pid,hostname',


                },
            },
            {
                level: 'info',
                target: 'pino-pretty', // For colorful console output in PM2
                options: {
                    colorize: true,
                    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
                    ignore: 'pid,hostname',
                },
            }
        ]
    });

    const logger = pino({
        // eslint-disable-next-line no-undef
        level: process.env.LOG_LEVEL || 'info',
    }, transport);

    // Add the new logger to the cache for future requests.
    loggerCache.set(clientId, logger);

    logger.info(`Logger initialized for client '${clientId}'. Logging to: ${logFilePath}`);

    return logger;
}

module.exports = { createLogger };