const fetch = require('node-fetch');
const { getApiToken, loginToApi } = require('./apiSync');
const transactionStore = require('./transactionStore');
const { createLogger } = require('./logger');

// We will check the queue frequently for new transactions.
const PROCESS_INTERVAL_MS = 10 * 1000; // 10 seconds
// We will only retry a FAILED transaction after a longer delay.
const RETRY_DELAY_MS = 60 * 1000; // 60 seconds

let isProcessing = false; // A lock to prevent multiple cycles from running at once.

/**
 * Sends a single transaction to the /raw-notifications endpoint.
 * @param {object} transaction The transaction object.
 * @param {string} clientId The client's ID.
 * @returns {Promise<string>} The final status: 'SUCCESS', 'FAILED', or 'BAD_REQUEST'.
 */
async function sendTransaction(transaction, clientId) {
    const logger = createLogger(clientId);
    const apiToken = getApiToken() || await loginToApi();

    if (!apiToken) {
        logger.error({ transactionId: transaction.transactionId }, "API token not available. Deferring transaction.");
        return "FAILED";
    }

    try {
        const fullApiUrl = `${process.env.API_BASE_URL}/raw-notifications`;
        logger.info({ transactionId: transaction.transactionId, url: fullApiUrl }, "Sending transaction to API.");

        const response = await fetch(fullApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiToken}`,
            },
            body: JSON.stringify(transaction.payload),
            timeout: 20000, // 20-second timeout
        });

        if (response.ok) {
            logger.info({ transactionId: transaction.transactionId, status: response.status }, "Transaction SUCCESS.");
            return "SUCCESS";
        }

        const errorText = await response.text();
        if (response.status === 400 || response.status === 422) {
            logger.warn({ transactionId: transaction.transactionId, status: response.status, response: errorText }, "Transaction rejected by API. Marking as BAD_REQUEST.");
            return "BAD_REQUEST";
        }

        logger.error({ transactionId: transaction.transactionId, status: response.status, response: errorText }, "Transaction FAILED due to server error. Will retry later.");
        return "FAILED";

    } catch (error) {
        logger.error({ err: error, transactionId: transaction.transactionId }, "Transaction FAILED due to network/fetch error.");
        return "FAILED";
    }
}

/**
 * The main processing loop that runs periodically.
 * @param {string} clientId The client's ID.
 */
async function runProcessor(clientId) {
    if (isProcessing) {
        return; // Prevent overlap
    }
    isProcessing = true;
    const logger = createLogger(clientId);

    try {
        let transactions = await transactionStore.getTransactions(clientId);
        const now = Date.now();

        // Find all transactions that need to be processed in this cycle.
        const transactionsToProcess = transactions.filter(t => {
            if (t.status === 'UNSENT' || t.status === 'PENDING') return true;
            // Only retry failed transactions after the delay has passed.
            if (t.status === 'FAILED' && (now - new Date(t.timestamp).getTime()) > RETRY_DELAY_MS) return true;
            return false;
        });

        if (transactionsToProcess.length === 0) {
            return; // Nothing to do.
        }

        logger.info({ count: transactionsToProcess.length }, "Found transactions to process.");

        // Mark them all as PENDING before we start.
        transactionsToProcess.forEach(t => {
            if (t.status === 'FAILED') t.retryCount = (t.retryCount || 0) + 1;
            t.status = 'PENDING';
        });
        await transactionStore.saveTransactions(clientId, transactions);

        // Process all selected transactions in parallel.
        const processingPromises = transactionsToProcess.map(async (trx) => {
            const finalStatus = await sendTransaction(trx, clientId);
            const originalTrxInArray = transactions.find(t => t.transactionId === trx.transactionId);
            if (originalTrxInArray) {
                originalTrxInArray.status = finalStatus;
                originalTrxInArray.timestamp = new Date().toISOString(); // Update timestamp on each attempt
            }
        });

        await Promise.all(processingPromises);

        // Save the final results back to the file.
        await transactionStore.saveTransactions(clientId, transactions);
        logger.info("Transaction processing cycle finished.");

    } catch (error) {
        logger.error({ err: error }, "Critical error in transaction processor loop.");
    } finally {
        isProcessing = false;
    }
}

/**
 * Initializes and starts the persistent transaction processing system.
 * @param {string} clientId The client's unique identifier.
 */
function start(clientId) {
    const logger = createLogger(clientId);
    logger.info(`Initializing Transaction Processor. Queue will be checked every ${PROCESS_INTERVAL_MS / 1000} seconds.`);

    // Set up a single, recurring timer that handles all logic.
    setInterval(() => runProcessor(clientId), PROCESS_INTERVAL_MS);
}

module.exports = { start };