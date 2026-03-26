const REGIONS = [
    'Москва', 'Санкт-Петербург', 'Казань', 'Екатеринбург',
    'Новосибирск', 'Краснодар', 'Сочи', 'Владивосток',
    'Ростов-на-Дону', 'Уфа', 'Красноярск', 'Пермь',
    'Воронеж', 'Волгоград', 'Омск', 'Челябинск',
    'Н. Новгород', 'Самара', 'Калининград'
];

const NAME_REGEX = /^[а-яА-ЯёЁ\s\-]{2,30}$/;
const REGION_REGEX = /^[а-яА-ЯёЁ0-9\s\-.]+$/;

let selectedRegion = null;
let driverName = null;
let currentOrderId = null;
let ordersRefreshInterval = null;
let driverId = null;

function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Генерация или получение уникального ID устройства
function getDeviceId() {
    let deviceId = localStorage.getItem('deviceId');
    if (!deviceId) {
        deviceId = 'device_' + crypto.randomUUID();
        localStorage.setItem('deviceId', deviceId);
        console.log('🆕 Новый deviceId:', deviceId);
    }
    return deviceId;
}

function showStep(stepName) {
    document.querySelectorAll(".step").forEach(step => {
        step.classList.add("hidden");
        step.classList.remove("active");
    });
    const targetStep = document.getElementById("step-" + stepName);
    if (targetStep) {
        targetStep.classList.remove("hidden");
        targetStep.classList.add("active");
    }
}

function showScreen(screenId) {
    document.querySelectorAll(".step").forEach(step => {
        step.classList.add("hidden");
        step.classList.remove("active");
    });
    document.querySelectorAll('.screen').forEach(s => {
        s.classList.add('hidden');
    });
    const targetScreen = document.getElementById(screenId);
    if (targetScreen) {
        targetScreen.classList.remove('hidden');
        targetScreen.classList.add('active');
    }
}

function validateName(name) {
    return NAME_REGEX.test(name?.trim() || '');
}

function validateRegion(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (REGIONS.includes(trimmed)) return true;
    return REGION_REGEX.test(trimmed) && trimmed.length >= 2;
}

function renderRegionButtons() {
    const container = document.getElementById('region-buttons');
    if (!container) return;
    container.innerHTML = '';
    
    REGIONS.forEach(region => {
        const btn = document.createElement('button');
        btn.textContent = region;
        btn.onclick = () => {
            selectedRegion = region;
            showStep('name');
        };
        container.appendChild(btn);
    });
    
    const customBtn = document.createElement('button');
    customBtn.textContent = '➕ Своя локация';
    customBtn.onclick = () => {
        document.getElementById('custom-region-input').classList.remove('hidden');
    };
    container.appendChild(customBtn);
}

function submitCustomRegion() {
    const custom = document.getElementById('customRegion').value.trim();
    if (!custom || !validateRegion(custom)) {
        alert('Некорректное название города');
        return;
    }
    selectedRegion = custom;
    document.getElementById('custom-region-input').classList.add('hidden');
    showStep('name');
}

function backToRegionList() {
    document.getElementById('custom-region-input').classList.add('hidden');
}

function backTo(stepName) {
    showStep(stepName);
}

function nextToConfirm() {
    const name = document.getElementById('driverName').value.trim();
    if (!validateName(name)) {
        alert('Некорректное имя');
        return;
    }
    driverName = name;
    document.getElementById('driver-preview').innerHTML = `
        <p><strong>👤 Имя:</strong> ${escapeHtml(driverName)}</p>
        <p><strong>🌍 Регион:</strong> ${escapeHtml(selectedRegion)}</p>
    `;
    showStep('confirm');
}

async function registerDriver() {
    const registerBtn = document.querySelector('#step-confirm .btn-primary');
    const deviceId = getDeviceId();
    
    await withButtonLock(registerBtn, '⏳ Регистрация...', async () => {
        try {
            const response = await safeFetch('/api/driver/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    name: driverName, 
                    region: selectedRegion,
                    deviceId: deviceId
                })
            }, 8000);
            
            const data = await handleResponse(response);
            
            driverId = data.driverId;
            localStorage.setItem('driverId', driverId);
            
            showScreen('screen-main');
            subscribeToNotifications(deviceId);
            const driverInfo = document.getElementById('driver-info');
            if (driverInfo) {
                driverInfo.innerHTML = `
                    👤 ${escapeHtml(driverName)} | 🌍 ${escapeHtml(selectedRegion)}<br>
                    <small>👥 Водителей: ${data.driversCount} (онлайн: ${data.onlineCount || 0})</small>
                `;
            }
            loadOrders(deviceId);
            
        } catch (error) {
            console.error('Register error:', error);
            
            if (error.message === 'timeout') {
                alert('⏱ Сервер долго не отвечает. Попробуйте еще раз.');
            } else if (error.message === 'server_busy') {
                alert('🔄 Сервер временно перегружен. Попробуйте через пару секунд.');
            } else {
                alert('Ошибка: ' + error.message);
            }
        }
    });
}

