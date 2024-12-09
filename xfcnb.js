const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();

// Инициализация бота
const token = '7875354720:AAEYKZ5aNGWFFIM7HV7OPxtDciqjtkqvAUc';
let actualBotUsername = '@umodnobot';
const bot = new TelegramBot(token, { polling: true });

// Получаем username бота при запуске
bot.getMe().then((botInfo) => {
  actualBotUsername = botInfo.username;
  console.log(`Bot username: @${actualBotUsername}`);
}).catch((error) => {
  console.error('Error getting bot info:', error);
});

// Инициализация базы данных
const db = new sqlite3.Database('users.db');

// Создание таблиц
db.serialize(() => {
  // Таблица пользователей
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      phone TEXT,
      email TEXT,
      birthdate TEXT,
      gender TEXT,
      full_name TEXT,
      registration_step TEXT,
      referral_count INTEGER DEFAULT 0,
      referred_by INTEGER
    )
  `);

  // Таблица реферальных переходов
  db.run(`
    CREATE TABLE IF NOT EXISTS referral_clicks (
      referrer_id INTEGER,
      referred_id INTEGER,
      click_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (referrer_id, referred_id)
    )
  `);
});

// Состояния регистрации
const STEPS = {
  PHONE: 'PHONE',
  BIRTHDATE: 'BIRTHDATE',
  EMAIL: 'EMAIL',
  GENDER: 'GENDER',
  FULL_NAME: 'FULL_NAME',
  COMPLETED: 'COMPLETED'
};

// Главное меню
const mainMenuKeyboard = {
  keyboard: [
    ['🦷 Анализ зубов', '💫 Акции'],
    ['📝 Записи', '⭐️ Бонусы'],
    ['💬 Отзывы', 'ℹ️ О клинике'],
    ['👤 Профиль', '🤝 Рекомендовать']
  ],
  resize_keyboard: true
};

// Кнопка "Назад"
const backKeyboard = {
  keyboard: [['◀️ Назад в меню']],
  resize_keyboard: true
};

// Кнопка "Пропустить"
const skipKeyboard = {
  keyboard: [['⏭️ Пропустить']],
  resize_keyboard: true
};

// Информация о клинике
const clinicInfo = {
  description: `🏥 *Стоматологическая клиника "ДентаЛюкс"*\n\n` +
               `Мы предоставляем полный спектр стоматологических услуг на самом высоком уровне:\n\n` +
               `✓ Современное оборудование\n` +
               `✓ Опытные врачи со стажем более 10 лет\n` +
               `✓ Комфортная атмосфера и индивидуальный подход\n` +
               `✓ Гарантия на все виды работ\n\n` +
               `🕐 *Режим работы:*\nПн-Вс: 9:00 - 21:00\n\n` +
               `📍 *Адрес:*\nул. Примерная, д. 123\n\n` +
               `📱 *Телефон:*\n+7 (999) 123-45-67\n\n` +
               `Доверьте здоровье ваших зубов профессионалам!`,
  photos: [
    './photos/clinic1.jpg',
    './photos/clinic2.jpg',
    './photos/clinic3.jpg',
    './photos/clinic4.jpg'
  ]
};

function showMainMenu(chatId, message = 'Выберите нужный раздел:') {
  return bot.sendMessage(chatId, message, {
    reply_markup: mainMenuKeyboard
  });
}

function formatProfileData(user) {
  const genderText = user.gender === 'male' ? 'Мужской' : 'Женский';
  let profile = `👤 *Ваш профиль:*\n\n` +
                `*ФИО:* ${user.full_name}\n` +
                `*Телефон:* ${user.phone}\n` +
                `*Дата рождения:* ${user.birthdate}\n`;
  
  if (user.email && user.email !== 'null') {
    profile += `*Email:* ${user.email}\n`;
  }
  
  profile += `*Пол:* ${genderText}\n` +
             `*Приглашено пользователей:* ${user.referral_count || 0}\n\n` +
             `Выберите действие:`;
             
  return profile;
}

function isValidDate(dateStr) {
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(dateStr)) {
    return false;
  }

  const [day, month, year] = dateStr.split('.').map(Number);
  const date = new Date(year, month - 1, day);

  return date.getDate() === day &&
         date.getMonth() === month - 1 &&
         date.getFullYear() === year &&
         year >= 1900 &&
         year <= new Date().getFullYear();
}

// Генерация реферальной ссылки
function generateReferralLink(userId) {
  return `https://t.me/${actualBotUsername}?start=ref${userId}`;
}

