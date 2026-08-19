(() => {
  const themeKey = 'loft-onboarding-theme';
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const systemTheme = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const savedTheme = () => {
    const value = localStorage.getItem(themeKey);
    return value === 'light' || value === 'dark' ? value : null;
  };
  const applyTheme = (theme, persist = false) => {
    const resolved = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = resolved;
    themeMeta?.setAttribute('content', resolved === 'dark' ? '#0b0b0e' : '#f5f5f7');
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.setAttribute('aria-label', resolved === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
      button.setAttribute('title', resolved === 'dark' ? 'Светлая тема' : 'Тёмная тема');
    });
    if (persist) localStorage.setItem(themeKey, resolved);
    if (window.Telegram?.WebApp) {
      Telegram.WebApp.setHeaderColor(resolved === 'dark' ? '#0b0b0e' : '#f5f5f7');
      Telegram.WebApp.setBackgroundColor(resolved === 'dark' ? '#0b0b0e' : '#f5f5f7');
    }
  };

  applyTheme(savedTheme() || window.Telegram?.WebApp?.colorScheme || systemTheme());
  document.querySelectorAll('[data-theme-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next, true);
    });
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', event => {
    if (!savedTheme()) applyTheme(event.matches ? 'dark' : 'light');
  });

  const storageKey = `loft-onboarding:${location.pathname.split('/').pop() || 'index.html'}`;
  const cards = [...document.querySelectorAll('[data-step]')];
  const toast = document.querySelector('[data-toast]');

  const showToast = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
  };

  const readState = () => {
    try { return JSON.parse(localStorage.getItem(storageKey)) || []; }
    catch { return []; }
  };

  const updateProgress = () => {
    const done = cards.filter(card => card.classList.contains('is-done')).length;
    const total = cards.length;
    const percent = total ? Math.round(done / total * 100) : 0;
    document.querySelectorAll('[data-progress-label]').forEach(el => el.textContent = `${done} из ${total}`);
    document.querySelectorAll('[data-progress-bar]').forEach(el => el.style.width = `${percent}%`);
    document.querySelectorAll('[data-progress-message]').forEach(el => {
      el.textContent = done === total ? 'Готово — все шаги выполнены' : done ? `Осталось шагов: ${total - done}` : (document.body.classList.contains('tau-page') ? 'Начните с регистрации СМЗ' : 'Начните с установки приложений');
    });
  };

  const saveState = () => {
    const done = cards.filter(card => card.classList.contains('is-done')).map(card => card.dataset.step);
    localStorage.setItem(storageKey, JSON.stringify(done));
    updateProgress();
  };

  const saved = readState();
  cards.forEach(card => {
    if (saved.includes(card.dataset.step)) card.classList.add('is-done');
    card.querySelector('[data-check]')?.addEventListener('click', () => {
      card.classList.toggle('is-done');
      saveState();
      if (card.classList.contains('is-done')) showToast('Шаг выполнен');
    });
  });
  updateProgress();

  document.querySelector('[data-reset]')?.addEventListener('click', () => {
    cards.forEach(card => card.classList.remove('is-done'));
    saveState();
    showToast('Прогресс сброшен');
  });

  document.querySelectorAll('[data-copy-target]').forEach(button => {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.textContent.trim());
        showToast('Шаблон скопирован');
      } catch {
        const range = document.createRange();
        range.selectNodeContents(target);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        showToast('Выделено — нажмите «Копировать»');
      }
    });
  });

  document.querySelectorAll('[data-sheet-open]').forEach(button => {
    button.addEventListener('click', () => document.getElementById(button.dataset.sheetOpen)?.showModal());
  });
  document.querySelectorAll('[data-sheet-close]').forEach(button => {
    button.addEventListener('click', () => button.closest('dialog')?.close());
  });
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  });

  document.querySelector('[data-share]')?.addEventListener('click', async () => {
    const shareData = { title: document.title, text: 'Инструкция Loft Hall для оформления выплат', url: location.href };
    try {
      if (navigator.share) await navigator.share(shareData);
      else { await navigator.clipboard.writeText(location.href); showToast('Ссылка скопирована'); }
    } catch (error) {
      if (error?.name !== 'AbortError') showToast('Не удалось поделиться');
    }
  });

  if (window.Telegram?.WebApp) {
    Telegram.WebApp.ready();
    Telegram.WebApp.expand();
    if (!savedTheme() && Telegram.WebApp.colorScheme) applyTheme(Telegram.WebApp.colorScheme);
    Telegram.WebApp.onEvent?.('themeChanged', () => {
      if (!savedTheme()) applyTheme(Telegram.WebApp.colorScheme || systemTheme());
    });
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
})();
