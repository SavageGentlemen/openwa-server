const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.OPENWA_API_KEY || "secure_shared_secret";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

console.log("Starting OpenWA WhatsApp Server...");
console.log(`Port: ${PORT}`);
console.log(`Webhook: ${WEBHOOK_URL}`);

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
    const patchedUA = "exports.useragent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';";
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
    const originalCheck = "wapiInjected = !!(yield page.waitForFunction(check, { timeout: 3000, polling: 50 }).catch(e => false));";
    const patchedCheck = "wapiInjected = !!(yield page.waitForFunction(check, { timeout: 30000, polling: 50 }).catch(e => false));";
    if (content.includes(originalCheck)) {
      content = content.replace(originalCheck, patchedCheck);
      console.log("🩹 Patched wapiInjected timeout in browser.js successfully!");
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

patchInitializer();
patchPuppeteerConfig();
patchBrowser();
patchWapi();

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
  headless: true,
  qrTimeout: 0,           // Never timeout waiting for QR scan
  authTimeout: 0,          // Never timeout waiting for auth
  timeout: 120000,         // Increase Puppeteer timeout to 120s for slow containers
  pageTimeout: 120000,     // Increase page load timeout to 120s
  cacheEnabled: false,
  useChrome: true,         // Use Google Chrome
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' ? undefined : "/usr/bin/google-chrome-stable"),
  killProcessOnBrowserClose: true,
  throwErrorOnTosBlock: false,
  chromiumArgs: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-zygote",
    "--single-process"
  ],
  qrPopup: false,
  logging: [{ type: "console" }],
  qrLogSkip: true          // We serve it via the web page, so we can skip logging large text QR to console if desired
};

create(clientConfig)
  .then((client) => {
    console.log("✅ WhatsApp client connected successfully!");
    whatsappClient = client;
    latestQrCode = null; // Clear QR code as we are connected!

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
