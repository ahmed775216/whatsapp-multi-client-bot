const crypto = require('crypto');
let process = require('process');
function encryptPassword(password) {
    if (!password) return null;
    
    // Simple encryption for now - you can enhance this
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'kqBxxtSh2ufFdm78PZdbHfTweYQAGH7JyZkElgmE4dxZufxUzLBr38oMaTpAM1Ap', 'salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    
    let encrypted = cipher.update(password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
}

function decryptPassword(encryptedPassword) {
    if (!encryptedPassword || !encryptedPassword.includes(':')) return null;
    
    const [ivHex, encrypted] = encryptedPassword.split(':');
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(process.env.ENCRYPTION_KEY || 'kqBxxtSh2ufFdm78PZdbHfTweYQAGH7JyZkElgmE4dxZufxUzLBr38oMaTpAM1Ap', 'salt', 32);
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
}

module.exports = { encryptPassword, decryptPassword };