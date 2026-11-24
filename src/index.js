const API = "https://api.telegram.org";
const OWNER_ID = "8719558690";

// --- Telegram Helpers ---
async function telegram(env, method, data) {
  const response = await fetch(`${API}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return response.json();
}

async function sendText(env, chatId, text, replyMarkup = undefined) {
  return telegram(env, "sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
}

async function answerCallback(env, callbackId, text = "") {
  return telegram(env, "answerCallbackQuery", { callback_query_id: callbackId, text });
}

// --- Database & Auth Helpers ---
function isOwner(userId, env) {
  const adminId = env.ADMIN_ID ? String(env.ADMIN_ID).trim() : OWNER_ID;
  return String(userId).trim() === adminId;
}

async function isMaintenanceMode(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'maintenance_mode'").first();
    return row?.value === "true";
  } catch(e) { return false; }
}

// --- Movie Display (UI) ---
async function showMovieDetails(env, chatId, movieId, messageId = null) {
  const movie = await env.DB.prepare("SELECT * FROM movies WHERE id = ? AND is_deleted = 0").bind(movieId).first();
  if (!movie) {
    await sendText(env, chatId, "😕 Movie not found or has been deleted.");
    return;
  }

  let caption = `🎬 <b>${movie.title}</b>\n`;
  if (movie.year) caption += `📅 Year: ${movie.year}\n`;
  if (movie.quality) caption += `📺 Quality: ${movie.quality}\n`;
  if (movie.language) caption += `🌐 Language: ${movie.language}\n`;
  if (movie.subtitle) caption += `📝 Subtitle: ${movie.subtitle}\n`;
  if (movie.description) caption += `\n📖 ${movie.description}`;

  const keyboard = [[{ text: "📥 Download Movie", callback_data: `dl_${movie.id}` }]];

  if (messageId) {
    await telegram(env, "editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption: caption,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard }
    });
  } else {
    if (movie.poster_file_id) {
      await telegram(env, "sendPhoto", {
        chat_id: chatId,
        photo: movie.poster_file_id,
        caption: caption,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard }
      });
    } else {
      await sendText(env, chatId, caption, { inline_keyboard: keyboard });
    }
  }
}

// --- Main Message Handler ---
async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = String(message.from?.id || "");
  const text = (message.text || "").trim();
  const isAdmin = isOwner(userId, env);

  const maintenance = await isMaintenanceMode(env);
  if (maintenance && !isAdmin) {
    await sendText(env, chatId, "🛠️ Under Maintenance!\n\nHey Movie Lovers! 😂 Our movie world is getting a little makeover! We'll be back soon. Stay tuned. 🍿❤️");
    return;
  }

  if (text === "/start") {
    const welcomeText = `👋 Welcome to WATCH & CHILL!\n\n🎬 Send a movie name to search.`;
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

  // --- Admin Movie Upload Flow ---
  if (text === "/addmovie") {
    if (!isAdmin) return await sendText(env, chatId, "⛔ Admin only.");
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`upload_step_${userId}`, "title").run();
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE ?").bind(`temp_%_${userId}`).run(); // clear old temp
    return await sendText(env, chatId, "🎬 Send the movie name:");
  }

  const uploadState = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`upload_step_${userId}`).first();
  if (uploadState && isAdmin) {
    const step = uploadState.value;
    const key = `upload_step_${userId}`;

    if (step === "title") {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`temp_title_${userId}`, text).run();
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, "year").run();
      return await sendText(env, chatId, "📅 Send the release year (or /skip):");
    }
    if (step === "year") {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`temp_year_${userId}`, text === "/skip" ? "" : text).run();
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, "quality").run();
      return await sendText(env, chatId, "📺 Send the quality (e.g., 1080p, 720p) (or /skip):");
    }
    if (step === "quality") {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`temp_quality_${userId}`, text === "/skip" ? "" : text).run();
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, "language").run();
      return await sendText(env, chatId, "🌐 Send the language (or /skip):");
    }
    if (step === "language") {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`temp_language_${userId}`, text === "/skip" ? "" : text).run();
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, "subtitle").run();
      return await sendText(env, chatId, "📝 Send subtitle availability (e.g., English) (or /skip):");
    }
    if (step === "subtitle") {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`temp_subtitle_${userId}`, text === "/skip" ? "" : text).run();
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, "poster").run();
      return await sendText(env, chatId, "🖼 Send the movie poster as a photo (or /skip):");
    }
    if (step === "poster") {
      let posterId = "";
      if (message.photo) {
        posterId = message.photo[message.photo.length - 1].file_id;
      } else if (text !== "/skip") {
        return await sendText(env, chatId, "⚠️ Please send a photo or /skip.");
      }
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`temp_poster_${userId}`, posterId).run();
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, "description").run();
      return await sendText(env, chatId, "📖 Send a short description (or /skip):");
    }
    if (step === "description") {
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(`temp_desc_${userId}`, text === "/skip" ? "" : text).run();
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, "file").run();
      return await sendText(env, chatId, "📥 Finally, send the movie video/document file:");
    }
    if (step === "file") {
      if (!message.document && !message.video) {
        return await sendText(env, chatId, "⚠️ Please send a valid video or document file.");
      }
      const fileId = message.document?.file_id || message.video?.file_id;
      
      const getVal = async (k) => (await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(`temp_${k}_${userId}`).first())?.value || null;
      
      const title = await getVal("title");
      const year = await getVal("year");
      const quality = await getVal("quality");
      const language = await getVal("language");
      const subtitle = await getVal("subtitle");
      const poster = await getVal("poster");
      const desc = await getVal("desc");

      await env.DB.prepare(
        "INSERT INTO movies (title, year, quality, language, subtitle, poster_file_id, description, telegram_file_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(title, year, quality, language, subtitle, poster, desc, fileId).run();

      await env.DB.prepare("DELETE FROM settings WHERE key LIKE ?").bind(`temp_%_${userId}`).run();
      await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
      return await sendText(env, chatId, "✅ Movie added successfully to Database!");
    }
  }

  // --- Search Feature ---
  if (text && !text.startsWith("/") && text !== "📩 Request a Movie") {
    const search = `%${text}%`;
    const movies = await env.DB.prepare("SELECT id, title, year FROM movies WHERE title LIKE ? AND is_deleted = 0 LIMIT 10").bind(search).all();
    
    if (movies.results.length === 0) {
      await sendText(env, chatId, "😕 No movies found for that search.");
    } else {
      const keyboard = movies.results.map(m => [{
        text: `🎬 ${m.title}${m.year ? ` (${m.year})` : ""}`,
        callback_data: `view_${m.id}`
      }]);
      await sendText(env, chatId, "🔎 Search Results:", { inline_keyboard: keyboard });
    }
  }
}

// --- Callback Handler ---
async function handleCallback(update, env) {
  const query = update.callback_query;
  const data = query.data || "";
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  await answerCallback(env, query.id);

  if (data.startsWith("view_")) {
    const movieId = data.split("_")[1];
    await showMovieDetails(env, chatId, movieId);
    return;
  }

  if (data.startsWith("dl_")) {
    const movieId = data.split("_")[1];
    const movie = await env.DB.prepare("SELECT telegram_file_id, title FROM movies WHERE id = ? AND is_deleted = 0").bind(movieId).first();
    if (movie && movie.telegram_file_id) {
      await telegram(env, "sendDocument", {
        chat_id: chatId,
        document: movie.telegram_file_id,
        caption: `Here is your movie: ${movie.title} 🍿`
      });
    } else {
      await sendText(env, chatId, "⚠️ File not found.");
    }
    return;
  }
}

// --- Webhook ---
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("Bot is running!");
    
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();
        if (update.message) await handleMessage(update.message, env);
        else if (update.callback_query) await handleCallback(update, env);
        return new Response("OK");
      } catch (e) {
        return new Response("Error", { status: 500 });
      }
    }
    return new Response("Not Found", { status: 404 });
  }
};
