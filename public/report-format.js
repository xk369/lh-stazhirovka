const TELEGRAM_REPORT_LIMIT = 3900;
const SEPARATOR = '━━━━━━━━━━━━━━━';
const KNOWN_HALLS = [
  'ROCKFELLER&ROTHSHILD`S HALL',
  'WELCOME HALL',
  'ROSEWOOD HALL',
  'MILINIS HALL',
  'ROYAL BLANC',
  'CHEKHOB HALL',
  'LEVITAN HALL',
  'MAIN HALL',
  'CONTRABANDA',
  'MONTBLANC',
  'ANDY&CYNDY',
  'LONG&ITTEN',
  'AMBERWOOD',
  'BLACKWOOD',
  'MAHOGANY',
  'AVANTAGE',
  'CHATEAU',
  'BACKYARD',
  'RATUSHA',
  'MONDRIAN',
  'BANKSY',
  'SMALL',
  'GRACE',
  'MANGO'
].sort((a, b) => b.length - a.length);

export function compactReportText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatDate(value) {
  if (!value) return '—';
  const [year, month, day] = String(value).split('-');
  return year && month && day ? `${day}.${month}.${year}` : String(value);
}

function splitLegacyName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  return { lastName: parts.shift() || '', firstName: parts.join(' ') };
}

function personLines({ firstName, lastName, legacyName, username, title }) {
  const legacy = splitLegacyName(legacyName);
  const cleanFirstName = compactReportText(String(firstName || legacy.firstName).trim() || 'Не заполнено', 60);
  const cleanLastName = compactReportText(String(lastName || legacy.lastName).trim() || 'Не заполнено', 60);
  const cleanUsername = compactReportText(String(username || '').trim(), 40);
  return [
    title,
    `Имя: ${cleanFirstName}`,
    `Фамилия: ${cleanLastName}`,
    cleanUsername ? `(${cleanUsername})` : '(Тег Telegram не указан)'
  ];
}

function mentorHashtag(profile) {
  const legacy = splitLegacyName(profile.fio);
  const surname = String(profile.lastName || legacy.lastName).trim().replace(/[^\p{L}\p{N}_]+/gu, '');
  return surname ? `#${surname}` : '#ФамилияНеУказана';
}

function hallHashtag(profile) {
  const hallValue = String(profile.hall || '').replace(/\s+/g, ' ').trim();
  const knownHall = KNOWN_HALLS.find(hall => hallValue === hall || hallValue.endsWith(` ${hall}`));
  const hall = knownHall || hallValue;
  const tag = hall.replace(/[^\p{L}\p{N}_]+/gu, '');
  return tag ? `#${tag}` : '#ЗалНеУказан';
}

function fitReport(headerLines, topicChunks, tailLines) {
  const compose = chunks => [...headerLines, ...chunks.flat(), ...tailLines].join('\n');
  let text = compose(topicChunks);
  if (text.length <= TELEGRAM_REPORT_LIMIT) return text;

  const overflowChunk = ['… Часть неосвоенных тем скрыта из-за лимита Telegram.'];
  const limitedChunks = [...topicChunks];
  while (
    limitedChunks.length &&
    compose([...limitedChunks, overflowChunk]).length > TELEGRAM_REPORT_LIMIT
  ) {
    limitedChunks.pop();
  }

  text = compose(limitedChunks.length ? [...limitedChunks, overflowChunk] : overflowChunk);
  return text.length <= TELEGRAM_REPORT_LIMIT
    ? text
    : compactReportText(text, TELEGRAM_REPORT_LIMIT);
}

