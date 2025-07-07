const fetch = require('node-fetch');
const { getApiToken, loginToApi } = require('./apiSync');
const transactionStore = require('./transactionStore');
const { createLogger } = require('./logger');
// const { v4: uuidv4 } = require('uuid'); // Added uuid import
let process = require('process');

// How often the processor checks the queue for new transactions.
const PROCESS_INTERVAL_MS = 30000; // 30 seconds
// How long to wait before retrying a failed transaction.
const RETRY_DELAY_MS = 10000; 

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
        return { status: "FAILED", transaction };
    }

    try {
        const fullApiUrl = `${process.env.API_BASE_URL}/raw-notifications`;
        logger.info({ transactionId: transaction.transactionId, url: fullApiUrl, eventKey: transaction.payload?.client_event_key }, "Sending transaction to API.");
        logger.debug({ transactionId: transaction.transactionId, eventKeySent: transaction.payload?.client_event_key, payload: transaction.payload }, "Sending transaction payload to API.");
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
            logger.info({ transactionId: transaction.transactionId, status: response.status, eventKey: transaction.payload?.client_event_key }, "Transaction SUCCESS.");
            return { status: "SUCCESS", transaction };
        }

        const errorText = await response.text();
        const isDuplicateKeyError = (
            (response.status === 500 || response.status === 409) &&
            /violates unique constraint|duplicate key|already exists|Integrity constraint violation|Duplicate entry/i.test(errorText)
        );
        if (isDuplicateKeyError) {
            logger.warn({ transactionId: transaction.transactionId, eventKey: transaction.payload?.client_event_key }, "Duplicate key error detected. Will append -doup in processor.");
            return { status: "DUPLICATE", transaction };
        }

        if (response.status === 400 || response.status === 422) {
            logger.warn({ transactionId: transaction.transactionId, status: response.status, response: errorText, eventKey: transaction.payload?.client_event_key }, "Transaction rejected by API. Marking as BAD_REQUEST.");
            return { status: "BAD_REQUEST", transaction };
        }

        logger.error({ transactionId: transaction.transactionId, status: response.status, response: errorText, eventKey: transaction.payload?.client_event_key }, "Transaction FAILED due to server error. Will retry later.");
        return { status: "FAILED", transaction };

    } catch (error) {
        logger.error({ err: error, transactionId: transaction.transactionId, eventKey: transaction.payload?.client_event_key }, "Transaction FAILED due to network/fetch error.");
        return { status: "FAILED", transaction };
    }
}

// Helper to append or increment -doup suffix
function appendDoupSuffix(str) {
    if (!str) return 'doup';
    const match = str.match(/-doup(\d+)?$/);
    if (match) {
        const num = match[1] ? parseInt(match[1], 10) + 1 : 2;
        return str.replace(/-doup(\d+)?$/, `-doup${num}`);
    }
    return str + '-doup';
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
            logger.debug({ transactionId: trx.transactionId, eventKeyBeforeSend: trx.payload?.client_event_key }, "Processing transaction.");
            let updatedTrx = trx;
            let finalStatus = null;
            let attempts = 0;
            const MAX_DUPLICATE_ATTEMPTS = 5;
            do {
                const result = await sendTransaction(updatedTrx, clientId);
                finalStatus = result.status;
                updatedTrx = result.transaction;
                if (finalStatus === "DUPLICATE") {
                    // Append or increment -doup suffix for both id and client_event_key
                    if (updatedTrx.payload) {
                        updatedTrx.payload.id = appendDoupSuffix(updatedTrx.payload.id);
                        updatedTrx.payload.client_event_key = appendDoupSuffix(updatedTrx.payload.client_event_key);
                    }
                    updatedTrx.transactionId = updatedTrx.payload.id;
                    attempts++;
                }
            } while (finalStatus === "DUPLICATE" && attempts < MAX_DUPLICATE_ATTEMPTS);
            logger.debug({ transactionId: updatedTrx.transactionId, eventKeyAfterSend: updatedTrx.payload?.client_event_key, finalStatus }, "Transaction processed by sendTransaction.");

            // Always remove the old transaction and add the updated one (handles id changes)
            const oldIndex = transactions.findIndex(t => t.transactionId === trx.transactionId);
            if (oldIndex !== -1) {
                transactions.splice(oldIndex, 1);
            }
            transactions.push({ ...updatedTrx, status: finalStatus, timestamp: new Date().toISOString() });
            logger.debug({ transactionId: updatedTrx.transactionId, eventKeyAfterUpdate: updatedTrx.payload?.client_event_key }, "Transaction updated in array (handles id changes).");
        });

        await Promise.all(processingPromises);

        // Save the final results back to the file.
        logger.debug({ transactionsToSave: transactions.map(t => ({ id: t.transactionId, eventKey: t.payload?.client_event_key, status: t.status })) }, "Saving transactions to file.");
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