// Обработка реферального перехода
async function handleReferral(referrerId, newUserId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM referral_clicks WHERE referrer_id = ? AND referred_id = ?', 
      [referrerId, newUserId], 
      (err, click) => {
        if (err) {
          reject(err);
          return;
        }

        if (!click) {
          db.run('INSERT INTO referral_clicks (referrer_id, referred_id) VALUES (?, ?)',
            [referrerId, newUserId], (err) => {
              if (err) {
                reject(err);
                return;
              }

              db.run('UPDATE users SET referral_count = referral_count + 1 WHERE telegram_id = ?',
                [referrerId], (err) => {
                  if (err) {
                    reject(err);
                    return;
                  }
                  
                  // Уведомляем реферера о новом приглашенном пользователе
                  bot.sendMessage(referrerId, 
                    '🎉 Поздравляем! По вашей реферальной ссылке зарегистрировался новый пользователь!\n' +
                    '💎 Вам начислены бонусные баллы и скидка 10% на следующее посещение.');
                  
                  resolve(true);
                });
            });
        } else {
          resolve(false);
        }
    });
  });
}
// Обработка команды /start
bot.onText(/\/start(.+)?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const referralParam = match[1] ? match[1].trim() : null;
    
    if (referralParam && referralParam.startsWith('ref')) {
      const referrerId = parseInt(referralParam.substring(3));
      if (referrerId && referrerId !== chatId) {
        try {
          await handleReferral(referrerId, chatId);
        } catch (error) {
          console.error('Error handling referral:', error);
        }
      }
    }
    
    db.get('SELECT * FROM users WHERE telegram_id = ?', [chatId], (err, user) => {
      if (user && user.registration_step === STEPS.COMPLETED) {
        showMainMenu(chatId, 'Добро пожаловать! Выберите нужный раздел:');
      } else {
        db.run('INSERT OR REPLACE INTO users (telegram_id, registration_step, referral_count) VALUES (?, ?, ?)',
          [chatId, STEPS.PHONE, 0]);
        
        const keyboard = {
          keyboard: [
            [{
              text: '📱 Отправить номер телефона',
              request_contact: true
            }],
            ['Ввести номер вручную']
          ],
          resize_keyboard: true
        };
        
        bot.sendMessage(chatId, 'Выберите способ ввода номера телефона:', {
          reply_markup: keyboard
        });
      }
    });
  });
  
  // Обработка нажатий на inline кнопки
  bot.on('callback_query', (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
  
    switch (data) {
      case 'male':
      case 'female':
        db.run('UPDATE users SET gender = ?, registration_step = ? WHERE telegram_id = ?',
          [data, STEPS.FULL_NAME, chatId]);
        bot.sendMessage(chatId, 'Введите ваше ФИО (с большой буквы):', {
          reply_markup: { remove_keyboard: true }
        });
        break;
        
      case 'my_appointments':
        bot.sendMessage(chatId, 'У вас пока нет записей на прием.');
        break;
        
      case 'history':
        bot.sendMessage(chatId, 'История посещений пуста.');
        break;
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
  });
  
  // Обработка отправки контакта
  bot.on('contact', (msg) => {
    const chatId = msg.chat.id;
    let phoneNumber = msg.contact.phone_number;
    
    if (!phoneNumber.startsWith('+')) {
      phoneNumber = '+' + phoneNumber;
    }
    if (!phoneNumber.startsWith('+7')) {
      phoneNumber = '+7' + phoneNumber.substring(1);
    }
    
    db.run('UPDATE users SET phone = ?, registration_step = ? WHERE telegram_id = ?',
      [phoneNumber, STEPS.BIRTHDATE, chatId]);
    
    bot.sendMessage(chatId, 'Введите вашу дату рождения в формате ДД.ММ.ГГГГ (например: 12.12.2000):', {
      reply_markup: { remove_keyboard: true }
    });
  });
  
  // Обработка текстовых сообщений
  bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    if (text === '◀️ Назад в меню') {
      return showMainMenu(chatId);
    }
    
    if (text === '⏭️ Пропустить') {
      db.get('SELECT registration_step FROM users WHERE telegram_id = ?', [chatId], (err, user) => {
        if (user && user.registration_step === STEPS.EMAIL) {
          db.run('UPDATE users SET email = ?, registration_step = ? WHERE telegram_id = ?',
            ['null', STEPS.GENDER, chatId]);
          
          const genderKeyboard = {
            inline_keyboard: [
              [
                { text: 'Мужской', callback_data: 'male' },
                { text: 'Женский', callback_data: 'female' }
              ]
            ]
          };
          
          bot.sendMessage(chatId, 'Выберите ваш пол:', {
            reply_markup: genderKeyboard
          });
        }
      });
      return;
    }
  
    if (text === '🤝 Рекомендовать') {
      const referralLink = generateReferralLink(chatId);
      const message = `🎁 *Пригласите друзей и получите бонусы!*\n\n` +
                     `Ваша персональная ссылка для приглашения:\n` +
                     `${referralLink}\n\n` +
                     `За каждого приглашенного друга вы получите:\n` +
                     `• Скидку 10% на следующее посещение\n` +
                     `• 500 бонусных баллов\n\n` +
                     `_Бонусы начисляются только за новых пользователей._`;
      
      bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: backKeyboard
      });
      return;
    }
    
    if (text === 'ℹ️ О клинике') {
      try {
        for (let i = 0; i < clinicInfo.photos.length - 1; i++) {
          await bot.sendPhoto(chatId, clinicInfo.photos[i]);
        }
        
        await bot.sendPhoto(chatId, clinicInfo.photos[clinicInfo.photos.length - 1], {
          caption: clinicInfo.description,
          parse_mode: 'Markdown',
          reply_markup: backKeyboard
        });
      } catch (error) {
        console.error('Error sending clinic info:', error);
        bot.sendMessage(chatId, clinicInfo.description, {
          parse_mode: 'Markdown',
          reply_markup: backKeyboard
        });
      }
      return;
    }
    
    if (text === '👤 Профиль') {
      db.get('SELECT * FROM users WHERE telegram_id = ?', [chatId], (err, user) => {
        if (user) {
          bot.sendMessage(chatId, formatProfileData(user), {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '📋 Мои записи', callback_data: 'my_appointments' },
                  { text: '📜 История', callback_data: 'history' }
                ]
              ]
            }
          });
          bot.sendMessage(chatId, 'Используйте кнопку ниже для возврата в главное меню:', {
            reply_markup: backKeyboard
          });
        }
      });
      return;
    }
    
    if (text === 'Ввести номер вручную') {
      bot.sendMessage(chatId, 'Введите ваш номер телефона (начиная с +7):', {
        reply_markup: { remove_keyboard: true }
      });
      return;
    }
    
    db.get('SELECT * FROM users WHERE telegram_id = ?', [chatId], (err, user) => {
      if (!user) return;
      
      switch (user.registration_step) {
        case STEPS.PHONE:
          if (text.startsWith('+7')) {
            db.run('UPDATE users SET phone = ?, registration_step = ? WHERE telegram_id = ?',
              [text, STEPS.BIRTHDATE, chatId]);
            
            bot.sendMessage(chatId, 'Введите вашу дату рождения в формате ДД.ММ.ГГГГ (например: 12.12.2000):', {
              reply_markup: { remove_keyboard: true }
            });
          } else {
            bot.sendMessage(chatId, 'Номер телефона должен начинаться с +7. Попробуйте еще раз.');
          }
          break;
  
        case STEPS.BIRTHDATE:
          if (isValidDate(text)) {
            db.run('UPDATE users SET birthdate = ?, registration_step = ? WHERE telegram_id = ?',
              [text, STEPS.EMAIL, chatId]);
            
            bot.sendMessage(chatId, 'Введите ваш email (или нажмите кнопку "Пропустить"):', {
              reply_markup: skipKeyboard
            });
          } else {
            bot.sendMessage(chatId, 'Пожалуйста, введите дату в правильном формате (ДД.ММ.ГГГГ)');
          }
          break;
          
        case STEPS.EMAIL:
          if (text.includes('@') && text.includes('.')) {
            db.run('UPDATE users SET email = ?, registration_step = ? WHERE telegram_id = ?',
              [text, STEPS.GENDER, chatId]);
            
            const genderKeyboard = {
              inline_keyboard: [
                [
                  { text: 'Мужской', callback_data: 'male' },
                  { text: 'Женский', callback_data: 'female' }
                ]
              ]
            };
            
            bot.sendMessage(chatId, 'Выберите ваш пол:', {
              reply_markup: genderKeyboard
            });
          } else {
            bot.sendMessage(chatId, 'Пожалуйста, введите корректный email адрес или нажмите "Пропустить"');
          }
          break;
          
        case STEPS.FULL_NAME:
          const nameParts = text.split(' ');
          const isValidName = nameParts.length >= 2 && 
            nameParts.every(part => part[0] === part[0].toUpperCase());
          
          if (isValidName) {
            db.run('UPDATE users SET full_name = ?, registration_step = ? WHERE telegram_id = ?',
              [text, STEPS.COMPLETED, chatId]);
            bot.sendMessage(chatId, 'Регистрация успешно завершена! Спасибо!');
            showMainMenu(chatId, 'Добро пожаловать! Выберите нужный раздел:');
          } else {
            bot.sendMessage(chatId, 'Пожалуйста, введите ФИО с заглавных букв (например: Иванов Иван Иванович)');
          }
          break;
      }
    });
  });
  
  bot.on('polling_error', (error) => {
    console.log(error);
  });