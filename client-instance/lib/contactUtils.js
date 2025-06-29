// client-instance/lib/contactUtils.js

/**
 * Finds the most reliable display name for a contact from various sources.
 * The hierarchy is designed to find the most specific name first.
 *
 * @param {object} [options] - The sources to search for a name.
 * @param {object|null} [options.baileysContact] - The full contact object from sock.contacts.
 * @param {object|null} [options.baileysMessage] - The message object from the 'messages.upsert' event.
 * @returns {string|null} The best available display name, or null if a valid name cannot be found.
 */
function findBestDisplayName({ baileysContact, baileysMessage } = {}) {
    let bestName = null;

    // 1. Highest priority: A name manually saved by the user (contact.name).
    // if (baileysContact?.name) {
    //     bestName = baileysContact.name;
    // }

    // 2. Second priority: The 'notify' name, which is the most reliable push name.
    // It's checked on both the message and contact objects.
    if (!bestName && baileysMessage?.notify) {
        bestName = baileysMessage.notify;
    }
    if (!bestName && baileysContact?.notify) {
        bestName = baileysContact.notify;
    }

    // 3. Third priority: The 'pushName' from the message object as a fallback.
    if (!bestName && baileysMessage?.pushName) {
        bestName = baileysMessage.pushName;
    }
    
    // 4. Fourth priority: Verified names for official business accounts.
    if (!bestName && baileysContact?.verifiedName) {
        bestName = baileysContact.verifiedName;
    }
    if (!bestName && baileysContact?.vname) {
        bestName = baileysContact.vname;
    }

    // Final cleanup and validation.
    if (bestName) {
        const cleanedName = bestName.trim();
        // A list of generic names we should NEVER use for creating/merging contacts.
        const genericNames = ['whatsapp', 'null', 'undefined', '', 'unknown', 'unknownpn'];
        if (genericNames.includes(cleanedName.toLowerCase())) {
            return null; // Reject generic names to prevent data corruption.
        }
        return cleanedName;
    }

    return null; // Return null if no valid name could be found.
}

module.exports = {
    findBestDisplayName
};