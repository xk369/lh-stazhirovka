const ALLOWED_ROLES = new Set(['trainee', 'mentor']);

export function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (!ALLOWED_ROLES.has(role)) {
    throw new Error('Неизвестная роль отчёта.');
  }
  return role;
}

export function normalizeReportText(value) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error('Текст отчёта пуст.');
  }
  if (text.length > 3900) {
    throw new Error('Отчёт превышает допустимый размер Telegram.');
  }
  return text;
}

export function resolveChatId(role, config) {
  const chatId = role === 'mentor' ? config.mentorChatId : config.traineeChatId;
  if (!chatId) {
    throw new Error(`Для роли ${role} не настроена группа Telegram.`);
  }
  return chatId;
}
