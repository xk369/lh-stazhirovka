import assert from 'node:assert/strict';
import test from 'node:test';
import { formatInternshipReport } from '../public/report-format.js';

const mentorTopics = {
  3: 'Правила поведения, санитарные нормы, техника и пожарная безопасность.',
  4: 'Компания, площадки и принципы работы коллектива.',
  6: 'Экскурсия по площадке и расположение рабочих зон.',
  11: 'Натирка стекла и посуды, техника безопасности.',
  12: 'Раскладка, гостевые салфетки, ручник и конверт для приборов.',
  25: 'Закрытие смены и порядок в рабочих зонах.'
};

test('formats trainee report for the recruiting group', () => {
  const items = [
    { id: 'trainee-05', item_order: 5, text: 'Я ознакомился с компанией и локациями и понял принципы работы коллектива: взаимопомощь, взаимовыручка и общее дело.' },
    { id: 'trainee-11', item_order: 11, text: 'Я выучил меню мероприятия, перечень алкоголя и план мероприятия до брифа.' },
    { id: 'trainee-16', item_order: 16, text: 'Я узнал, что такое облив и обнос, и освоил правило открытой руки при работе с гостями.' },
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `passed-${index + 1}`,
      item_order: index + 30,
      text: `Пройденный пункт ${index + 1}`
    }))
  ];
  const answers = Object.fromEntries(items.map(item => [item.id, { status: 'yes' }]));
  answers['trainee-05'] = { status: 'no', comment: 'Мне не рассказали' };
  answers['trainee-11'] = { status: 'no', comment: 'У меня плохая память' };
  answers['trainee-16'] = { status: 'no', comment: 'Не понял' };

  assert.equal(
    formatInternshipReport({
      role: 'trainee',
      profile: { date: '2026-06-12', firstName: 'Равшан', lastName: 'Канапиев', telegram: '@ravshiik' },
      summary: { traineeFeedback: 'В целом ок, но это какая-то шарашкина контора' },
      items,
      answers
    }),
    [
      'Дата стажировки: 12.06.2026',
      'Имя стажёра: Равшан',
      'Фамилия стажёра: Канапиев',
      'Ник в Telegram: @ravshiik',
      'Пройдено: 25/28 · Непройдено: 3',
      '━━━━━━━━━━━━━━━',
      'НЕ ОСВОЕННЫЕ ТЕМЫ',
      '5. Я ознакомился с компанией и локациями и понял принципы работы коллектива: взаимопомощь, взаимовыручка и общее дело.',
      '↳ Мне не рассказали',
      '11. Я выучил меню мероприятия, перечень алкоголя и план мероприятия до брифа.',
      '↳ У меня плохая память',
      '16. Я узнал, что такое облив и обнос, и освоил правило открытой руки при работе с гостями.',
      '↳ Не понял',
      '━━━━━━━━━━━━━━━',
      'ВПЕЧАТЛЕНИЕ О СТАЖИРОВКЕ',
      'В целом ок, но это какая-то шарашкина контора'
    ].join('\n')
  );
});

test('formats mentor report for the manager group', () => {
  const failedOrders = new Set([3, 4, 11, 12, 25]);
  const items = Array.from({ length: 29 }, (_, index) => ({
    id: `mentor-${index + 1}`,
    item_order: index + 1,
    text: `Пункт наставника ${index + 1}`
  }));
  const answers = Object.fromEntries(items.map(item => [
    item.id,
    { status: failedOrders.has(item.item_order) ? 'no' : 'yes' }
  ]));
  answers['mentor-3'].comment = 'Не успели';
  answers['mentor-4'].comment = 'Была запара';
  answers['mentor-6'].comment = 'Быстро сориентировался по площадке';
  answers['mentor-25'].comment = 'Он ушел домой';

  assert.equal(
    formatInternshipReport({
      role: 'mentor',
      profile: {
        date: '2026-06-12',
        hall: 'LOFT #3 RATUSHA',
        firstName: 'Равшан',
        lastName: 'Канапиев',
        telegram: '@ravshik',
        traineeFirstName: 'Руслан',
        traineeLastName: 'Рекрутович',
        traineeTelegram: '@ruslanka'
      },
      summary: {
        mentorRecommendations: 'В целом он норм, но темки предлагает левые',
        mentorDecision: 'Стажировка пройдена'
      },
      items,
      answers,
      mentorTopics
    }),
    [
      'Дата стажировки: 12.06.2026',
      'Зал: LOFT #3 RATUSHA',
      'Наставник:',
      'Имя: Равшан',
      'Фамилия: Канапиев',
      '(@ravshik)',
      '',
      'Стажёр:',
      'Имя: Руслан',
      'Фамилия: Рекрутович',
      '(@ruslanka)',
      'Выполнено: 24 из 29 пунктов',
      '━━━━━━━━━━━━━━━',
      'НЕ ОСВОЕННЫЕ ТЕМЫ',
      '3. Правила поведения, санитарные нормы, техника и пожарная безопасность.',
      '↳ Не успели',
      '4. Компания, площадки и принципы работы коллектива.',
      '↳ Была запара',
      '11. Натирка стекла и посуды, техника безопасности.',
      '12. Раскладка, гостевые салфетки, ручник и конверт для приборов.',
      '25. Закрытие смены и порядок в рабочих зонах.',
      '↳ Он ушел домой',
      '━━━━━━━━━━━━━━━',
      'КОММЕНТАРИИ К ОСВОЕННЫМ ПУНКТАМ',
      '6. Экскурсия по площадке и расположение рабочих зон.',
      '↳ Быстро сориентировался по площадке',
      '━━━━━━━━━━━━━━━',
      'КОММЕНТАРИЙ НАСТАВНИКА',
      'В целом он норм, но темки предлагает левые',
      '━━━━━━━━━━━━━━━',
      'РЕШЕНИЕ',
      '🟢 Стажировка пройдена.',
      '',
      '#Канапиев',
      '#RATUSHA'
    ].join('\n')
  );
});
