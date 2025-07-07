const fs = require('fs').promises;
const path = require('path');
const lockfile = require('proper-lockfile');
const { createLogger } = require('./logger');

const filePathCache = new Map();

/**
 * Gets the standardized path for a client's transactions.json file.
 * @param {string} clientId The client's unique identifier.
 * @returns {string} The full path to the transactions file.
 */
function getTransactionFilePath(clientId) {
    if (filePathCache.has(clientId)) {
        return filePathCache.get(clientId);
    }
    const dataDir = path.join(__dirname, '..', '..', 'Data', clientId);
    const filePath = path.join(dataDir, 'transactions.json');
    filePathCache.set(clientId, filePath);
    return filePath;
}

/**
 * Ensures a file exists before locking. If it doesn't, it creates an empty file.
 * @param {string} filePath The full path to the file.
 */
async function ensureFileExists(filePath) {
    try {
        await fs.access(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist, create its directory and an empty JSON array file.
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, '[]', 'utf-8'); // Create with an empty array
        } else {
            throw error; // Re-throw other errors
        }
    }
}

/**
 * Safely reads all transactions from a client's JSON file.
 * @param {string} clientId The client's unique identifier.
 * @returns {Promise<Array<object>>} An array of transaction objects.
 */
async function getTransactions(clientId) {
    const logger = createLogger(clientId);
    const filePath = getTransactionFilePath(clientId);

    try {
        await ensureFileExists(filePath); // <-- FIX: Make sure file exists first
        const release = await lockfile.lock(filePath, { retries: 5 });
        try {
            const fileContent = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(fileContent);
        } finally {
            await release();
        }
    } catch (error) {
        logger.error({ err: error }, 'A critical error occurred while reading transactions file.');
        throw error;
    }
}

/**
 * Safely overwrites the transactions file with a new set of transactions.
 * @param {string} clientId The client's unique identifier.
 * @param {Array<object>} transactions The new array of transaction objects to save.
 */
async function saveTransactions(clientId, transactions) {
    const logger = createLogger(clientId);
    const filePath = getTransactionFilePath(clientId);

    try {
        await ensureFileExists(filePath); // <-- FIX: Make sure file exists first
        const release = await lockfile.lock(filePath, { retries: 5 });
        try {
            await fs.writeFile(filePath, JSON.stringify(transactions, null, 2), 'utf-8');
        } finally {
            await release();
        }
    } catch (error) {
        logger.error({ err: error }, 'A critical error occurred while saving transactions file.');
        throw error;
    }
}

/**
 * Safely adds a single new transaction to the end of the transactions file.
 * @param {string} clientId The client's unique identifier.
 * @param {object} newTransaction The new transaction object to add.
 */
async function addTransaction(clientId, newTransaction) {
    const logger = createLogger(clientId);
    const filePath = getTransactionFilePath(clientId);

    try {
        await ensureFileExists(filePath); // <-- FIX: Make sure file exists first
        const release = await lockfile.lock(filePath, { retries: 5 });
        try {
            // Now that we know the file exists, we can safely read it.
            const fileContent = await fs.readFile(filePath, 'utf-8');
            const transactions = JSON.parse(fileContent);
            transactions.push(newTransaction);
            await fs.writeFile(filePath, JSON.stringify(transactions, null, 2), 'utf-8');
            logger.info({ transactionId: newTransaction.transactionId }, 'Successfully added new transaction to store.');
        } finally {
            await release();
        }
    } catch (error) {
        logger.error({ err: error, transactionId: newTransaction.transactionId }, 'Failed to add transaction to store.');
        throw error;
    }
}

module.exports = {
    getTransactions,
    saveTransactions,
    addTransaction,
};