// Загружаем переменные окружения из .env файла
require('dotenv').config();

// Импортируем библиотеки
const TelegramBot = require('node-telegram-bot-api');
const avatar = require('boring-avatars');
const fs = require('fs');
const ReactDOMServer = require('react-dom/server');
const React = require('react');
const sharp = require('sharp'); // Для конвертации в PNG

// Получаем токен из переменных окружения
const token = process.env.TELEGRAM_BOT_TOKEN;

// Проверяем, загрузился ли токен
if (!token) {
    console.error('Ошибка: Токен Telegram-бота не найден! Убедитесь, что он задан в файле .env');
    process.exit(1);
}

// Создаем экземпляр бота
const bot = new TelegramBot(token, { polling: true });

console.log('Бот запускается...');

// Хранилище состояний пользователей
// Добавили currentColors для хранения цветов текущего превью
const userState = {}; // { chatId: { step, name, variant, awaitingColors, currentSvgString, previewMessageId, currentColors } }

// Доступные типы аватаров
const avatarVariants = ['marble', 'beam', 'pixel', 'sunset', 'ring', 'bauhaus'];
// Цвета по умолчанию
const defaultColors = ['#92A1C6', '#146A7C', '#F0AB3D', '#C271B4', '#C20D90'];

// --- Вспомогательные функции ---

// Генерация случайной палитры
function generateRandomPalette(count = 5) {
    const palette = [];
    for (let i = 0; i < count; i++) {
        palette.push('#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'));
    }
    return palette;
}

// Функция генерации SVG строки
function generateSvgString(name, variant, colors) {
    try {
        const avatarElement = React.createElement(avatar.default, {
            size: 800, // Размер для PNG превью
            name: name,
            variant: variant,
            colors: colors,
            square: true // Делаем квадратным для превью
        });
        const svgString = ReactDOMServer.renderToStaticMarkup(avatarElement);
        if (typeof svgString !== 'string' || svgString.length === 0) {
            console.error("Ошибка: renderToStaticMarkup не вернул строку SVG.");
            throw new Error('ReactDOMServer.renderToStaticMarkup не вернул валидную строку SVG');
        }
        return svgString;
    } catch (error) {
        console.error('Ошибка при генерации SVG строки:', error);
        return null; // Возвращаем null в случае ошибки
    }
}

// Функция конвертации SVG в PNG Buffer
async function convertSvgToPng(svgString) {
    if (!svgString) return null;
    try {
        const pngBuffer = await sharp(Buffer.from(svgString))
            .png({ quality: 90 }) // Настройка качества PNG
            .toBuffer();
        return pngBuffer;
    } catch (error) {
        console.error('Ошибка конвертации SVG в PNG с помощью sharp:', error);
        return null; // Возвращаем null в случае ошибки
    }
}

