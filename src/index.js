const API = "https://api.telegram.org";

// --- Telegram Helpers ---
async function telegram(env, method, data) {
  const response = await fetch(`${API}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return response.json();
}

async function sendText(env, chatId, text) {
  return telegram(env, "sendMessage", { chat_id: chatId, text });
}

// --- Database & Auth Helpers ---
function isOwner(userId, env) {
  return Boolean(userId) && String(userId) === String(env.ADMIN_ID);
}

async function isMaintenanceMode(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").first();
    return row?.value === "true";
  } catch(e) { return false; }
}

// --- Main Message Handler ---
async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = String(message.from?.id || "");
  const text = (message.text || "").trim();

  const maintenance = await isMaintenanceMode(env);
  if (maintenance && !isOwner(userId, env)) {
    await sendText(env, chatId, "🛠️ Under Maintenance!\n\nHey Movie Lovers! 😂 Our movie world is getting a little makeover! We'll be back soon. Stay tuned. 🍿❤️");
    return;
  }

  if (text === "/start") {
    const welcomeText = `👋 Welcome to WATCH & CHILL!\n\n🎬 Send a movie or series name to search.\n📩 Use /request to request a movie.`;
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: welcomeText,
      reply_markup: {
        keyboard: [[{ text: "📩 Request a Movie" }]],
        resize_keyboard: true
      }
    });
    return;
  }

  if (text === "/help") {
    await sendText(env, chatId, "ℹ️ How to use WATCH & CHILL:\n\n- Send a movie name to search.\n- Use /request to ask for a movie.");
    return;
  }

  if (text && !text.startsWith("/")) {
    await sendText(env, chatId, `🔎 Searching for "${text}"... (Feature coming soon)`);
  }
}

// --- Webhook Entry Point ---
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("WATCH & CHILL Bot is running!");
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();
        if (update.message) {
          await handleMessage(update.message, env);
        }
        return new Response("OK");
      } catch (error) {
        return new Response("Webhook Error", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};
