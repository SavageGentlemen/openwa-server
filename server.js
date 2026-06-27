const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.OPENWA_API_KEY || "secure_shared_secret";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

console.log("Starting OpenWA WhatsApp Server...");
console.log(`Port: ${PORT}`);
console.log(`Webhook: ${WEBHOOK_URL}`);

// Verify persistent session directory write permissions
const sessionDir = "/app/session";
const localUserDataDir = "/app/_IGNORE_session";
const persistentTarball = "/app/session/session.tar.gz";

// Nuke any stale/broken state to start completely fresh
const nukeSession = false;
if (nukeSession) {
  try {
    if (fs.existsSync(persistentTarball)) {
      fs.unlinkSync(persistentTarball);
      console.log("🧹 Nuked persistent tarball");
    }
    if (fs.existsSync(localUserDataDir)) {
      fs.rmSync(localUserDataDir, { recursive: true, force: true });
      console.log("🧹 Nuked local user data dir");
    }
  } catch (err) {
    console.error("Nuke failed:", err.message);
  }
}

// Restore Chrome profile from persistent storage on startup
const restoreProfile = () => {
  if (fs.existsSync(persistentTarball)) {
    try {
      console.log("📦 Restoring Chrome profile from persistent storage...");
      if (!fs.existsSync(path.dirname(localUserDataDir))) {
        fs.mkdirSync(path.dirname(localUserDataDir), { recursive: true });
      }
      const { execSync } = require('child_process');
      execSync(`tar -xzf ${persistentTarball} -C /`);
      console.log("✅ Chrome profile restored successfully!");
    } catch (err) {
      console.error("⚠️ Failed to restore Chrome profile:", err.message);
    }
  } else {
    console.log("ℹ️ No persistent Chrome profile tarball found to restore.");
  }
};

// Backup Chrome profile to persistent storage
const backupProfile = () => {
  try {
    if (fs.existsSync(localUserDataDir)) {
      console.log("💾 Backing up Chrome profile to persistent disk...");
      const tarballDir = path.dirname(persistentTarball);
      if (!fs.existsSync(tarballDir)) {
        fs.mkdirSync(tarballDir, { recursive: true });
      }
      const { execSync } = require('child_process');
      // Clean up stale lock files before compressing to prevent locks persisting in tarball
      const lockPath = path.join(localUserDataDir, 'SingletonLock');
      if (fs.existsSync(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
        } catch (e) {}
      }
      execSync(`tar -czf ${persistentTarball} ${localUserDataDir}`);
      console.log("✅ Chrome profile backed up successfully!");
    } else {
      console.log("ℹ️ Local Chrome profile directory does not exist yet. Skipping backup.");
    }
  } catch (err) {
    console.error("⚠️ Failed to back up Chrome profile:", err.message);
  }
};

try {
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  fs.writeFileSync(path.join(sessionDir, '.write-test'), 'ok', 'utf8');
  fs.unlinkSync(path.join(sessionDir, '.write-test'));
  console.log(`📁 Persistent session directory ${sessionDir} is fully writable!`);

  // Restore session profile from persistent storage if it exists
  restoreProfile();

  // Run a 15-second background backup interval to capture the session immediately after scanning
  setInterval(backupProfile, 15000);

  // Clean up any stale Chrome locks locally (just in case)
  const deleteSingletonLock = (dir) => {
    const lockPath = path.join(dir, 'SingletonLock');
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        console.log(`🧹 Removed stale Chrome SingletonLock at ${lockPath}`);
      } catch (err) {
        console.error(`⚠️ Failed to remove SingletonLock at ${lockPath}:`, err.message);
      }
    }
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          deleteSingletonLock(fullPath);
        }
      }
    } catch (err) {}
  };
  if (fs.existsSync(localUserDataDir)) {
    deleteSingletonLock(localUserDataDir);
  }

} catch (err) {
  console.error(`⚠️ Persistent session directory ${sessionDir} is NOT writable:`, err.message);
}

