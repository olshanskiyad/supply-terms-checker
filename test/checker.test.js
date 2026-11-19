// Запуск: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../checker.js');

const DIR = path.join(__dirname, '..', 'documents');
const SAMPLE = fs.readdirSync(DIR).filter((n) => n.endsWith('.txt'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(DIR, name), 'utf8') }));
const CHECK = '2026-03-10';

const run = (docs = SAMPLE, date = CHECK) => C.analyze(docs, date);
const row = (res, no) => res.rows.find((r) => r.number === no);
const replaceIn = (name, from, to) => SAMPLE.map((d) => (d.name === name ? { ...d, text: d.text.replace(from, to) } : d));

test('STN-101: сумма и срок изменены подписанным допсоглашением', () => {
  const r = row(run(), 'STN-101');
  assert.equal(r.amount.value, '1380000');
  assert.equal(r.amount.changedBy, '02_amendment_signed.txt');
  assert.equal(r.amount.previous.value, '1200000');
  assert.equal(r.deadline.value, '2026-04-30');
  assert.equal(r.deadline.changedBy, '02_amendment_signed.txt');
});

test('STN-101: проект допсоглашения не меняет условия, но показан как предложение', () => {
  const r = row(run(), 'STN-101');
  const p = r.proposals.filter((x) => x.kind === 'draft').map((x) => [x.field, x.value]);
  assert.deepEqual(p, [['amount', '1450000'], ['deadline', '2026-05-10']]);
});

test('STN-102: сумма 840 000, аванс не путается с суммой, срок оплаты не путается со сроком поставки', () => {
  const r = row(run(), 'STN-102');
  assert.equal(r.amount.value, '840000');
  assert.equal(r.deadline.value, '2026-03-20');
  assert.equal(r.amount.changedBy, undefined);
});

test('STN-102: перенос из письма поставщика только предложение', () => {
  const r = row(run(), 'STN-102');
  assert.equal(r.deadline.value, '2026-03-20');
  assert.deepEqual(r.proposals.map((x) => [x.kind, x.field, x.value]), [['letter', 'deadline', '2026-03-27']]);
});

test('STN-103: суммы нет, лимит бюджета 600 000 не выдаётся за сумму', () => {
  const r = row(run(), 'STN-103');
  assert.equal(r.amount.status, 'no_data');
  assert.equal(r.amount.value, null);
  assert.match(r.amount.source.quote, /определяется спецификацией/);
  assert.equal(r.deadline.value, '2026-04-30');
});

test('вопрос 4: раньше 1 апреля только STN-102, у него есть несогласованный перенос', () => {
  const hits = C.contractsBefore(run(), '2026-04-01');
  assert.deepEqual(hits.map((h) => h.row.number), ['STN-102']);
  assert.equal(hits[0].before, true);
  assert.deepEqual(hits[0].pending.map((p) => p.value), ['2026-03-27']);
});

test('каждая цитата дословно есть в исходном абзаце', () => {
  const res = run();
  const byId = {};
  res.docs.forEach((d) => d.paragraphs.forEach((p) => { byId[p.id] = p.text; }));
  const sources = [];
  for (const r of res.rows) {
    for (const k of Object.keys(C.FIELDS)) if (r[k].source) sources.push(r[k].source);
    r.proposals.forEach((p) => sources.push(p.source));
  }
  assert.ok(sources.length >= 9);
  for (const s of sources) assert.ok(byId[s.paragraphId].includes(s.quote), `${s.file}: ${s.quote}`);
});

test('цитата из допсоглашения не обрывается внутри «новой редакции» пункта', () => {
  const q = row(run(), 'STN-101').amount.source.quote;
  assert.match(q, /итоговая стоимость договора»\.$/);
  assert.equal((q.match(/«/g) || []).length, (q.match(/»/g) || []).length);
});

test('изменённое поле в договоре подхватывается из текста', () => {
  const docs = replaceIn('03_contract.txt', '840 000 (восемьсот сорок тысяч)', '910 000 (девятьсот десять тысяч)');
  assert.equal(row(run(docs), 'STN-102').amount.value, '910000');
});

test('новый договор того же формата попадает в таблицу', () => {
  const text = fs.readFileSync(path.join(DIR, '03_contract.txt'), 'utf8')
    .replace('STN-102', 'STN-104').replace('«Контур Электро»', '«Новый Поставщик»')
    .replace('840 000', '2 500 000').replace('не позднее 20.03.2026', 'не позднее 25.03.2026');
  const r = row(run([...SAMPLE, { name: 'new.txt', text }]), 'STN-104');
  assert.equal(r.supplier, 'ООО «Новый Поставщик»');
  assert.equal(r.amount.value, '2500000');
  assert.equal(r.deadline.value, '2026-03-25');
});

test('дата проверки раньше подписания допсоглашения: действуют условия договора', () => {
  const r = row(run(SAMPLE, '2026-02-25'), 'STN-101');
  assert.equal(r.amount.value, '1200000');
  assert.equal(r.deadline.value, '2026-04-15');
  assert.ok(r.proposals.some((p) => p.reason.startsWith('подписано 01.03.2026')));
});

test('допсоглашение вступает в силу позже даты проверки: не применяется', () => {
  const docs = replaceIn('02_amendment_signed.txt', 'вступает в силу 01.03.2026', 'вступает в силу 01.04.2026');
  const r = row(run(docs), 'STN-101');
  assert.equal(r.deadline.value, '2026-04-15');
  assert.ok(r.proposals.some((p) => p.reason === 'вступает в силу 01.04.2026'));
});

test('подписанное допсоглашение без даты вступления в силу: требует проверки', () => {
  const docs = replaceIn('02_amendment_signed.txt', /4\. Настоящее соглашение.*\n?/, '');
  const r = row(run(docs), 'STN-101');
  assert.equal(r.deadline.status, 'review');
  assert.equal(r.amount.status, 'review');
});

test('документ без номера договора не привязывается молча', () => {
  const res = run([...SAMPLE, { name: 'x.txt', text: 'ПИСЬМО\nТема: поставка\nПредлагаем перенести срок поставки на 01.06.2026.' }]);
  assert.ok(res.warnings.some((w) => w.file === 'x.txt'));
});

test('CRLF и BOM в файле не мешают разбору', () => {
  const docs = SAMPLE.map((d) => (d.name === '03_contract.txt' ? { ...d, text: '﻿' + d.text.replace(/\n/g, '\r\n') } : d));
  assert.equal(row(run(docs), 'STN-102').amount.value, '840000');
});
