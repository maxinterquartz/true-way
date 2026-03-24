async function safeFetch(url, options, timeout = 8000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('timeout');
        }
        throw error;
    }
}

async function withButtonLock(button, loadingText, asyncFn) {
    if (!button) return await asyncFn();

    const originalText = button.innerText;
    button.disabled = true;
    button.innerText = loadingText;

    try {
        return await asyncFn();
    } finally {
        button.disabled = false;
        button.innerText = originalText;
    }
}

async function handleResponse(response) {
    if (response.status === 503) {
        throw new Error('server_busy');
    }
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
    }
    return await response.json();
}

// Регистрация Service Worker для PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('✅ SW зарегистрирован:', reg.scope))
            .catch(err => console.error('❌ Ошибка SW:', err));
    });
}

// ========== PWA УСТАНОВКА ==========
let deferredPrompt;

// Показываем кнопку через 3 секунды (всегда, на всякий случай)
setTimeout(() => {
    const container = document.getElementById('install-container');
    if (container) {
        container.style.display = 'block';
        console.log('🔘 Кнопка установки показана');
    }
}, 3000);

// Если браузер разрешил установку — запоминаем событие
window.addEventListener('beforeinstallprompt', (e) => {
    console.log('✅ PWA можно установить');
    e.preventDefault();
    deferredPrompt = e;
    
    // Показываем кнопку (если ещё не показана)
    const container = document.getElementById('install-container');
    if (container) container.style.display = 'block';
});

// Обработчик кнопки установки
document.addEventListener('DOMContentLoaded', () => {
    const installBtn = document.getElementById('install-btn');
    if (installBtn) {
        installBtn.addEventListener('click', async () => {
            if (deferredPrompt) {
                // Если есть событие — используем стандартную установку
                installBtn.disabled = true;
                installBtn.textContent = '⏳ Установка...';
                
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                
                console.log(`📲 Установка: ${outcome}`);
                installBtn.textContent = outcome === 'accepted' ? '✅ Установлено!' : '❌ Отменено';
                deferredPrompt = null;
                
                setTimeout(() => {
                    const container = document.getElementById('install-container');
                    if (container) container.style.display = 'none';
                }, 2000);
            } else {
                // Если события нет — показываем инструкцию
                alert('📲 Чтобы установить приложение:\n\n' +
                      '1. Нажмите на три точки в правом верхнем углу\n' +
                      '2. Выберите "Установить приложение"\n' +
                      '3. Нажмите "Установить"');
            }
        });
    }
});

// Если приложение уже установлено
window.addEventListener('appinstalled', () => {
    console.log('✅ PWA установлено');
    const container = document.getElementById('install-container');
    if (container) container.style.display = 'none';
});
