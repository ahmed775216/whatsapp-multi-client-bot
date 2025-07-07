const fs = require('fs').promises;
const path = require('path');
const lockfile = require('proper-lockfile');
const { createLogger } = require('./logger');

const filePathCache = new Map();

function getTransactionFilePath(clientId) {
    if (filePathCache.has(clientId)) {
        return filePathCache.get(clientId);
    }
    // eslint-disable-next-line no-undef
    const dataDir = path.join(__dirname, '..', '..', 'Data', clientId);
    const filePath = path.join(dataDir, 'transactions.json');
    filePathCache.set(clientId, filePath);
    return filePath;
}

/**
 * Ensures the directory for the transaction file exists.
 * @param {string} filePath The full path to the transactions file.
 */
async function ensureDirectoryExists(filePath) {
    const dirPath = path.dirname(filePath);
    await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Safely appends a single transaction to the file.
 * @param {string} clientId
 * @param {object} newTransaction
 */
async function addTransaction(clientId, newTransaction) {
    const logger = createLogger(clientId);
    const filePath = getTransactionFilePath(clientId);
    const transactionString = JSON.stringify(newTransaction) + '\n'; // Add newline

    try {
        await ensureDirectoryExists(filePath);
        // Use fs.appendFile, which is an atomic operation for this purpose.
        // It's much safer than read-modify-write.
        await fs.appendFile(filePath, transactionString, 'utf-8');
        logger.info({ transactionId: newTransaction.transactionId }, 'Successfully appended new transaction to log.');
    } catch (error) {
        logger.error({ err: error, transactionId: newTransaction.transactionId }, 'Failed to append transaction to log.');
    }
}

/**
 * Reads all transactions from the NDJSON file.
 * @param {string} clientId
 * @returns {Promise<Array<object>>}
 */
async function getTransactions(clientId) {
    const logger = createLogger(clientId);
    const filePath = getTransactionFilePath(clientId);
    try {
        await fs.access(filePath); // Check if file exists
        const fileContent = await fs.readFile(filePath, 'utf-8');
        if (!fileContent.trim()) return []; // Handle empty file

        const transactions = [];
        const lines = fileContent.trim().split('\n');

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue; // Skip empty or whitespace-only lines
            try {
                transactions.push(JSON.parse(trimmedLine));
            } catch (parseError) {
                // If a single line is corrupt, log it and skip it instead of crashing.
                logger.warn({ err: parseError, line }, 'Skipping malformed line in transaction file.');
            }
        }
        return transactions;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return []; // File doesn't exist, which is fine.
        }
        logger.error({ err: error }, 'Failed to read transactions file.');
        throw error; // Re-throw other errors
    }
}

/**
 * Overwrites the transaction file with a new set of transactions (for compaction).
 * This function acquires a lock to prevent conflicts with addTransaction.
 * @param {string} clientId
 * @param {Array<object>} transactions
 */
async function saveTransactions(clientId, transactions) {
    const logger = createLogger(clientId);
    const filePath = getTransactionFilePath(clientId);
    
    // Convert the array back to newline-delimited JSON string
    const newContent = transactions.map(t => JSON.stringify(t)).join('\n') + (transactions.length > 0 ? '\n' : '');

    // logger.debug({ action: "Saving transactions", count: transactions.length, transactions: transactions.map(t => ({ id: t.transactionId, eventKey: t.payload?.client_event_key, status: t.status })) }, "Attempting to save transactions.");

    try {
        await ensureDirectoryExists(filePath);
        const release = await lockfile.lock(filePath, { retries: 5 });
        try {
            await fs.writeFile(filePath, newContent, 'utf-8');
        } finally {
            await release();
        }
    } catch (error) {
        logger.error({ err: error }, 'Failed to save/compact transactions file.');
    }
}

module.exports = {
    addTransaction,
    getTransactions,
    saveTransactions,
};