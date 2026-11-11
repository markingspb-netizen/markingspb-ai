# Markingspb AI — video editor you talk to

Write what you want ("make it vertical for Reels and add subtitles"), and Markingspb AI edits the video.

**How it works**
- The video is edited **inside the user's browser** (ffmpeg.wasm). It is never uploaded, which keeps the website free and private.
- Only the text request goes to the AI (**Groq**, free plan, open model Llama 3.3). The AI answers with a list of edit steps.
- Subtitles: the sound (not the video) is sent to Groq Whisper (free) to get the text.

**It can:** trim, cut a part out, change speed, make 9:16 / 16:9 / 1:1 / 4:5, rotate, flip, filters (black and white, sepia, warm, cool, vivid, vintage…), add text, automatic subtitles, change volume, mute, add music, fade in/out. Russian and English.

---

## Put it online — step by step (about 20 minutes)

### Step 1. Get a free Groq key
1. Open **console.groq.com** and sign up.
2. Go to **API Keys** → **Create API Key** → name it `markingspb` → copy the key (it starts with `gsk_`).
3. Keep it secret. Never put it in a file on GitHub.

### Step 2. Put the code on GitHub
1. Unzip `markingspb-ai.zip` on your computer.
2. On **github.com**, click **+** (top right) → **New repository**.
3. Name: `markingspb-ai` → **Create repository**.
4. Click the link **"uploading an existing file"**.
5. Open the unzipped folder, select **everything inside it** (not the folder itself), and drag it into the page.
6. Click **Commit changes**.

### Step 3. Launch on Render
1. Open **dashboard.render.com** → **New +** → **Web Service**.
2. Connect GitHub and choose the `markingspb-ai` repository.
3. Check the settings:
   - Language: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Free**
4. Under **Environment Variables**, add:
   - Key: `GROQ_API_KEY`, Value: your key from Step 1
5. Click **Deploy Web Service**. Wait 2–5 minutes until you see **Live**.
6. Open your link (like `https://markingspb-ai.onrender.com`). 🎉

**Check:** open `your-link/api/health`. You should see `"groq":true`.

### Step 4 (optional). Backup brain
If Groq reaches its daily limit, the app can use OpenRouter's free models:
1. Sign up at **openrouter.ai** → **Keys** → create a key.
2. In Render → your service → **Environment**, add `OPENROUTER_API_KEY`.

---

## How to change things
- **The name and the welcome text:** `public/index.html` and the top of `public/app.js`.
- **The AI's personality and rules:** `prompt.js`.
- **Colors:** the first lines of `public/style.css`.
- **The logo:** `public/logo.svg`.

After you change a file on GitHub (click the file → ✏️ pencil → **Commit changes**), Render updates the site automatically.

## Limits you should know
- **Render free:** the server sleeps after about 15 minutes without visitors, so the first visit can take up to a minute.
- **Groq free:** a daily limit of requests. Enough for you and a small group of users.
- **Browser editing:** best for clips up to about 3 minutes, on a computer. Phones are slower.
- **The first time**, the app downloads the editor (~30 MB). After that, it's cached.
- The site allows 40 AI requests per hour per person (to protect your free limits). Change this with `LIMIT_PER_HOUR`.

## Coming next (step 2)
- Firebase login (Google account) and saved chat history.

---
Font: DejaVu Sans (free license, see `public/fonts/DejaVu-LICENSE.txt`).
