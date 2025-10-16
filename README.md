# News Pulse API (Render)

Express API for News Pulse AI. Node 22, CORS, Helmet, caching headers.

Endpoints
- GET  /api/health
- GET  /api/feed?category=Hyderabad|Telangana|India|International|Sports|Gadgets|Health
- GET  /api/breaking
- POST /api/translate   { text, target: "hi|ur|te|romhi" }
- POST /api/tts         { text }
- GET  /api/weather?lat=&lon=   (defaults to Hyderabad)
- GET  /api/gold
- GET  /api/azad-studio
- GET  /tg/file/:file_id
- POST /telegram/webhook   (Telegram Bot webhook; secured with secret_token=ADMIN_KEY)
- POST /api/verify-screenshot (multipart 'image')
- POST /api/notify/breaking (admin; header x-admin-key: ADMIN_KEY)

Deploy on Render (via GitHub)
1) Create a new GitHub repo and add these files.
2) On render.com → New → Web Service → connect the repo.
3) Root: repo root; Build: `npm ci`; Start: `node app.js`.
4) Environment:
   - NODE_VERSION=22
   - NODE_ENV=production
   - OPENAI_API_KEY=...
   - BOT_TOKEN=...
   - TELEGRAM_CHANNEL=@AzadStudioPosts
   - ADMIN_KEY=... (32-64 hex)
   - DEFAULT_CITY=Hyderabad
   - TZ=Asia/Kolkata
   (optional keys as needed)
5) Deploy. Health: /api/health.

Telegram webhook
- After deploy, set webhook (replace):
  https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=https://YOUR_RENDER_URL/telegram/webhook&secret_token=YOUR_ADMIN_KEY

Quick tests
- Health:        GET https://YOUR_URL/api/health
- Feed:          GET https://YOUR_URL/api/feed?category=India
- Breaking:      GET https://YOUR_URL/api/breaking
- Translate:     POST JSON {"text":"Hello","target":"hi"} → /api/translate
- TTS:           POST JSON {"text":"नमस्ते"} → /api/tts (returns mp3)
- Azad Studio:   Post a photo/video in your channel → GET /api/azad-studio

Security
- Keep all keys in Render Environment (never in Git).
- Telegram webhook uses secret header (ADMIN_KEY).
- Admin routes require x-admin-key.