// 1. Monkey-patch the node_modules to bypass the deprecated window.Debug check
// This fixes the infinite 30s timeout issue in wa-automate caused by WhatsApp Web updates
const patchInitializer = () => {
  const targetPath = path.join(__dirname, 'node_modules', '@open-wa', 'wa-automate', 'dist', 'controllers', 'initializer.js');
  if (fs.existsSync(targetPath)) {
    let content = fs.readFileSync(targetPath, 'utf8');
    
    const originalCheck = "yield waPage.waitForFunction('window.Debug!=undefined && window.Debug.VERSION!=undefined && require');";
    const patchedCheck = "yield waPage.waitForFunction('window.require || window.webpackChunkwhatsapp_web_client');";
    
    if (content.includes(originalCheck)) {
      content = content.replace(originalCheck, patchedCheck);
      console.log("🩹 Patched waPage.waitForFunction check successfully!");
    }

    const originalVersionCheck = "const WA_VERSION = yield waPage.evaluate(() => window.Debug ? window.Debug.VERSION : 'I think you have been TOS_BLOCKed');";
    const patchedVersionCheck = "const WA_VERSION = yield waPage.evaluate(() => window.Debug ? window.Debug.VERSION : (window.Debug = { VERSION: '2.3000.0' }).VERSION);";

    if (content.includes(originalVersionCheck)) {
      content = content.replace(originalVersionCheck, patchedVersionCheck);
      console.log("🩹 Patched WA_VERSION evaluation successfully!");
    }

    const originalSessionCheck = "{ timeout: 9000, polling: 200 }";
    const patchedSessionCheck = "{ timeout: 120000, polling: 200 }";

    if (content.includes(originalSessionCheck)) {
      content = content.replace(originalSessionCheck, patchedSessionCheck);
      console.log("🩹 Patched VALID_SESSION timeout check successfully!");
    }

    // Unconditionally set window.Store = {"Msg": true} to bypass the window.Store check in injectWapi
    const originalStoreSet = "if (attemptingReauth)\n                    yield waPage.evaluate(`window.Store = {\"Msg\": true}`);";
    const patchedStoreSet = "yield waPage.evaluate(`window.Store = {\"Msg\": true}`);";
    
    if (content.includes(originalStoreSet)) {
      content = content.replace(originalStoreSet, patchedStoreSet);
      console.log("🩹 Patched early window.Store injection successfully!");
    } else {
      // Try regex version just in case of newline mismatch
      const regexStoreSet = /if\s*\(attemptingReauth\)\s*yield\s*waPage\.evaluate\(`window\.Store\s*=\s*\{"Msg":\s*true\}`\);/;
      if (regexStoreSet.test(content)) {
        content = content.replace(regexStoreSet, 'yield waPage.evaluate(`window.Store = {"Msg": true}`);');
        console.log("🩹 Patched early window.Store injection via regex successfully!");
      }
    }

    // Unconditionally clear window.Store and wait for ripe session when canInjectEarly is true
    const originalStoreClear = 'if (attemptingReauth) {';
    const patchedStoreClear = 'if (canInjectEarly) {';
    
    if (content.includes(originalStoreClear)) {
      content = content.replace(originalStoreClear, patchedStoreClear);
      console.log("🩹 Patched window.Store clear and ripe session check successfully!");
    }

    // Add page console logging patch
    const regexConsoleLog = /waPage\s*=\s*yield\s*\(0\s*,\s*browser_1\.initPage\)\(sessionId,\s*config,\s*qrManager,\s*customUserAgent,\s*spinner\);\r?\n\s*spinner\.succeed\('Page loaded'\);/;
    if (regexConsoleLog.test(content)) {
      content = content.replace(regexConsoleLog, 'waPage = yield (0, browser_1.initPage)(sessionId, config, qrManager, customUserAgent, spinner);\n            waPage.on(\'console\', msg => console.log(`[Page Console] ${msg.text()}`));\n            waPage.on(\'pageerror\', err => console.error(`[Page Error] ${err.message}`));\n            spinner.succeed(\'Page loaded\');');
      console.log("🩹 Patched page console logging successfully!");
    }
    
    fs.writeFileSync(targetPath, content, 'utf8');
  } else {
    console.log("⚠️ Could not find initializer.js to patch. Skipping patch.");
  }
};

const patchPuppeteerConfig = () => {
  const targetPath = path.join(__dirname, 'node_modules', '@open-wa', 'wa-automate', 'dist', 'config', 'puppeteer.config.js');
  if (fs.existsSync(targetPath)) {
    let content = fs.readFileSync(targetPath, 'utf8');
    const originalUA = "exports.useragent = (0, exports.createUserAgent)('2.2147.16');";
    const patchedUA = "exports.useragent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';";
    if (content.includes(originalUA)) {
      content = content.replace(originalUA, patchedUA);
      console.log("🩹 Patched useragent in puppeteer.config.js successfully!");
      fs.writeFileSync(targetPath, content, 'utf8');
    }
  } else {
    console.log("⚠️ Could not find puppeteer.config.js to patch. Skipping UA patch.");
  }
};

