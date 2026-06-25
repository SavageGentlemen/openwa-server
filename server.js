const { create, ev } = require("@open-wa/wa-automate");

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
  useChrome: false,        // Use Chromium installed in Docker instead of looking for Chrome
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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