export function formatInternshipReport({
  role,
  profile = {},
  summary = {},
  items = [],
  answers = {},
  mentorTopics = {}
}) {
  const orderedItems = [...items].sort((a, b) => Number(a.item_order) - Number(b.item_order));
  const failed = orderedItems.filter(item => answers[item.id]?.status === 'no');
  const passedWithComments = orderedItems.filter(item =>
    answers[item.id]?.status === 'yes' && String(answers[item.id]?.comment || '').trim()
  );
  const passed = orderedItems.filter(item => answers[item.id]?.status === 'yes').length;

  if (role === 'mentor') {
    const decision = summary.mentorDecision === 'Требуется повторная стажировка'
      ? '🔴 Повторная стажировка обязательна.'
      : summary.mentorDecision === 'Стажировка пройдена'
        ? '🟢 Стажировка пройдена.'
        : 'Решение не указано.';
    const headerLines = [
      `Дата стажировки: ${formatDate(profile.date)}`,
      `Зал: ${compactReportText(String(profile.hall || '').trim() || 'Не заполнено', 90)}`,
      ...personLines({ firstName: profile.firstName, lastName: profile.lastName, legacyName: profile.fio, username: profile.telegram, title: 'Наставник:' }),
      '',
      ...personLines({ firstName: profile.traineeFirstName, lastName: profile.traineeLastName, legacyName: profile.traineeFio, username: profile.traineeTelegram, title: 'Стажёр:' }),
      `Выполнено: ${passed} из ${orderedItems.length} пунктов`,
      SEPARATOR,
      'НЕ ОСВОЕННЫЕ ТЕМЫ'
    ];
    const failedChunks = failed.length
      ? failed.map(item => {
          const topic = mentorTopics[item.item_order] || compactReportText(item.text, 320);
          const chunk = [`${item.item_order}. ${topic}`];
          const comment = String(answers[item.id]?.comment || '').trim();
          if (comment) chunk.push(`↳ ${compactReportText(comment, 240)}`);
          return chunk;
        })
      : [['Все темы освоены.']];
    const passedCommentChunks = passedWithComments.length
      ? [
          [SEPARATOR, 'КОММЕНТАРИИ К ОСВОЕННЫМ ПУНКТАМ'],
          ...passedWithComments.map(item => {
            const topic = mentorTopics[item.item_order] || compactReportText(item.text, 320);
            return [
              `${item.item_order}. ${topic}`,
              `↳ ${compactReportText(answers[item.id].comment, 240)}`
            ];
          })
        ]
      : [];
    const topicChunks = [...failedChunks, ...passedCommentChunks];
    const tailLines = [
      SEPARATOR,
      'КОММЕНТАРИЙ НАСТАВНИКА',
      compactReportText(summary.mentorRecommendations || 'Комментарий не указан.', 1200),
      SEPARATOR,
      'РЕШЕНИЕ',
      decision,
      '',
      mentorHashtag(profile),
      hallHashtag(profile)
    ];

    return fitReport(headerLines, topicChunks, tailLines);
  }

  const headerLines = [
    `Дата стажировки: ${formatDate(profile.date)}`,
    `Имя стажёра: ${compactReportText(profile.firstName || splitLegacyName(profile.fio).firstName || 'Не заполнено', 60)}`,
    `Фамилия стажёра: ${compactReportText(profile.lastName || splitLegacyName(profile.fio).lastName || 'Не заполнено', 60)}`,
    `Ник в Telegram: ${compactReportText(profile.telegram || 'Не указан', 50)}`,
    `Пройдено: ${passed}/${orderedItems.length} · Непройдено: ${failed.length}`,
    SEPARATOR,
    'НЕ ОСВОЕННЫЕ ТЕМЫ'
  ];
  const topicChunks = failed.length
    ? failed.map(item => {
        const chunk = [`${item.item_order}. ${compactReportText(item.text, 320)}`];
        const comment = String(answers[item.id]?.comment || '').trim();
        if (comment) chunk.push(`↳ ${compactReportText(comment, 240)}`);
        return chunk;
      })
    : [['Все темы освоены.']];
  const tailLines = [
    SEPARATOR,
    'ВПЕЧАТЛЕНИЕ О СТАЖИРОВКЕ',
    compactReportText(summary.traineeFeedback || 'Впечатление не указано.', 1200)
  ];

  return fitReport(headerLines, topicChunks, tailLines);
}
