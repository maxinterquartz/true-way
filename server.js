require('dotenv').config();
const express = require('express');
const session = require('cookie-session');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Проверка обязательных переменных окружения
const requiredEnvVars = [
    'SESSION_SECRET'
];

requiredEnvVars.forEach(varName => {
    if (!process.env[varName]) {
        console.error(`❌ CRITICAL: ${varName} not set in .env`);
        process.exit(1);
    }
});

const app = express();
const PORT = process.env.PORT || 8080;

// ========== КОНСТАНТЫ И ЛИМИТЫ ==========
const ORDER_TTL = 15 * 60 * 1000; // 15 минут
const MAX_DRIVERS = 9999;          // Максимум водителей
const MAX_ORDERS = 999;             // Максимум активных заказов
const MAX_OFFERS_PER_ORDER = 99;    // Максимум предложений на заказ

// ========== PUSH УВЕДОМЛЕНИЯ ==========
const webpush = require('web-push');

// Настройка VAPID
webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

// Хранилище подписок (пока в памяти)
const subscriptions = {}; // { driverId: { subscription, region } }

// Хранилище данных в памяти
const drivers = {};
const orders = {};

// Список регионов
const REGIONS = [
    'Москва', 'Санкт-Петербург', 'Казань', 'Екатеринбург',
    'Новосибирск', 'Краснодар', 'Сочи', 'Владивосток',
    'Ростов-на-Дону', 'Уфа', 'Красноярск', 'Пермь',
    'Воронеж', 'Волгоград', 'Омск', 'Челябинск',
    'Н. Новгород', 'Самара', 'Калининград'
];

// Регулярные выражения для валидации
const NAME_REGEX = /^[а-яА-ЯёЁ\s\-]{2,30}$/;
const REGION_REGEX = /^[а-яА-ЯёЁ0-9\s\-.]+$/;
const ADDRESS_REGEX = /^[а-яА-ЯёЁ0-9\s\-,\.\(\)]{3,100}$/;
const CAR_REGEX = /^[а-яА-ЯёЁa-zA-Z0-9\s\-]{2,50}$/;
const PHONE_REGEX = /^\+?[0-9]{10,15}$/;

// Rate limiting
const createOrderLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { error: 'Слишком много попыток, попробуйте позже' },
    standardHeaders: true,
    legacyHeaders: false
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Слишком много попыток регистрации' }
});

// Middleware
app.use(express.json());

// ========== УЛУЧШЕНИЕ 1: КЭШИРОВАНИЕ СТАТИКИ ==========
app.use(express.static('public', {
    maxAge: '1d',
    etag: true,
    lastModified: true,
    immutable: true
}));

// Логирование медленных запросов
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (duration > 1000) {
            console.log(`⚠️ Медленный запрос: ${req.method} ${req.url} - ${duration}ms`);
        }
    });
    next();
});

app.use(session({
    name: 'session',
    keys: [process.env.SESSION_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
}));

// ========== API: VAPID ПУБЛИЧНЫЙ КЛЮЧ ==========
app.get('/api/vapid-public-key', (req, res) => {
    res.json({ 
        publicKey: process.env.VAPID_PUBLIC_KEY || null 
    });
});

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\//g, '&#x2F;');
}

function sanitizeInput(str) {
    if (!str || typeof str !== 'string') return '';
    return str.trim();
}

