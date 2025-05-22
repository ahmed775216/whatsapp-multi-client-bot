// client-instance/handler.js
const { getContentType, jidNormalizedUser, areJidsSameUser } = require('@whiskeysockets/baileys');
// No longer needs explicit path/fs for global data files, whitelist.js handles it.
// If your handler directly accesses fs or other files, you need to adjust its paths.

// All plugins are loaded into handler (from app.js perspective in your original code)
// Here, we're assuming the main clientBotApp loads the plugins and passes them or handles them.
// For this stage, we'll keep it simple and focus on basic message processing.

const plugins = {}; // In a real scenario, this would be loaded here. For this test, it's simplified.

// Assuming apiSync and whitelist functions are already configured to use client's DATA_DIR
// If plugins.all array is also defined in clientBotApp.js and iterated, it would be passed in ctx
const ALL_HANDLERS_FROM_PLUGINS = [
    // This is where plugins/_whitelistFilter.js would be
    // Example: (Assuming you place _whitelistFilter.js directly in client-instance/plugins/)
    require('./plugins/_whitelistFilter.js').all
    // Other 'all' plugins would go here too
];


async function handleMessage(sock, m, options = {}) {
    // Basic Message Checks
    if (!m.message) return;
    const msgType = getContentType(m.message);
    if (msgType === 'protocolMessage' || msgType === 'senderKeyDistributionMessage') return;
    // if (m.key.fromMe) return; // Allow self-commands for testing

    const chatId = m.key.remoteJid;
    // participant is available in group messages, remoteJid for DMs
    const sender = jidNormalizedUser(m.key.participant || m.key.remoteJid);
    const isGroup = chatId.endsWith('@g.us');

    // --- Dynamic Owner Check for this specific Client Bot ---
    // The owner number is passed via environment variable by the manager process.
    const ownerNumbers = (process.env.OWNER_NUMBER_FOR_CLIENT_BOT_LOGIC || "").split(',').map(num => num.trim());
    const isOwner = ownerNumbers.includes(sender.split('@')[0]);
    // console.log(`[HANDLER] Sender ${sender.split('@')[0]} isOwner: ${isOwner}`);


    // Enrich the message object (m) (copy from your current handler.js)
    m.reply = (text, targetChatId = m.key.remoteJid, replyOptions = {}) => sock.sendMessage(targetChatId, (typeof text === 'string') ? { text: text } : text, { quoted: m, ...replyOptions });

    const msgContextInfo = m.message?.[msgType]?.contextInfo;
    m.mentionedJid = msgContextInfo?.mentionedJid || [];

    if (m.message?.[msgType]?.contextInfo?.quotedMessage) { // Check if it's a reply
        // Simplified quoted message object for this test
        m.quoted = {
            key: {
                remoteJid: m.key.remoteJid,
                id: m.message[msgType].contextInfo.stanzaId,
                participant: m.message[msgType].contextInfo.participant
            },
            message: m.message[msgType].contextInfo.quotedMessage,
            sender: m.message[msgType].contextInfo.participant,
        };
        // Add a dummy download method if needed for quoted messages
        // m.quoted.download = async () => { /* ... simplified download logic ... */ return Buffer.from('dummy'); };
    }
    // Add download method for current message (if it's media)
    if (m.message?.[msgType]?.mimetype) {
         m.download = () => require('@whiskeysockets/baileys').downloadContentFromMessage(m.message[msgType], msgType.replace('Message', ''));
    }

    // --- Fetch Group Info (if applicable) ---
    let groupMetadata = {};
    let participants = [];
    let isAdmin = false;
    let isBotAdmin = false;

    if (isGroup) {
        try {
            groupMetadata = await sock.groupMetadata(chatId);
            participants = groupMetadata.participants || [];
            const botJid = jidNormalizedUser(sock.user?.id);
            const botParticipant = participants.find(p => p.id === botJid);
            isBotAdmin = botParticipant && botParticipant.admin === 'admin';

            const senderParticipant = participants.find(p => p.id === sender);
            isAdmin = senderParticipant && senderParticipant.admin === 'admin';
        } catch (e) {
            console.warn(`[HANDLER] Could not fetch group metadata or participant info for ${chatId}:`, e.message);
        }
    }

    // Create context for plugin handlers
    const ctx = {
        sock,
        m,
        chatId,
        sender,
        text: m.message?.conversation || m.message?.[msgType]?.text || m.message?.[msgType]?.caption || '',
        usedPrefix: '!', // Assuming default prefix is '!'
        isGroup,
        participants,
        groupMetadata,
        isAdmin,
        isBotAdmin,
        isOwner, // Dynamically determined
        botJid: jidNormalizedUser(sock.user?.id),
        // Add plugins object, etc., if you enable commands
        // plugins: plugins, // Not active in this simplified handler for now
        // WHISPER_TIMEOUT: 60000, // Or from config
    };

    // --- Process 'all' type handlers first (e.g., whitelistFilter) ---
    for (const allHandler of ALL_HANDLERS_FROM_PLUGINS) {
        try {
            // For _whitelistFilter.js, it returns {} if blocked
            const blockResult = await allHandler(m, ctx);
            if (blockResult && typeof blockResult === 'object' && Object.keys(blockResult).length === 0) {
                console.log(`[HANDLER] Message blocked by 'all' plugin.`);
                return; // Stop further processing if blocked
            }
        } catch (e) {
            console.error(`[HANDLER_ERROR] Error in 'all' handler:`, e);
            // Don't block message processing if handler itself errors, unless it's critical.
        }
    }

    // --- No command processing for this minimal test ---
    // You would integrate your command processing loop here later.
    // console.log(`[HANDLER] Message processed by client instance ${process.env.CLIENT_ID}`);

}

module.exports = { handleMessage };