require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN || API_TOKEN === 'change_me_to_a_long_random_secret') {
    console.error('ERROR: Set a strong API_TOKEN in your .env file before starting.');
    console.error('Copy .env.example to .env and generate a token:');
    console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
}

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// Accept raw JSON bodies (primary). Also parse text/plain as JSON for clients
// that send raw body without application/json Content-Type.
app.use(express.json({
    limit: '25mb',
    type: ['application/json', 'text/json', 'text/plain'],
}));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

/** Use multer only for multipart; leave req.body alone for raw JSON */
function optionalFileUpload(req, res, next) {
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('multipart/form-data')) {
        return upload.single('file')(req, res, next);
    }
    return next();
}

/** Extract token from Authorization Bearer, x-api-token, or ?token= */
function extractToken(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        return auth.slice(7).trim();
    }
    if (req.headers['x-api-token']) {
        return String(req.headers['x-api-token']).trim();
    }
    if (req.query && req.query.token) {
        return String(req.query.token).trim();
    }
    if (req.body && req.body.token) {
        return String(req.body.token).trim();
    }
    return null;
}

function tokensEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/** Reject any request without a valid API token (except public GET /) */
function requireApiToken(req, res, next) {
    const token = extractToken(req);
    if (!token || !tokensEqual(token, API_TOKEN)) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized',
            message: 'Valid API token required. Use Authorization: Bearer <token> or x-api-token header.',
        });
    }
    next();
}

/** Public: API overview (no token) */
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp REST API',
        auth: 'All other routes require Authorization: Bearer <API_TOKEN> or x-api-token header',
        body: 'POST endpoints accept raw JSON (Content-Type: application/json). Media fields use base64.',
        endpoints: {
            status: 'GET /status',
            qrImage: 'GET /qr/image',
            sendText: 'POST /send/text  JSON: { number, message }',
            sendImage: 'POST /send/image  JSON: { number, caption?, base64, mimetype, filename? }',
            sendVoice: 'POST /send/voice  JSON: { number, base64, mimetype?, filename? }',
            sendMedia: 'POST /send/media  JSON: { number, caption?, base64, mimetype, filename?, asVoice? }',
            messages: 'GET /messages?limit=50&from=92300...',
            messageById: 'GET /messages/:id',
            chats: 'GET /chats',
            media: 'GET /media/:filename',
            logout: 'POST /logout',
        },
    });
});

app.use(requireApiToken);

// Ensure folders exist
const AUTH_PATH = path.join(__dirname, '.wwebjs_auth');
const CACHE_PATH = path.join(__dirname, '.wwebjs_cache');
const UPLOADS_PATH = path.join(__dirname, 'uploads');
const MEDIA_PATH = path.join(__dirname, 'media');

function ensureRuntimeDirs() {
    [UPLOADS_PATH, MEDIA_PATH].forEach((dir) => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}
ensureRuntimeDirs();

let isReady = false;
let latestQr = null; // only one active QR string at a time
let connectionState = 'INITIALIZING'; // INITIALIZING | QR | AUTHENTICATED | READY | DISCONNECTED
let isLoggingOut = false;

// In-memory inbox (last 500 messages). Replace with DB later if needed.
const inbox = [];
const MAX_INBOX = 500;

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
});

function clearDirContents(dir) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
}