function generateId() {
    return Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function validateDriverName(name) {
    return NAME_REGEX.test((name || '').trim());
}

function validateRegion(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (REGIONS.includes(trimmed)) return true;
    return REGION_REGEX.test(trimmed) && trimmed.length >= 2 && trimmed.length <= 50;
}

function validateAddress(text) {
    if (!text || typeof text !== 'string') return false;
    return ADDRESS_REGEX.test(text.trim());
}

function validateCar(text) {
    if (!text || typeof text !== 'string') return false;
    return CAR_REGEX.test(text.trim());
}

function validatePrice(price) {
    const priceStr = String(price || '').trim();
    if (!/^\d+$/.test(priceStr)) return false;
    const priceNum = parseInt(priceStr);
    return priceNum >= 1000 && priceNum <= 1000000;
}

function validatePhone(phone) {
    return PHONE_REGEX.test((phone || '').trim());
}

function countDriversInRegion(region) {
    return Object.values(drivers).filter(d => d.region === region).length;
}

function countOnlineDriversInRegion(region) {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    return Object.values(drivers).filter(d => 
        d.region === region && 
        d.lastSeen && 
        d.lastSeen > fiveMinutesAgo
    ).length;
}

// ========== API: ПРОВЕРКА СЕРВЕРА ==========

app.get('/api/ping', (req, res) => {
    res.json({ 
        ok: true, 
        timestamp: Date.now(),
        drivers: Object.keys(drivers).length,
        orders: Object.keys(orders).length,
        limits: {
            maxDrivers: MAX_DRIVERS,
            maxOrders: MAX_ORDERS,
            maxOffersPerOrder: MAX_OFFERS_PER_ORDER
        }
    });
});

// ========== УЛУЧШЕНИЕ 2: HEALTHCHECK ==========
app.get('/health', (req, res) => {
    const memoryUsage = process.memoryUsage();
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: Date.now(),
        memory: {
            rss: Math.round(memoryUsage.rss / 1024 / 1024),
            heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
            heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024)
        },
        stats: {
            drivers: Object.keys(drivers).length,
            orders: Object.keys(orders).length
        },
        limits: {
            maxDrivers: MAX_DRIVERS,
            maxOrders: MAX_ORDERS,
            maxOffersPerOrder: MAX_OFFERS_PER_ORDER
        }
    });
});

// ========== API: ВОДИТЕЛЬ ==========

app.post('/api/driver/register', registerLimiter, (req, res) => {
    const { name, region, deviceId } = req.body;
    
    if (!deviceId) {
        return res.status(400).json({ error: 'deviceId обязателен' });
    }
    
    if (!validateDriverName(name)) {
        return res.status(400).json({ error: 'Имя должно быть на русском, от 2 до 30 символов' });
    }
    
    if (!validateRegion(region)) {
        return res.status(400).json({ error: 'Некорректный регион' });
    }
    
    // Проверка лимита водителей
    if (Object.keys(drivers).length >= MAX_DRIVERS) {
        return res.status(503).json({ error: 'Сервер перегружен, попробуйте позже' });
    }
    
    // Ищем водителя по deviceId (вместо sessionId)
    let driver = Object.values(drivers).find(d => d.deviceId === deviceId);
    
    if (driver) {
        // Обновляем существующего
        driver.name = sanitizeInput(name);
        driver.region = sanitizeInput(region);
        driver.lastSeen = Date.now();
        console.log(`🔄 Водитель ${driver.id} обновлён: ${name}, ${region}, deviceId: ${deviceId}`);
    } else {
        // Создаём нового
        const driverId = 'driver_' + generateId();
        drivers[driverId] = {
            id: driverId,
            name: sanitizeInput(name),
            region: sanitizeInput(region),
            deviceId: deviceId,
            createdAt: Date.now(),
            lastSeen: Date.now()
        };
        driver = drivers[driverId];
        console.log(`✅ Новый водитель ${driverId}: ${name}, ${region}, deviceId: ${deviceId}`);
    }
    
    res.json({ 
        ok: true, 
        driverId: driver.id,
        driversCount: countDriversInRegion(region),
        onlineCount: countOnlineDriversInRegion(region)
    });
});

app.get('/api/driver/status', (req, res) => {
    const { deviceId } = req.query;
    
    if (!deviceId) {
        return res.json({ registered: false });
    }
    
    const driver = Object.values(drivers).find(d => d.deviceId === deviceId);
    
    if (driver) {
        driver.lastSeen = Date.now();
        res.json({ 
            registered: true,
            driver: {
                id: driver.id,
                name: escapeHtml(driver.name),
                region: escapeHtml(driver.region)
            }
        });
    } else {
        res.json({ registered: false });
    }
});

app.get('/api/driver/orders', (req, res) => {
    const { deviceId } = req.query;
    
    if (!deviceId) {
        return res.status(401).json({ error: 'Водитель не авторизован' });
    }
    
    const driver = Object.values(drivers).find(d => d.deviceId === deviceId);
    
    if (!driver) {
        return res.status(401).json({ error: 'Водитель не авторизован' });
    }
    
    driver.lastSeen = Date.now();
    
    const activeOrders = Object.values(orders).filter(
        o => o.region === driver.region && o.status === 'active'
    );
    
    res.json(activeOrders.map(o => ({
        id: o.id,
        time: o.time,
        addressFrom: escapeHtml(o.addressFrom),
        addressTo: escapeHtml(o.addressTo),
        car: escapeHtml(o.car),
        createdAt: o.createdAt,
        hasOffer: o.offers.some(offer => offer.driverId === driver.id)
    })));
});