// Функция отправки PNG превью с кнопками
async function sendPngPreview(chatId, pngBuffer, currentState) {
    // Проверяем наличие всех необходимых данных в состоянии
    if (!pngBuffer || !currentState || !currentState.name || !currentState.variant || !currentState.currentSvgString || !currentState.currentColors) {
         console.error(`[${chatId}] Ошибка: Недостаточно данных для отправки превью. State:`, currentState);
         bot.sendMessage(chatId, 'Произошла внутренняя ошибка при подготовке превью. Попробуйте начать заново /start.');
         delete userState[chatId]; // Очищаем некорректное состояние
         return;
    }

    const { name, variant } = currentState;
    const caption = `Вот превью для "${name}" (стиль: ${variant}).\nЧто дальше?`;

    // Определяем клавиатуру под превью
    const keyboard = [
        [ // Первый ряд
            { text: '🎨 Новые цвета', callback_data: 'regenerate_colors' }, // Перегенерировать только цвета
            { text: '🔄 Сменить стиль', callback_data: 'change_style' }     // Сменить только стиль
        ],
        [ // Второй ряд
            { text: '💾 Получить SVG', callback_data: 'get_current_svg' },      // Скачать текущий SVG
            { text: '🎨 Другие цвета', callback_data: 'back_to_color_options' } // Вернуться к выбору способа задания цветов
        ],
        [ // Третий ряд
            { text: '❌ Отмена', callback_data: 'cancel_creation' }
        ]
    ];

    try {
        // Отправляем фото с подписью и кнопками
        const sentMessage = await bot.sendPhoto(chatId, pngBuffer, {
            caption: caption,
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
        // Сохраняем ID отправленного сообщения для возможности его редактирования/удаления
        if (userState[chatId]) { // Убедимся, что состояние еще существует
             userState[chatId].previewMessageId = sentMessage.message_id;
             userState[chatId].step = 'preview'; // Устанавливаем текущий шаг
        } else {
             console.warn(`[${chatId}] Состояние было удалено до сохранения previewMessageId.`);
        }

    } catch (error) {
        console.error(`Ошибка отправки PNG превью chatId=${chatId}:`, error.response ? error.response.body : error);
        bot.sendMessage(chatId, 'К сожалению, не удалось отправить превью изображения. Попробуйте еще раз.');
        // Не удаляем состояние, если отправка не удалась, возможно временная проблема
    }
}

// Функция для начала процесса генерации (SVG -> PNG -> Отправка превью)
async function startGenerationProcess(chatId, name, variant, colors, messageToEdit = null) {
    let workingMsg;
    try {
        if (messageToEdit) {
            // Если передано сообщение для редактирования, используем его
            await bot.editMessageText(`⏳ Генерирую аватар "${name}" (стиль: ${variant})...`, {
                chat_id: chatId,
                message_id: messageToEdit.message_id,
                reply_markup: {} // Убираем старые кнопки
            });
            workingMsg = messageToEdit;
        } else {
            // Иначе, отправляем новое сообщение
            workingMsg = await bot.sendMessage(chatId, `⏳ Генерирую аватар "${name}" (стиль: ${variant})...`);
        }

        const svgString = generateSvgString(name, variant, colors);
        if (!svgString) {
            await bot.editMessageText('Произошла ошибка при создании SVG. Попробуйте снова.', { chat_id: chatId, message_id: workingMsg.message_id });
            delete userState[chatId];
            return;
        }

        // Сохраняем SVG и ЦВЕТА в состояние ДО конвертации в PNG
        if (userState[chatId]) {
            userState[chatId].currentSvgString = svgString;
            userState[chatId].currentColors = colors; // Сохраняем использованные цвета
        } else {
            console.warn(`[${chatId}] Состояние пользователя не найдено перед сохранением SVG/цветов.`);
            await bot.editMessageText('Произошла ошибка состояния. Начните заново /start', { chat_id: chatId, message_id: workingMsg.message_id });
            return;
        }

        const pngBuffer = await convertSvgToPng(svgString);
        if (!pngBuffer) {
            await bot.editMessageText('Произошла ошибка при конвертации в PNG. Попробуйте снова.', { chat_id: chatId, message_id: workingMsg.message_id });
            delete userState[chatId];
            return;
        }

        // Удаляем сообщение "Генерирую..." перед отправкой превью
        await bot.deleteMessage(chatId, workingMsg.message_id).catch(() => { /* Игнорируем ошибку удаления */ });
        workingMsg = null; // Сбрасываем, чтобы не пытаться удалить еще раз в catch

        await sendPngPreview(chatId, pngBuffer, userState[chatId]);

    } catch (error) {
        console.error(`[${chatId}] Ошибка в startGenerationProcess:`, error);
        if (workingMsg) { // Если сообщение "Генерирую" еще не удалено
            await bot.editMessageText('Произошла непредвиденная ошибка при генерации. Попробуйте начать заново /start', { chat_id: chatId, message_id: workingMsg.message_id }).catch(() => { });
        } else {
            await bot.sendMessage(chatId, 'Произошла непредвиденная ошибка при генерации. Попробуйте начать заново /start').catch(() => { });
        }
        delete userState[chatId]; // Очищаем состояние при серьезной ошибке
    }
}


// --- Обработчики команд и сообщений ---

// Команда /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "Привет! 👋\nЯ помогу тебе создать уникальный аватар Boring Avatars.\n\nПросто отправь мне команду:\n`/avatar ТекстДляАватара`\n\nПосле этого я предложу выбрать стиль и цвета. ✨", {parse_mode: 'Markdown'});
    delete userState[chatId]; // Сбрасываем состояние при старте
});