/** Delete session, cache, uploads, media, and any exported QR image files */
function wipeSessionFiles() {
    for (const dir of [AUTH_PATH, CACHE_PATH]) {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    clearDirContents(UPLOADS_PATH);
    clearDirContents(MEDIA_PATH);
    for (const file of ['qr.png', 'qr.jpg', 'qr.jpeg']) {
        const p = path.join(__dirname, file);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    ensureRuntimeDirs();
}

function clearRuntimeState() {
    isReady = false;
    latestQr = null;
    inbox.length = 0;
}

function toChatId(number) {
    // Accept: 923001234567 OR 923001234567@c.us OR group id
    if (!number) return null;
    const n = String(number).trim();
    if (n.includes('@')) return n;
    const digits = n.replace(/\D/g, '');
    return digits ? `${digits}@c.us` : null;
}

/**
 * Resolve a phone number / chat id to a real WhatsApp chat id.
 * Phone numbers are looked up via getNumberId (handles LID-era accounts).
 */
async function resolveChatId(number) {
    const raw = number == null ? '' : String(number).trim();
    if (!raw) {
        return { ok: false, status: 400, error: 'number is required' };
    }

    // Already a full WhatsApp id (group, lid, c.us, newsletter, …)
    if (raw.includes('@')) {
        return { ok: true, chatId: raw };
    }

    const digits = raw.replace(/\D/g, '');
    if (!digits) {
        return { ok: false, status: 400, error: 'Invalid phone number' };
    }

    try {
        const wid = await client.getNumberId(digits);
        if (!wid || !wid._serialized) {
            return {
                ok: false,
                status: 404,
                error: 'Number is not registered on WhatsApp',
                number: digits,
            };
        }
        return { ok: true, chatId: wid._serialized };
    } catch (err) {
        console.error('getNumberId failed:', err.message);
        // Fallback — may still work for some accounts
        return { ok: true, chatId: `${digits}@c.us` };
    }
}

/**
 * Send content to a chat.
 * whatsapp-web.js often delivers the message but returns undefined (LID accounts).
 * If sendMessage does not throw, treat as success.
 */
async function sendToChat(chatId, content, options = {}) {
    try {
        await client.sendMessage(chatId, content, options);
        return true;
    } catch (err) {
        // Message may still have been delivered; only fail on hard errors
        const msg = String(err && err.message ? err.message : err);
        console.warn('sendMessage warning:', msg);
        if (
            /reading 'id'|getMessageModel|undefined/i.test(msg)
        ) {
            return true;
        }
        throw err;
    }
}

function pushInbox(item) {
    inbox.unshift(item);
    if (inbox.length > MAX_INBOX) inbox.pop();
}

async function saveIncomingMedia(msg) {
    if (!msg.hasMedia) return null;
    try {
        const media = await msg.downloadMedia();
        if (!media) return null;

        const ext = (media.mimetype && media.mimetype.split('/')[1]) || 'bin';
        const safeExt = ext.split(';')[0].replace(/[^a-z0-9]/gi, '') || 'bin';
        const filename = `${Date.now()}_${msg.id.id}.${safeExt}`;
        const filepath = path.join(__dirname, 'media', filename);
        fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));

        return {
            mimetype: media.mimetype,
            filename,
            filepath,
            dataUrl: `data:${media.mimetype};base64,${media.data}`,
            size: Buffer.from(media.data, 'base64').length,
        };
    } catch (err) {
        console.error('Failed to download media:', err.message);
        return null;
    }
}

client.on('qr', async (qr) => {
    // WhatsApp refreshes QR periodically — keep only the newest one
    isReady = false;
    connectionState = 'QR';
    latestQr = qr;
    console.log('QR ready — GET /qr/image');
});

client.on('authenticated', () => {
    connectionState = 'AUTHENTICATED';
    latestQr = null;
    console.log('Authenticated');
});

client.on('ready', () => {
    isReady = true;
    connectionState = 'READY';
    latestQr = null;
    console.log('WhatsApp Ready!');
});

client.on('auth_failure', (msg) => {
    isReady = false;
    connectionState = 'DISCONNECTED';
    console.error('Auth failure:', msg);
});

client.on('disconnected', (reason) => {
    isReady = false;
    connectionState = 'DISCONNECTED';
    latestQr = null;
    console.log('Disconnected:', reason);
    // During logout we re-init ourselves; skip auto re-init here
    if (isLoggingOut) return;
    client.initialize().catch(() => {});
});

client.on('message', async (msg) => {
    // Skip status broadcasts
    if (msg.from === 'status@broadcast') return;

    const contact = await msg.getContact().catch(() => null);
    const chat = await msg.getChat().catch(() => null);
    const mediaInfo = await saveIncomingMedia(msg);

    const item = {
        id: msg.id._serialized,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        type: msg.type,
        timestamp: msg.timestamp,
        fromMe: msg.fromMe,
        hasMedia: msg.hasMedia,
        isGroup: chat ? chat.isGroup : false,
        contactName: contact ? contact.pushname || contact.name || contact.number : null,
        media: mediaInfo
            ? {
                  mimetype: mediaInfo.mimetype,
                  filename: mediaInfo.filename,
                  url: `/media/${mediaInfo.filename}`,
                  // omit huge base64 from list by default; use /messages/:id for full
              }
            : null,
        _mediaDataUrl: mediaInfo ? mediaInfo.dataUrl : null,
    };

    pushInbox(item);
    console.log(`[IN] ${item.from}: ${item.body || '[' + item.type + ']'}`);
});

client.initialize();