app.post('/api/driver/forget', (req, res) => {
    const { deviceId } = req.body;
    
    if (!deviceId) {
        return res.status(400).json({ error: 'deviceId обязателен' });
    }
    
    const driver = Object.values(drivers).find(d => d.deviceId === deviceId);
    
    if (driver) {
        Object.values(orders).forEach(order => {
            if (order.offers) {
                order.offers = order.offers.filter(offer => offer.driverId !== driver.id);
            }
        });
        delete drivers[driver.id];
        console.log(`🗑 Водитель ${driver.name} удалён (deviceId: ${deviceId})`);
    }
    
    res.json({ ok: true });
});

// ========== API: ЗАКАЗЫ ==========

app.post('/api/order/create', createOrderLimiter, (req, res) => {
    const { region, time, addressFrom, addressTo, car } = req.body;
    
    if (!validateRegion(region)) {
        return res.status(400).json({ error: 'Некорректный регион' });
    }
    if (!validateAddress(addressFrom)) {
        return res.status(400).json({ error: 'Некорректный адрес подачи' });
    }
    if (!validateAddress(addressTo)) {
        return res.status(400).json({ error: 'Некорректный адрес назначения' });
    }
    if (!validateCar(car)) {
        return res.status(400).json({ error: 'Некорректная марка авто' });
    }
    
    // Проверка лимита заказов
    if (Object.keys(orders).length >= MAX_ORDERS) {
        return res.status(503).json({ error: 'Слишком много активных заказов, попробуйте позже' });
    }
    
    const sessionId = req.session.id;
    
    const userActiveOrders = Object.values(orders).filter(
        order => order.sessionId === sessionId && order.status === 'active'
    ).length;
    
    if (userActiveOrders >= 3) {
        return res.status(400).json({ error: 'Слишком много активных заказов (максимум 3)' });
    }
    
    const orderId = 'order_' + generateId();
    
    orders[orderId] = {
        id: orderId,
        sessionId: sessionId,
        region: sanitizeInput(region),
        time: sanitizeInput(time),
        addressFrom: sanitizeInput(addressFrom),
        addressTo: sanitizeInput(addressTo),
        car: sanitizeInput(car),
        createdAt: Date.now(),
        status: 'active',
        offers: []
    };
    
    req.session.lastOrderId = orderId;
    
    res.json({ 
        ok: true, 
        orderId,
        message: 'Заказ создан',
        driversCount: countDriversInRegion(region),
        onlineCount: countOnlineDriversInRegion(region)
    });
});

app.get('/api/order/:id', (req, res) => {
    const order = orders[req.params.id];
    if (!order) {
        return res.status(404).json({ error: 'Заказ не найден' });
    }
    
    if (order.sessionId === req.session.id) {
        res.json({
            id: order.id,
            region: escapeHtml(order.region),
            time: escapeHtml(order.time),
            addressFrom: escapeHtml(order.addressFrom),
            addressTo: escapeHtml(order.addressTo),
            car: escapeHtml(order.car),
            status: order.status,
            createdAt: order.createdAt,
            offers: order.offers.map(o => ({
                driverName: escapeHtml(o.driverName),
                phone: o.phone,
                price: o.price,
                createdAt: o.createdAt
            }))
        });
        return;
    }
    
    res.json({
        id: order.id,
        region: escapeHtml(order.region),
        time: escapeHtml(order.time),
        addressFrom: escapeHtml(order.addressFrom),
        addressTo: escapeHtml(order.addressTo),
        car: escapeHtml(order.car),
        status: order.status
    });
});

app.post('/api/order/:id/close', (req, res) => {
    const order = orders[req.params.id];
    if (!order || order.sessionId !== req.session.id) {
        return res.status(404).json({ error: 'Заказ не найден' });
    }
    
    delete orders[req.params.id];
    console.log(`✅ Заказ ${req.params.id} закрыт и удалён`);
    res.json({ ok: true });
});

app.post('/api/order/:id/cancel', (req, res) => {
    const order = orders[req.params.id];
    if (!order || order.sessionId !== req.session.id) {
        return res.status(404).json({ error: 'Заказ не найден' });
    }
    
    delete orders[req.params.id];
    console.log(`❌ Заказ ${req.params.id} отменён`);
    res.json({ ok: true });
});

// ========== API: ПРЕДЛОЖЕНИЯ ==========

