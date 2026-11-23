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

async function answerCallback(env, callbackId) {
  return telegram(env, "answerCallbackQuery", { callback_query_id: callbackId });
}

// --- Database & Auth Helpers ---
function isOwner(userId, env) {
  const adminId = env.ADMIN_ID ? String(env.ADMIN_ID).trim() : "";
  const currentId = String(userId).trim();
  return currentId === adminId;
}

async function isMaintenanceMode(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").first();
    return row?.value === "true";
  } catch(e) { return false; }
}

// --- Movie Display (UI) ---
async function showMovie(env, chatId, movieId, edit = false, messageId = null) {
  const movie = await env.DB.prepare("SELECT * FROM movies WHERE id = ?").bind(movieId).first();
  if (!movie) return;

  let caption = `🎬 <b>${movie.title}</b>`;
  if (movie.year) caption += `\n📅 Year: ${movie.year}`;
  if (movie.language) caption += `\n🌐 Language: ${movie.language}`;
  if (movie.description) caption += `\n\n${movie.description}`;

  const keyboard = [[{
    text: "📥 Download / Watch",
    callback_data: `v_${movie.id}`
  }]];

  if (edit && messageId) {
    await telegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: caption,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard }
    });
  } else {
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: caption,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard }
    });
  }
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
    await sendText(env, chatId, "ℹ️ How to use WATCH & CHILL:\n\n- Send a movie name to search.\n- Use /request to ask for a movie.\n- Admin: /addmovie to add new movie.");
    return;
  }

  // --- ID Check (Admin Test) ---
  if (text === "/adminid") {
    await sendText(env, chatId, `Your ID: ${userId}\nBot ADMIN_ID: ${env.ADMIN_ID}`);
    return;
  }

  // --- Maintenance Mode Command ---
  if (text === "/maintenance") {
    if (!isOwner(userId, env)) {
      await sendText(env, chatId, "⛔ Owner only.");
      return;
    }
    const currentMode = await isMaintenanceMode(env);
    const newMode = currentMode ? "false" : "true";
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind("maintenance_mode", newMode).run();
    
    if (newMode === "true") {
      await sendText(env, chatId, "🛠️ Maintenance Mode is now ON.");
    } else {
      await sendText(env, chatId, "✅ Maintenance Mode is now OFF.");
    }
    return;
  }

  // --- Admin Movie Upload ---
  if (text === "/addmovie") {
    if (!isOwner(userId, env)) {
      await sendText(env, chatId, "⛔ Only the Owner can add movies.");
      return;
    }
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`upload_step_${userId}`, "title").run();
    await sendText(env, chatId, "🎬 Send the movie name:");
    return;
  }

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

  // --- User Search Feature ---
  if (text && !text.startsWith("/") && text !== "📩 Request a Movie") {
    const search = `%${text}%`;
    const movies = await env.DB.prepare("SELECT id, title, year FROM movies WHERE title LIKE ? LIMIT 10").bind(search).all();
    
    if (movies.results.length === 0) {
      await sendText(env, chatId, "😕 No movies found for that search.");
    } else {
      const keyboard = movies.results.map(m => [{
        text: `🎬 ${m.title}${m.year ? ` (${m.year})` : ""}`,
        callback_data: `m_${m.id}`
      }]);
      await telegram(env, "sendMessage", {
        chat_id: chatId,
        text: "🔎 Search Results:",
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  }
}

// --- Callback Handler (Button Clicks) ---
async function handleCallback(update, env) {
  const query = update.callback_query;
  const data = query.data || "";
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  await answerCallback(env, query.id);

  if (data.startsWith("m_")) {
    const movieId = data.split("_")[1];
    await showMovie(env, chatId, movieId);
    return;
  }

  if (data.startsWith("v_")) {
    const movieId = data.split("_")[1];
    const movie = await env.DB.prepare("SELECT telegram_file_id, title FROM movies WHERE id = ?").bind(movieId).first();
    if (movie && movie.telegram_file_id) {
      await telegram(env, "sendDocument", {
        chat_id: chatId,
        document: movie.telegram_file_id,
        caption: `Here is your movie: ${movie.title} 🍿`
      });
    }
    return;
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
        } else if (update.callback_query) {
          await handleCallback(update, env);
        }
        return new Response("OK");
      } catch (error) {
        return new Response("Webhook Error", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};
