require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const { PAGE_ACCESS_TOKEN, VERIFY_TOKEN, PORT } = process.env;

// Helper function to prevent rate-limiting in batch operations
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 1. STATE MANAGEMENT ---
// Database schema: db[psid] = { task_completed: boolean, otn_token: string | null }
const db = {};

function getTargetUsers() {
  if (!process.env.TARGET_PSIDS) return [];
  return process.env.TARGET_PSIDS.split(",").map((id) => id.trim());
}

// --- 2. DAILY 5:00 PM SCHEDULER ---
cron.schedule(
  "0 17 * * *",
  async () => {
    console.log("⏰ Running daily 5:00 PM check...");
    const today = new Date().getDay(); // 0 = Sun, 4 = Thu
    const users = getTargetUsers();

    for (const psid of users) {
      if (!db[psid]) {
        db[psid] = { task_completed: true, otn_token: null };
      }

      const user = db[psid];

      // Reset completion status every Thursday
      if (today === 4) {
        console.log(`Thursday reset triggered for PSID: ${psid}`);
        user.task_completed = false;
      }

      // Send reminder if task is still incomplete
      if (user.task_completed === false) {
        try {
          await sendMessengerReminder(
            psid,
            "⏰ Reminder: Have you reminded the host for this week?",
          );
          // Wait 500ms between users to respect Meta's Send API rate limits
          await sleep(500);
        } catch (error) {
          console.error(`❌ Cron error sending to ${psid}:`, error.message);
        }
      }
    }
  },
  {
    timezone: "Asia/Manila",
  },
);

// --- 3. SEND API (Outbound Messages) ---

// Sends a reminder with YES / NO quick reply buttons
async function sendMessengerReminder(senderPsid, text) {
  const user = db[senderPsid] || {};

  // Log token presence for debugging, but ALWAYS use recipient.id for Send API
  if (user.otn_token) {
    console.log(`🔑 Virtual Opt-In Token active for PSID: ${senderPsid}`);
    user.otn_token = null; // Consume virtual token
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderPsid }, // 👈 Fix: Always send to recipient ID
        message: {
          text: text,
          quick_replies: [
            {
              content_type: "text",
              title: "YES 🟢",
              payload: "TASK_YES_PAYLOAD",
            },
            {
              content_type: "text",
              title: "NO 🔴",
              payload: "TASK_NO_PAYLOAD",
            },
          ],
        },
      },
    );
    console.log(`📤 Reminder sent to ${senderPsid}`);
  } catch (error) {
    console.error(
      "❌ Error sending reminder:",
      error.response?.data || error.message,
    );
  }
}
// Sends an Opt-In Card with dynamic text and postback payload
async function sendOTNRequest(senderPsid, subtitleText, payloadType) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderPsid },
        messaging_type: "RESPONSE",
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "generic",
              elements: [
                {
                  title: "Weekly Reminder Opt-In",
                  subtitle: subtitleText,
                  buttons: [
                    {
                      type: "postback",
                      title: "Notify Me 🔔",
                      payload: payloadType,
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    );
    console.log(`📤 Reminder Opt-In card sent to ${senderPsid}`);
  } catch (error) {
    console.error(
      "❌ Error sending Opt-In card:",
      error.response?.data || error.message,
    );
  }
}

// Sends a simple text reply
async function sendStandardReply(senderPsid, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderPsid },
        messaging_type: "RESPONSE",
        message: { text: text },
      },
    );
  } catch (error) {
    console.error(
      "❌ Error sending standard reply:",
      error.response?.data || error.message,
    );
  }
}