app.post('/api/offer', (req, res) => {
    const { orderId, price, phone, deviceId } = req.body;
    
    if (!deviceId) {
        return res.status(401).json({ error: 'Водитель не авторизован' });
    }
    
    const driver = Object.values(drivers).find(d => d.deviceId === deviceId);
    
    if (!driver) {
        return res.status(401).json({ error: 'Водитель не авторизован' });
    }
    
    if (!validatePrice(price)) {
        return res.status(400).json({ error: 'Цена от 1000 до 1000000' });
    }
    
    if (!validatePhone(phone)) {
        return res.status(400).json({ error: 'Некорректный номер телефона' });
    }
    
    const order = orders[orderId];
    if (!order || order.status !== 'active') {
        return res.status(404).json({ error: 'Заказ не найден или неактивен' });
    }
    
    if (driver.region !== order.region) {
        return res.status(400).json({ error: 'Не ваш регион' });
    }
    
    // Проверка лимита предложений
    if (order.offers.length >= MAX_OFFERS_PER_ORDER) {
        return res.status(400).json({ error: 'Достигнут лимит предложений на этот заказ' });
    }
    
    const existingIndex = order.offers.findIndex(o => o.driverId === driver.id);
    if (existingIndex !== -1) {
        order.offers.splice(existingIndex, 1);
    }
    
    order.offers.push({
        driverId: driver.id,
        driverName: driver.name,
        phone: sanitizeInput(phone),
        price: parseInt(price),
        createdAt: Date.now()
    });
    
    console.log(`💰 Водитель ${driver.name} предложил ${price} руб. за заказ ${orderId}`);
    res.json({ ok: true });
});

// ========== API: PUSH ПОДПИСКА ==========
app.post('/api/subscribe', (req, res) => {
    const { subscription, region, deviceId } = req.body;
    
    if (!deviceId) {
        return res.status(401).json({ error: 'Водитель не авторизован' });
    }
    
    const driver = Object.values(drivers).find(d => d.deviceId === deviceId);
    
    if (!driver) {
        return res.status(401).json({ error: 'Водитель не авторизован' });
    }
    
    subscriptions[driver.id] = {
        subscription,
        region: driver.region,
        createdAt: Date.now()
    };
    
    console.log(`🔔 Водитель ${driver.name} подписался на уведомления (deviceId: ${deviceId})`);
    res.json({ ok: true });
});

// Тестовый эндпоинт для проверки уведомлений
app.post('/api/test-notification', (req, res) => {
    const { subscription } = req.body;
    
    if (!subscription) {
        return res.status(400).json({ error: 'Нет подписки' });
    }
    
    webpush.sendNotification(subscription, JSON.stringify({
        title: '🔔 Тест',
        body: 'Уведомления работают!',
        icon: '/icons/icon-192x192.png',
        url: '/driver'
    })).then(() => {
        console.log('✅ Тестовое уведомление отправлено');
        res.json({ ok: true });
    }).catch(err => {
        console.error('❌ Ошибка отправки:', err.message);
        res.status(500).json({ error: err.message });
    });
});

// ========== ОЧИСТКА СТАРЫХ ЗАКАЗОВ ==========

setInterval(() => {
    const now = Date.now();
    const expired = now - ORDER_TTL;
    
    Object.keys(orders).forEach(orderId => {
        if (orders[orderId].createdAt < expired) {
            delete orders[orderId];
        }
    });
}, 5 * 60 * 1000);

// ========== СТРАНИЦЫ ==========

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/order', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

app.get('/driver', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'driver.html'));
});

// ========== УЛУЧШЕНИЕ 3: ОБРАБОТЧИК ОШИБОК ==========
// Глобальный обработчик ошибок (должен быть последним middleware)
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err.message);
    console.error(err.stack);
    
    // Не отправляем детали ошибки клиенту
    res.status(500).json({ 
        error: 'Внутренняя ошибка сервера',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Обработка 404 (не найденные маршруты)
app.use((req, res) => {
    res.status(404).json({ error: 'Маршрут не найден' });
});

const HOST = '0.0.0.0';

// Всегда запускаем HTTP, потому что HTTPS обеспечивается Cloud.ru на балансировщике
app.listen(PORT, HOST, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    console.log(`🌍 Локально: http://localhost:${PORT}/`);
    console.log(`📊 Лимиты: водители=${MAX_DRIVERS}, заказы=${MAX_ORDERS}, предложений на заказ=${MAX_OFFERS_PER_ORDER}`);
    console.log(`🩺 Healthcheck: http://localhost:${PORT}/health`);
    console.log(`🔐 HTTPS обеспечивается Cloud.ru на внешнем уровне`);
});
