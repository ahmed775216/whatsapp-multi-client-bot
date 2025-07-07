/**
 * @fileoverview A robust, time-aware in-memory cache for WhatsApp group metadata.
 * This helps prevent rate-limiting by avoiding redundant API calls.
 * It also handles concurrent requests for the same group to prevent a "thundering herd" of API calls.
 */

// A simple in-memory cache using a Map.
const groupMetadataCache = new Map();

// Time-To-Live for cache entries in milliseconds.
// Here, we'll cache metadata for 1 hour. Adjust as needed.
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Fetches group metadata, utilizing a cache to avoid redundant API calls.
 * - If valid, non-expired data is in the cache, it's returned immediately.
 * - If another request is already fetching data for the same group, this request will wait for that result.
 * - Otherwise, it fetches fresh data, updates the cache, and returns the new data.
 *
 * @param {string} groupId The ID of the group (e.g., '120363386433706238@g.us').
 * @param {object} waClient The WhatsApp client instance used to fetch data on a cache miss.
 * @param {import('pino').Logger} logger The logger instance for structured logging.
 * @returns {Promise<any>} A promise that resolves to the group metadata.
 * @throws {Error} Throws an error if the API call fails on a cache miss.
 */
async function getCachedGroupMetadata(groupId, waClient, logger) {
  const cachedEntry = groupMetadataCache.get(groupId);
  const now = Date.now();

  // --- CACHE HIT (VALID DATA) ---
  // Check if a valid, non-expired data entry exists.
  if (cachedEntry && cachedEntry.data && (now - cachedEntry.timestamp < CACHE_TTL_MS)) {
    logger.info({ groupId }, `[CACHE HIT] Using cached metadata.`);
    return cachedEntry.data;
  }

  // --- CACHE HIT (PENDING FETCH) ---
  // If the entry is a promise, another request is already fetching it. Await that result.
  if (cachedEntry && cachedEntry.promise) {
    logger.info({ groupId }, `[CACHE AWAIT] Another request is in-flight. Awaiting result.`);
    return await cachedEntry.promise;
  }

  // --- CACHE MISS ---
  // If no valid entry or pending promise, fetch new data.
  logger.info({ groupId }, `[CACHE MISS] Fetching new metadata.`);

  // Create the promise but don't await it yet.
  const fetchPromise = waClient.groupMetadata(groupId);

  // Store an object containing the promise in the cache immediately.
  // This prevents other concurrent requests from making the same API call.
  groupMetadataCache.set(groupId, { promise: fetchPromise });

  try {
    const metadata = await fetchPromise;

    // On success, replace the promise with the actual data and timestamp.
    groupMetadataCache.set(groupId, {
      data: metadata,
      timestamp: now,
    });

    logger.info({ groupId, subject: metadata.subject }, `[CACHE SET] Successfully fetched and cached metadata.`);
    return metadata;
  } catch (error) {
    logger.error({ err: error, groupId }, `Failed to fetch metadata after cache miss.`);
    // On failure, remove the entry so that a subsequent request can retry.
    groupMetadataCache.delete(groupId);
    // Re-throw the error so the calling function knows the operation failed.
    throw error;
  }
}

/**
 * Manually invalidates a specific group's cache entry, forcing a re-fetch on the next request.
 * @param {string} groupId The ID of the group to invalidate.
 * @param {import('pino').Logger} logger The logger instance for structured logging.
 */
function invalidateGroupMetadata(groupId, logger) {
  groupMetadataCache.delete(groupId);
  logger.info({ groupId }, `[CACHE INVALIDATED] Cleared cache for group.`);
}

module.exports = {
  getCachedGroupMetadata,
  invalidateGroupMetadata
};