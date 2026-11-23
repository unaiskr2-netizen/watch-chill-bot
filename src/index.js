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

  // --- Admin Movie Upload Feature ---
  if (text === "/addmovie") {
    if (!isOwner(userId, env)) {
      await sendText(env, chatId, "⛔ Only the Owner can add movies.");
      return;
    }
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`upload_step_${userId}`, "title").run();
    await sendText(env, chatId, "🎬 Send the movie name:");
    return;
  }

  // --- Upload Flow Steps ---
  const uploadStep = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`upload_step_${userId}`).first();
  
  if (uploadStep) {
    const step = uploadStep.value;
    const key = `upload_step_${userId}`;

    if (step === "title") {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`temp_title_${userId}`, text).run();
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, "year").run();
      await sendText(env, chatId, "📅 Send the release year, or /skip:");
      return;
    }

    if (step === "year") {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`temp_year_${userId}`, text === "/skip" ? null : text).run();
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, "description").run();
      await sendText(env, chatId, "📝 Send a short description, or /skip:");
      return;
    }

    if (step === "description") {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`temp_description_${userId}`, text === "/skip" ? null : text).run();
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, "file").run();
      await sendText(env, chatId, "📥 Now send the movie file (Video/Document):");
      return;
    }

    if (step === "file") {
      if (message.document || message.video) {
        const fileId = message.document?.file_id || message.video?.file_id;
        const title = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`temp_title_${userId}`).first();
        const year = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`temp_year_${userId}`).first();
        const desc = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`temp_description_${userId}`).first();

        await env.DB.prepare(
          "INSERT INTO movies (title, year, description, telegram_file_id) VALUES (?, ?, ?, ?)"
        ).bind(title?.value, year?.value, desc?.value, fileId).run();

        // Clean up temp data
        await env.DB.prepare("DELETE FROM settings WHERE key LIKE ?").bind(`temp_%_${userId}`).run();
        await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();

        await sendText(env, chatId, "✅ Movie added successfully!");
        return;
      } else {
        await sendText(env, chatId, "⚠️ Please send a valid file.");
        return;
      }
    }
  }

  // --- Search Feature ---
  if (text && !text.startsWith("/")) {
    const search = `%${text}%`;
    const movies = await env.DB.prepare("SELECT title FROM movies WHERE title LIKE ? LIMIT 5").bind(search).all();
    
    if (movies.results.length === 0) {
      await sendText(env, chatId, "😕 No movies found for that search.");
    } else {
      const reply = "🔎 Found movies:\n\n" + movies.results.map(m => `🎬 ${m.title}`).join("\n");
      await sendText(env, chatId, reply);
    }
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
