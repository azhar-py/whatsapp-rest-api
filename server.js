const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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
// POST /send/text        -> send text
// POST /send/image       -> send image (file upload or base64)
// POST /send/voice       -> send voice note (file upload or base64)
// POST /send/media       -> send any media
// GET  /messages         -> received messages inbox
// GET  /messages/:id     -> one message (includes media base64 if any)
// GET  /chats            -> list chats
// GET  /media/:filename  -> serve saved incoming media
// POST /logout           -> logout session
// -------------------------------------------------

app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp API',
        endpoints: {
            status: 'GET /status',
            qr: 'GET /qr',
            qrImage: 'GET /qr/image',
            sendText: 'POST /send/text  { number, message }',
            sendImage: 'POST /send/image  multipart: number, caption?, file  OR json: number, caption?, base64, mimetype, filename?',
            sendVoice: 'POST /send/voice  multipart: number, file  OR json: number, base64, mimetype?',
            sendMedia: 'POST /send/media  multipart: number, caption?, file  OR json: number, caption?, base64, mimetype, filename?, asVoice?',
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

/** Send image */
app.post('/send/image', upload.single('file'), async (req, res) => {
    if (!requireReady(res)) return;
    try {
        const number = req.body.number;
        const caption = req.body.caption || '';
        const chatId = toChatId(number);
        if (!chatId) {
            cleanupUpload(req.file);
            return res.status(400).json({ success: false, error: 'number is required' });
        }

        let media;
        if (req.file) {
            media = MessageMedia.fromFilePath(req.file.path);
            if (req.file.mimetype) media.mimetype = req.file.mimetype;
            if (req.file.originalname) media.filename = req.file.originalname;
        } else if (req.body.base64) {
            media = new MessageMedia(
                req.body.mimetype || 'image/jpeg',
                req.body.base64.replace(/^data:[^;]+;base64,/, ''),
                req.body.filename || 'image.jpg'
            );
        } else {
            return res.status(400).json({ success: false, error: 'Provide file upload or base64' });
        }

        const sent = await client.sendMessage(chatId, media, { caption });
        cleanupUpload(req.file);
        res.json({ success: true, id: sent.id._serialized, to: chatId });
    } catch (err) {
        cleanupUpload(req.file);
        res.status(500).json({ success: false, error: err.message });
    }
});

/** Send voice note (PTT) */
app.post('/send/voice', upload.single('file'), async (req, res) => {
    if (!requireReady(res)) return;
    try {
        const number = req.body.number;
        const chatId = toChatId(number);
        if (!chatId) {
            cleanupUpload(req.file);
            return res.status(400).json({ success: false, error: 'number is required' });
        }

        let media;
        if (req.file) {
            media = MessageMedia.fromFilePath(req.file.path);
            media.mimetype = req.file.mimetype || 'audio/ogg; codecs=opus';
            media.filename = req.file.originalname || 'voice.ogg';
        } else if (req.body.base64) {
            media = new MessageMedia(
                req.body.mimetype || 'audio/ogg; codecs=opus',
                req.body.base64.replace(/^data:[^;]+;base64,/, ''),
                req.body.filename || 'voice.ogg'
            );
        } else {
            return res.status(400).json({
                success: false,
                error: 'Provide audio file upload or base64 (preferably .ogg opus)',
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

/** Send any media (image/video/audio/document) */
app.post('/send/media', upload.single('file'), async (req, res) => {
    if (!requireReady(res)) return;
    try {
        const number = req.body.number;
        const caption = req.body.caption || '';
        const asVoice = String(req.body.asVoice || '') === 'true';
        const chatId = toChatId(number);
        if (!chatId) {
            cleanupUpload(req.file);
            return res.status(400).json({ success: false, error: 'number is required' });
        }

        let media;
        if (req.file) {
            media = MessageMedia.fromFilePath(req.file.path);
            if (req.file.mimetype) media.mimetype = req.file.mimetype;
            if (req.file.originalname) media.filename = req.file.originalname;
        } else if (req.body.base64) {
            media = new MessageMedia(
                req.body.mimetype || 'application/octet-stream',
                req.body.base64.replace(/^data:[^;]+;base64,/, ''),
                req.body.filename || 'file.bin'
            );
        } else {
            return res.status(400).json({ success: false, error: 'Provide file upload or base64' });
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