// Команда /avatar [имя]
bot.onText(/\/avatar (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const name = match[1].trim();

    if (!name) {
        bot.sendMessage(chatId, "Кажется, вы не указали текст для аватара. Попробуйте так: `/avatar МоеИмя`");
        return;
    }
    // Инициализируем состояние для нового пользователя
    userState[chatId] = { step: 'type', name: name };

    // Формируем кнопки выбора типа
    const typeKeyboard = avatarVariants.reduce((acc, variant, index) => {
        const button = { text: variant.charAt(0).toUpperCase() + variant.slice(1), callback_data: `select_type_${variant}` };
        if (index % 2 === 0) {
            acc.push([button]); // Новый ряд
        } else {
            acc[acc.length - 1].push(button); // Добавить во второй столбец
        }
        return acc;
    }, []);
    // Добавляем кнопку отмены последним рядом
    typeKeyboard.push([{ text: '❌ Отмена', callback_data: 'cancel_creation' }]);

    const options = {
        reply_markup: {
            inline_keyboard: typeKeyboard
        }
    };
    // Отправляем сообщение с выбором типа
    bot.sendMessage(chatId, `Отлично! Используем текст: "${name}".\nТеперь выберите стиль (тип) аватара:`, options);
});

// Команда /avatar без текста
bot.onText(/\/avatar$/, (msg) => {
     bot.sendMessage(msg.chat.id, "Пожалуйста, укажите текст после команды. Например: `/avatar МоеКлассноеИмя`");
});