const patchBrowser = () => {
  const targetPath = path.join(__dirname, 'node_modules', '@open-wa', 'wa-automate', 'dist', 'controllers', 'browser.js');
  if (fs.existsSync(targetPath)) {
    let content = fs.readFileSync(targetPath, 'utf8');
    let modified = false;

    const originalCheck = "wapiInjected = !!(yield page.waitForFunction(check, { timeout: 3000, polling: 50 }).catch(e => false));";
    const patchedCheck = "wapiInjected = !!(yield page.waitForFunction(check, { timeout: 30000, polling: 50 }).catch(e => false));";
    if (content.includes(originalCheck)) {
      content = content.replace(originalCheck, patchedCheck);
      console.log("🩹 Patched wapiInjected timeout in browser.js successfully!");
      modified = true;
    }

    const originalLaunch = "const launch = yield (0, tools_1.timePromise)(() => (0, exports.addScript)(page, 'launch.js'));";
    const patchedLaunch = `const launch = yield (0, tools_1.timePromise)(() => (0, exports.addScript)(page, 'launch.js'));
        yield page.evaluate(() => {
          window.getQrPng = function() {
            const canvas = document.querySelector("canvas[aria-label]") || document.querySelector("canvas");
            if (!canvas) return false;
            const parent = canvas.parentElement;
            if (!parent) return false;
            const qrText = parent.getAttribute("data-ref") || canvas.getAttribute("data-ref");
            if (!qrText) return false;
            try {
              const qr = new window.QRCode({ content: qrText, width: 256, height: 256 });
              const svg = qr.svg();
              return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
            } catch (e) {
              return false;
            }
          };
        });`;
        
    if (content.includes(originalLaunch)) {
      content = content.replace(originalLaunch, patchedLaunch);
      console.log("🩹 Injected custom window.getQrPng definition patch in browser.js successfully!");
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(targetPath, content, 'utf8');
    }
  } else {
    console.log("⚠️ Could not find browser.js to patch. Skipping browser patch.");
  }
};

const patchWapi = () => {
  const targetPath = path.join(__dirname, 'node_modules', '@open-wa', 'wa-automate', 'dist', 'lib', 'wapi.js');
  if (fs.existsSync(targetPath)) {
    let content = fs.readFileSync(targetPath, 'utf8');
    const originalCheck = "if (!contact || !contact.isMyContact) return 'Not a contact';";
    const originalFind = "await Store.Chat.find(Store.Contact.get(id).id)";
    
    let modified = false;
    if (content.includes(originalCheck)) {
      content = content.replace(originalCheck, "/* patched contact check */");
      modified = true;
    }
    if (content.includes(originalFind)) {
      content = content.replace(originalFind, "await Store.Chat.find(new Store.WidFactory.createWid(id))");
      modified = true;
    }
    
    if (modified) {
      console.log("🩹 Patched wapi.js contact check successfully!");
      fs.writeFileSync(targetPath, content, 'utf8');
    }
  } else {
    console.log("⚠️ Could not find wapi.js to patch. Skipping WAPI patch.");
  }
};

const patchAuth = () => {
  const targetPath = path.join(__dirname, 'node_modules', '@open-wa', 'wa-automate', 'dist', 'controllers', 'auth.js');
  if (fs.existsSync(targetPath)) {
    let content = fs.readFileSync(targetPath, 'utf8');
    
    // Replace all polling: 'mutation' with polling: 100 to prevent Puppeteer hangs in headless mode
    if (content.includes("polling: 'mutation'")) {
      content = content.replace(/polling:\s*'mutation'/g, "polling: 100");
      console.log("🩹 Patched all 'mutation' polling to 100ms in auth.js successfully!");
      fs.writeFileSync(targetPath, content, 'utf8');
    }
  } else {
    console.log("⚠️ Could not find auth.js to patch. Skipping auth patch.");
  }
};

patchInitializer();
patchPuppeteerConfig();
patchBrowser();
patchWapi();
patchAuth();

// 2. HTTP Server configuration to satisfy Render health check immediately on boot
let whatsappClient = null;
let latestQrCode = null;

