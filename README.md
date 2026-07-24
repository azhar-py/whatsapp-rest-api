# WhatsApp REST API

[![GitHub](https://img.shields.io/badge/GitHub-azhar--py%2Fwhatsapp--rest--api-blue?logo=github)](https://github.com/azhar-py/whatsapp-rest-api)

A simple but powerful REST API for WhatsApp Web built with [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) and Express.

**Repository:** [https://github.com/azhar-py/whatsapp-rest-api](https://github.com/azhar-py/whatsapp-rest-api)

Send **text**, **images**, **voice notes**, and **any media**. Receive incoming messages (including images). Check connection status and get a **QR code via API** when the session is not linked.

---

## Features

- Connect WhatsApp Web via QR code (API + browser image + terminal)
- Session persistence with `LocalAuth` (no need to scan QR every restart)
- Send text messages
- Send images (file upload or base64)
- Send voice notes (PTT)
- Send any media (image / video / audio / document)
- Receive messages into an in-memory inbox
- Download / view received media
- List chats
- Connection status endpoint
- Logout / disconnect session
- **API token auth** — every request requires a secret from `.env`

---

## Requirements

- **Node.js** 18+ recommended
- **Google Chrome** or Chromium (used by Puppeteer)
- A phone with WhatsApp installed

---

## Installation

```bash
git clone https://github.com/azhar-py/whatsapp-rest-api.git
cd whatsapp-rest-api
npm install
cp .env.example .env
```

Edit `.env` and set a strong `API_TOKEN` (do not use the example value):

```env
PORT=3000
API_TOKEN=your_long_random_secret_here
```

Generate a random token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> `.env` is gitignored. Never commit your real token. Only `.env.example` is in the repo.

---

## Start the server

```bash
npm start
```

Server runs at:

```
http://localhost:3000
```

On first run you will see a QR code in the terminal. You can also fetch it from the API (see below).

Scan the QR with WhatsApp:

**WhatsApp → Linked Devices → Link a Device**

After a successful scan, the API is ready. Session data is saved in `.wwebjs_auth/`, so next time you usually won’t need to scan again.

---

## Authentication (required)

Every API call must include your `API_TOKEN` from `.env`. Without it the server returns **401 Unauthorized**.

**Option 1 — Bearer header (recommended)**

```bash
curl http://localhost:3000/status \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

**Option 2 — Custom header**

```bash
curl http://localhost:3000/status \
  -H "x-api-token: YOUR_API_TOKEN"
```

**Option 3 — Query string** (less secure; avoid in production)

```bash
curl "http://localhost:3000/status?token=YOUR_API_TOKEN"
```

Missing/invalid token response:

```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "Valid API token required. Use Authorization: Bearer <token> or x-api-token header."
}
```

This protects the API if your PC/Wi‑Fi is exposed on the local network — others cannot send messages or read inbox without the secret.

---

## Quick start flow

1. Copy `.env.example` → `.env` and set `API_TOKEN`
2. Start the server → `npm start`
3. Check status → `GET /status` **with token**
4. If not connected → `GET /qr` or open `GET /qr/image` (with token)
5. Scan QR with your phone
6. When `connected: true` → send / receive messages

---

## Phone number format

Always use the **full international number** without `+` or spaces:

| Correct | Wrong |
|---------|-------|
| `923001234567` | `+92 300 1234567` |
| `923001234567` | `03001234567` |

The API converts it to WhatsApp chat id: `923001234567@c.us`.

You can also pass a full chat id (including group ids), e.g. `1234567890@g.us`.

---

## API Reference

Base URL: `http://localhost:3000`

All examples below use:

```bash
-H "Authorization: Bearer YOUR_API_TOKEN"
```

Replace `YOUR_API_TOKEN` with the value from your `.env` file.

### `GET /`

Returns a short list of available endpoints.

```bash
curl http://localhost:3000/ \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

---

### `GET /status`

Check whether WhatsApp is connected.

**Response example**

```json
{
  "success": true,
  "connected": true,
  "state": "READY",
  "hasQr": false
}
```

| `state` | Meaning |
|---------|---------|
| `INITIALIZING` | Client is starting |
| `QR` | Waiting for QR scan |
| `AUTHENTICATED` | QR scanned / session restored |
| `READY` | Fully ready to send/receive |
| `DISCONNECTED` | Session lost |

```bash
curl http://localhost:3000/status \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

---

### `GET /qr`

Get QR code as JSON when **not connected**.

**Response example**

```json
{
  "success": true,
  "connected": false,
  "state": "QR",
  "qr": "2@Abc...",
  "qrImage": "data:image/png;base64,iVBORw0KGgo...",
  "qrImageUrl": "/qr/image"
}
```

Use `qrImage` directly in an `<img src="...">` in your frontend.

If already connected:

```json
{
  "success": true,
  "connected": true,
  "message": "Already connected. No QR needed."
}
```

If QR is not ready yet (HTTP `202`):

```json
{
  "success": false,
  "connected": false,
  "state": "INITIALIZING",
  "message": "QR not ready yet. Wait a few seconds and retry."
}
```

```bash
curl http://localhost:3000/qr \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

---

### `GET /qr/image`

Returns the QR as a **PNG image**. Open this URL in a browser and scan it.

```
http://localhost:3000/qr/image
```

```bash
curl -o qr.png http://localhost:3000/qr/image \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

---

### `POST /send/text`

Send a text message.

**Body (JSON)**

```json
{
  "number": "923001234567",
  "message": "Hello from WhatsApp API"
}
```

**Response**

```json
{
  "success": true,
  "id": "true_923001234567@c.us_XXXX",
  "to": "923001234567@c.us",
  "message": "Hello from WhatsApp API"
}
```

```bash
curl -X POST http://localhost:3000/send/text \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"number\":\"923001234567\",\"message\":\"Hello\"}"
```

> Alias: `POST /send` (same body) is also supported.

---

### `POST /send/image`

Send an image with optional caption.

#### Option A — multipart file upload

```bash
curl -X POST http://localhost:3000/send/image \
  -F "number=923001234567" \
  -F "caption=My photo" \
  -F "file=@./photo.jpg"
```

#### Option B — JSON base64

```json
{
  "number": "923001234567",
  "caption": "My photo",
  "mimetype": "image/jpeg",
  "filename": "photo.jpg",
  "base64": "/9j/4AAQSkZJRgABAQ..."
}
```

`base64` may include a data URL prefix (`data:image/jpeg;base64,...`) — it is cleaned automatically.

```bash
curl -X POST http://localhost:3000/send/image \
  -H "Content-Type: application/json" \
  -d "{\"number\":\"923001234567\",\"caption\":\"Hi\",\"mimetype\":\"image/jpeg\",\"base64\":\"YOUR_BASE64\"}"
```

---

### `POST /send/voice`

Send a **voice note** (PTT). Prefer `.ogg` (opus) for best WhatsApp compatibility.

#### Multipart

```bash
curl -X POST http://localhost:3000/send/voice \
  -F "number=923001234567" \
  -F "file=@./voice.ogg"
```

#### JSON base64

```json
{
  "number": "923001234567",
  "mimetype": "audio/ogg; codecs=opus",
  "filename": "voice.ogg",
  "base64": "T2dnUwAC..."
}
```

**Response**

```json
{
  "success": true,
  "id": "true_923001234567@c.us_XXXX",
  "to": "923001234567@c.us",
  "asVoice": true
}
```

---

### `POST /send/media`

Send any media type (image, video, audio, document).

#### Multipart

```bash
curl -X POST http://localhost:3000/send/media \
  -F "number=923001234567" \
  -F "caption=Document" \
  -F "file=@./file.pdf"
```

Send audio as voice note:

```bash
curl -X POST http://localhost:3000/send/media \
  -F "number=923001234567" \
  -F "asVoice=true" \
  -F "file=@./voice.ogg"
```

#### JSON base64

```json
{
  "number": "923001234567",
  "caption": "File",
  "mimetype": "application/pdf",
  "filename": "file.pdf",
  "base64": "JVBERi0xLjQK...",
  "asVoice": false
}
```

---

### `GET /messages`

List received messages (in-memory inbox, last 500).

**Query params**

| Param | Description | Default |
|-------|-------------|---------|
| `limit` | Max messages to return | `50` |
| `from` | Filter by sender number | — |

```bash
curl http://localhost:3000/messages
curl "http://localhost:3000/messages?limit=20"
curl "http://localhost:3000/messages?from=923001234567&limit=20"
```

**Response example**

```json
{
  "success": true,
  "count": 2,
  "messages": [
    {
      "id": "false_923001234567@c.us_XXXX",
      "from": "923001234567@c.us",
      "to": "me",
      "body": "Hello",
      "type": "chat",
      "timestamp": 1720000000,
      "fromMe": false,
      "hasMedia": false,
      "isGroup": false,
      "contactName": "Ali",
      "media": null
    },
    {
      "id": "false_923001234567@c.us_YYYY",
      "from": "923001234567@c.us",
      "body": "",
      "type": "image",
      "hasMedia": true,
      "media": {
        "mimetype": "image/jpeg",
        "filename": "1720000000_YYYY.jpeg",
        "url": "/media/1720000000_YYYY.jpeg"
      }
    }
  ]
}
```

Open received image:

```
http://localhost:3000/media/1720000000_YYYY.jpeg
```

> Inbox is stored in memory. Restarting the server clears it. Incoming media files on disk under `media/` remain until deleted.

---

### `GET /messages/:id`

Get one message. If it has media, includes `media.dataUrl` (base64).

```bash
curl http://localhost:3000/messages/false_923001234567@c.us_XXXX
```

---

### `GET /chats`

List recent chats (up to 100).

```bash
curl http://localhost:3000/chats
```

**Response example**

```json
{
  "success": true,
  "chats": [
    {
      "id": "923001234567@c.us",
      "name": "Ali",
      "isGroup": false,
      "unreadCount": 2,
      "timestamp": 1720000000
    }
  ]
}
```

---

### `GET /media/:filename`

Serve a saved incoming media file.

```
http://localhost:3000/media/FILENAME.jpeg
```

---

### `POST /logout`

Logout WhatsApp session. After logout, call `/qr` again to link a new device.

```bash
curl -X POST http://localhost:3000/logout
```

---

## Error responses

When WhatsApp is not ready, send/receive endpoints return **HTTP 503**:

```json
{
  "success": false,
  "error": "WhatsApp not connected",
  "state": "QR",
  "hint": "Call GET /qr to get QR code, then scan with WhatsApp"
}
```

Validation errors return **HTTP 400**. Server errors return **HTTP 500** with `error` message.

---

## Example: connect from frontend

```html
<img id="qr" alt="Scan QR" />
<script>
  const TOKEN = 'YOUR_API_TOKEN'; // from .env — never expose in public websites
  const headers = { Authorization: `Bearer ${TOKEN}` };

  async function loadQr() {
    const status = await fetch('http://localhost:3000/status', { headers }).then(r => r.json());
    if (status.connected) {
      document.getElementById('qr').alt = 'Already connected';
      return;
    }
    const data = await fetch('http://localhost:3000/qr', { headers }).then(r => r.json());
    if (data.qrImage) {
      document.getElementById('qr').src = data.qrImage;
    } else {
      setTimeout(loadQr, 2000); // retry until QR is ready
    }
  }
  loadQr();
</script>
```

---

## Project structure

```
whatsapp-rest-api/
├── server.js          # Main API server
├── package.json
├── .env               # Your secrets (gitignored)
├── .env.example       # Example env (safe to commit)
├── .gitignore
├── uploads/           # Temporary uploads (auto-cleaned after send)
├── media/             # Saved incoming media files
└── .wwebjs_auth/      # WhatsApp session (do not commit)
```

---

## Environment

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_TOKEN` | **Yes** | — | Secret token required on every request |
| `PORT` | No | `3000` | HTTP server port |

Copy the example file:

```bash
cp .env.example .env
```

```env
PORT=3000
API_TOKEN=change_me_to_a_long_random_secret
```

```bash
# Windows PowerShell
$env:PORT=4000; npm start

# Linux / macOS
PORT=4000 npm start
```

---

## Notes & limitations

- This uses **WhatsApp Web**, not the official Meta Cloud API.
- Using unofficial clients can risk account restrictions. Use a secondary/test number for development.
- Do **not** commit `.wwebjs_auth/` or personal media files.
- Voice notes work best with **OGG Opus** audio.
- Inbox (`/messages`) is in-memory only (last 500 messages).
- First Chrome/Puppeteer launch may take a few seconds.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| QR never appears | Wait 5–10s and call `GET /qr` again; check terminal logs |
| `WhatsApp not connected` | Scan QR via `/qr` or `/qr/image` |
| Message not delivered | Use full country code number, e.g. `92...` |
| Voice not showing as note | Use `.ogg` opus and `/send/voice` |
| Session broken | `POST /logout`, delete `.wwebjs_auth`, restart, scan new QR |
| Puppeteer / Chrome errors | Install Google Chrome; on Linux add needed dependencies |

---

## License

ISC

---

## Credits

Built with:

- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js)
- [Express](https://expressjs.com/)
- [qrcode](https://www.npmjs.com/package/qrcode)
- [multer](https://www.npmjs.com/package/multer)