// Обработчик нажатий на inline-кнопки (callback_query)
bot.on('callback_query', async (callbackQuery) => { // Асинхронный обработчик
    const msg = callbackQuery.message; // Сообщение, к которому прикреплены кнопки
    // Иногда msg может быть undefined, если сообщение было удалено до обработки callback
    if (!msg) {
        console.warn(`[${callbackQuery.from.id}] Callback ${callbackQuery.data} получен для несуществующего сообщения.`);
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Сообщение устарело' });
        return;
    }
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    // Всегда отвечаем Telegram, что получили callback
    // Можно добавить { text: '...' } для всплывающего уведомления
    bot.answerCallbackQuery(callbackQuery.id);

    // --- Логика Отмены ---
    if (data === 'cancel_creation') {
        const currentState = userState[chatId];
        delete userState[chatId]; // Удаляем состояние
        const messageText = 'Создание аватара отменено.';
        const messageIdToEdit = currentState?.previewMessageId || msg.message_id; // ID превью или исходного сообщения

        // Пытаемся отредактировать сообщение (убрать кнопки и изменить текст)
        bot.editMessageText(messageText, {
            chat_id: chatId,
            message_id: messageIdToEdit,
            reply_markup: {} // Пустая клавиатура убирает кнопки
        }).catch(err => {
            // Если это было превью (фото) и его нельзя отредактировать как текст
            if (currentState?.previewMessageId === messageIdToEdit) {
                bot.deleteMessage(chatId, messageIdToEdit).catch(() => {/* Игнор */}); // Удаляем фото
                bot.sendMessage(chatId, messageText); // Отправляем текстовое подтверждение
            } else if (!(err.response && err.response.statusCode === 400)) { // Игнорируем 400 ошибки (message not modified etc.) для текстовых сообщений
                console.error(`[${chatId}] Ошибка editMessageText при отмене:`, err.response ? err.response.body : err);
            }
        });
        return; // Завершаем обработку
    }

    // --- Логика Возврата ---
     if (data === 'back_to_type_selection' || data === 'back_to_color_options') {
         const currentState = userState[chatId];
         // Проверяем наличие базового состояния
         if (!currentState || !currentState.name) {
             bot.sendMessage(chatId, "Ой, не могу найти предыдущий шаг. Начните сначала: `/avatar ВашеИмя`");
             // Попытаемся убрать кнопки у текущего сообщения
             bot.editMessageReplyMarkup({}, { chat_id: chatId, message_id: msg.message_id }).catch(()=>{});
             return;
         }

         // Если было превью, удаляем его
         if (currentState.previewMessageId) {
             bot.deleteMessage(chatId, currentState.previewMessageId).catch(()=>{});
             delete currentState.previewMessageId;
             delete currentState.currentSvgString;
             delete currentState.currentColors;
         }

         // Возврат к выбору ТИПА
         if (data === 'back_to_type_selection') {
             currentState.step = 'type';
             delete currentState.variant; delete currentState.awaitingColors; // Сбрасываем выбор
             // Формируем кнопки выбора типа заново
             const typeKeyboard = avatarVariants.reduce((acc, variant, index) => {
                 const button = { text: variant.charAt(0).toUpperCase() + variant.slice(1), callback_data: `select_type_${variant}` };
                 if (index % 2 === 0) acc.push([button]); else acc[acc.length - 1].push(button); return acc;
             }, []);
             typeKeyboard.push([{ text: '❌ Отмена', callback_data: 'cancel_creation' }]);
             const options = { reply_markup: { inline_keyboard: typeKeyboard } };
             // Редактируем ИСХОДНОЕ сообщение msg.message_id (где был выбор типа или цвета)
             bot.editMessageText(`Хорошо, возвращаемся к выбору стиля для "${currentState.name}":`, {
                 chat_id: chatId, message_id: msg.message_id, ...options
             }).catch(error => { // Обработка ошибки редактирования
                 if (!(error.response && error.response.statusCode === 400)) {
                    console.error(`[${chatId}] Ошибка при вызове editMessageText (back_to_type):`, error.response ? error.response.body : error);
                 }
             });
             return; // Важно завершить
         }

         // Возврат к выбору СПОСОБА ЗАДАНИЯ ЦВЕТА
         if (data === 'back_to_color_options') {
             if (!currentState.variant) { // Убедимся, что тип уже выбран
                 bot.sendMessage(chatId, "Сначала нужно выбрать стиль. Возвращаемся к выбору стиля...");
                 // Вызываем логику возврата к типу (рекурсивно или копипастом)
                 currentState.step = 'type'; delete currentState.variant; delete currentState.awaitingColors;
                 const typeKeyboard = avatarVariants.reduce((acc, variant, index) => { /* ... */ }); typeKeyboard.push(/*...*/);
                 const options = { reply_markup: { inline_keyboard: typeKeyboard } };
                 bot.editMessageText(`Хорошо, возвращаемся к выбору стиля для "${currentState.name}":`, { chat_id: chatId, message_id: msg.message_id, ...options }).catch(()=>{});
                 return;
             }
             currentState.step = 'colors'; delete currentState.awaitingColors; // Убираем ожидание ввода, если было
             // Формируем кнопки выбора способа задания цвета
             const colorOptionsKeyboard = [
                [{ text: '🎨 Случайная палитра', callback_data: 'select_color_random' }],
                [{ text: '🖌️ Цвета по умолчанию', callback_data: 'select_color_default' }],
                [{ text: '⌨️ Ввести свои цвета', callback_data: 'select_color_custom' }],
                [ // Ряд с кнопками Назад/Отмена
                    { text: '⬅️ Назад (к стилю)', callback_data: 'back_to_type_selection' },
                    { text: '❌ Отмена', callback_data: 'cancel_creation' }
                ]
             ];
             const colorOptions = { reply_markup: { inline_keyboard: colorOptionsKeyboard } };
             // Редактируем сообщение msg.message_id
             bot.editMessageText(`Стиль выбран: ${currentState.variant}.\nТеперь определимся с цветами:`, {
                 chat_id: chatId, message_id: msg.message_id, ...colorOptions
             }).catch(error => { // Обработка ошибки редактирования
                 if (!(error.response && error.response.statusCode === 400)) {
                    console.error(`[${chatId}] Ошибка при вызове editMessageText (back_to_color):`, error.response ? error.response.body : error);
                 }
             });
             return; // Важно завершить
         }
     }


    // --- Логика Выбора ТИПА (Изначального или После Смены Стиля) ---
    if (data.startsWith('select_type_')) {
        const selectedVariant = data.replace('select_type_', '');

        // Проверяем, находимся ли мы на шаге выбора типа или шаге выбора НОВОГО типа
        if (!userState[chatId] || (userState[chatId].step !== 'type' && userState[chatId].step !== 'selecting_new_style')) {
            console.warn(`[${chatId}] Получен callback ${data}, но состояние не 'type' и не 'selecting_new_style'. State:`, userState[chatId]);
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Неожиданное действие' });
            // Можно убрать кнопки у сообщения на всякий случай
            bot.editMessageReplyMarkup({}, { chat_id: chatId, message_id: msg.message_id }).catch(()=>{});
            return;
        }

        const currentState = userState[chatId];
        const previousStep = currentState.step; // Запоминаем, откуда пришли

        // Сохраняем выбранный вариант
        currentState.variant = selectedVariant;

        // --- Обработка в зависимости от предыдущего шага ---
        if (previousStep === 'selecting_new_style') {
             // Если мы МЕНЯЛИ стиль после превью
             const { name, currentColors } = currentState;
             if (!name || !currentColors) {
                 console.error(`[${chatId}] Ошибка: Отсутствуют name или currentColors при смене стиля.`);
                 bot.sendMessage(chatId, "Произошла ошибка состояния (нет имени/цветов). Начните заново /start.");
                 delete userState[chatId];
                 return;
             }
             // Запускаем генерацию превью с НОВЫМ стилем и СТАРЫМИ цветами,
             // редактируя сообщение с выбором стиля
             currentState.step = 'generating'; // Промежуточный шаг
             await startGenerationProcess(chatId, name, selectedVariant, currentColors, msg);

        } else { // previousStep === 'type' (изначальный выбор типа)
            // Переходим к выбору цветов (старая логика)
            currentState.step = 'colors';
            console.log(`[${chatId}] State после выбора типа:`, JSON.stringify(currentState));

            // Формируем кнопки выбора СПОСОБА задания цвета
            const colorOptionsKeyboard = [
                [{ text: '🎨 Случайная палитра', callback_data: 'select_color_random' }],
                [{ text: '🖌️ Цвета по умолчанию', callback_data: 'select_color_default' }],
                [{ text: '⌨️ Ввести свои цвета', callback_data: 'select_color_custom' }],
                [ { text: '⬅️ Назад (к стилю)', callback_data: 'back_to_type_selection' }, { text: '❌ Отмена', callback_data: 'cancel_creation' } ]
            ];
            const colorOptions = { reply_markup: { inline_keyboard: colorOptionsKeyboard } };

            // Редактируем сообщение msg.message_id, чтобы показать опции выбора цвета
            bot.editMessageText(`Стиль выбран: ${selectedVariant}.\nТеперь определимся с цветами:`, {
                chat_id: chatId, message_id: msg.message_id, ...colorOptions
            }).catch(error => { // Обработка ошибки редактирования
                if (!(error.response && error.response.statusCode === 400)) { // Игнорируем "message not modified"
                    console.error(`[${chatId}] ОШИБКА editMessageText (тип -> цвет):`, error.response ? error.response.body : error);
                }
            });
        }
        return; // Важно завершить
    }

    // --- Логика Выбора ЦВЕТОВ (Способа задания) ---
    if (data.startsWith('select_color_')) {
        const colorSelectionType = data.replace('select_color_', '');
        // Проверяем состояние
        if (!userState[chatId] || userState[chatId].step !== 'colors' || !userState[chatId].name || !userState[chatId].variant) {
            console.warn(`[${chatId}] Получен callback ${data} в некорректном состоянии. State:`, userState[chatId]);
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Неожиданное действие' });
            bot.editMessageReplyMarkup({}, { chat_id: chatId, message_id: msg.message_id }).catch(()=>{});
            return;
        }

        const currentState = userState[chatId];
        const { name, variant } = currentState;
        let colorsToUse;

        // Убираем кнопки у сообщения с выбором способа задания цвета
        bot.editMessageReplyMarkup({}, { chat_id: chatId, message_id: msg.message_id }).catch(()=>{});

        // Определяем цвета и запускаем генерацию/запрос ввода
        switch (colorSelectionType) {
            case 'random':
                colorsToUse = generateRandomPalette();
                currentState.step = 'generating'; // Промежуточный шаг
                await startGenerationProcess(chatId, name, variant, colorsToUse, msg);
                break;
            case 'default':
                colorsToUse = defaultColors;
                currentState.step = 'generating'; // Промежуточный шаг
                await startGenerationProcess(chatId, name, variant, colorsToUse, msg);
                break;
            case 'custom':
                currentState.awaitingColors = true; // Устанавливаем флаг ожидания
                currentState.step = 'awaiting_custom_colors'; // Более точный шаг
                 // Редактируем текущее сообщение, превращая его в инструкцию
                 bot.editMessageText(`Хорошо. Теперь просто отправь мне сообщением список цветов через запятую.\n\n*Пример:* 
#ff0000, 0000ff, #aabbcc
(Можно с # или без, 3 или 6 символов hex)`, {
                     chat_id: chatId,
                     message_id: msg.message_id,
                     reply_markup: {
                         inline_keyboard: [
                             // Кнопка назад вернет к выбору способа задания цвета (random/default/custom)
                             [{ text: '⬅️ Назад (к выбору палитры)', callback_data: 'back_to_color_options' }],
                             [{ text: '❌ Отмена', callback_data: 'cancel_creation' }]
                         ]
                     },
                     parse_mode: 'Markdown'
                 }).catch(error => {
                     console.error(`[${chatId}] Ошибка отправки инструкции для кастомных цветов:`, error);
                 });
                 break;
        }
        return; // Важно завершить
    }

    // --- Логика кнопок под превью ---
    // Проверяем, что мы на шаге превью и есть ID сообщения
    if (userState[chatId]?.step === 'preview' && userState[chatId]?.previewMessageId === msg.message_id) {
        const currentState = userState[chatId];
        const { name, variant, previewMessageId, currentColors } = currentState; // Достаем нужные данные

        // Перегенерация ЦВЕТОВ
        if (data === 'regenerate_colors') {
            if (!name || !variant) { /* Доп. проверка */ return; } // На всякий случай
            const newColors = generateRandomPalette(); // Новые СЛУЧАЙНЫЕ цвета

            bot.answerCallbackQuery(callbackQuery.id, { text: '🎨 Генерирую новые цвета...' });

            const newSvgString = generateSvgString(name, variant, newColors); // Используем СТАРЫЙ стиль
            if (!newSvgString) { bot.sendMessage(chatId, "Ошибка при генерации нового SVG."); return; }

            currentState.currentSvgString = newSvgString; // Обновляем SVG
            currentState.currentColors = newColors; // Обновляем ЦВЕТА в состоянии

            const newPngBuffer = await convertSvgToPng(newSvgString);
            if (!newPngBuffer) { bot.sendMessage(chatId, "Ошибка при конвертации нового SVG в PNG."); return; }

            // Пытаемся обновить существующее фото
            try {
                 const existingMarkup = callbackQuery.message.reply_markup; // Используем ту же клавиатуру
                 await bot.editMessageMedia({
                    type: 'photo',
                    media: `attach://photo.png` // Идентификатор для файла ниже
                 }, {
                    chat_id: chatId,
                    message_id: previewMessageId,
                    reply_markup: existingMarkup // Передаем существующую клавиатуру
                 }, { // Доп. параметр для передачи файла
                    photo: newPngBuffer // Передаем новый PNG буфер
                 });
                 // Обновляем подпись, если нужно (например, упомянуть что цвета обновлены)
                 await bot.editMessageCaption(`Превью для "${name}" (стиль: ${variant}). Цвета обновлены! Что дальше?`, {
                     chat_id: chatId,
                     message_id: previewMessageId,
                     reply_markup: existingMarkup // Обязательно передаем markup еще раз
                 });

            } catch (error) {
                 console.error(`[${chatId}] Не удалось обновить превью (editMessageMedia - regen colors):`, error.response ? error.response.body : error);
                 // Если обновить не вышло (старое сообщение удалено, API изменился и т.д.)
                 bot.deleteMessage(chatId, previewMessageId).catch(()=>{}); // Удаляем старое
                 delete currentState.previewMessageId; // Убираем старый ID
                 await sendPngPreview(chatId, newPngBuffer, currentState); // Посылаем как новое
            }
            return; // Важно завершить
        }

        // Смена СТИЛЯ
        if (data === 'change_style') {
             if (!name || !currentColors) { /* Доп. проверка */ return; }

            // Удаляем старое превью
            bot.deleteMessage(chatId, previewMessageId).catch(()=>{});
            delete currentState.previewMessageId; // Убираем ID из состояния

            // Меняем шаг, чтобы далее обработать выбор типа как выбор НОВОГО типа
            currentState.step = 'selecting_new_style';
            // currentSvgString и currentColors НЕ удаляем - они нужны

            // Формируем кнопки выбора типа
            const typeKeyboard = avatarVariants.reduce((acc, variant, index) => {
                const button = { text: variant.charAt(0).toUpperCase() + variant.slice(1), callback_data: `select_type_${variant}` };
                if (index % 2 === 0) acc.push([button]); else acc[acc.length - 1].push(button); return acc;
            }, []);
            typeKeyboard.push([{ text: '❌ Отмена', callback_data: 'cancel_creation' }]);
            const options = { reply_markup: { inline_keyboard: typeKeyboard } };

            // Отправляем новое сообщение с выбором стиля
            bot.sendMessage(chatId, `Меняем стиль для "${name}". Выберите новый:\n(Текущие цвета [${currentColors.join(', ')}] будут сохранены)`, options);
            return; // Важно завершить
        }


        // Получение текущего SVG
        if (data === 'get_current_svg') {
             const { currentSvgString } = currentState; // SVG берем из состояния
             if (!currentSvgString) { bot.sendMessage(chatId, "Ошибка: Не найден SVG для отправки."); return; }

             const svgBuffer = Buffer.from(currentSvgString, 'utf8');
             const safeName = name.replace(/[^a-z0-9а-яё]/gi, '_').substring(0, 30); // Очищаем имя для файла
             const fileName = `${safeName}_${variant}.svg`; // Формируем имя файла

             try {
                  // Отправляем SVG как документ
                  await bot.sendDocument(chatId, svgBuffer, {
                      caption: `✅ Ваш SVG файл для "${name}" готов!` // Добавляем подпись к документу
                    }, {
                      filename: fileName, // Имя файла
                      contentType: 'image/svg+xml', // MIME-тип
                  });
                  console.log(`SVG аватар для "${name}" (${variant}) успешно отправлен chatId=${chatId}.`);

                  // Успешно отправили, удаляем состояние и убираем кнопки у превью
                  delete userState[chatId];
                  bot.editMessageReplyMarkup({}, { chat_id: chatId, message_id: previewMessageId })
                     .catch(err => {/* Игнорируем, если не удалось убрать кнопки (сообщение могло быть удалено) */});

             } catch (error) {
                  console.error(`[${chatId}] Ошибка отправки SVG документа:`, error.response ? error.response.body : error);
                  bot.sendMessage(chatId, '😔 Не удалось отправить SVG файл. Попробуйте еще раз нажать кнопку "Получить SVG".');
                  // Не удаляем состояние в этом случае, даем шанс повторить
             }
             return; // Важно завершить
        }
    } // Конец блока if (step === 'preview')

    // Если callback не обработан ни одним из блоков выше
    console.warn(`[${chatId}] Получен необработанный callback_data: ${data} в состоянии:`, userState[chatId]);
    bot.answerCallbackQuery(callbackQuery.id, { text: 'Неизвестное действие' });
});


