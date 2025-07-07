let db; // Will be initialized asynchronously
let dbReadyPromiseResolve; // Function to resolve the promise
const dbReadyPromise = new Promise(resolve => {
    dbReadyPromiseResolve = resolve;
});

(async () => {
    const { Low } = await import('lowdb');
    const { JSONFile } = await import('lowdb/node');
    db = new Low(new JSONFile(path.join(CACHE_DIR, 'db.json')), {});
    await initializeCache();
    dbReadyPromiseResolve(); // Resolve the promise once db is ready
})();
const path = require('path');
const fs = require('fs');
const pgDb = require('./db');

const syncQueue = [];
const CACHE_DIR = path.join(__dirname, '../Data', 'database_cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}



async function initializeCache() {
    await db.read();
    db.data = db.data || { tables: {} };
    await db.write();
}

async function query(text, params) {
    await dbReadyPromise; // Ensure db is initialized
    await initializeCache();

    const isWriteOperation = /^(INSERT|UPDATE|DELETE)/i.test(text);

    if (isWriteOperation) {
        syncQueue.push({ text, params });
        // For now, we'll just log the query. In a real implementation,
        // we would add this to a persistent queue and process it.
        console.log('Query added to sync queue:', { text, params });
        return { rowCount: 1 }; // Mock row count
    } else {
        // For SELECT queries, we would ideally parse the query and read from the JSON cache.
        // This is a complex task, so for now, we'll just pass it through to the database.
        // A more robust solution would be to have a more structured cache.
        try {
            return await pgDb.query(text, params);
        } catch (error) {
            console.error('Error executing SELECT query:', error);
            throw error;
        }
    }
}

// We would need a background worker to process the syncQueue
// This is a simplified example and does not include the worker.

module.exports = {
    query
};