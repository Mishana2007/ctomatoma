const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
const XLSX = require("xlsx");
// const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const {
  GoogleAIFileManager,
  FileState,
  GoogleAICacheManager,
} = require("@google/generative-ai/server");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require('form-data');
require("dotenv").config();

// Конфигурация бота
const token = process.env.TELEGRAM_BOT_TOKEN;
//TokenStoma;
const genAI = new GoogleGenerativeAI(process.env.GENAI1);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const fileManager = new GoogleAIFileManager(process.env.GENAI1);
let actualBotUsername = "@umodnobot";
const bot = new TelegramBot(token, { polling: true });

const appointmentMessages = new Map();

// Список админов (их Telegram ID)
const ADMINS = [453834377, 22566, 5084589177];

// Подключение к базе данных
const db = new sqlite3.Database("users.db", (err) => {
  if (err) {
    console.error("Database connection error:", err);
    process.exit(1);
  }
  console.log("Connected to the database successfully");
});

// Создаем папку для фотографий, если её нет
const PHOTOS_DIR = path.join(__dirname, "teeth_photos");
if (!fs.existsSync(PHOTOS_DIR)) {
  fs.mkdirSync(PHOTOS_DIR);
}

// Создание всех таблиц базы данных
db.serialize(() => {
  // Таблица пользователей
  db.run(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY,
            phone TEXT,
            email TEXT,
            birthdate TEXT,
            gender TEXT CHECK(gender IN ('male', 'female')),
            full_name TEXT,
            registration_step TEXT,
            referral_count INTEGER DEFAULT 0,
            is_admin INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
            username TEXT,
            bonuses INTEGER DEFAULT 0
        )
    `);

  // Таблица рефералов
  db.run(`
        CREATE TABLE IF NOT EXISTS referrals (
            referrer_id INTEGER,
            referred_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (referrer_id, referred_id),
            FOREIGN KEY (referrer_id) REFERENCES users(telegram_id),
            FOREIGN KEY (referred_id) REFERENCES users(telegram_id)
        )
    `);

  // Таблица акций
  db.run(`
        CREATE TABLE IF NOT EXISTS promotions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_active INTEGER DEFAULT 1,
            start_date DATE DEFAULT CURRENT_DATE,
            end_date DATE,
            deleted_at DATETIME
        )
    `);

  // Таблица просмотров акций
  db.run(`
        CREATE TABLE IF NOT EXISTS promotion_views (
            promotion_id INTEGER,
            user_id INTEGER,
            viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (promotion_id, user_id),
            FOREIGN KEY (promotion_id) REFERENCES promotions(id),
            FOREIGN KEY (user_id) REFERENCES users(telegram_id)
        )
    `);

  // Таблица заявок
  db.run(`
        CREATE TABLE IF NOT EXISTS appointment_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER,
            status TEXT DEFAULT 'pending',
            admin_comment TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            processed_at DATETIME,
            processed_by INTEGER,
            data_snapshot TEXT,
            appointment_date TEXT,
            appointment_time TEXT,
            FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
            FOREIGN KEY (processed_by) REFERENCES users(telegram_id)
        )
    `);

  // Таблица истории бонусов
  db.run(`
        CREATE TABLE IF NOT EXISTS bonus_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            amount INTEGER NOT NULL,
            operation_type TEXT CHECK(operation_type IN ('add', 'subtract')),
            admin_id INTEGER,
            comment TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(telegram_id),
            FOREIGN KEY (admin_id) REFERENCES users(telegram_id)
        )
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS teeth_analysis_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
        )
    `);

  // Создание индексов
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_promotions_active ON promotions(is_active)`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_promotions_dates ON promotions(start_date, end_date)`
  );
});

// Константы состояний и шагов
const STEPS = {
    PHONE: "PHONE",
    BIRTHDATE: "BIRTHDATE",
    GENDER: "GENDER",
    FULL_NAME: "FULL_NAME",
    COMPLETED: "COMPLETED",
  };

const EDIT_STATES = {
  WAITING_FOR_FIELD: "WAITING_FOR_FIELD",
  EDITING_PHONE: "EDITING_PHONE",
  EDITING_EMAIL: "EDITING_EMAIL",
  EDITING_BIRTHDATE: "EDITING_BIRTHDATE",
  EDITING_FULLNAME: "EDITING_FULLNAME",
  EDITING_GENDER: "EDITING_GENDER",
  EDITING_ALL: "EDITING_ALL",
};

const APPOINTMENT_STATES = {
  CONFIRMING_DATA: "CONFIRMING_DATA",
  CHOOSING_EDIT_FIELD: "CHOOSING_EDIT_FIELD",
  SUBMITTING_REQUEST: "SUBMITTING_REQUEST",
};

// Добавим новые состояния для процесса одобрения заявки
const APPROVAL_STATES = {
  WAITING_FOR_DATE: "WAITING_FOR_DATE",
  WAITING_FOR_TIME: "WAITING_FOR_TIME",
};

// Функция для валидации времени
function validateTime(time) {
  return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time);
}

// Клавиатуры
const mainMenuKeyboard = {
  keyboard: [
    ["📝 Запись на прием", "💫 Акции"],
    ["💬 Оставить отзыв", "ℹ️ О клинике"],
    ["👤 Профиль", "🤝 Рекомендовать"],
    ["🦷 Анализ зубов"],
  ],
  resize_keyboard: true,
};

const adminMenuKeyboard = {
  keyboard: [
    ["📝 Запись на прием", "💫 Акции"],
    ["💬 Оставить отзыв", "ℹ️ О клинике"],
    ["👤 Профиль", "🤝 Рекомендовать"],
    ["⚙️ Админ-панель", "🦷 Анализ зубов"],
  ],
  resize_keyboard: true,
};

// Обновляем adminPanelKeyboard
const adminPanelKeyboard = {
  keyboard: [
    ["📊 Статистика", "📋 Заявки"],
    ["📢 Рассылка", "👥 АКЦИИ"],
    ["📁 История заявок"],
    ["➕ Начислить бонусы", "➖ Списать бонусы"],
    ["◀️ Назад в меню"],
  ],
  resize_keyboard: true,
};
const backKeyboard = {
  keyboard: [["◀️ Назад в меню"]],
  resize_keyboard: true,
};

const backToAppointmentKeyboard = {
  keyboard: [["◀️ Назад к заявке"]],
  resize_keyboard: true,
};

const skipKeyboard = {
  keyboard: [["⏭️ Пропустить"]],
  resize_keyboard: true,
};

// Map для хранения состояний пользователей
const userStates = new Map();

async function getMonthlyRequestCount(chatId) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT COUNT(*) as count FROM teeth_analysis_requests WHERE telegram_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')",
      [chatId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      }
    );
  });
}

async function recordTeethAnalysisRequest(chatId) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO teeth_analysis_requests (telegram_id) VALUES (?)",
      [chatId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Базовые функции для работы с базой данных
async function getUserInfo(userId) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT * FROM users WHERE telegram_id = ?",
      [userId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

async function updateUser(userId, field, value) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE users SET ${field} = ?, last_activity = DATETIME('now') WHERE telegram_id = ?`,
      [value, userId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

async function updateMultipleFields(userId, updates) {
  const fields = Object.keys(updates);
  const values = Object.values(updates);
  const setClause = fields.map((field) => `${field} = ?`).join(", ");

  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE users SET ${setClause}, last_activity = DATETIME('now') WHERE telegram_id = ?`,
      [...values, userId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

async function isAdmin(userId) {
  try {
    const user = await getUserInfo(userId);
    return ADMINS.includes(userId) || (user && user.is_admin === 1);
  } catch (error) {
    console.error("Error checking admin status:", error);
    return false;
  }
}

// Функции форматирования и валидации
function formatDate(date) {
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function validatePhone(phone) {
  return /^\+7\d{10}$/.test(phone);
}

function validateDate(date) {
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(date)) return false;

  const [day, month, year] = date.split(".").map(Number);
  const dateObj = new Date(year, month - 1, day);

  return (
    dateObj.getDate() === day &&
    dateObj.getMonth() === month - 1 &&
    dateObj.getFullYear() === year &&
    year >= 1900 &&
    year <= new Date().getFullYear()
  );
}

// function validateEmail(email) {
//   return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
// }

function validateFullName(name) {
  const parts = name.trim().split(" ");
  return (
    parts.length >= 3 &&
    parts.every((part) => part.length >= 2 && /^[А-ЯЁ][а-яё]+$/.test(part))
  );
}

function formatUserDataForConfirmation(user) {
    return (
      `*👤 ФИО:* ${user.full_name || "Не указано"}\n` +
      `*📱 Телефон:* ${user.phone || "Не указан"}\n` +
      `*📅 Дата рождения:* ${user.birthdate || "Не указана"}\n` +
      `*👥 Пол:* ${user.gender === "male" ? "Мужской" : "Женский"}\n`
    );
  }

// Вспомогательные функции для заявок
function getStatusText(status) {
  switch (status) {
    case "pending":
      return "⏳ Ожидает рассмотрения";
    case "approved":
      return "✅ Одобрена";
    case "rejected":
      return "❌ Отклонена";
    default:
      return "❔ Неизвестный статус";
  }
}

function getStatusEmoji(status) {
  switch (status) {
    case "pending":
      return "⏳";
    case "approved":
      return "✅";
    case "rejected":
      return "❌";
    default:
      return "❔";
  }
}

// Функция для отображения главного меню
const userLastMessage = new Map(); // Храним ID последнего сообщения, чтобы не спамить

async function showMainMenu(chatId) {
  try {
    const isUserAdmin = await isAdmin(chatId);
    const keyboard = isUserAdmin ? adminMenuKeyboard : mainMenuKeyboard;
    const text = "🔹 Главное меню";

    // Проверяем, есть ли у пользователя последнее сообщение с меню
    if (userLastMessage.has(chatId)) {
      return; // Если уже отправлено, не отправляем снова
    }

    const sentMessage = await bot.sendMessage(chatId, text, {
      reply_markup: keyboard,
    });

    // Запоминаем ID сообщения, чтобы не дублировать
    userLastMessage.set(chatId, sentMessage.message_id);

    // Через 2-3 секунды удаляем ID из памяти, чтобы можно было снова открыть меню
    setTimeout(() => userLastMessage.delete(chatId), 3000);
  } catch (error) {
    console.error("Error in showMainMenu:", error);
    await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
  }
}

// Функции для работы со списком администраторов
async function getAdminsList() {
  try {
    const dbAdmins = await new Promise((resolve, reject) => {
      db.all(
        "SELECT telegram_id FROM users WHERE is_admin = 1",
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows.map((row) => row.telegram_id));
        }
      );
    });
    return [...new Set([...ADMINS, ...dbAdmins])];
  } catch (error) {
    console.error("Error getting admins list:", error);
    return ADMINS;
  }
}

// Функция для валидации полей ввода
async function sendValidationError(chatId, field) {
  let message = "";
  switch (field) {
    case "phone":
      message =
        "Пожалуйста, введите корректный номер телефона в формате +7XXXXXXXXXX";
      break;
    case "birthdate":
      message = "Пожалуйста, введите корректную дату в формате ДД.ММ.ГГГГ";
      break;
    case "email":
      message = "Пожалуйста, введите корректный email";
      break;
    case "fullname":
      message = "Пожалуйста, введите ФИО полностью (Фамилия Имя Отчество)";
      break;
  }
  await bot.sendMessage(chatId, message);
}

// Инициализация OpenAI
// const openai = new OpenAI({
//     apiKey: process.env.OPENAI_API_KEY
// });

// Функции для работы с фотографиями
async function clearOldPhotos(userId) {
  const userPhotoPattern = new RegExp(`^${userId}_.*\\.jpg$`);
  const files = fs.readdirSync(PHOTOS_DIR);

  for (const file of files) {
    if (userPhotoPattern.test(file)) {
      fs.unlinkSync(path.join(PHOTOS_DIR, file));
    }
  }
}

async function handleTeethPhoto(msg) {
  const chatId = msg.chat.id;
  const state = userStates.get(chatId);

  if (state && state.state === "WAITING_FOR_TEETH_PHOTO") {
    try {
      bot.sendMessage(chatId, `🔍 Анализирую фотографию ваших зубов...`);
      // Получаем ID последней фотографии из массива photo
      const photoId = msg.photo[msg.photo.length - 1].file_id;

      // Получаем URL для скачивания фотографии
      const file = await bot.getFile(photoId);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

      // Скачиваем фотографию
      const photoResponse = await axios.get(fileUrl, {
        responseType: "arraybuffer",
      });
      const fs = require("fs");
      const filePath = `/tmp/${photoId}.jpg`; // Путь для временного сохранения

      // Сохраняем файл
      fs.writeFileSync(filePath, photoResponse.data);

      // Загружаем файл в Gemini
      const uploadResult = await fileManager.uploadFile(filePath, {
        mimeType: "image/jpeg",
      });

      // Подготовка файла для запроса
      const photoPart = {
        fileData: {
          fileUri: uploadResult.file.uri,
          mimeType: uploadResult.file.mimeType,
        },
      };

      // Формируем промпт для модели
      const prompt = `
                ТЫ - ВЕДУЩИЙ ЭКСПЕРТ В ОБЛАСТИ СТОМАТОЛОГИИ. ТВОЯ ЗАДАЧА - НА ОСНОВЕ ПРЕДОСТАВЛЕННОГО ФОТО сделать предварительный анализ СОСТОЯНИЯ ЗУБОВ И ДЁСЕН, а также прикуса и кривости зубов, ПРЕДЛОЖИТЬ РЕКОМЕНДАЦИИ ПО ЕЖЕДНЕВНОМУ УХОДУ. УТОЧНИТЬ если СЛЕДУЕТ ОБРАТИТЬСЯ К СТОМАТОЛОГУ.

                ЦЕЛИ:
                Сделать предварительный анализ ФОТО ПО СЛЕДУЮЩИМ КРИТЕРИЯМ:
                - Цвет зубов: белизна, пятна, изменение цвета
                - Поверхность зубов: трещины, сколы, неровности
                - Состояние дёсен: покраснение, отёк, кровоточивость
                - Прикус и искривление зубов

                ЕСЛИ ФОТО НИЗКОГО КАЧЕСТВА:
                Дать рекомендации для съёмки (освещение, ракурс, качество фото).

                ПРЕДЛОЖИТЬ УЛУЧШЕННЫЙ УХОД:
                Ирригатор, зубная нить, пасты, ополаскиватели, диета.

                Используй следующий формат ответа:

                АНАЛИЗ ФОТО:
                [Подробное описание состояния зубов и дёсен]

                ПРЕДЛОЖЕНИЯ ПО УХОДУ:
                [Дневной уход и профилактические меры]

                РЕКОМЕНДАЦИИ ПО ВИЗИТУ К ВРАЧУ:
                [Уточнить, в каких случаях обязательно обратиться к стоматологу]

                ЗАКЛЮЧЕНИЕ:
                [Резюме действий для пользователя]
            `;

      // Отправляем запрос в модель
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

      const generateResult = await model.generateContent([prompt, photoPart]);
      const response = await generateResult.response;
      const responseText = await response.text();

      // Проверяем результат
      if (
        !responseText ||
        responseText.toLowerCase().includes("не могу анализировать")
      ) {
        throw new Error("Модель отказалась анализировать фото");
      }

      // Отправляем результат пользователю
      await bot.sendMessage(chatId, `${responseText}`);
      // Записываем новый запрос
      await recordTeethAnalysisRequest(chatId);
      // Получаем начальное количество до этого запроса
      const initialCount = await getMonthlyRequestCount(chatId) - 1;
      const requestsLeft = 2 - (initialCount + 1);
      await bot.sendMessage(chatId, `Ваш анализ завершен. У вас осталось ${requestsLeft} запрос(ов) в этом месяце.`);


    //   await showMainMenu(chatId, "Выберите действие:");
    } catch (error) {
      console.error("Ошибка при обработке фотографии:", error);
      await bot.sendMessage(
        chatId,
        "Произошла ошибка при анализе фотографии. Пожалуйста, попробуйте позже."
      );
    //   await showMainMenu(chatId, "Выберите действие:");
    // } finally {
      userStates.delete(chatId);
    }
  }
}

// Функции для работы с акциями
async function addPromotion(chatId, text) {
  try {
    // Добавляем акцию с расширенными полями
    await db.run(
      `
            INSERT INTO promotions (
                text,
                created_at,
                is_active,
                start_date
            ) VALUES (?, DATETIME('now'), 1, DATE('now'))`,
      [text]
    );

    // Получаем ID только что добавленной акции
    const promotionId = await new Promise((resolve, reject) => {
      db.get("SELECT last_insert_rowid() as id", (err, row) => {
        if (err) reject(err);
        else resolve(row.id);
      });
    });

    // Получаем список всех активных пользователей
    const users = await new Promise((resolve, reject) => {
      db.all(
        `
                SELECT telegram_id 
                FROM users 
                WHERE registration_step = ? 
                AND last_activity >= datetime('now', '-30 day')`, // Только активные пользователи
        [STEPS.COMPLETED],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    // Отправляем уведомление и записываем просмотр
    const notification = `*🎉 Новая акция!*\n\n${text}`;
    for (const user of users) {
      try {
        await bot.sendMessage(user.telegram_id, notification, {
          parse_mode: "Markdown",
        });

        // Записываем факт отправки уведомления
        await db.run(
          `
                    INSERT INTO promotion_views (promotion_id, user_id, viewed_at)
                    VALUES (?, ?, DATETIME('now'))`,
          [promotionId, user.telegram_id]
        );
      } catch (error) {
        console.error(
          `Error sending promotion to user ${user.telegram_id}:`,
          error
        );
      }
    }

    await bot.sendMessage(
      chatId,
      "Новая акция успешно добавлена и разослана пользователям!"
    );
    userStates.delete(chatId);
    await showMainMenu(chatId);
  } catch (error) {
    console.error("Error adding promotion:", error);
    await bot.sendMessage(chatId, "Произошла ошибка при добавлении акции.");
  }
}

async function showPromotions(chatId) {
  try {
    const promotions = await new Promise((resolve, reject) => {
      db.all(
        `
                SELECT p.*, 
                       COALESCE(pv.view_count, 0) as view_count
                FROM promotions p
                LEFT JOIN (
                    SELECT promotion_id, COUNT(*) as view_count 
                    FROM promotion_views 
                    GROUP BY promotion_id
                ) pv ON p.id = pv.promotion_id
                WHERE (p.is_active IS NULL OR p.is_active = 1)
                  AND (p.end_date IS NULL OR p.end_date >= DATE('now'))
                  AND (p.deleted_at IS NULL)
                ORDER BY p.created_at DESC 
                LIMIT 5`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    if (promotions.length === 0) {
      await bot.sendMessage(chatId, "В данный момент нет активных акций.");
      return;
    }

    // Отправляем каждую акцию отдельным сообщением
    for (const promo of promotions) {
      const message =
        `*🎉 Акция от ${formatDate(new Date(promo.created_at))}*\n\n` +
        `${promo.text}\n\n` +
        ((await isAdmin(chatId)) ? `👁 Просмотров: ${promo.view_count}\n` : "");

      await bot.sendMessage(chatId, message, {
        parse_mode: "Markdown",
      });

      // Записываем просмотр для обычных пользователей
      if (!(await isAdmin(chatId))) {
        await db.run(
          `
                    INSERT OR IGNORE INTO promotion_views (promotion_id, user_id)
                    VALUES (?, ?)`,
          [promo.id, chatId]
        );
      }
    }

    // await bot.sendMessage(chatId, "Выберите действие:", {
    //   reply_markup: (await isAdmin(chatId))
    //     ? adminMenuKeyboard
    //     : mainMenuKeyboard,
    // });
  } catch (error) {
    console.error("Error showing promotions:", error);
    await bot.sendMessage(chatId, "Произошла ошибка при загрузке акций.");
  }
}

async function startAddPromotion(chatId) {
  if (!(await isAdmin(chatId))) return;

  await bot.sendMessage(chatId, "Введите текст новой акции:", {
    reply_markup: {
      keyboard: [["◀️ Отменить"]],
      resize_keyboard: true,
    },
  });
  userStates.set(chatId, { state: "ADDING_PROMOTION" });
}

// Функции регистрации
// Добавляем Set для отслеживания процесса регистрации
const registrationInProgress = new Set();

async function startRegistration(chatId, username) {
  // Проверяем, не идет ли уже процесс регистрации
  if (registrationInProgress.has(chatId)) {
    return;
  }

  try {
    // Добавляем пользователя в Set
    registrationInProgress.add(chatId);

    const existingUser = await getUserInfo(chatId);

    // Если пользователь уже полностью зарегистрирован
    if (existingUser && existingUser.registration_step === STEPS.COMPLETED) {
      await showMainMenu(chatId, "Вы уже зарегистрированы!");
      return;
    }

    // Если пользователь существует, но регистрация не завершена
    if (existingUser && existingUser.registration_step !== STEPS.COMPLETED) {
      await updateUser(chatId, "username", username);
      await continueRegistration(chatId, existingUser.registration_step);
      return;
    }

    // Создание нового пользователя с защитой от дублирования
    await db.run(
      `
            INSERT OR IGNORE INTO users 
            (telegram_id, registration_step, created_at, username) 
            VALUES (?, ?, DATETIME('now'), ?)`,
      [chatId, STEPS.PHONE, username]
    );

    const keyboard = {
      keyboard: [
        [
          {
            text: "📱 Отправить номер телефона",
            request_contact: true,
          },
        ],
        ["Ввести номер вручную"],
      ],
      resize_keyboard: true,
    };

    await bot.sendMessage(
      chatId,
      "Добро пожаловать! Для начала работы необходимо зарегистрироваться.\n\n" +
        "Пожалуйста, поделитесь своим номером телефона:",
      { reply_markup: keyboard }
    );
  } catch (error) {
    console.error("Error in startRegistration:", error);
    await bot.sendMessage(
      chatId,
      "Произошла ошибка при регистрации. Попробуйте позже."
    );
  } finally {
    // Удаляем пользователя из Set в любом случае
    registrationInProgress.delete(chatId);
  }
}
async function continueRegistration(chatId, step) {
    try {
      switch (step) {
        case STEPS.PHONE:
          const keyboard = {
            keyboard: [
              [
                {
                  text: "📱 Отправить номер телефона",
                  request_contact: true,
                },
              ],
              ["Ввести номер вручную"],
            ],
            resize_keyboard: true,
          };
          await bot.sendMessage(
            chatId,
            "Пожалуйста, поделитесь своим номером телефона:",
            { reply_markup: keyboard }
          );
          break;
        case STEPS.BIRTHDATE:
          await bot.sendMessage(
            chatId,
            "Введите вашу дату рождения в формате ДД.ММ.ГГГГ:",
            { reply_markup: { remove_keyboard: true } }
          );
          break;
        case STEPS.GENDER:
          await showGenderKeyboard(chatId);
          break;
        case STEPS.FULL_NAME:
          await bot.sendMessage(
            chatId,
            "Введите ваши ФИО полностью (Фамилия Имя Отчество):",
            { reply_markup: { remove_keyboard: true } }
          );
          break;
      }
    } catch (error) {
      console.error("Error in continueRegistration:", error);
      await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
    }
  }

  async function handleRegistrationStep(chatId, text, step) {
    try {
      switch (step) {
        case STEPS.PHONE:
          if (validatePhone(text)) {
            await updateUser(chatId, "phone", text);
            await updateUser(chatId, "registration_step", STEPS.BIRTHDATE);
            await bot.sendMessage(
              chatId,
              "Отлично! Теперь введите вашу дату рождения в формате ДД.ММ.ГГГГ:",
              { reply_markup: { remove_keyboard: true } }
            );
          } else {
            await bot.sendMessage(
              chatId,
              "Пожалуйста, введите корректный номер телефона в формате +7XXXXXXXXXX"
            );
          }
          break;
  
        case STEPS.BIRTHDATE:
          if (validateDate(text)) {
            await updateUser(chatId, "birthdate", text);
            await updateUser(chatId, "registration_step", STEPS.GENDER);
            await showGenderKeyboard(chatId);
          } else {
            await bot.sendMessage(
              chatId,
              "Пожалуйста, введите корректную дату в формате ДД.ММ.ГГГГ"
            );
          }
          break;
  
        case STEPS.FULL_NAME:
          if (validateFullName(text)) {
            await updateUser(chatId, "full_name", text);
            await updateUser(chatId, "registration_step", STEPS.COMPLETED);
            await bot.sendMessage(
              chatId,
              "✅ Регистрация успешно завершена!\n\nТеперь вы можете пользоваться всеми функциями бота.",
              {
                reply_markup: (await isAdmin(chatId))
                  ? adminMenuKeyboard
                  : mainMenuKeyboard,
              }
            );
          } else {
            await bot.sendMessage(
              chatId,
              "Пожалуйста, введите ФИО полностью (Фамилия Имя Отчество)"
            );
          }
          break;
      }
    } catch (error) {
      console.error("Error in handleRegistrationStep:", error);
      await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
    }
  }

// Функции для управления профилем
async function showProfile(chatId) {
    try {
      const user = await getUserInfo(chatId);
      if (!user) {
        await bot.sendMessage(chatId, "Профиль не найден.");
        return;
      }
  
      let message =
        `*👤 Ваш профиль*\n\n` +
        `*ФИО:* ${user.full_name || "Не указано"}\n` +
        `*Телефон:* ${user.phone || "Не указан"}\n` +
        `*Дата рождения:* ${user.birthdate || "Не указана"}\n` +
        `*Пол:* ${user.gender === "male" ? "Мужской" : "Женский"}\n` +
        `*ID:* \`${user.telegram_id}\`\n` +
        `*Дата регистрации:* ${formatDate(new Date(user.created_at))}`;
  
      const keyboard = {
        inline_keyboard: [
          [{ text: "✏️ Редактировать данные", callback_data: "edit_profile" }],
          [{ text: "📅 Мои записи", callback_data: "my_appointments" }],
        ],
      };
  
      await bot.sendMessage(chatId, message, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    } catch (error) {
      console.error("Error in showProfile:", error);
      await bot.sendMessage(chatId, "Ошибка при загрузке профиля");
    }
  }

async function showGenderKeyboard(chatId) {
  const genderKeyboard = {
    inline_keyboard: [
      [
        { text: "Мужской", callback_data: "gender_male" },
        { text: "Женский", callback_data: "gender_female" },
      ],
    ],
  };
  await bot.sendMessage(chatId, "Выберите ваш пол:", {
    reply_markup: genderKeyboard,
    reply_to_message_id: null,
  });
}

async function showEditGenderKeyboard(chatId) {
  const genderKeyboard = {
    inline_keyboard: [
      [
        { text: "Мужской", callback_data: "gender_edit_male" },
        { text: "Женский", callback_data: "gender_edit_female" },
      ],
      [{ text: "◀️ Назад к заявке", callback_data: "edit_back" }],
    ],
  };
  await bot.sendMessage(chatId, "Выберите ваш пол:", {
    reply_markup: genderKeyboard,
  });
}

// Функции для работы с заявками
async function handleAppointmentRequest(chatId) {
  try {
    const user = await getUserInfo(chatId);
    if (!user) {
      await bot.sendMessage(
        chatId,
        "Пожалуйста, сначала пройдите регистрацию."
      );
      return;
    }

    const userData = formatUserDataForConfirmation(user);
    const confirmKeyboard = {
      inline_keyboard: [
        [
          { text: "✅ Верно", callback_data: "appointment_confirm" },
          { text: "✏️ Исправить", callback_data: "appointment_edit" },
        ],
      ],
    };

    await bot.sendMessage(
      chatId,
      "*📝 Запись на прием*\n\n" +
        "Пожалуйста, проверьте ваши данные:\n\n" +
        userData +
        "\nВсе данные указаны верно?",
      {
        parse_mode: "Markdown",
        reply_markup: confirmKeyboard,
      }
    );

    userStates.set(chatId, { state: APPOINTMENT_STATES.CONFIRMING_DATA });
  } catch (error) {
    console.error("Error in handleAppointmentRequest:", error);
    await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
  }
}

async function submitAppointmentRequest(chatId) {
  try {
    const user = await getUserInfo(chatId);
    const dataSnapshot = JSON.stringify({
      full_name: user.full_name,
      phone: user.phone,
      email: user.email,
      birthdate: user.birthdate,
      gender: user.gender,
      telegram_id: user.telegram_id,
      username: user.username,
    });

    await db.run(
      `
            INSERT INTO appointment_requests (
                telegram_id, 
                status, 
                created_at,
                data_snapshot
            ) VALUES (?, 'pending', DATETIME('now'), ?)
        `,
      [chatId, dataSnapshot]
    );

    await bot.sendMessage(
      chatId,
      "✅ Ваша заявка успешно создана!\n\n" +
        "Администратор рассмотрит её и свяжется с вами в ближайшее время.",
      {
        reply_markup: (await isAdmin(chatId))
          ? adminMenuKeyboard
          : mainMenuKeyboard,
      }
    );

    await notifyAdminsAboutNewRequest(chatId);
    userStates.delete(chatId);
  } catch (error) {
    console.error("Error submitting appointment request:", error);
    await bot.sendMessage(
      chatId,
      "Произошла ошибка при создании заявки. Попробуйте позже.",
      {
        reply_markup: (await isAdmin(chatId))
          ? adminMenuKeyboard
          : mainMenuKeyboard,
      }
    );
  }
}

async function handleEditCallback(chatId, data) {
    const field = data.split("_")[1];
  
    switch (field) {
      case "phone":
        userStates.set(chatId, { state: EDIT_STATES.EDITING_PHONE });
        await bot.sendMessage(
          chatId,
          "Введите новый номер телефона в формате +7XXXXXXXXXX:",
          { reply_markup: backToAppointmentKeyboard }
        );
        break;
  
      case "birthdate":
        userStates.set(chatId, { state: EDIT_STATES.EDITING_BIRTHDATE });
        await bot.sendMessage(
          chatId,
          "Введите новую дату рождения в формате ДД.ММ.ГГГГ:",
          { reply_markup: backToAppointmentKeyboard }
        );
        break;
  
      case "fullname":
        userStates.set(chatId, { state: EDIT_STATES.EDITING_FULLNAME });
        await bot.sendMessage(
          chatId,
          "Введите ваши ФИО полностью (Фамилия Имя Отчество):",
          { reply_markup: backToAppointmentKeyboard }
        );
        break;
  
      case "gender":
        userStates.set(chatId, { state: EDIT_STATES.EDITING_GENDER });
        await showEditGenderKeyboard(chatId);
        break;
  
      case "all":
        userStates.set(chatId, {
          state: EDIT_STATES.EDITING_ALL,
          currentField: "phone",
        });
        await startEditAllProcess(chatId);
        break;
  
      case "back":
        await handleAppointmentRequest(chatId);
        break;
    }
  }

async function handleEditAllState(chatId, text, currentField) {
  try {
    let isValid = false;
    let nextField = null;

    switch (currentField) {
      case "phone":
        isValid = validatePhone(text);
        if (isValid) {
          await updateUser(chatId, "phone", text);
          nextField = "birthdate";
          await bot.sendMessage(
            chatId,
            "Введите дату рождения в формате ДД.ММ.ГГГГ:",
            { reply_markup: backToAppointmentKeyboard }
          );
        }
        break;

      case "birthdate":
        isValid = validateDate(text);
        if (isValid) {
          await updateUser(chatId, "birthdate", text);
          nextField = "email";
          await bot.sendMessage(chatId, "Введите email:", {
            reply_markup: backToAppointmentKeyboard,
          });
        }
        break;

      case "email":
        isValid = validateEmail(text);
        if (isValid) {
          await updateUser(chatId, "email", text);
          nextField = "gender";
          await showEditGenderKeyboard(chatId);
        }
        break;

      case "fullname":
        isValid = validateFullName(text);
        if (isValid) {
          await updateUser(chatId, "full_name", text);
          await handleAppointmentRequest(chatId);
          return;
        }
        break;
    }

    if (!isValid) {
      await sendValidationError(chatId, currentField);
    } else if (nextField) {
      userStates.set(chatId, {
        state: EDIT_STATES.EDITING_ALL,
        currentField: nextField,
      });
    }
  } catch (error) {
    console.error("Error in handleEditAllState:", error);
    await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
  }
}

async function handleSingleFieldEdit(chatId, text, state) {
  try {
    let field = "";
    let value = text;
    let isValid = false;

    switch (state) {
      case EDIT_STATES.EDITING_PHONE:
        field = "phone";
        isValid = validatePhone(text);
        break;
      case EDIT_STATES.EDITING_EMAIL:
        field = "email";
        isValid = validateEmail(text);
        break;
      case EDIT_STATES.EDITING_BIRTHDATE:
        field = "birthdate";
        isValid = validateDate(text);
        break;
      case EDIT_STATES.EDITING_FULLNAME:
        field = "full_name";
        isValid = validateFullName(text);
        break;
    }

    if (isValid) {
      await updateUser(chatId, field, value);
      await handleAppointmentRequest(chatId);
    } else {
      await sendValidationError(chatId, field.replace("_", ""));
    }
  } catch (error) {
    console.error("Error in handleSingleFieldEdit:", error);
    await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
  }
}

// Админ-панель и связанные функции
async function showAdminPanel(chatId) {
  if (!(await isAdmin(chatId))) return;

  try {
    const stats = await new Promise((resolve, reject) => {
      db.get(
        `
                SELECT 
                    (SELECT COUNT(*) FROM users) as totalUsers,
                    (SELECT COUNT(*) FROM users WHERE DATE(created_at) = DATE('now')) as newToday,
                    (SELECT COUNT(*) FROM appointment_requests WHERE status = 'pending') as pendingRequests,
                    (SELECT COUNT(*) FROM appointment_requests WHERE status = 'approved') as approvedRequests,
                    (SELECT COUNT(*) FROM appointment_requests WHERE DATE(created_at) = DATE('now')) as requestsToday,
                    (SELECT COUNT(DISTINCT referrer_id) FROM referrals) as activeReferrers
            `,
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    const message =
      `*⚙️ Админ-панель*\n\n` +
      `📊 *Общая статистика:*\n` +
      `• Всего пользователей: ${stats.totalUsers}\n` +
      `• Новых за сегодня: ${stats.newToday}\n\n` +
      `📝 *Заявки:*\n` +
      `• Ожидают обработки: ${stats.pendingRequests}\n` +
      `• Одобрено всего: ${stats.approvedRequests}\n` +
      `• Создано сегодня: ${stats.requestsToday}\n\n` +
      `🤝 *Рефералы:*\n` +
      `• Активных рефереров: ${stats.activeReferrers}\n\n` +
      `Выберите нужный раздел:`;

    await bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: adminPanelKeyboard,
    });
  } catch (error) {
    console.error("Error in showAdminPanel:", error);
    await bot.sendMessage(
      chatId,
      "Произошла ошибка при загрузке админ-панели."
    );
  }
}

async function notifyAdminsAboutNewRequest(userId) {
  try {
    const user = await getUserInfo(userId);

    // Получаем ID последней заявки пользователя
    const lastRequest = await new Promise((resolve, reject) => {
      db.get(
        `
                SELECT id FROM appointment_requests 
                WHERE telegram_id = ? 
                ORDER BY created_at DESC 
                LIMIT 1
            `,
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    const message =
  `*📝 Заявка #${lastRequest.id}*\n\n` +
  `👤 *Пациент:* ${user.full_name}\n` +
  `📱 *Телефон:* ${user.phone}\n` +
  `📅 *Дата рождения:* ${user.birthdate || "Не указана"}\n` +
  `👥 *Пол:* ${user.gender === "male" ? "Мужской" : "Женский"}\n` +
  `🔗 *Username:* ${user.username ? "@" + user.username : "Не указан"}\n` +
  `⏰ *Дата создания:* ${formatDate(new Date())}`;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: "✉️ Написать пользователю",
            url: `tg://user?id=${user.telegram_id}`,
          },
        ],
        [
          {
            text: "👤 Профиль пользователя",
            callback_data: `view_user_${user.telegram_id}`,
          },
        ],
        [
          {
            text: "✅ Одобрить",
            callback_data: `approve_request_${lastRequest.id}`,
          },
          {
            text: "❌ Отклонить",
            callback_data: `reject_request_${lastRequest.id}`,
          },
        ],
        [
          {
            text: "💬 Комментарий",
            callback_data: `comment_request_${lastRequest.id}`,
          },
        ],
      ],
    };

    const admins = await getAdminsList();
    for (const adminId of admins) {
      try {
        await bot.sendMessage(adminId, message, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
      } catch (error) {
        console.error(`Error notifying admin ${adminId}:`, error);
      }
    }
  } catch (error) {
    console.error("Error in notifyAdminsAboutNewRequest:", error);
  }
}

async function handleRequestAction(
  adminId,
  requestId,
  action,
  appointmentDate = null,
  appointmentTime = null
) {
  try {
    const request = await new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM appointment_requests WHERE id = ?",
        [requestId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!request) {
      throw new Error("Request not found");
    }

    if (action === "approved" && (!appointmentDate || !appointmentTime)) {
      // Если нет даты или времени, начинаем процесс их ввода
      userStates.set(adminId, {
        state: APPROVAL_STATES.WAITING_FOR_DATE,
        requestId: requestId,
      });

      await bot.sendMessage(
        adminId,
        "Введите дату приёма в формате ДД.ММ.ГГГГ:",
        {
          reply_markup: {
            keyboard: [["◀️ Отменить"]],
            resize_keyboard: true,
          },
        }
      );
      return;
    }

    // Обновляем заявку с датой и временем приёма
    await db.run(
      `
            UPDATE appointment_requests 
            SET status = ?, 
                processed_at = DATETIME('now'),
                processed_by = ?,
                appointment_date = ?,
                appointment_time = ?
            WHERE id = ?
        `,
      [action, adminId, appointmentDate, appointmentTime, requestId]
    );

    const statusMessage =
      action === "approved"
        ? `✅ Ваша заявка одобрена\n\n📅 Дата приёма: ${appointmentDate}\n⏰ Время приёма: ${appointmentTime}`
        : "❌ Ваша заявка отклонена";

    await bot.sendMessage(request.telegram_id, statusMessage);
    await bot.sendMessage(
      adminId,
      `Заявка #${requestId} ${
        action === "approved" ? "одобрена" : "отклонена"
      }.`
    );

    // Очищаем состояние админа
    userStates.delete(adminId);

    // Обновляем список заявок для админа
    await showPendingRequests(adminId);
  } catch (error) {
    console.error("Error in handleRequestAction:", error);
    throw error;
  }
}

// Обновленная функция показа заявок пользователю
async function showMyAppointments(chatId) {
  try {
    const appointments = await new Promise((resolve, reject) => {
      db.all(
        `
                SELECT * FROM appointment_requests 
                WHERE telegram_id = ? 
                ORDER BY created_at DESC
            `,
        [chatId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    if (appointments.length === 0) {
      await bot.sendMessage(chatId, "У вас пока нет записей на прием.");
      return;
    }

    let message = "*📅 Ваши записи на прием:*\n\n";
    for (const appointment of appointments) {
      message +=
        `*Заявка от:* ${formatDate(new Date(appointment.created_at))}\n` +
        `*Статус:* ${getStatusText(appointment.status)}\n`;

      if (
        appointment.status === "approved" &&
        appointment.appointment_date &&
        appointment.appointment_time
      ) {
        message +=
          `*Дата приёма:* ${appointment.appointment_date}\n` +
          `*Время приёма:* ${appointment.appointment_time}\n`;
      }

      if (appointment.admin_comment) {
        message += `*Комментарий:* ${appointment.admin_comment}\n`;
      }

      message += "\n";
    }

    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error in showMyAppointments:", error);
    await bot.sendMessage(
      chatId,
      "Произошла ошибка при загрузке ваших записей."
    );
  }
}

async function handleAdminComment(adminId, comment, requestId) {
  try {
    await db.run(
      `
            UPDATE appointment_requests 
            SET admin_comment = ?,
                processed_at = DATETIME('now'),
                processed_by = ?
            WHERE id = ?
        `,
      [comment, adminId, requestId]
    );

    const request = await new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM appointment_requests WHERE id = ?",
        [requestId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (request) {
      await bot.sendMessage(
        request.telegram_id,
        `Администратор оставил комментарий к вашей заявке:\n\n${comment}`
      );
    }

    await bot.sendMessage(adminId, "Комментарий успешно добавлен к заявке.", {
      reply_markup: adminPanelKeyboard, // Возвращаем админ-клавиатуру
    });

    userStates.delete(adminId);
    await showPendingRequests(adminId);
  } catch (error) {
    console.error("Error handling admin comment:", error);
    await bot.sendMessage(
      adminId,
      "Произошла ошибка при добавлении комментария.",
      {
        reply_markup: adminPanelKeyboard, // Возвращаем админ-клавиатуру даже при ошибке
      }
    );
    userStates.delete(adminId);
  }
}

async function showEditFieldsKeyboard(chatId) {
  const editKeyboard = {
    inline_keyboard: [
      [{ text: "📱 Телефон", callback_data: "edit_phone" }],
      [{ text: "📅 Дата рождения", callback_data: "edit_birthdate" }],
      [{ text: "📧 Email", callback_data: "edit_email" }],
      [{ text: "👤 ФИО", callback_data: "edit_fullname" }],
      [{ text: "👥 Пол", callback_data: "edit_gender" }],
      [{ text: "✏️ Изменить все", callback_data: "edit_all" }],
      [{ text: "◀️ Назад", callback_data: "edit_back" }],
    ],
  };

  await bot.sendMessage(chatId, "Выберите, что хотите изменить:", {
    reply_markup: editKeyboard,
  });

  userStates.set(chatId, { state: APPOINTMENT_STATES.CHOOSING_EDIT_FIELD });
}

async function startEditAllProcess(chatId) {
  await bot.sendMessage(
    chatId,
    "Давайте обновим все данные.\n\n" +
      "Введите номер телефона в формате +7XXXXXXXXXX:",
    { reply_markup: backToAppointmentKeyboard }
  );
}

// Функции для показа детальной статистики
async function showDetailedStatistics(chatId) {
  if (!(await isAdmin(chatId))) return;

  try {
    const stats = await new Promise((resolve, reject) => {
      db.get(
        `
                SELECT 
                    COUNT(*) as totalUsers,
                    SUM(CASE WHEN DATE(created_at) = DATE('now') THEN 1 ELSE 0 END) as newToday,
                    SUM(CASE WHEN DATE(created_at) >= DATE('now', '-7 days') THEN 1 ELSE 0 END) as newLastWeek,
                    SUM(CASE WHEN DATE(created_at) >= DATE('now', '-30 days') THEN 1 ELSE 0 END) as newLastMonth
                FROM users
            `,
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    const appointmentStats = await new Promise((resolve, reject) => {
      db.get(
        `
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                    SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
                    SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
                    SUM(CASE WHEN DATE(created_at) = DATE('now') THEN 1 ELSE 0 END) as today
                FROM appointment_requests
            `,
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    const message =
      `*📊 Подробная статистика*\n\n` +
      `*👥 Пользователи:*\n` +
      `• Всего: ${stats.totalUsers}\n` +
      `• За сегодня: ${stats.newToday}\n` +
      `• За неделю: ${stats.newLastWeek}\n` +
      `• За месяц: ${stats.newLastMonth}\n\n` +
      `*📝 Заявки:*\n` +
      `• Всего: ${appointmentStats.total}\n` +
      `• Ожидают: ${appointmentStats.pending}\n` +
      `• Одобрены: ${appointmentStats.approved}\n` +
      `• Отклонены: ${appointmentStats.rejected}\n` +
      `• За сегодня: ${appointmentStats.today}\n`;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: "📊 Выгрузить статистику регистраций",
            callback_data: "admin_statistics_registrations",
          },
        ],
        [
          {
            text: "📋 Выгрузить статистику заявок",
            callback_data: "admin_statistics_appointments",
          },
        ],
        [{ text: "◀️ Назад", callback_data: "back_to_admin_panel" }],
      ],
    };

    await bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (error) {
    console.error("Error in showDetailedStatistics:", error);
    await bot.sendMessage(chatId, "Произошла ошибка при загрузке статистики.");
  }
}

// Функция для показа ожидающих заявок
async function showPendingRequests(chatId) {
  if (!(await isAdmin(chatId))) return;

  try {
    // Удаляем старые сообщения с заявками
    const oldMessages = appointmentMessages.get(chatId) || [];
    for (const messageId of oldMessages) {
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (error) {
        console.error("Error deleting message:", error);
      }
    }

    const newMessages = [];
    const requests = await new Promise((resolve, reject) => {
      db.all(
        `
                SELECT 
                    ar.*,
                    u.full_name,
                    u.phone,
                    u.email,
                    u.username
                FROM appointment_requests ar
                JOIN users u ON ar.telegram_id = u.telegram_id
                WHERE ar.status = 'pending'
                ORDER BY ar.created_at DESC
                LIMIT 10
            `,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    if (requests.length === 0) {
      const msg = await bot.sendMessage(chatId, "Нет ожидающих заявок.", {
        reply_markup: adminPanelKeyboard,
      });
      newMessages.push(msg.message_id);
    } else {
      for (const request of requests) {
        const message =
          `*📝 Заявка #${request.id}*\n\n` +
          `👤 *От:* ${request.full_name}\n` +
          `📱 *Телефон:* ${request.phone}\n` +
          `📧 *Email:* ${request.email || "Не указан"}\n` +
          `🔗 *Username:* ${
            request.username ? "@" + request.username : "Не указан"
          }\n` +
          `📅 *Создана:* ${formatDate(new Date(request.created_at))}`;

        const msg = await bot.sendMessage(chatId, message, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Одобрить",
                  callback_data: `approve_request_${request.id}`,
                },
                {
                  text: "❌ Отклонить",
                  callback_data: `reject_request_${request.id}`,
                },
              ],
              [
                {
                  text: "💬 Комментарий",
                  callback_data: `comment_request_${request.id}`,
                },
                {
                  text: "👤 Профиль",
                  callback_data: `view_user_${request.telegram_id}`,
                },
              ],
            ],
          },
        });
        newMessages.push(msg.message_id);
      }
    }

    // Сохраняем ID новых сообщений
    appointmentMessages.set(chatId, newMessages);
  } catch (error) {
    console.error("Error in showPendingRequests:", error);
    await bot.sendMessage(chatId, "Произошла ошибка при загрузке заявок.");
  }
}

// Функция для обработки информации о клинике
async function showClinicInfo(chatId) {
    const clinicInfo =
        `🏥 *О нашей клинике*\n\n` +
        `Мы - современная стоматологическая клиника, оснащенная передовым оборудованием и укомплектованная опытными специалистами.\n\n` +
        `🕒 *График работы:*\n` +
        `Пн-Вс, без выходных 9:00 - 21:00\n\n` +
        `📍 *Адрес:*\n` +
        `г. Санкт-Петербург, Большой пр-т, Петроградской стороны, д 69.\n\n` +
        `📱 *Контакты:*\n` +
        `Телефон: +7 (981) 879 67 82, 8 (812) 606 77 50\n` +
        `Email: office@u-modno.ru\n` +
        `Сайт: u-modno.ru\n\n` +
        `🌟 *Наши услуги:*\n` +
        `• Профессиональная гигиена\n` +
        `• Лечение кариеса\n` +
        `• Имплантация\n` +
        `• Протезирование\n` +
        `• Исправление прикуса\n` +
        `• Отбеливание`;

    // Пути к фотографиям (замените на реальные пути или URL)
    // const fs = require('fs');

const photo1 = 'https://ltdfoto.ru/images/2025/03/20/IMG_0511.jpg'; // Путь к локальному файлу
const photo2 = 'https://i.ibb.co/3hMrsTY/photo2.jpg'; // URL
const photo3 = 'https://i.ibb.co/DzRypJ4/photo3.jpg'; // URL

try {
    // Отправляем медиагруппу
    await bot.sendMediaGroup(chatId, [
        {
            type: 'photo',
            media: photo1, // Используем локальный файл
        },
        {
            type: 'photo',
            media: photo2
        },
        {
            type: 'photo',
            media: photo3
        }
    ]);
} catch (error) {
    console.error('Error sending media group:', error);
    
    // В случае ошибки пробуем отправить фотографии по одной
    try {
        await bot.sendPhoto(chatId, photo1);
        await bot.sendPhoto(chatId, photo2);
        await bot.sendPhoto(chatId, photo3);
    } catch (photoError) {
        console.error('Error sending individual photos:', photoError);

        // Если и это не получилось, отправляем только текст
        await bot.sendMessage(chatId, clinicInfo, { parse_mode: 'Markdown' });
    }
}

    // Отправляем инлайн-кнопки с ссылками
    const inlineKeyboard = {
        inline_keyboard: [
            [{ text: "Отзывы на Яндексе", url: "https://yandex.ru/maps/org/ulybatsya_modno/186973513026/reviews/?ll=30.309966%2C59.964224&z=16" }],
            [{ text: "Отзывы на 2гис", url: "https://2gis.ru/spb/firm/70000001032573404/tab/reviews?m=30.313264%2C59.969843%2F14.93" }],
            [{ text: "Отзывы на Напоправку", url: "https://spb.napopravku.ru/clinics/ulybatsa-modno-centr-ortodonticeskoj-stomatologii/otzyvy/" }],
            [{ text: "Отзывы на ПроДокторов", url: "https://prodoctorov.ru/spb/lpu/58760-ulybatsya-modno/" }],
        ]
    };

    await bot.sendMessage(chatId, 'Отзывы на клинику можно прочитать здесь', {
        reply_markup: inlineKeyboard
    });
}

// Функция для обработки реферальной системы
async function handleReferralSystem(chatId) {
  try {
    const user = await getUserInfo(chatId);
    if (!user) {
      await bot.sendMessage(
        chatId,
        "Пожалуйста, сначала пройдите регистрацию."
      );
      return;
    }

    const referralLink = `https://t.me/${actualBotUsername}?start=ref${chatId}`;
    const referralCount = user.referral_count || 0;

    const message =
      `*🤝 Реферальная программа*\n\n` +
      `Приглашайте друзей в нашу клинику и получайте бонусы!\n\n` +
      `*Ваша статистика:*\n` +
      `• Приглашено пациентов: ${referralCount}\n\n` +
      `*Ваша реферальная ссылка:*\n` +
      `\`${referralLink}\`\n\n` +
      `*Как это работает:*\n` +
      `1. Отправьте вашу реферальную ссылку друзьям\n` +
      `2. Когда они перейдут по ссылке и запишутся на приём, вы получите уведомление\n` +
      `3. После их первого посещения вы получите бонус`;

    await bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: (await isAdmin(chatId))
        ? adminMenuKeyboard
        : mainMenuKeyboard,
    });
  } catch (error) {
    console.error("Error in handleReferralSystem:", error);
    await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
  }
}

function showReviews(chatId) {
  const message = "Ваше мнение – лучший стимул для нашей команды. Мы будем признательны, если вы оставите отзыв о нашей клинике. Это поможет другим пациентам сделать правильный выбор, а нам – продолжать совершенствоваться";

  const inlineKeyboard = {
    inline_keyboard: [
        [{ text: "Оставить отзыв на Яндексе", url: "https://yandex.ru/maps/org/ulybatsya_modno/186973513026/reviews/?ll=30.309966%2C59.964224&z=16" }],
        [{ text: "Оставить отзыв на 2гис", url: "https://2gis.ru/spb/firm/70000001032573404/tab/reviews?m=30.313264%2C59.969843%2F14.93" }],
        [{ text: "Оставить отзыв на Напоправку", url: "https://spb.napopravku.ru/clinics/ulybatsa-modno-centr-ortodonticeskoj-stomatologii/otzyvy/" }],
        [{ text: "Оставить отзыв на ПроДокторов", url: "https://prodoctorov.ru/spb/lpu/58760-ulybatsya-modno/" }],
    ],
  };


  
  bot.sendMessage(chatId, message, {
    reply_markup: inlineKeyboard,
  });
}

async function viewUserProfile(adminId, userId) {
  if (!(await isAdmin(adminId))) return;

  try {
    const user = await getUserInfo(userId);
    if (!user) {
      await bot.sendMessage(adminId, "Пользователь не найден.");
      return;
    }

    // Получаем статистику заявок пользователя
    const appointmentStats = await new Promise((resolve, reject) => {
      db.get(
        `
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                    SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
                    SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
                FROM appointment_requests
                WHERE telegram_id = ?
            `,
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    // В функции viewUserProfile добавить информацию о бонусах:
    const message =
      `*👤 Профиль пользователя*\n\n` +
      `*ID:* \`${user.telegram_id}\`\n` +
      `*Username:* ${user.username ? "@" + user.username : "Не указан"}\n` +
      `*ФИО:* ${user.full_name || "Не указано"}\n` +
      `*Телефон:* ${user.phone || "Не указан"}\n` +
      `*Email:* ${user.email || "Не указан"}\n` +
      `*Дата рождения:* ${user.birthdate || "Не указана"}\n` +
      `*Пол:* ${user.gender === "male" ? "Мужской" : "Женский"}\n` +
      `*Бонусы:* ${user.bonuses || 0}\n` + // Добавляем информацию о бонусах
      `*Регистрация:* ${formatDate(new Date(user.created_at))}`;
    `*📊 Статистика заявок:*\n` +
      `• Всего: ${appointmentStats.total}\n` +
      `• Ожидают: ${appointmentStats.pending}\n` +
      `• Одобрены: ${appointmentStats.approved}\n` +
      `• Отклонены: ${appointmentStats.rejected}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "✉️ Написать", url: `tg://user?id=${user.telegram_id}` },
          {
            text: "📝 Заявки",
            callback_data: `user_appointments_${user.telegram_id}`,
          },
        ],
        [{ text: "◀️ Назад", callback_data: "back_to_admin_panel" }],
      ],
    };

    await bot.sendMessage(adminId, message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (error) {
    console.error("Error in viewUserProfile:", error);
    await bot.sendMessage(
      adminId,
      "Произошла ошибка при загрузке профиля пользователя."
    );
  }
}

// Функция для отображения конкретной заявки
async function showSpecificRequest(chatId, requestId) {
  if (!(await isAdmin(chatId))) return;

  try {
    const request = await new Promise((resolve, reject) => {
      db.get(
        `
                SELECT 
                    ar.*,
                    u.full_name,
                    u.phone,
                    u.email,
                    u.username,
                    u.birthdate,
                    u.gender
                FROM appointment_requests ar
                JOIN users u ON ar.telegram_id = u.telegram_id
                WHERE ar.id = ?
            `,
        [requestId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!request) {
      await bot.sendMessage(chatId, "Заявка не найдена.");
      return;
    }

    const message =
      `*📝 Заявка #${request.id}*\n\n` +
      `👤 *Пациент:* ${request.full_name}\n` +
      `📱 *Телефон:* ${request.phone}\n` +
      `📧 *Email:* ${request.email || "Не указан"}\n` +
      `📅 *Дата рождения:* ${request.birthdate || "Не указана"}\n` +
      `👥 *Пол:* ${request.gender === "male" ? "Мужской" : "Женский"}\n` +
      `🔗 *Username:* ${
        request.username ? "@" + request.username : "Не указан"
      }\n` +
      `⏰ *Дата создания:* ${formatDate(new Date(request.created_at))}`;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: "✅ Одобрить",
            callback_data: `approve_request_${request.id}`,
          },
          {
            text: "❌ Отклонить",
            callback_data: `reject_request_${request.id}`,
          },
        ],
        [
          {
            text: "💬 Комментарий",
            callback_data: `comment_request_${request.id}`,
          },
          {
            text: "👤 Профиль",
            callback_data: `view_user_${request.telegram_id}`,
          },
        ],
        [
          {
            text: "◀️ Назад к списку заявок",
            callback_data: "admin_view_requests",
          },
        ],
      ],
    };

    await bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (error) {
    console.error("Error in showSpecificRequest:", error);
    await bot.sendMessage(chatId, "Произошла ошибка при загрузке заявки.");
  }
}

// Функция генерации Excel файла с регистрациями
// Обновленная функция для генерации Excel с регистрациями
async function generateRegistrationsExcel(chatId) {
  try {
    const users = await new Promise((resolve, reject) => {
      db.all(
        `
                SELECT 
                    telegram_id,
                    username,
                    phone,
                    email,
                    birthdate,
                    gender,
                    full_name,
                    created_at,
                    last_activity
                FROM users
                ORDER BY created_at DESC
            `,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(
      users.map((user) => ({
        ID: user.telegram_id,
        Username: user.username,
        ФИО: user.full_name,
        Телефон: user.phone,
        Email: user.email,
        "Дата рождения": user.birthdate,
        Пол: user.gender === "male" ? "Мужской" : "Женский",
        "Дата регистрации": formatDate(new Date(user.created_at)),
        "Последняя активность": formatDate(new Date(user.last_activity)),
      }))
    );

    XLSX.utils.book_append_sheet(workbook, worksheet, "Регистрации");

    // Создаем временный файл
    const tempFilePath = path.join(
      __dirname,
      `registrations_${Date.now()}.xlsx`
    );
    XLSX.writeFile(workbook, tempFilePath);

    // Отправляем файл
    await bot.sendDocument(
      chatId,
      tempFilePath,
      {},
      {
        filename: `registrations_${formatDate(new Date())}.xlsx`,
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }
    );

    // Удаляем временный файл
    fs.unlinkSync(tempFilePath);
  } catch (error) {
    console.error("Error generating registrations Excel:", error);
    await bot.sendMessage(chatId, "Произошла ошибка при формировании отчета.");
  }
}

// Обновленная функция для генерации Excel с заявками
async function generateAppointmentsExcel(chatId) {
  try {
    const appointments = await new Promise((resolve, reject) => {
      db.all(
        `
                SELECT 
                    ar.*,
                    u.username,
                    u.full_name,
                    u.phone,
                    u.email
                FROM appointment_requests ar
                JOIN users u ON ar.telegram_id = u.telegram_id
                ORDER BY ar.created_at DESC
            `,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(
      appointments.map((app) => ({
        "ID заявки": app.id,
        ФИО: app.full_name,
        Username: app.username,
        Телефон: app.phone,
        Email: app.email,
        Статус: getStatusText(app.status),
        "Дата создания": formatDate(new Date(app.created_at)),
        "Дата приёма": app.appointment_date || "Не назначена",
        "Время приёма": app.appointment_time || "Не назначено",
        Комментарий: app.admin_comment || "",
      }))
    );

    XLSX.utils.book_append_sheet(workbook, worksheet, "Заявки");

    // Создаем временный файл
    const tempFilePath = path.join(
      __dirname,
      `appointments_${Date.now()}.xlsx`
    );
    XLSX.writeFile(workbook, tempFilePath);

    // Отправляем файл
    await bot.sendDocument(
      chatId,
      tempFilePath,
      {},
      {
        filename: `appointments_${formatDate(new Date())}.xlsx`,
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }
    );

    // Удаляем временный файл
    fs.unlinkSync(tempFilePath);
  } catch (error) {
    console.error("Error generating appointments Excel:", error);
    await bot.sendMessage(chatId, "Произошла ошибка при формировании отчета.");
  }
}

async function showAppointmentHistory(chatId) {
  if (!(await isAdmin(chatId))) return;

  try {
    const requests = await new Promise((resolve, reject) => {
      db.all(
        `
                SELECT 
                    ar.*,
                    u.full_name,
                    u.phone,
                    u.email,
                    u.username
                FROM appointment_requests ar
                JOIN users u ON ar.telegram_id = u.telegram_id
                WHERE ar.status != 'pending'
                ORDER BY ar.processed_at DESC
                LIMIT 20
            `,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    if (requests.length === 0) {
      await bot.sendMessage(chatId, "История заявок пуста.");
      return;
    }

    for (const request of requests) {
      const statusEmoji = request.status === "approved" ? "✅" : "❌";
      const message =
        `*${statusEmoji} Заявка #${request.id}*\n\n` +
        `👤 *От:* ${request.full_name}\n` +
        `📱 *Телефон:* ${request.phone}\n` +
        `📧 *Email:* ${request.email || "Не указан"}\n` +
        `🔗 *Username:* ${
          request.username ? "@" + request.username : "Не указан"
        }\n` +
        `📅 *Создана:* ${formatDate(new Date(request.created_at))}\n` +
        `⏰ *Обработана:* ${formatDate(new Date(request.processed_at))}\n` +
        (request.status === "approved"
          ? `📆 *Дата приёма:* ${request.appointment_date}\n` +
            `🕒 *Время приёма:* ${request.appointment_time}\n`
          : "") +
        (request.admin_comment
          ? `💬 *Комментарий:* ${request.admin_comment}\n`
          : "");

      await bot.sendMessage(chatId, message, {
        parse_mode: "Markdown",
      });
    }
  } catch (error) {
    console.error("Error showing appointment history:", error);
    await bot.sendMessage(
      chatId,
      "Произошла ошибка при загрузке истории заявок."
    );
  }
}

// Функция для начисления/списания бонусов
async function handleBonusOperation(chatId, operationType) {
  userStates.set(chatId, {
    state: operationType === "add" ? "ADDING_BONUS" : "SUBTRACTING_BONUS",
    step: "WAITING_FOR_PHONE",
  });

  await bot.sendMessage(
    chatId,
    "Введите номер телефона пользователя в формате +7XXXXXXXXXX:",
    {
      reply_markup: {
        keyboard: [["◀️ Отменить"]],
        resize_keyboard: true,
      },
    }
  );
}

// Функция для обработки ввода телефона при операциях с бонусами
async function handleBonusPhoneInput(chatId, phone, state) {
  try {
    const user = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM users WHERE phone = ?", [phone], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      await bot.sendMessage(
        chatId,
        "Пользователь с таким номером телефона не найден."
      );
      return;
    }

    userStates.set(chatId, {
      ...state,
      step: "WAITING_FOR_AMOUNT",
      targetUserId: user.telegram_id,
      currentBonuses: user.bonuses,
    });

    await bot.sendMessage(
      chatId,
      `Найден пользователь: ${user.full_name}\n` +
        `Текущий баланс бонусов: ${user.bonuses}\n\n` +
        `Введите количество бонусов для ${
          state.state === "ADDING_BONUS" ? "начисления" : "списания"
        }:`,
      { reply_markup: { keyboard: [["◀️ Отменить"]], resize_keyboard: true } }
    );
  } catch (error) {
    console.error("Error in handleBonusPhoneInput:", error);
    await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
  }
}

// Функция для обработки ввода количества бонусов
async function handleBonusAmountInput(chatId, amount, state) {
  try {
    const bonusAmount = parseInt(amount);
    if (isNaN(bonusAmount) || bonusAmount <= 0) {
      await bot.sendMessage(
        chatId,
        "Пожалуйста, введите корректное положительное число."
      );
      return;
    }

    if (
      state.state === "SUBTRACTING_BONUS" &&
      bonusAmount > state.currentBonuses
    ) {
      await bot.sendMessage(
        chatId,
        `У пользователя недостаточно бонусов. Текущий баланс: ${state.currentBonuses}`
      );
      return;
    }

    // Обновляем баланс пользователя
    const newBalance =
      state.state === "ADDING_BONUS"
        ? state.currentBonuses + bonusAmount
        : state.currentBonuses - bonusAmount;

    await db.run("UPDATE users SET bonuses = ? WHERE telegram_id = ?", [
      newBalance,
      state.targetUserId,
    ]);

    // Записываем операцию в историю
    await db.run(
      `
            INSERT INTO bonus_history (
                user_id,
                amount,
                operation_type,
                admin_id
            ) VALUES (?, ?, ?, ?)`,
      [
        state.targetUserId,
        bonusAmount,
        state.state === "ADDING_BONUS" ? "add" : "subtract",
        chatId,
      ]
    );

    // Уведомляем пользователя
    const message =
      state.state === "ADDING_BONUS"
        ? `🎉 Вам начислено ${bonusAmount} бонусов!\nТекущий баланс: ${newBalance} бонусов`
        : `ℹ️ С вашего счета списано ${bonusAmount} бонусов.\nТекущий баланс: ${newBalance} бонусов`;

    await bot.sendMessage(state.targetUserId, message);

    // Уведомляем админа
    await bot.sendMessage(
      chatId,
      `Операция успешно выполнена!\n` +
        `${
          state.state === "ADDING_BONUS" ? "Начислено" : "Списано"
        }: ${bonusAmount} бонусов\n` +
        `Новый баланс пользователя: ${newBalance} бонусов`,
      { reply_markup: adminPanelKeyboard }
    );

    userStates.delete(chatId);
  } catch (error) {
    console.error("Error in handleBonusAmountInput:", error);
    await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
  }
}

async function checkTeethAnalysisLimit(chatId) {
  try {
    const count = await new Promise((resolve, reject) => {
      db.get(
        "SELECT COUNT(*) as count FROM teeth_analysis_requests WHERE telegram_id = ?",
        [chatId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        }
      );
    });
    return count < 2; // Возвращает true, если у пользователя меньше 2 запросов
  } catch (error) {
    console.error("Error checking teeth analysis limit:", error);
    throw error;
  }
}

async function recordTeethAnalysisRequest(chatId) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO teeth_analysis_requests (telegram_id) VALUES (?)",
      [chatId],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Обработчик команды /start
bot.onText(/\/start(.+)?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const username = msg.from.username;
  const referralParam = match[1] ? match[1].trim() : null;

  try {
    // Проверяем, не обрабатывается ли уже команда для этого пользователя
    if (userStates.get(chatId)) {
      return; // Выходим, если команда уже обрабатывается
    }

    // Устанавливаем временное состояние
    userStates.set(chatId, { state: "PROCESSING_START" });

    const user = await getUserInfo(chatId);
    const isUserAdmin = await isAdmin(chatId);

    if (!user) {
      await startRegistration(chatId, username);
    } else if (user.registration_step === STEPS.COMPLETED) {
      if (isUserAdmin) {
        await showAdminPanel(chatId);
      } else {
        await showMainMenu(chatId);
      }
    } else {
      await continueRegistration(chatId, user.registration_step);
    }

    // Удаляем состояние после обработки
    userStates.delete(chatId);
  } catch (error) {
    console.error("Error in /start handler:", error);
    await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
    userStates.delete(chatId);
  }
});

// Обработчик контактов
bot.on("contact", async (msg) => {
  const chatId = msg.chat.id;
  const phoneNumber = "+" + msg.contact.phone_number.replace(/\D/g, "");

  if (msg.contact.user_id === msg.from.id) {
    try {
      await updateUser(chatId, "phone", phoneNumber);
      await updateUser(chatId, "registration_step", STEPS.BIRTHDATE);
      await bot.sendMessage(
        chatId,
        "Спасибо! Теперь введите вашу дату рождения в формате ДД.ММ.ГГГГ:",
        { reply_markup: { remove_keyboard: true } }
      );
    } catch (error) {
      console.error("Error handling contact:", error);
      await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
    }
  } else {
    await bot.sendMessage(
      chatId,
      "Пожалуйста, поделитесь своим собственным номером телефона."
    );
  }
});

// Обработчик фотографий
bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;
    const state = userStates.get(chatId);
  
    if (state && state.state === "WAITING_FOR_TEETH_PHOTO") {
      try {
        await bot.sendMessage(chatId, `🔍 Анализирую фотографию ваших зубов...`);
  
        // Получаем ID последней фотографии из массива photo
        const photoId = msg.photo[msg.photo.length - 1].file_id;
  
        // Получаем URL для скачивания фотографии
        const file = await bot.getFile(photoId);
        const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  
        // Скачиваем фотографию
        const photoResponse = await axios.get(fileUrl, {
          responseType: "arraybuffer",
        });
  
        // Сохраняем файл во временную директорию
        const filePath = path.join(__dirname, `temp_${photoId}.jpg`);
        fs.writeFileSync(filePath, photoResponse.data);
  
        // Загружаем файл в Gemini
        const uploadResult = await fileManager.uploadFile(filePath, {
          mimeType: "image/jpeg",
        });
  
        // Подготовка файла для запроса
        const photoPart = {
          fileData: {
            fileUri: uploadResult.file.uri,
            mimeType: uploadResult.file.mimeType,
          },
        };
  
        // Формируем промпт для модели
        const prompt = `
        Ты — профессиональный стоматологический ИИ-ассистент для телеграм-бота. Твоя задача — провести предварительный анализ зубов по фотографии в дружелюбном, но официальном стиле, чтобы заинтересовать пользователей и ненавязчиво предложить консультацию у стоматолога. Выполняй следующие шаги:

        Определи зубы: Укажи, какие зубы видны на фото (например, передние резцы, клыки, моляры) и их расположение (верхняя или нижняя челюсть).
        Оцени состояние зубов: Обрати внимание на заметные особенности:
        Тёмные пятна (возможный кариес),
        Неровности или сколы,
        Изменение цвета (например, пожелтение или налёт),
        Нестандартное расположение зубов (если применимо).
        
        Проверь десны: Если десны видны, опиши их состояние (здоровый розовый цвет или признаки покраснения/отека).
        Сделай заключение: Дай краткий вывод о состоянии зубов и десен в доброжелательном тоне, без сложных медицинскиъ терминов, предложи обратиться к стоматологу для точной оценки.
        Ограничение: Укажи в конце: 'Этот анализ носит информационный характер и не заменяет профессиональную диагностику'.
        Отвечай в структурированном виде:
        
        представься, что ты ИИ ассистент
        Видимые зубы: [список]
        Состояние зубов: [описание]
        Состояние десен: [описание, если применимо]
        Заключение: [вывод + совет]
        
        
        Пример ответа:
        Видимые зубы: Передние резцы и клыки верхней челюсти.
        Состояние зубов: Резцы выглядят ровными, но на одном из клыков заметно лёгкое пожелтение — возможно, налёт. Между зубами видны небольшие тёмные участки, что может указывать на начальную стадию кариеса.
        Состояние десен: Десны розовые, без видимых признаков воспаления.
        Заключение: Ваши зубы в хорошей форме, но пожелтение и тёмные пятна стоит проверить. Рекомендуем посетить стоматолога для более точной оценки и сохранения здоровой улыбки! Напоминаем: это предварительный анализ и не заменяет профессиональную диагностику.
        Особенности:
        Всегда отвечай на понятном и доступном языке для любого пользователя
        Тон: Дружелюбный, но сдержанный и профессиональный. добавляй эмоджи в текст для боле эмоцеональной связи с пользователем
        Маркетинг: Мягкое побуждение к визиту к стоматологу.
        Чёткость: Структура понятна и удобна для чтения в чате.
        
        Строго не желать: 
        Не писать про качество фотографии.
        `;
  
        // Отправляем запрос в модель
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const generateResult = await model.generateContent([prompt, photoPart]);
        const response = await generateResult.response;
        const responseText = await response.text();
  
        // Проверяем результат
        if (!responseText || responseText.toLowerCase().includes("не могу анализировать")) {
          throw new Error("Модель отказалась анализировать фото");
        }
  
        // Отправляем результат пользователю
        await bot.sendMessage(chatId, `${responseText}`);
        // Записываем новый запрос
        await recordTeethAnalysisRequest(chatId);
        // Получаем начальное количество до этого запроса
        const initialCount = await getMonthlyRequestCount(chatId) - 1;
        const requestsLeft = 2 - (initialCount + 1);
        await bot.send_message(chatId, `Ваш анализ завершен. У вас осталось ${requestsLeft} запрос(ов) в этом месяце.`);

  
        // Удаляем временный файл
        fs.unlinkSync(filePath);
  
        // await showMainMenu(chatId, "Выберите действие:");
      } catch (error) {
        console.error("Ошибка при обработке фотографии:", error);
        await bot.sendMessage(
          chatId,
          "Произошла ошибка при анализе фотографии. Пожалуйста, попробуйте позже."
        );
    //     await showMainMenu(chatId, "Выберите действие:");
    //   } finally {
        userStates.delete(chatId);
      }
    }
  });


// Обработчик текстовых сообщений
bot.on("text", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  try {
    const state = userStates.get(chatId);
    const user = await getUserInfo(chatId);
    const isUserAdmin = await isAdmin(chatId);

    // Обработка ввода даты для записи на прием
    if (state && state.state === APPROVAL_STATES.WAITING_FOR_DATE) {
      if (text === "◀️ Отменить") {
        userStates.delete(chatId);
        await showPendingRequests(chatId);
        return;
      }

      if (validateDate(text)) {
        userStates.set(chatId, {
          state: APPROVAL_STATES.WAITING_FOR_TIME,
          requestId: state.requestId,
          appointmentDate: text,
        });
        await bot.sendMessage(
          chatId,
          "Введите время приёма в формате ЧЧ:ММ (например, 14:30):",
          {
            reply_markup: {
              keyboard: [["◀️ Отменить"]],
              resize_keyboard: true,
            },
          }
        );
      } else {
        await bot.sendMessage(
          chatId,
          "Пожалуйста, введите корректную дату в формате ДД.ММ.ГГГГ"
        );
      }
      return;
    }

    // Обработка ввода времени для записи на прием
    if (state && state.state === APPROVAL_STATES.WAITING_FOR_TIME) {
      if (text === "◀️ Отменить") {
        userStates.delete(chatId);
        await showPendingRequests(chatId);
        return;
      }

      if (validateTime(text)) {
        await handleRequestAction(
          chatId,
          state.requestId,
          "approved",
          state.appointmentDate,
          text
        );
      } else {
        await bot.sendMessage(
          chatId,
          "Пожалуйста, введите корректное время в формате ЧЧ:ММ"
        );
      }
      return;
    }

    // Обработка состояния добавления акции
    if (state && state.state === "ADDING_PROMOTION") {
      if (text === "◀️ Отменить") {
        userStates.delete(chatId);
        await showAdminPanel(chatId);
      } else {
        await addPromotion(chatId, text);
      }
      return;
    }

    // Если пользователь ожидает комментария админа
    if (state && state.state === "WAITING_FOR_COMMENT") {
      if (text === "◀️ Назад к заявке") {
        userStates.delete(chatId);
        const requestId = state.requestId;
        await showSpecificRequest(chatId, requestId);
      } else {
        await handleAdminComment(chatId, text, state.requestId);
      }
      return;
    }

    // Если пользователь в процессе редактирования данных
    if (state && state.state.startsWith("EDITING_")) {
      if (state.state === EDIT_STATES.EDITING_ALL) {
        await handleEditAllState(chatId, text, state.currentField);
      } else {
        await handleSingleFieldEdit(chatId, text, state.state);
      }
      return;
    }

    if (state) {
      if (text === "◀️ Отменить") {
        userStates.delete(chatId);
        await showAdminPanel(chatId);
        return;
      }

      if (
        state.state === "ADDING_BONUS" ||
        state.state === "SUBTRACTING_BONUS"
      ) {
        if (state.step === "WAITING_FOR_PHONE") {
          await handleBonusPhoneInput(chatId, text, state);
        } else if (state.step === "WAITING_FOR_AMOUNT") {
          await handleBonusAmountInput(chatId, text, state);
        }
        return;
      }
    }

    // Обработка команд меню
    switch (text) {
      case "◀️ Назад в меню":
        userStates.delete(chatId);
        await showMainMenu(chatId);
        break;

      case "◀️ Назад к заявке":
        userStates.delete(chatId);
        await handleAppointmentRequest(chatId);
        break;

      case "👤 Профиль":
        await showProfile(chatId);
        break;

      case "📝 Запись на прием":
        await handleAppointmentRequest(chatId);
        break;

        case "🦷 Анализ зубов":
          const count = await getMonthlyRequestCount(chatId);
          const requestsLeft = 2 - count;
          if (requestsLeft > 0) {
            await bot.sendMessage(
              chatId,
              `У вас осталось ${requestsLeft} запрос(ов) в этом месяце.\n\n +
Пожалуйста, отправьте фото ваших зубов для анализа. Фото будет видно только вам и не будет сохранено где-либо еще.\n\n +
Жду ваше фото! 📸`,
              {
                reply_markup: {
                  keyboard: [["◀️ Назад в меню"]],
                  resize_keyboard: true,
                },
              }
            );
            userStates.set(chatId, { state: "WAITING_FOR_TEETH_PHOTO" });
          } else {
            await bot.sendMessage(
              chatId,
              `У вас больше нет запросов в этом месяце. Пожалуйста, попробуйте снова в следующем месяце.`,
              {
                reply_markup: {
                  keyboard: [["◀️ Назад в меню"]],
                  resize_keyboard: true,
                },
              }
            );
          }
        
            break;

      case "⚙️ Админ-панель":
        if (isUserAdmin) {
          await showAdminPanel(chatId);
        }
        break;

      case "📊 Статистика":
        if (isUserAdmin) {
          await showDetailedStatistics(chatId);
        }
        break;

      case "📁 История заявок":
        if (isUserAdmin) {
          await showAppointmentHistory(chatId);
        }
        break;

      case "📋 Заявки":
        if (isUserAdmin) {
          await showPendingRequests(chatId);
        }
        break;

      case "💫 Акции":
        await showPromotions(chatId);
        break;

      case "👥 АКЦИИ":
        if (isUserAdmin) {
          await startAddPromotion(chatId);
        } else {
          await showPromotions(chatId);
        }
        break;

      case "ℹ️ О клинике":
        await showClinicInfo(chatId);
        break;

      case "🤝 Рекомендовать":
        await handleReferralSystem(chatId);
        break;

      case "💬 Оставить отзыв":
        await showReviews(chatId);
        break;

      case "➕ Начислить бонусы":
        if (await isAdmin(chatId)) {
          await handleBonusOperation(chatId, "add");
        }
        break;

      case "➖ Списать бонусы":
        if (await isAdmin(chatId)) {
          await handleBonusOperation(chatId, "subtract");
        }
        break;

      default:
        if (!user) {
          await startRegistration(chatId, msg.from.username);
        } else if (user.registration_step !== STEPS.COMPLETED) {
          await handleRegistrationStep(chatId, text, user.registration_step);
        }
        break;
    }
  } catch (error) {
    console.error("Error in message handler:", error);
    await bot.sendMessage(chatId, "Произошла ошибка. Попробуйте позже.");
  }
});

// Обработчик callback запросов
bot.on("callback_query", async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  try {
    // Обработка выбора пола при регистрации
    if (data === "gender_male" || data === "gender_female") {
      const gender = data.split("_")[1];
      await updateUser(chatId, "gender", gender);
      await updateUser(chatId, "registration_step", STEPS.FULL_NAME);
      await bot.sendMessage(
        chatId,
        "Введите ваши ФИО полностью (Фамилия Имя Отчество):",
        { reply_markup: { remove_keyboard: true } }
      );
    }
    // Обработка выбора пола при редактировании
    else if (data.startsWith("gender_edit_")) {
      const gender = data.split("_")[2];
      await updateUser(chatId, "gender", gender);
      const state = userStates.get(chatId);

      if (state && state.state === EDIT_STATES.EDITING_ALL) {
        userStates.set(chatId, {
          state: EDIT_STATES.EDITING_ALL,
          currentField: "fullname",
        });
        await bot.sendMessage(
          chatId,
          "Введите ваши ФИО полностью (Фамилия Имя Отчество):",
          { reply_markup: backToAppointmentKeyboard }
        );
      } else {
        await handleAppointmentRequest(chatId);
      }
    }
    // Обработка действий с заявкой
    else if (data === "appointment_confirm") {
      await submitAppointmentRequest(chatId);
    } else if (data === "appointment_edit") {
      await showEditFieldsKeyboard(chatId);
    } else if (data.startsWith("edit_")) {
      await handleEditCallback(chatId, data);
    }
    // Админские действия
    else if (data.startsWith("approve_request_")) {
      if (await isAdmin(chatId)) {
        const requestId = parseInt(data.split("_")[2]);
        userStates.set(chatId, {
          state: APPROVAL_STATES.WAITING_FOR_DATE,
          requestId: requestId,
        });
        await bot.sendMessage(
          chatId,
          "Введите дату приёма в формате ДД.ММ.ГГГГ:",
          {
            reply_markup: {
              keyboard: [["◀️ Отменить"]],
              resize_keyboard: true,
            },
          }
        );
      }
    } else if (data.startsWith("reject_request_")) {
      if (await isAdmin(chatId)) {
        const requestId = parseInt(data.split("_")[2]);
        await handleRequestAction(chatId, requestId, "rejected");
      }
    } else if (data.startsWith("comment_request_")) {
      if (await isAdmin(chatId)) {
        const requestId = parseInt(data.split("_")[2]);
        userStates.set(chatId, {
          state: "WAITING_FOR_COMMENT",
          requestId: requestId,
        });
        await bot.sendMessage(chatId, "Введите комментарий к заявке:", {
          reply_markup: backToAppointmentKeyboard,
        });
      }
    } else if (data.startsWith("view_user_")) {
      if (await isAdmin(chatId)) {
        const userId = parseInt(data.split("_")[2]);
        await viewUserProfile(chatId, userId);
      }
    }
    // Новый обработчик для просмотра конкретной заявки
    else if (data.startsWith("view_request_")) {
      if (await isAdmin(chatId)) {
        const requestId = parseInt(data.split("_")[2]);
        await showSpecificRequest(chatId, requestId);
      }
    } else if (data === "my_appointments") {
      await showMyAppointments(chatId);
    } else if (data === "admin_statistics_registrations") {
      await generateRegistrationsExcel(chatId);
    } else if (data === "admin_statistics_appointments") {
      await generateAppointmentsExcel(chatId);
    } else if (data === "admin_view_requests") {
      if (await isAdmin(chatId)) {
        await showPendingRequests(chatId);
      }
    } else if (data === "back_to_admin_panel") {
      if (await isAdmin(chatId)) {
        await showAdminPanel(chatId);
      }
    }

    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    console.error("Error in callback query handler:", error);
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: "Произошла ошибка. Попробуйте позже.",
    });
  }
});

// Обработка ошибок
bot.on("polling_error", (error) => {
  console.error("Bot polling error:", error);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

// Функция для запуска бота
async function startBot() {
  try {
    console.log("Bot is starting...");

    // Здесь можно добавить инициализацию или проверку базы данных

    console.log("Bot successfully started!");
    console.log(`Bot username: ${actualBotUsername}`);
  } catch (error) {
    console.error("Error starting the bot:", error);
    process.exit(1);
  }
}

// Запуск бота
startBot();

// Экспорт бота для возможности использования в других модулях
module.exports = bot;