// Обработчик обычных текстовых сообщений (для ввода кастомных цветов)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Игнорируем команды и сообщения без текста
    if (!text || text.startsWith('/')) {
        return;
    }

    // Проверяем, ожидает ли бот ввода кастомных цветов от этого пользователя
    if (userState[chatId] && userState[chatId].step === 'awaiting_custom_colors') {
        const currentState = userState[chatId];
        const inputText = text;
        try {
            // Парсим введенные цвета
            const customColors = inputText.split(',')
                .map(c => c.trim()) // Убираем пробелы
                .filter(c => c.length > 0) // Убираем пустые элементы
                .map(c => c.startsWith('#') ? c : `#${c}`); // Добавляем # если нет

            // Валидация формата HEX
            const hexRegex = /^#([0-9A-F]{3}|[0-9A-F]{6})$/i;
            const isValid = customColors.length > 0 && customColors.every(c => hexRegex.test(c));

            if (!isValid) {
                // Если формат неверный, просим пользователя попробовать снова
                bot.sendMessage(chatId, "🚫 Некорректный формат цветов. Убедитесь, что цвета разделены запятыми и являются валидными HEX-кодами (например, `#ff0000, 00ff00, abc`). Попробуйте еще раз.");
                // Не сбрасываем состояние `awaitingColors`, даем еще попытку
                return;
            }

            // Убираем флаг ожидания и меняем шаг
            delete currentState.awaitingColors;
            currentState.step = 'generating'; // Переходим к генерации

            // Можно попытаться удалить сообщение с инструкцией, если сохраняли его ID
            // if (currentState.instructionMessageId) {
            //     bot.deleteMessage(chatId, currentState.instructionMessageId).catch(()=>{});
            //     delete currentState.instructionMessageId;
            // }

            const { name, variant } = currentState; // Получаем сохраненные имя и тип

            // Запускаем генерацию превью с введенными кастомными цветами
            await startGenerationProcess(chatId, name, variant, customColors);

        } catch (error) {
            console.error(`[${chatId}] Ошибка обработки кастомных цветов:`, error);
            bot.sendMessage(chatId, "Произошла ошибка при обработке ваших цветов. Попробуйте еще раз или начните сначала /start.");
            // Можно оставить состояние awaiting_custom_colors или сбросить userState[chatId] полностью
        }
    } else if (userState[chatId] && userState[chatId].step && userState[chatId].step !== 'preview') {
        // Если пользователь находится в каком-то шаге создания (не превью), но прислал текст вместо нажатия кнопки
        // bot.sendMessage(chatId, "Пожалуйста, используйте кнопки для выбора опций.");
    }
    // Игнорируем все остальные сообщения, если пользователь не в процессе создания аватара
});


