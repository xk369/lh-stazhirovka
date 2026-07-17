import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../', import.meta.url);

async function readPublicFile(name) {
  return readFile(new URL(`public/${name}`, projectRoot), 'utf8');
}

test('home menu names describe the user action behind every entry', async () => {
  const html = await readPublicFile('index.html');

  assert.match(html, /ЗАПИСАТЬСЯ НА СТАЖИРОВКУ/);
  assert.match(html, /ЧЕК-ЛИСТ СТАЖЁРА/);
  assert.match(html, /ОТЧЁТ НАСТАВНИКА/);
  assert.equal((html.match(/class="role-description"/g) || []).length, 3);
});

test('recruiter candidates button is a primary navigation item', async () => {
  const html = await readPublicFile('booking.html');
  const nav = html.match(/<nav class="recruiter-nav"[\s\S]*?<\/nav>/)?.[0] || '';
  const moreMenu = nav.match(/<div class="recruiter-more-menu">[\s\S]*?<\/details>/)?.[0] || '';

  assert.match(nav, /data-section="dates"[^>]*>Даты<\/button>/);
  assert.match(nav, /data-section="candidates"[^>]*>Кандидаты<\/button>/);
  assert.match(nav, /data-section="groups"[^>]*>Группы<\/button>/);
  assert.doesNotMatch(moreMenu, /data-section="candidates"/);
});

test('registry search updates results asynchronously without replacing its input', async () => {
  const html = await readPublicFile('booking.html');
  const registrySection = html.match(/<section id="registrySection"[\s\S]*?<section id="groupsSection"/)?.[0] || '';
  const renderRegistry = html.match(/function renderRegistry\(\) \{[\s\S]*?\n    \}/)?.[0] || '';
  const inputHandler = html.match(/if \(event\.target\.id === "registrySearch"\) \{[\s\S]*?\n      \}/)?.[0] || '';

  assert.match(registrySection, /id="registrySearch"[^>]*type="search"/);
  assert.doesNotMatch(renderRegistry, /outerHTML|replaceWith/);
  assert.match(inputHandler, /scheduleRegistryRender\(\)/);
  assert.doesNotMatch(inputHandler, /render\(\)|renderRegistry\(\)/);
});

