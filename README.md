# RP App

## Deploy

### 1. Database (Turso)
- Sign up at turso.tech
- `turso db create rp-db`
- `turso db tokens create rp-db` → copy token
- `turso db show rp-db --url` → copy URL

### 2. Backend (Render)
- Connect GitHub repo at render.com
- New Web Service → select repo
- Build: `pip install -r backend/requirements.txt`
- Start: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
- Add env vars: `TURSO_URL`, `TURSO_TOKEN`
- Deploy

### 3. Frontend (Vercel)
- Connect GitHub repo at vercel.com
- Root directory: `frontend`
- Add env var: `REACT_APP_API_URL=https://your-render-url.onrender.com`
- Deploy

### 4. First run
- Open the app → Settings → paste your HF token
- Go to Bots → create a bot
- Go to Chats → start chatting
# rp-app