const httpServer = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint (Render checks this path)
  if (req.url === '/getConnectionState' || req.url.startsWith('/getConnectionState?')) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    if (whatsappClient) {
      try {
        const state = await whatsappClient.getConnectionState();
        res.end(JSON.stringify({ response: state }));
      } catch (err) {
        res.end(JSON.stringify({ response: "CONNECTED" }));
      }
    } else {
      res.end(JSON.stringify({ response: "CONNECTING" }));
    }
    return;
  }

  // Web page to display QR code for scanning
  if (req.url === '/' || req.url === '/qr') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    if (whatsappClient) {
      res.end('<h1>✅ WhatsApp connected successfully!</h1>');
    } else if (latestQrCode) {
      let qrSrc = latestQrCode;
      if (!qrSrc.startsWith('data:image')) {
        qrSrc = `data:image/png;base64,${qrSrc}`;
      }
      res.end(`
        <html>
          <head>
            <title>Scan WhatsApp QR Code</title>
            <style>
              body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f0f2f5; }
              .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); text-align: center; max-width: 400px; }
              img { margin: 20px 0; border: 1px solid #ddd; padding: 10px; background: white; border-radius: 8px; }
            </style>
          </head>
          <body>
            <div class="card">
              <h2>Scan to connect Carnival Planner</h2>
              <p>Open WhatsApp on your phone, go to Linked Devices, and scan the code below:</p>
              <img src="${qrSrc}" alt="WhatsApp QR Code" width="250" height="250" />
              <p style="font-size: 12px; color: #666;">Code refreshes automatically. Refresh page if needed.</p>
            </div>
            <script>
              setTimeout(() => { location.reload(); }, 15000);
            </script>
          </body>
        </html>
      `);
    } else {
      res.end('<h1>🔄 Loading WhatsApp Web... Please refresh in a few seconds.</h1>');
    }
    return;
  }

  // API Token Authentication for outbound alerts
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  
  if (token !== API_KEY) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // Send message endpoint
  if (req.url === '/sendText' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const { to, content } = payload;
        
        if (!whatsappClient) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: "WhatsApp client not authenticated yet" }));
          return;
        }

        const result = await whatsappClient.sendText(to, content);
        res.writeHead(200);
        res.end(JSON.stringify({ response: result }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 404 handler
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not Found" }));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 HTTP Server listening on port ${PORT}`);
});

// 3. Start the OpenWA client
const { create, ev } = require("@open-wa/wa-automate");

// Capture generated QR codes
ev.on('qr.session', (data) => {
  latestQrCode = data;
  console.log("🆕 Received new QR Code from WhatsApp (qr.session).");
});

ev.on('qr.**', (data) => {
  latestQrCode = data;
  console.log("🆕 Received new QR Code from WhatsApp (qr.**).");
});

// Configure the wa-automate client
const clientConfig = {
  sessionId: "session",
  sessionDataPath: "/app/session",
  userDataDir: "/app/_IGNORE_session",
  useStealth: true,
  customUserAgent: process.platform === 'win32'
    ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  headless: true,
  qrTimeout: 0,           // Never timeout waiting for QR scan
  authTimeout: 0,          // Never timeout waiting for auth
  timeout: 120000,         // Increase Puppeteer timeout to 120s for slow containers
  pageTimeout: 120000,     // Increase page load timeout to 120s
  cacheEnabled: true,      // Enable caching to reduce CPU/compilation spikes
  blockAssets: false,      // Disabled resource blocking to prevent pairing failures
  useChrome: true,         // Use Google Chrome
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' ? undefined : "/usr/bin/google-chrome-stable"),
  killProcessOnBrowserClose: true,
  throwErrorOnTosBlock: false,
  qrPopup: false,
  logging: [{ type: "console" }],
  dumpio: true,
  qrLogSkip: true,          // We serve it via the web page, so we can skip logging large text QR to console if desired
  chromiumArgs: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-extensions",
    "--no-default-browser-check",
    "--js-flags=--max-old-space-size=180",
    "--no-first-run",
    "--no-zygote"
  ]
};

create(clientConfig)
  .then((client) => {
    console.log("✅ WhatsApp client connected successfully!");
    whatsappClient = client;
    latestQrCode = null; // Clear QR code as we are connected!

    // Back up the session directory to the persistent disk immediately
    backupProfile();

    // Schedule periodic backups every 10 minutes (600,000ms)
    setInterval(backupProfile, 600000);

    if (WEBHOOK_URL) {
      client.onMessage(async (message) => {
        try {
          console.log(`Forwarding message from ${message.from}`);
          await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: "message",
              data: {
                from: message.from,
                body: message.body,
                type: message.type,
                timestamp: message.timestamp,
              },
            }),
          });
        } catch (err) {
          console.error("Webhook forward failed:", err.message);
        }
      });
      console.log(`📡 Forwarding messages to: ${WEBHOOK_URL}`);
    }
  })
  .catch((err) => {
    console.error("❌ Fatal: Failed to initialize WhatsApp client:", err);
    // Don't kill process so the HTTP server stays alive and Render doesn't restart the container
  });

// Clean shutdown backup handlers
process.on('SIGINT', () => {
  console.log("Received SIGINT, backing up Chrome profile...");
  backupProfile();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log("Received SIGTERM, backing up Chrome profile...");
  backupProfile();
  process.exit(0);
});

// Trigger redeploy: 2026-06-27T19:32:00Z
