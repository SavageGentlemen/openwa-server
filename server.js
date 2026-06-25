const fs = require('fs');
const path = require('path');

// 1. Monkey-patch the node_modules to bypass the deprecated window.Debug check
// This fixes the infinite 30s timeout issue in wa-automate caused by WhatsApp Web updates
const patchInitializer = () => {
  const targetPath = path.join(__dirname, 'node_modules', '@open-wa', 'wa-automate', 'dist', 'controllers', 'initializer.js');
  if (fs.existsSync(targetPath)) {
    let content = fs.readFileSync(targetPath, 'utf8');
    
    // Check if the check exists and replace it
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
    
    fs.writeFileSync(targetPath, content, 'utf8');
  } else {
    console.log("⚠️ Could not find initializer.js to patch. Skipping patch.");
  }
};

// Run the patch before importing wa-automate!
patchInitializer();

// 2. Now import and run the rest of the application
const { create } = require("@open-wa/wa-automate");

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.OPENWA_API_KEY || "secure_shared_secret";

// Webhook URL = your Firebase whatsappWebhook Cloud Function
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

console.log("Starting OpenWA WhatsApp Server...");
console.log(`Port: ${PORT}`);
console.log(`Webhook: ${WEBHOOK_URL}`);

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
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable",
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

  // Built-in REST API Express Server config
  port: PORT,
  host: "0.0.0.0",
  apiHost: "0.0.0.0",
  ...(API_KEY && { key: API_KEY }),
  webhook: WEBHOOK_URL || undefined,
};

// Start the OpenWA client
create(clientConfig)
  .then((client) => {
    console.log("✅ WhatsApp client connected successfully!");
    console.log(`🚀 OpenWA API running on port ${PORT}`);

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
    process.exit(1);
  });
