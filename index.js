require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const mongoose = require("mongoose");

const app = express();
app.use(express.json());

const { PAGE_ACCESS_TOKEN, VERIFY_TOKEN, PORT } = process.env;

// Connect to MongoDB Atlas
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("🍃 Connected to MongoDB Atlas"))
  .catch((err) => console.error("❌ Database connection error:", err));

// Define User Schema
const userSchema = new mongoose.Schema({
  psid: { type: String, required: true, unique: true },
  task_completed: { type: Boolean, default: false },
  otn_token: { type: String, default: null },
});

const User = mongoose.model("User", userSchema);

// Helper function to get or create a user in DB
async function getOrCreateUser(psid) {
  let user = await User.findOne({ psid });
  if (!user) {
    user = await User.create({ psid, task_completed: false, otn_token: null });
  }
  return user;
}

// Helper function to prevent rate-limiting in batch operations
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- 1. STATE MANAGEMENT ---
function getTargetUsers() {
  if (!process.env.TARGET_PSIDS) return [];
  return process.env.TARGET_PSIDS.split(",").map((id) => id.trim());
}

// --- 2. DAILY 5:05 PM SCHEDULER ---
cron.schedule(
  "5 17 * * *",
  async () => {
    console.log("⏰ Running daily 5:05 PM check...");
    const today = new Date().getDay(); // 0 = Sun, 4 = Thu
    const users = getTargetUsers();

    for (const psid of users) {
      // Get user directly from MongoDB
      const user = await getOrCreateUser(psid);

      // Reset completion status every Thursday
      if (today === 4) {
        console.log(`Thursday reset triggered for PSID: ${psid}`);
        user.task_completed = false;
        await user.save(); // Save changes to DB
      }

      // Send reminder if task is still incomplete
      if (user.task_completed === false) {
        try {
          await sendMessengerReminder(
            psid,
            "⏰ Reminder: Have you reminded the host for this week?",
            user,
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
async function sendMessengerReminder(senderPsid, text, userRecord = null) {
  const user = userRecord || (await getOrCreateUser(senderPsid));

  // Default to standard PSID recipient mapping
  let recipientData = { id: senderPsid };
  let usedOtnToken = false;

  // If a valid token exists in the DB, use it instead of the PSID to bypass the 24h window
  if (user.otn_token && !user.otn_token.startsWith("MOCK_TOKEN")) {
    console.log(`🔑 Using real OTN Token for PSID: ${senderPsid}`);
    recipientData = { one_time_notif_token: user.otn_token };
    usedOtnToken = true;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: recipientData, // Passes the token if available, otherwise falls back to ID
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

    // Only consume/delete the token from DB if the message was successfully sent
    if (usedOtnToken) {
      user.otn_token = null;
      await user.save();
    }
  } catch (error) {
    console.error(
      "❌ Error sending reminder:",
      error.response?.data || error.message,
    );
  }
}

// Sends Meta's official Native Opt-In Card
async function sendOTNRequest(senderPsid, titleText, payloadType) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderPsid },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "one_time_notif_req", // Required by Meta for OTN
              title: titleText,
              payload: payloadType,
            },
          },
        },
      },
    );
    console.log(`📤 Native OTN Opt-In card sent to ${senderPsid}`);
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

app.post("/webhook", async (req, res) => {
  let body = req.body;
  res.status(200).send("EVENT_RECEIVED"); // Fast response to Meta

  if (body.object === "page") {
    for (let entry of body.entry) {
      if (!entry.messaging || entry.messaging.length === 0) continue;

      let webhook_event = entry.messaging[0];
      let sender_psid = webhook_event.sender?.id;

      if (!sender_psid) continue;

      // 🔍 DEBUG: Log the incoming event
      console.log(`\n📥 New Webhook Event from PSID: ${sender_psid}`);
      console.log(JSON.stringify(webhook_event, null, 2));

      try {
        // 1. Get user from MongoDB
        const user = await getOrCreateUser(sender_psid);
        console.log(`👤 Database check passed for PSID: ${sender_psid}`);

        // A. HANDLE OFFICIAL OTN OPT-IN RESPONSE
        if (webhook_event.optin) {
          console.log("➡️ Processing Opt-In Event...");
          const optin = webhook_event.optin;
          const token =
            optin.one_time_notif_token || optin.notification_messages_token;
          const payload = optin.payload;

          if (token) {
            user.otn_token = token;
            await user.save();
            console.log(
              `✅ Saved Notification Token to DB for PSID ${sender_psid}: ${token}`,
            );

            const confirmationMsg =
              payload === "OPTIN_TOMORROW_REMINDER"
                ? "👍 Got it! I'll remind you again tomorrow at 5:05 PM."
                : "👍 Got it! I'll ping you next Thursday at 5:05 PM.";

            sendStandardReply(sender_psid, confirmationMsg);
          }
        }

        // B. HANDLE POSTBACKS (In case of Get Started buttons, etc.)
        else if (webhook_event.postback) {
          console.log("➡️ Processing Postback Event...");
          let payload = webhook_event.postback.payload;
          console.log(`Postback Payload: ${payload}`);
          // You can add logic here if you have standard postback buttons
        }

        // C. HANDLE MESSAGES AND QUICK REPLIES
        else if (webhook_event.message) {
          console.log("➡️ Processing Message Event...");
          let quickReplyPayload = webhook_event.message.quick_reply
            ? webhook_event.message.quick_reply.payload
            : null;
          let text = webhook_event.message.text
            ? webhook_event.message.text.toLowerCase().trim()
            : "";

          if (quickReplyPayload === "TASK_YES_PAYLOAD" || text === "yes") {
            user.task_completed = true;
            await user.save();
            console.log("✅ User marked task as YES");
            sendStandardReply(sender_psid, "✅ Marked as done!");

            setTimeout(() => {
              sendOTNRequest(
                sender_psid,
                "Remind you next Thursday at 5:05 PM?",
                "OPTIN_THURSDAY_REMINDER",
              );
            }, 1000);
          } else if (quickReplyPayload === "TASK_NO_PAYLOAD" || text === "no") {
            user.task_completed = false;
            await user.save();
            console.log("🔴 User marked task as NO");
            sendStandardReply(
              sender_psid,
              "Understood. Tap 'Notify Me' below so I can remind you again tomorrow!",
            );

            setTimeout(() => {
              sendOTNRequest(
                sender_psid,
                "Remind you tomorrow at 5:05 PM?",
                "OPTIN_TOMORROW_REMINDER",
              );
            }, 1000);
          } else if (text) {
            const greetings = ["hi", "hello", "hey", "start", "test"];

            console.log(`💬 User said: "${text}"`);

            if (greetings.includes(text)) {
              sendMessengerReminder(
                sender_psid,
                "👋 Hi! Have you completed your task for this week?",
                user,
              );
            } else {
              sendStandardReply(
                sender_psid,
                "I'm an automated task reminder bot! 🤖 Use the buttons above or reply 'hi' to check your task status.",
              );
              console.log(`📤 Standard reply sent for unrecognized text.`);
            }
          }
        }
      } catch (err) {
        console.error("❌ Critical Webhook Error:", err.message);
      }
    }
  }
});

// Ping
app.get("/ping", (req, res) => {
  res.status(200).send("OK");
  console.log(
    `🏓 Ping received at ${new Date().toLocaleString("en-US", {
      timeZone: "Asia/Manila",
      hour12: true,
    })} GMT+8`,
  );
});

// --- 5. START SERVER ---
app.listen(PORT || 3000, () => {
  console.log(`🚀 Server listening on port ${PORT || 3000}`);
});