// --- 4. WEBHOOK SETUP ---
app.get("/webhook", (req, res) => {
  let mode = req.query["hub.mode"];
  let token = req.query["hub.verify_token"];
  let challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", (req, res) => {
  let body = req.body;
  res.status(200).send("EVENT_RECEIVED"); // Fast response to Meta

  if (body.object === "page") {
    body.entry.forEach((entry) => {
      if (!entry.messaging || entry.messaging.length === 0) return;

      let webhook_event = entry.messaging[0];
      let sender_psid = webhook_event.sender?.id;

      if (!sender_psid) return; // Guard against events lacking a sender ID

      // Ensure user record exists
      if (!db[sender_psid]) {
        db[sender_psid] = { task_completed: false, otn_token: null };
      }

      // A. HANDLE POSTBACK BUTTON TAPS (e.g., "Notify Me 🔔")
      if (webhook_event.postback) {
        let payload = webhook_event.postback.payload;

        if (
          payload === "OPTIN_THURSDAY_REMINDER" ||
          payload === "OPTIN_TOMORROW_REMINDER"
        ) {
          // Safeguard against duplicate button taps
          if (db[sender_psid].otn_token) {
            console.log(
              `⚠️ User ${sender_psid} already opted in. Ignoring duplicate tap.`,
            );
            return;
          }

          db[sender_psid].otn_token = `MOCK_TOKEN_${Date.now()}`;
          console.log(
            `✅ User opted in! Virtual Token stored for PSID: ${sender_psid}`,
          );

          // Dynamic reply based on which card they clicked
          const confirmationMsg =
            payload === "OPTIN_TOMORROW_REMINDER"
              ? "👍 Got it! I'll remind you again tomorrow at 5 PM."
              : "👍 Got it! I'll ping you next Thursday at 5 PM.";

          sendStandardReply(sender_psid, confirmationMsg);
        }
      }

      // B. HANDLE OTN OPT-IN RESPONSE (Native OTN fallback)
      else if (webhook_event.optin) {
        const optin = webhook_event.optin;
        const token =
          optin.one_time_notif_token || optin.notification_messages_token;

        if (token) {
          db[sender_psid].otn_token = token;
          console.log(
            `✅ Saved Notification Token for PSID ${sender_psid}: ${token}`,
          );
          sendStandardReply(
            sender_psid,
            "👍 Got it! I'll ping you next Thursday at 5 PM.",
          );
        }
      }

      // C. HANDLE MESSAGES AND QUICK REPLIES
      else if (webhook_event.message) {
        let quickReplyPayload = webhook_event.message.quick_reply
          ? webhook_event.message.quick_reply.payload
          : null;
        let text = webhook_event.message.text
          ? webhook_event.message.text.toLowerCase().trim()
          : "";

        if (quickReplyPayload === "TASK_YES_PAYLOAD" || text === "yes") {
          db[sender_psid].task_completed = true;
          sendStandardReply(sender_psid, "✅ Marked as done!");

          setTimeout(() => {
            // Send card configured for NEXT THURSDAY
            sendOTNRequest(
              sender_psid,
              "Remind you next Thursday at 5 PM?",
              "OPTIN_THURSDAY_REMINDER",
            );
          }, 1000);
        } else if (quickReplyPayload === "TASK_NO_PAYLOAD" || text === "no") {
          db[sender_psid].task_completed = false;
          sendStandardReply(
            sender_psid,
            "Understood. Tap 'Notify Me' below so I can remind you again tomorrow!",
          );

          setTimeout(() => {
            // Send card configured for TOMORROW
            sendOTNRequest(
              sender_psid,
              "Remind you tomorrow at 5 PM?",
              "OPTIN_TOMORROW_REMINDER",
            );
          }, 1000);
        }

        // 👇 THIS IS THE MISSING PART THAT CATCHES "HI" AND OTHER TEXT 👇
        else if (text) {
          const greetings = ["hi", "hello", "hey", "start"];

          if (greetings.includes(text)) {
            sendMessengerReminder(
              sender_psid,
              "👋 Hi! Have you completed your task for this week?",
            );
          } else {
            // Default fallback response for random chat text
            sendStandardReply(
              sender_psid,
              "I'm an automated task reminder bot! 🤖 Use the buttons above or reply 'hi' to check your task status.",
            );
          }
        }
      }
    });
  }
});

// --- 5. START SERVER ---
app.listen(PORT || 3000, () => {
  console.log(`🚀 Server listening on port ${PORT || 3000}`);
});
