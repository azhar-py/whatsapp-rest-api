require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
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

/** Reject any request without a valid API token */
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

app.use(requireApiToken);

// Ensure folders exist
['uploads', 'media'].forEach((dir) => {
    const full = path.join(__dirname, dir);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

let isReady = false;
let latestQr = null; // raw QR string from WhatsApp
let latestQrDataUrl = null; // base64 PNG for API clients
let connectionState = 'INITIALIZING'; // INITIALIZING | QR | AUTHENTICATED | READY | DISCONNECTED

// In-memory inbox (last 500 messages). Replace with DB later if needed.
const inbox = [];
const MAX_INBOX = 500;

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
});

function toChatId(number) {
    // Accept: 923001234567 OR 923001234567@c.us OR group id
    if (!number) return null;
    const n = String(number).trim();
    if (n.includes('@')) return n;
    return `${n.replace(/\D/g, '')}@c.us`;
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
    isReady = false;
    connectionState = 'QR';
    latestQr = qr;
    try {
        latestQrDataUrl = await QRCode.toDataURL(qr);
    } catch (e) {
        latestQrDataUrl = null;
    }
    console.log('Scan this QR:');
    qrcodeTerminal.generate(qr, { small: true });
});

client.on('authenticated', () => {
    connectionState = 'AUTHENTICATED';
    latestQr = null;
    latestQrDataUrl = null;
    console.log('Authenticated');
});

client.on('ready', () => {
    isReady = true;
    connectionState = 'READY';
    latestQr = null;
    latestQrDataUrl = null;
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
    console.log('Disconnected:', reason);
    // Re-init so a new QR becomes available
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
            hint: 'Call GET /qr to get QR code, then scan with WhatsApp',
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
// GET  /                 -> API docs
// GET  /status           -> connection status
// GET  /qr               -> QR as JSON (base64) when not connected
// GET  /qr/image         -> QR as PNG image
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

app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp REST API',
        auth: 'Required on every request: Authorization: Bearer <API_TOKEN> or x-api-token header',
        body: 'POST endpoints accept raw JSON (Content-Type: application/json). Media fields use base64.',
        endpoints: {
            status: 'GET /status',
            qr: 'GET /qr',
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

/** Check if WhatsApp is connected */
app.get('/status', (req, res) => {
    res.json({
        success: true,
        connected: isReady,
        state: connectionState,
        hasQr: Boolean(latestQr),
    });
});

/** Get QR code (JSON + base64 PNG) when not connected */
app.get('/qr', async (req, res) => {
    if (isReady) {
        return res.json({
            success: true,
            connected: true,
            message: 'Already connected. No QR needed.',
        });
    }

    if (!latestQr) {
        return res.status(202).json({
            success: false,
            connected: false,
            state: connectionState,
            message: 'QR not ready yet. Wait a few seconds and retry.',
        });
    }

    if (!latestQrDataUrl) {
        latestQrDataUrl = await QRCode.toDataURL(latestQr);
    }

    res.json({
        success: true,
        connected: false,
        state: connectionState,
        qr: latestQr,
        qrImage: latestQrDataUrl, // data:image/png;base64,...
        qrImageUrl: '/qr/image',
    });
});

/** Return QR as raw PNG (open in browser) */
app.get('/qr/image', async (req, res) => {
    if (isReady) {
        return res.status(400).json({ success: false, message: 'Already connected' });
    }
    if (!latestQr) {
        return res.status(202).json({ success: false, message: 'QR not ready yet' });
    }
    const png = await QRCode.toBuffer(latestQr, { type: 'png', width: 300 });
    res.set('Content-Type', 'image/png');
    res.send(png);
});

/** Send text message */
app.post('/send/text', async (req, res) => {
    if (!requireReady(res)) return;
    try {
        const { number, message } = req.body;
        const chatId = toChatId(number);
        if (!chatId || !message) {
            return res.status(400).json({ success: false, error: 'number and message are required' });
        }
        const sent = await client.sendMessage(chatId, message);
        res.json({
            success: true,
            id: sent.id._serialized,
            to: chatId,
            message,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/** Legacy alias: POST /send */
app.post('/send', async (req, res) => {
    if (!requireReady(res)) return;
    try {
        const { number, message } = req.body;
        const chatId = toChatId(number);
        if (!chatId || !message) {
            return res.status(400).json({ success: false, error: 'number and message are required' });
        }
        const sent = await client.sendMessage(chatId, message);
        res.json({ success: true, id: sent.id._serialized });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

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
        const number = body.number;
        const caption = body.caption || '';
        const chatId = toChatId(number);
        if (!chatId) {
            cleanupUpload(req.file);
            return res.status(400).json({ success: false, error: 'number is required' });
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
            return res.status(400).json({
                success: false,
                error: 'Provide JSON body with base64 (and mimetype) or multipart file',
            });
        }

        const sent = await client.sendMessage(chatId, media, { caption });
        cleanupUpload(req.file);
        res.json({ success: true, id: sent.id._serialized, to: chatId });
    } catch (err) {
        cleanupUpload(req.file);
        res.status(500).json({ success: false, error: err.message });
    }
});

/** Send voice note (PTT) — raw JSON (base64) preferred; multipart file optional */
app.post('/send/voice', optionalFileUpload, async (req, res) => {
    if (!requireReady(res)) return;
    try {
        const body = req.body || {};
        const number = body.number;
        const chatId = toChatId(number);
        if (!chatId) {
            cleanupUpload(req.file);
            return res.status(400).json({ success: false, error: 'number is required' });
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
            return res.status(400).json({
                success: false,
                error: 'Provide JSON body with base64 (preferably .ogg opus) or multipart file',
            });
        }

        const sent = await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
        cleanupUpload(req.file);
        res.json({ success: true, id: sent.id._serialized, to: chatId, asVoice: true });
    } catch (err) {
        cleanupUpload(req.file);
        res.status(500).json({ success: false, error: err.message });
    }
});

/** Send any media — raw JSON (base64) preferred; multipart file optional */
app.post('/send/media', optionalFileUpload, async (req, res) => {
    if (!requireReady(res)) return;
    try {
        const body = req.body || {};
        const number = body.number;
        const caption = body.caption || '';
        const asVoice = truthy(body.asVoice);
        const chatId = toChatId(number);
        if (!chatId) {
            cleanupUpload(req.file);
            return res.status(400).json({ success: false, error: 'number is required' });
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
            return res.status(400).json({
                success: false,
                error: 'Provide JSON body with base64 (and mimetype) or multipart file',
            });
        }

        const options = { caption };
        if (asVoice) options.sendAudioAsVoice = true;

        const sent = await client.sendMessage(chatId, media, options);
        cleanupUpload(req.file);
        res.json({ success: true, id: sent.id._serialized, to: chatId });
    } catch (err) {
        cleanupUpload(req.file);
        res.status(500).json({ success: false, error: err.message });
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

/** Logout / clear session (will show new QR) */
app.post('/logout', async (req, res) => {
    try {
        isReady = false;
        connectionState = 'DISCONNECTED';
        await client.logout();
        res.json({ success: true, message: 'Logged out. Call GET /qr after restart/reinit.' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
    console.log(`Docs: GET http://localhost:${PORT}/`);
});