test('trainee booking form requires phone and sends it with applications', async () => {
  const html = await readPublicFile('booking.html');
  const traineeView = html.match(/<section id="traineeView">[\s\S]*?<section id="recruiterView"/)?.[0] || '';
  const applicationPayload = html.match(/function applicationCommandPayload\(app\) \{[\s\S]*?\n    \}/)?.[0] || '';
  const syncProfile = html.match(/function syncProfile\(options = \{\}\) \{[\s\S]*?\n    \}/)?.[0] || '';
  const validation = html.match(/function validateTraineeProfile\(\) \{[\s\S]*?\n    \}/)?.[0] || '';
  const workgroupLine = html.match(/function traineeWorkgroupLine\(app\) \{[\s\S]*?\n    \}/)?.[0] || '';

  assert.match(traineeView, /id="traineePhone"[^>]*type="tel"[^>]*required/);
  assert.match(traineeView, /Номер телефона при регистрации в боте/);
  assert.match(traineeView, /id="trainingDateField"[\s\S]*Дата обучения/);
  assert.match(traineeView, /class="date-field-shell"[\s\S]*id="traineeTrainingDate"[^>]*type="date"/);
  assert.match(traineeView, /id="traineeTrainingDate"[^>]*type="date"/);
  assert.match(html, /class="date-field-shell"[\s\S]*id="newDate"[^>]*type="date"/);
  assert.match(html, /\.date-field-shell \{[\s\S]*overflow: hidden;/);
  assert.match(html, /\.date-field-shell input\[type="date"\] \{[\s\S]*-webkit-appearance: none;/);
  assert.match(applicationPayload, /phone: app\.phone \|\| ""/);
  assert.match(applicationPayload, /trainingDate: app\.training === "passed" \? app\.trainingDate \|\| "" : ""/);
  assert.match(syncProfile, /phone: fields\.traineePhone\.value\.trim\(\)/);
  assert.match(syncProfile, /trainingDate = training === "passed" \? fields\.traineeTrainingDate\.value : ""/);
  assert.match(validation, /isValidPhone\(state\.profile\.phone\)/);
  assert.match(validation, /state\.profile\.training === "passed"/);
  assert.match(validation, /Укажите дату прохождения обучения/);
  assert.match(workgroupLine, /тел\. \$\{phone\}/);
  assert.match(html, /Дата обучения: \$\{escapeHtml\(formatDate\(app\.trainingDate\)\)\}/);
  assert.match(html, /<span>Дата обучения<\/span><b>\$\{escapeHtml\(formatDate\(app\.trainingDate\)\)\}<\/b>/);
  assert.match(html, /Дата обучения: \$\{escapeHtml\(row\.trainingDate\)\}/);
});

test('candidate cards are numbered, comment-free and use one step-back action', async () => {
  const html = await readPublicFile('booking.html');
  const renderCandidates = html.match(/function renderCandidates\(\) \{[\s\S]*?\n    \}\n\n    function registryRows/)?.[0] || '';

  assert.match(renderCandidates, /<span class="candidate-number">\$\{index \+ 1\}<\/span>/);
  assert.doesNotMatch(renderCandidates, /№/);
  assert.match(renderCandidates, /candidate-status/);
  assert.match(renderCandidates, /candidate-info-grid/);
  assert.match(renderCandidates, /data-step-back/);
  assert.match(renderCandidates, /step-back-main/);
  assert.match(renderCandidates, /step-back-target/);
  assert.doesNotMatch(renderCandidates, /class="badges"/);
  assert.doesNotMatch(renderCandidates, /data-comment|<textarea/);
  assert.doesNotMatch(renderCandidates, /Откатить к отчету|Откатить к приглашению/);
});

test('recruiter date cards attach internship cancellation to trainee cards', async () => {
  const html = await readPublicFile('booking.html');
  const renderPendingCandidate = html.match(/function renderPendingCandidate\(app\) \{[\s\S]*?\n    \}\n\n    function renderBookedCandidate/)?.[0] || '';
  const renderBookedCandidate = html.match(/function renderBookedCandidate\(app\) \{[\s\S]*?\n    \}\n\n    function eligibleInviteCandidates/)?.[0] || '';
  const actionsBlock = html.match(/<div class="shift-admin-actions">[\s\S]*?<\/div>/)?.[0] || '';

  assert.doesNotMatch(actionsBlock, /data-cancel-shift|Отменить стажировку/);
  assert.match(renderPendingCandidate, /data-cancel-internship="\$\{app\.id\}"/);
  assert.match(renderBookedCandidate, /data-cancel-internship="\$\{app\.id\}"/);
  assert.match(html, /queueBookingCommand\("cancel_internship"/);
  assert.match(html, /Закрыть дату/);
  assert.doesNotMatch(html, /мероприятие/i);
});

test('recruiter date actions render date-level controls only', async () => {
  const html = await readPublicFile('booking.html');
  const actionsBlock = html.match(/<div class="shift-admin-actions">[\s\S]*?<\/div>/)?.[0] || '';

  assert.match(actionsBlock, /data-toggle-shift="\$\{shift\.id\}"/);
  assert.match(actionsBlock, /data-edit-seats="\$\{shift\.id\}"[^>]*>Изменить количество мест/);
  assert.doesNotMatch(actionsBlock, /data-cancel-shift|data-cancel-internship|full-row/);
  assert.match(html, /\.shift-admin-actions \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});

test('date creation gives recruiter feedback and blocks duplicate dates in the UI', async () => {
  const html = await readPublicFile('booking.html');
  const createDateBlock = html.match(/if \(event\.target\.id === "createDateBtn"\) \{[\s\S]*?\n      \}/)?.[0] || '';

  assert.match(html, /id="createDateStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /function setCreateDateStatus/);
  assert.match(html, /fields\.newDate\.min = todayValue\(\)/);
  assert.match(createDateBlock, /state\.shifts\.find\(shift => shift\.date === dateValue\)/);
  assert.match(createDateBlock, /Такая дата уже есть/);
  assert.match(createDateBlock, /dateValue < todayValue\(\)/);
  assert.match(createDateBlock, /Нельзя создать дату в прошлом/);
  assert.match(createDateBlock, /Дата \$\{formatDate\(dateValue\)\} создана/);
});

test('recruiter date cards do not manage attendance directly', async () => {
  const html = await readPublicFile('booking.html');
  const renderBookedCandidate = html.match(/function renderBookedCandidate\(app\) \{[\s\S]*?\n    \}\n\n    function eligibleInviteCandidates/)?.[0] || '';
  const renderCandidates = html.match(/function renderCandidates\(\) \{[\s\S]*?\n    \}\n\n    function registryRows/)?.[0] || '';

  assert.doesNotMatch(renderBookedCandidate, />Вышел<|>Не вышел</);
  assert.match(renderCandidates, />Вышел<|>Не вышел</);
});

test('capacity edit action calls the dedicated booking command', async () => {
  const html = await readPublicFile('booking.html');

  assert.match(html, /queueBookingCommand\("update_shift_capacity",\s*\{\s*shiftId: Number\(shift\.id\), seats\s*\}\)/);
});

test('recruiter queue is searchable, grouped by priority and exposes Telegram copy', async () => {
  const html = await readPublicFile('booking.html');
  const datesSection = html.match(/<section id="datesSection">[\s\S]*?<section id="candidatesSection"/)?.[0] || '';
  const renderRecruiterDates = html.match(/function renderRecruiterDates\(\) \{[\s\S]*?\n    \}\n\n    function renderPendingCandidate/)?.[0] || '';

  assert.match(datesSection, /id="queueSearch"[^>]*type="search"/);
  assert.ok(datesSection.indexOf('id="recruiterDates"') < datesSection.indexOf('id="queuePool"'));
  assert.match(html, /const queuePriorityGroups = \[/);
  assert.match(html, /Обучение пройдено · первая стажировка/);
  assert.match(html, /function renderQueuePool\(\)/);
  assert.match(html, /data-copy-telegram="\$\{app\.id\}"/);
  assert.match(html, /data-assign-selected="\$\{app\.id\}"/);
  assert.doesNotMatch(renderRecruiterDates, /renderQueuePool|renderQueueForShift|queue-priority-group/);
  assert.doesNotMatch(datesSection, /Самый приоритетный|Нужно внимательнее|Низший приоритет|Очередь отображается/);
});

test('recruiter date cards are collapsible and sorted from earlier dates first', async () => {
  const html = await readPublicFile('booking.html');
  const renderRecruiterDates = html.match(/function renderRecruiterDates\(\) \{[\s\S]*?\n    \}\n\n    function renderPendingCandidate/)?.[0] || '';
  const clickHandler = html.match(/const shiftDetails = event\.target\.closest\("\[data-toggle-shift-details\]"\);[\s\S]*?return;\n      \}/)?.[0] || '';

  assert.match(html, /const expandedShiftIds = new Set\(\)/);
  assert.match(html, /function sortedShiftsByDate\(shifts\)/);
  assert.match(renderRecruiterDates, /data-toggle-shift-details="\$\{shiftId\}"/);
  assert.match(renderRecruiterDates, /shift-body-shell/);
  assert.match(renderRecruiterDates, /sortedShiftsByDate\(state\.shifts\.filter\(shift => shift\.open\)\)/);
  assert.match(renderRecruiterDates, /sortedShiftsByDate\(state\.shifts\.filter\(shift => !shift\.open\)\)/);
  assert.match(clickHandler, /expandedShiftIds\.has\(shiftId\)/);
  assert.match(html, /\.shift-card\.expanded \.shift-body-shell \{[\s\S]*?grid-template-rows: 1fr;/);
});

test('registry hides limitations and lets recruiters copy Telegram', async () => {
  const html = await readPublicFile('booking.html');
  const renderRegistryTable = html.match(/function renderRegistryTable\(rows\) \{[\s\S]*?\n    \}\n\n    function renderRegistry/)?.[0] || '';
  const renderRegistryTelegram = html.match(/function renderRegistryTelegram\(row\) \{[\s\S]*?\n    \}\n\n    function renderRegistryStatus/)?.[0] || '';
  const copyHandler = html.match(/const copyTelegram = event\.target\.closest\("\[data-copy-telegram\]"\);[\s\S]*?return;\n        \}/)?.[0] || '';

  assert.match(html, /function renderRegistryTelegram\(row\)/);
  assert.match(renderRegistryTable, /renderRegistryTelegram\(row\)/);
  assert.match(renderRegistryTelegram, /class="registry-telegram"/);
  assert.match(renderRegistryTelegram, /data-copy-value="\$\{escapeHtml\(row\.telegram\)\}"/);
  assert.doesNotMatch(renderRegistryTable, />Ограничения</);
  assert.doesNotMatch(renderRegistryTable, /row\.limits/);
  assert.match(copyHandler, /copyTelegram\.dataset\.copyValue \|\| traineeTelegramTag\(app\)/);
});

test('passed candidates can be marked as experienced without changing their base status', async () => {
  const html = await readPublicFile('booking.html');
  const renderCandidates = html.match(/function renderCandidates\(\) \{[\s\S]*?\n    \}\n\n    function registryRows/)?.[0] || '';

  assert.match(renderCandidates, /data-mark-experienced="\$\{app\.id\}"/);
  assert.match(renderCandidates, /experienceLabel\(app\)/);
  assert.match(html, /queueBookingCommand\("mark_experienced"/);
  assert.match(html, /<option value="experienced">Опытный стажёр<\/option>/);
});

test('workgroup templates keep a separate manager per sent group', async () => {
  const html = await readPublicFile('booking.html');
  const templatesSection = html.match(/<section class="panel">\s*<h2>Шаблоны для рабочих групп<\/h2>[\s\S]*?<div class="list" id="sentGroups"><\/div>/)?.[0] || '';
  const inputHandler = html.match(/const workgroupManagerInput = event\.target\.closest\("\[data-workgroup-manager\], \[data-workgroup-manager-custom\]"\);[\s\S]*?return;\n      \}/)?.[0] || '';
  const changeHandler = html.match(/document\.addEventListener\("change", event => \{[\s\S]*?if \(\[fields\.traineeTraining/)?.[0] || '';
  const copyHandler = html.match(/const copyWorkgroup = event\.target\.closest\("\[data-copy-workgroup\]"\);[\s\S]*?return;\n        \}/)?.[0] || '';

  assert.doesNotMatch(templatesSection, /id="workgroupManager"/);
  assert.match(html, /workgroupManagers: \{\}/);
  assert.match(html, /data-workgroup-manager="\$\{group\.templateIndex\}"/);
  assert.match(html, /data-workgroup-template="\$\{group\.templateIndex\}"/);
  assert.match(html, /<select data-workgroup-manager="\$\{group\.templateIndex\}">/);
  assert.match(html, /data-workgroup-manager-custom="\$\{group\.templateIndex\}"/);
  assert.match(html, /Белянченко Екатерина/);
  assert.match(html, /Клековкина Валерия/);
  assert.match(html, /Хотемлянский Александр/);
  assert.match(html, /Портнова Анастасия/);
  assert.match(html, /Нет подходящего менеджера/);
  assert.match(html, /WORKGROUP_CUSTOM_MANAGER_VALUE/);
  assert.match(inputHandler, /updateWorkgroupManagerControl\(workgroupManagerInput\)/);
  assert.match(changeHandler, /updateWorkgroupManagerControl\(workgroupManagerInput\)/);
  assert.match(copyHandler, /visibleWorkgroupTemplateGroups\(\)\[Number\(copyWorkgroup\.dataset\.copyWorkgroup\)\]/);
  assert.doesNotMatch(inputHandler, /renderSentGroupTemplates\(\)/);
});

test('workgroup templates are grouped by venue and hide expired internship dates', async () => {
  const html = await readPublicFile('booking.html');
  const renderSentGroups = html.match(/function renderSentGroupTemplates\(\) \{[\s\S]*?\n    \}\n\n    function updateWorkgroupManagerControl/)?.[0] || '';

  assert.match(html, /function visibleWorkgroupTemplateGroups\(\) \{/);
  assert.match(html, /function isWorkgroupTemplateVisible\(group\) \{/);
  assert.match(html, /latestDate >= todayValue\(\)/);
  assert.match(renderSentGroups, /<details class="sent-venue-group"/);
  assert.match(renderSentGroups, /<summary>/);
  assert.match(renderSentGroups, /sent-venue-body/);
  assert.match(renderSentGroups, /Прошедшие скрываются на следующий день после даты стажировки/);
});

test('trainee available dates stay clean after an active application is locked', async () => {
  const html = await readPublicFile('booking.html');
  const renderTrainee = html.match(/function renderTrainee\(\) \{[\s\S]*?\n    \}\n\n    function renderTelegramConnect/)?.[0] || '';

  assert.match(renderTrainee, /currentCanChangeDate = current && \["pending", "queue"\]\.includes\(current\.status\)/);
  assert.match(renderTrainee, /openShifts\(\)\.filter/);
  assert.match(renderTrainee, /String\(shift\.id\) !== String\(current\.shiftId\)/);
  assert.match(renderTrainee, /if \(currentCanChangeDate && currentShift/);
});

test('trainee status hydrates from server-owned applications without a local profile name', async () => {
  const html = await readPublicFile('booking.html');
  const applyServerStatePayload = html.match(/function applyServerStatePayload\(payload\) \{[\s\S]*?\n    \}/)?.[0] || '';
  const resumeRefresh = html.match(/function refreshBookingStateOnResume\(\) \{[\s\S]*?\n    \}/)?.[0] || '';
  const personalApplicationCandidate = html.match(/function personalApplicationCandidate\(\) \{[\s\S]*?\n    \}/)?.[0] || '';
  const hydrateProfile = html.match(/function hydrateTraineeProfileFromServerState\(\) \{[\s\S]*?\n    \}/)?.[0] || '';
  const currentApplication = html.match(/function currentApplication\(\) \{[\s\S]*?\n    \}/)?.[0] || '';

  assert.match(applyServerStatePayload, /hydrateTraineeProfileFromServerState\(\)/);
  assert.match(html, /let lastStateRefreshAt = 0/);
  assert.match(html, /refreshBookingStateOnResume\(\);/);
  assert.match(resumeRefresh, /now - lastStateRefreshAt < 3500/);
  assert.match(html, /document\.addEventListener\("visibilitychange"/);
  assert.match(html, /window\.addEventListener\("focus", refreshBookingStateOnResume\)/);
  assert.match(personalApplicationCandidate, /serverRole !== "trainee"/);
  assert.match(personalApplicationCandidate, /\["confirmed", "invited", "feedback"\]/);
  assert.match(hydrateProfile, /state\.profile\.activeAppId = app\.id/);
  assert.match(hydrateProfile, /if \(!state\.profile\.name\) state\.profile\.name = app\.name/);
  assert.match(currentApplication, /const personal = personalApplicationCandidate\(\)/);
  assert.ok(currentApplication.indexOf('const personal = personalApplicationCandidate()') < currentApplication.indexOf('if (!state.profile.name) return null'));
});

test('workgroup links use Telegram link handling and reject non-Telegram URLs in the UI', async () => {
  const html = await readPublicFile('booking.html');
  const openExternalLink = html.match(/function openExternalLink\(url, event\) \{[\s\S]*?\n    \}/)?.[0] || '';
  const linkValidator = html.match(/function isValidInviteLink\(value\) \{[\s\S]*?\n    \}/)?.[0] || '';

  assert.ok(openExternalLink.indexOf('openTelegramLink') > -1);
  assert.ok(openExternalLink.indexOf('openLink') > -1);
  assert.ok(openExternalLink.indexOf('openTelegramLink') < openExternalLink.indexOf('openLink'));
  assert.match(linkValidator, /isTelegramLink\(url\)/);
  assert.match(html, /Нужна Telegram-ссылка/);
});

test('invite group date selector keeps the recruiter-selected date even when it has no candidates', async () => {
  const html = await readPublicFile('booking.html');
  const syncInviteDraft = html.match(/function syncInviteDraftWithEligibleCandidates\(draft\) \{[\s\S]*?\n    \}/)?.[0] || '';

  assert.match(syncInviteDraft, /if \(hasSelectedShift\) return;/);
  assert.doesNotMatch(syncInviteDraft, /selectedHasCandidates/);
});

test('report submission success does not auto-close the mini app', async () => {
  const html = await readPublicFile('index.html');
  const sendSuccessBlock = html.match(/showStatus\(`Отчёт успешно отправлен[\s\S]*?\n        \} catch \(error\)/)?.[0] || '';

  assert.match(sendSuccessBlock, /Отчёт отправлен/);
  assert.doesNotMatch(sendSuccessBlock, /tg\?\.close|disableClosingConfirmation|closeMiniApp/);
});

test('trainee report date is loaded from the trainee booking state', async () => {
  const html = await readPublicFile('index.html');
  const loadBookingProfile = html.match(/async function loadTraineeBookingProfile\(\) \{[\s\S]*?\n      \}/)?.[0] || '';
  const renderProfileFields = html.match(/function renderProfileFields\(\) \{[\s\S]*?\n      \}/)?.[0] || '';

  assert.match(html, /traineeBookingDateLocked/);
  assert.match(html, /if \(role === 'trainee'\) loadTraineeBookingProfile\(\)/);
  assert.match(loadBookingProfile, /fetch\('\/api\/state'/);
  assert.match(loadBookingProfile, /'x-telegram-init-data': initData/);
  assert.match(loadBookingProfile, /payload\.role !== 'trainee'/);
  assert.match(loadBookingProfile, /state\.profile\.date = shift\.date/);
  assert.match(loadBookingProfile, /state\.traineeBookingDateLocked = true/);
  assert.match(renderProfileFields, /readonly aria-readonly="true"/);
  assert.match(renderProfileFields, /Дата автоматически подтянулась из вашей записи/);
});
