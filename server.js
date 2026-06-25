const { create, ev } = require("@open-wa/wa-automate");

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.OPENWA_API_KEY || "secure_shared_secret";

// Webhook URL = your Firebase whatsappWebhook Cloud Function
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

const start = async () => {
  const client = await create({
    headless: true,
    qrTimeout: 0,           // Never timeout waiting for QR scan
    authTimeout: 0,          // Never timeout waiting for auth
    cacheEnabled: false,
    useChrome: true,
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
    // QR will be printed to the Render logs
    qrPopup: false,
    logging: [{ type: "console" }],
  });

  console.log("✅ WhatsApp client connected!");

  // Forward incoming messages to your Firebase webhook
  if (WEBHOOK_URL) {
    client.onMessage(async (message) => {
      try {
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

  // Start the REST API server
  // This exposes endpoints like /sendText, /getSessionInfo, etc.
  ev.on("api", (api) => {
    console.log(`🚀 OpenWA API ready on port ${PORT}`);
  });
};

// Use the built-in Express server from @open-wa/wa-automate
create({
  headless: true,
  qrTimeout: 0,
  authTimeout: 0,
  cacheEnabled: false,
  useChrome: true,
  killProcessOnBrowserClose: true,
  throwErrorOnTosBlock: false,
  restartOnCrash: start,   // Auto-restart on crash
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

  // --- API SERVER CONFIG ---
  // This starts the built-in Express REST API
  ...(API_KEY && { key: API_KEY }),
  port: PORT,
  host: "0.0.0.0",
  apiHost: "0.0.0.0",
  webhook: WEBHOOK_URL || undefined,
}).then((client) => {
  console.log("✅ WhatsApp client connected!");
  console.log(`🚀 OpenWA API running on port ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY}`);
});