async function loadOrders(deviceId) {
    try {
        const response = await fetch('/api/driver/orders?deviceId=' + deviceId);
        const orders = await response.json();
        
        const container = document.getElementById('orders-list');
        if (!container) return;
        
        const now = Date.now();
        
        if (orders.length === 0) {
            container.innerHTML = '<p style="text-align: center; margin: 30px;">📭 Нет активных заказов</p>';
            return;
        }
        
        let html = '<h3 style="margin: 20px 0;">📋 Доступные заказы:</h3>';
        orders.sort((a, b) => b.createdAt - a.createdAt).forEach(order => {
            const minutes = Math.floor((now - order.createdAt) / 60000);
            const timeText = minutes < 1 ? 'только что' : `${minutes} мин назад`;
            
            let offerStatus = '';
            if (order.hasOffer) {
                offerStatus = '<span class="badge badge-success">✅ Вы откликнулись</span>';
            }
            
            html += `
                <div class="order-card">
                    <p><strong>⏱ ${timeText} | ${escapeHtml(order.time)} ${offerStatus}</strong></p>
                    <p>📍 ${escapeHtml(order.addressFrom)} → ${escapeHtml(order.addressTo)}</p>
                    <p>🚗 ${escapeHtml(order.car)}</p>
                    <button onclick="openOfferModal('${order.id}')" style="margin-top: 15px;">
                        💰 Предложить цену
                    </button>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (error) {
        console.error('Load orders error:', error);
    }
}

function openOfferModal(orderId) {
    currentOrderId = orderId;
    const modal = document.getElementById('offer-modal');
    if (modal) {
        modal.style.display = 'flex';
    }
}

function closeOfferModal() {
    const modal = document.getElementById('offer-modal');
    if (modal) {
        modal.style.display = 'none';
    }
    const priceInput = document.getElementById('offer-price');
    const phoneInput = document.getElementById('offer-phone');
    if (priceInput) priceInput.value = '';
    if (phoneInput) phoneInput.value = '';
}

async function submitOffer() {
    const price = document.getElementById('offer-price')?.value;
    const phone = document.getElementById('offer-phone')?.value;
    const modal = document.getElementById('offer-modal');
    const submitBtn = modal?.querySelector('.btn-primary');
    const deviceId = getDeviceId();

    if (!price || !phone) {
        alert('Заполните все поля');
        return;
    }

    await withButtonLock(submitBtn, '⏳ Отправка...', async () => {
        try {
            const response = await safeFetch('/api/offer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    orderId: currentOrderId,
                    price: parseInt(price),
                    phone: phone,
                    deviceId: deviceId
                })
            }, 8000);

            await handleResponse(response);

            alert('✅ Предложение отправлено');
            closeOfferModal();
            loadOrders(deviceId);

        } catch (error) {
            console.error('Offer error:', error);

            if (error.message === 'timeout') {
                alert('⏱ Сервер долго не отвечает. Попробуйте еще раз.');
            } else if (error.message === 'server_busy') {
                alert('🔄 Сервер временно перегружен. Попробуйте через пару секунд.');
            } else {
                alert('Ошибка: ' + error.message);
            }
        }
    });
}

async function forgetDriver() {
    if (ordersRefreshInterval) clearInterval(ordersRefreshInterval);
    if (confirm('Удалить все данные?')) {
        const deviceId = getDeviceId();
        await fetch('/api/driver/forget', { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId })
        });
        localStorage.removeItem('driverId');
        localStorage.removeItem('deviceId');
        window.location.href = '/';
    }
}

async function restoreDriverSession() {
    try {
        const deviceId = getDeviceId();
        const response = await fetch('/api/driver/status?deviceId=' + deviceId);
        const data = await response.json();
        
        if (data.registered) {
            selectedRegion = data.driver.region;
            driverName = data.driver.name;
            driverId = data.driver.id;
            localStorage.setItem('driverId', driverId);
            
            showScreen('screen-main');
            
            const driverInfo = document.getElementById('driver-info');
            if (driverInfo) {
                driverInfo.innerHTML = `
                    👤 ${escapeHtml(driverName)} | 🌍 ${escapeHtml(selectedRegion)}<br>
                    <small>👥 Загрузка...</small>
                `;
            }
            loadOrders(deviceId);
        } else {
            showStep('region');
        }
    } catch (error) {
        console.error('Restore session error:', error);
        showStep('region');
    }
}

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
    renderRegionButtons();
    restoreDriverSession();
    
    const nameInput = document.getElementById('driverName');
    if (nameInput) {
        nameInput.addEventListener('input', function() {
            const val = this.value.trim();
            const errorDiv = document.getElementById('name-error');
            if (val && !validateName(val)) {
                this.classList.add('error-field');
                if (errorDiv) errorDiv.classList.remove('hidden');
            } else {
                this.classList.remove('error-field');
                if (errorDiv) errorDiv.classList.add('hidden');
            }
        });
    }
});

window.addEventListener('beforeunload', () => {
    if (ordersRefreshInterval) clearInterval(ordersRefreshInterval);
});

// ========== PUSH УВЕДОМЛЕНИЯ ==========

// Подписка на push-уведомления
async function subscribeToNotifications(deviceId) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.log('Push не поддерживается');
        return;
    }
    
    try {
        const keyResponse = await fetch('/api/vapid-public-key');
        const keyData = await keyResponse.json();
        
        if (!keyData.publicKey) {
            console.log('VAPID ключ не настроен на сервере');
            return;
        }
        
        const registration = await navigator.serviceWorker.ready;
        
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
        });
        
        const response = await fetch('/api/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subscription,
                region: selectedRegion,
                deviceId: deviceId
            })
        });
        
        if (response.ok) {
            console.log('✅ Подписка на уведомления оформлена');
        }
    } catch (error) {
        console.error('Ошибка подписки:', error);
    }
}

// Вспомогательная функция для преобразования ключа
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}
