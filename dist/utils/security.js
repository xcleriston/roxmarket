import * as crypto from 'crypto';
const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-key-32-chars-for-dev-only!!!'; // Must be 32 chars
const IV_LENGTH = 16;
export const encrypt = (text) => {
    if (!text)
        return '';
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY.slice(0, 32)), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
};
export const decrypt = (text) => {
    if (!text || !text.includes(':'))
        return text;
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY.slice(0, 32)), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
};
export const redactSecrets = (text) => {
    if (!text)
        return text;
    // Redact 64-char hex strings (private keys)
    return text.replace(/[a-fA-F0-9]{64}/g, '[REDACTED_KEY]');
};