function requireReady(res) {
    if (!isReady) {
        res.status(503).json({
            success: false,
            error: 'WhatsApp not connected',
            state: connectionState,
            hint: 'GET /qr/image',
        });
        return false;
    }
    return true;
}

function cleanupUpload(file) {
    if (file && file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
    }
}

// -------------------- API LIST --------------------
// GET  /                 -> API docs (public, no auth)
// GET  /status           -> connection status
// GET  /qr/image         -> active QR as PNG (only QR route)
// POST /send/text        -> send text (raw JSON)
// POST /send/image       -> send image (raw JSON base64; multipart optional)
// POST /send/voice       -> send voice note (raw JSON base64; multipart optional)
// POST /send/media       -> send any media (raw JSON base64; multipart optional)
// GET  /messages         -> received messages inbox
// GET  /messages/:id     -> one message (includes media base64 if any)
// GET  /chats            -> list chats
// GET  /media/:filename  -> serve saved incoming media
// POST /logout           -> logout session
// -------------------------------------------------

/** Check if WhatsApp is connected */
app.get('/status', (req, res) => {
    res.json({
        success: true,
        connected: isReady,
        state: connectionState,
        hasQr: Boolean(latestQr),
    });
});

/** Return the currently active QR as PNG (only one QR kept at a time) */
app.get('/qr/image', async (req, res) => {
    if (isReady) {
        return res.status(400).json({ success: false });
    }
    if (!latestQr) {
        return res.status(202).json({ success: false });
    }
    const png = await QRCode.toBuffer(latestQr, { type: 'png', width: 300 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(png);
});

async function handleSendText(req, res) {
    if (!requireReady(res)) return;
    try {
        const body = req.body || {};
        const message = body.message;
        if (message == null || String(message).trim() === '') {
            return res.status(400).json({ success: false });
        }

        const resolved = await resolveChatId(body.number);
        if (!resolved.ok) {
            return res.status(resolved.status).json({ success: false });
        }

        await sendToChat(resolved.chatId, String(message));
        return res.json({ success: true });
    } catch (err) {
        console.error('send text failed:', err.message);
        return res.status(500).json({ success: false });
    }
}

/** Send text message (raw JSON: { number, message }) */
app.post('/send/text', handleSendText);

function parseBase64Field(value) {
    if (!value || typeof value !== 'string') return null;
    return value.replace(/^data:[^;]+;base64,/, '');
}

function truthy(value) {
    if (value === true || value === 1) return true;
    const s = String(value || '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
}

/** Send image — raw JSON (base64) preferred; multipart file optional */
app.post('/send/image', optionalFileUpload, async (req, res) => {
    if (!requireReady(res)) return;
    try {
        const body = req.body || {};
        const caption = body.caption || '';

        const resolved = await resolveChatId(body.number);
        if (!resolved.ok) {
            cleanupUpload(req.file);
            return res.status(resolved.status).json({ success: false });
        }

        let media;
        const base64 = parseBase64Field(body.base64);
        if (base64) {
            media = new MessageMedia(
                body.mimetype || 'image/jpeg',
                base64,
                body.filename || 'image.jpg'
            );
        } else if (req.file) {
            media = MessageMedia.fromFilePath(req.file.path);
            if (req.file.mimetype) media.mimetype = req.file.mimetype;
            if (req.file.originalname) media.filename = req.file.originalname;
        } else {
            cleanupUpload(req.file);
            return res.status(400).json({ success: false });
        }

        await sendToChat(resolved.chatId, media, { caption });
        cleanupUpload(req.file);
        return res.json({ success: true });
    } catch (err) {
        cleanupUpload(req.file);
        console.error('send image failed:', err.message);
        return res.status(500).json({ success: false });
    }
});

/** Send voice note (PTT) — raw JSON (base64) preferred; multipart file optional */
app.post('/send/voice', optionalFileUpload, async (req, res) => {
    if (!requireReady(res)) return;
    try {
        const body = req.body || {};

        const resolved = await resolveChatId(body.number);
        if (!resolved.ok) {
            cleanupUpload(req.file);
            return res.status(resolved.status).json({ success: false });
        }

        let media;
        const base64 = parseBase64Field(body.base64);
        if (base64) {
            media = new MessageMedia(
                body.mimetype || 'audio/ogg; codecs=opus',
                base64,
                body.filename || 'voice.ogg'
            );
        } else if (req.file) {
            media = MessageMedia.fromFilePath(req.file.path);
            media.mimetype = req.file.mimetype || 'audio/ogg; codecs=opus';
            media.filename = req.file.originalname || 'voice.ogg';
        } else {
            cleanupUpload(req.file);
            return res.status(400).json({ success: false });
        }

        await sendToChat(resolved.chatId, media, { sendAudioAsVoice: true });
        cleanupUpload(req.file);
        return res.json({ success: true });
    } catch (err) {
        cleanupUpload(req.file);
        console.error('send voice failed:', err.message);
        return res.status(500).json({ success: false });
    }
});

/** Send any media — raw JSON (base64) preferred; multipart file optional */
app.post('/send/media', optionalFileUpload, async (req, res) => {
    if (!requireReady(res)) return;
    try {
        const body = req.body || {};
        const caption = body.caption || '';
        const asVoice = truthy(body.asVoice);

        const resolved = await resolveChatId(body.number);
        if (!resolved.ok) {
            cleanupUpload(req.file);
            return res.status(resolved.status).json({ success: false });
        }

        let media;
        const base64 = parseBase64Field(body.base64);
        if (base64) {
            media = new MessageMedia(
                body.mimetype || 'application/octet-stream',
                base64,
                body.filename || 'file.bin'
            );
        } else if (req.file) {
            media = MessageMedia.fromFilePath(req.file.path);
            if (req.file.mimetype) media.mimetype = req.file.mimetype;
            if (req.file.originalname) media.filename = req.file.originalname;
        } else {
            cleanupUpload(req.file);
            return res.status(400).json({ success: false });
        }

        const options = { caption };
        if (asVoice) options.sendAudioAsVoice = true;

        await sendToChat(resolved.chatId, media, options);
        cleanupUpload(req.file);
        return res.json({ success: true });
    } catch (err) {
        cleanupUpload(req.file);
        console.error('send media failed:', err.message);
        return res.status(500).json({ success: false });
    }
});

/** List received messages */
app.get('/messages', (req, res) => {
    if (!requireReady(res)) return;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), MAX_INBOX);
    const from = req.query.from ? toChatId(req.query.from) : null;

    let list = inbox;
    if (from) list = list.filter((m) => m.from === from);

    res.json({
        success: true,
        count: list.length,
        messages: list.slice(0, limit).map(({ _mediaDataUrl, ...rest }) => rest),
    });
});

/** Get one message including media base64 */
app.get('/messages/:id', (req, res) => {
    if (!requireReady(res)) return;
    const msg = inbox.find((m) => m.id === req.params.id || m.id.endsWith(req.params.id));
    if (!msg) return res.status(404).json({ success: false, error: 'Message not found in inbox' });

    const { _mediaDataUrl, ...rest } = msg;
    res.json({
        success: true,
        message: {
            ...rest,
            media: rest.media
                ? { ...rest.media, dataUrl: _mediaDataUrl || null }
                : null,
        },
    });
});

/** List chats */
app.get('/chats', async (req, res) => {
    if (!requireReady(res)) return;
    try {
        const chats = await client.getChats();
        res.json({
            success: true,
            chats: chats.slice(0, 100).map((c) => ({
                id: c.id._serialized,
                name: c.name,
                isGroup: c.isGroup,
                unreadCount: c.unreadCount,
                timestamp: c.timestamp,
            })),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** Serve saved incoming media files */
app.get('/media/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    const filepath = path.join(__dirname, 'media', filename);
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ success: false, error: 'File not found' });
    }
    res.sendFile(filepath);
});

/**
 * Logout WhatsApp, wipe session/QR/cache/uploads/media, then re-init for a new QR.
 */
app.post('/logout', async (req, res) => {
    if (isLoggingOut) {
        return res.status(409).json({ success: false });
    }
    isLoggingOut = true;
    try {
        clearRuntimeState();
        connectionState = 'DISCONNECTED';

        try {
            await client.logout();
        } catch (err) {
            console.warn('client.logout:', err.message);
        }

        try {
            await client.destroy();
        } catch (err) {
            console.warn('client.destroy:', err.message);
        }

        wipeSessionFiles();
        clearRuntimeState();
        connectionState = 'INITIALIZING';
        console.log('Session wiped (.wwebjs_auth, .wwebjs_cache, uploads, media, QR). Reconnecting…');

        await client.initialize();
        return res.json({ success: true });
    } catch (err) {
        console.error('logout failed:', err.message);
        return res.status(500).json({ success: false });
    } finally {
        isLoggingOut = false;
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
    console.log(`Docs: GET http://localhost:${PORT}/`);
});