// --- Обработка ошибок ---
bot.on('polling_error', (error) => {
    console.error(`Polling ошибка: ${error.code} ${error.message ? `- ${error.message}` : ''}`);
    // Критическая ошибка авторизации
    if (error.response && error.response.statusCode === 401) {
        console.error("!!! КРИТИЧЕСКАЯ ОШИБКА: Недействительный токен бота! Проверьте .env файл! Завершение работы...");
        process.exit(1); // Выход, чтобы pm2 не перезапускал бесконечно
    } else if (error.code === 'EFATAL') {
         console.error("!!! Критическая ошибка опроса EFATAL. Возможно, проблемы с сетью или серверами Telegram.");
         // PM2 должен перезапустить процесс
    }
    // Другие ошибки (ECONNRESET, ETIMEDOUT) могут быть временными
});

bot.on('error', (error) => {
    console.error('Общая ошибка бота:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('!!! Глобальная ошибка: UNHANDLED REJECTION !!!');
  console.error('Причина:', reason);
  // console.error('Promise:', promise); // Раскомментируйте для детального стека промиса
  // Здесь может быть логика для отправки уведомления администратору
});

process.on('uncaughtException', (error, origin) => {
  console.error('!!! Глобальная ошибка: UNCAUGHT EXCEPTION !!!');
  console.error('Ошибка:', error);
  console.error('Источник:', origin);
  // После 'uncaughtException' приложение в непредсказуемом состоянии.
  // Рекомендуется завершить процесс. PM2 его перезапустит.
  process.exit(1);
});

console.log('Бот успешно настроен и слушает команды...');