/*
 * Сверка условий договоров поставки: разбор TXT правилами, без LLM.
 * Каждое значение берётся из конкретного предложения документа, поэтому у него всегда есть цитата.
 * Работает в браузере (window.Checker) и в Node (require('./checker.js')) для тестов.
 */
(function (root) {
  'use strict';

  const DATE = String.raw`(\d{2}\.\d{2}\.\d{4})`;
  const NUMBER = String.raw`(\d[\d  ]*\d)`;
  const CONTRACT_NO = /\b[A-ZА-ЯЁ]{2,6}-\d{2,6}\b/g;

  // Поля, которые достаём из текста. Новое поле (например, ставка неустойки) добавляется сюда же.
  // patterns: первая группа каждого шаблона и есть значение. exclude: предложения, которые не берём.
  const FIELDS = {
    amount: {
      label: 'Сумма, ₽',
      patterns: [
        new RegExp(String.raw`стоимост.*?составляет\s+${NUMBER}\s*(?:\([^)]*\)\s*)?руб`, 'i'),
        new RegExp(String.raw`стоимост.*?\sна\s+${NUMBER}\s*(?:\([^)]*\)\s*)?руб`, 'i'),
      ],
      exclude: /не является/i,
      mentions: /стоимост/i,
      normalize: (s) => s.replace(/[  ]/g, ''),
      format: (v) => Number(v).toLocaleString('ru-RU'),
    },
    deadline: {
      label: 'Срок поставки',
      patterns: [
        new RegExp(String.raw`постав.*?(?:не позднее|\sдо)\s+${DATE}`, 'i'),
        new RegExp(String.raw`срок\S*\s+поставки.*?\sна\s+${DATE}`, 'i'),
      ],
      exclude: /оплат/i,
      mentions: /постав\S*\s.*не позднее|срок\S*\s+поставки/i,
      normalize: toIso,
      format: fromIso,
    },
  };

  const KIND_LABEL = {
    contract: 'договор',
    amendment: 'допсоглашение',
    draft: 'проект изменения',
    letter: 'письмо',
    unknown: 'не распознан',
  };

  function toIso(d) {
    const [dd, mm, yyyy] = d.split('.');
    return `${yyyy}-${mm}-${dd}`;
  }

  function fromIso(iso) {
    const [yyyy, mm, dd] = iso.split('-');
    return `${dd}.${mm}.${yyyy}`;
  }

  // Граница предложения: точка, пробел, заглавная буква. Внутри «...» не режем: там бывает новая редакция пункта целиком.
  function splitSentences(text) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '«') depth++;
      else if (ch === '»') depth = Math.max(0, depth - 1);
      else if (depth === 0 && '.!?'.includes(ch)) {
        const next = text.slice(i + 1).match(/^\s+(?=[А-ЯЁA-Z«])/);
        if (next) {
          out.push(text.slice(start, i + 1).trim());
          start = i + 1 + next[0].length;
        }
      }
    }
    out.push(text.slice(start).trim());
    return out.filter(Boolean);
  }

  // Абзац = непустая строка: в документах каждый пункт договора стоит отдельной строкой.
  function parseDocument(name, rawText) {
    const text = rawText.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const paragraphs = [];
    text.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      const clause = (t.match(/^(\d+(?:\.\d+)*)\.?\s/) || [])[1] || null;
      paragraphs.push({ id: `${slug(name)}-${i + 1}`, line: i + 1, text: t, clause, sentences: splitSentences(t) });
    });

    const title = paragraphs.length ? paragraphs[0].text : '';
    const statusP = paragraphs.find((p) => /^Статус:/i.test(p.text));
    const status = statusP ? statusP.text : null;
    let signed = null;
    let signedDate = null;
    if (status && /не подписан/i.test(status)) signed = false;
    else if (status && /подписан\S*\s+обеими\s+сторонами/i.test(status)) {
      signed = true;
      const m = status.match(new RegExp(String.raw`обеими\s+сторонами\s+${DATE}`, 'i'));
      if (m) signedDate = toIso(m[1]);
    }

    let effectiveDate = null;
    const eff = text.match(new RegExp(String.raw`вступает в силу\s+(?:с\s+)?${DATE}`, 'i'));
    if (eff) effectiveDate = toIso(eff[1]);
    else if (/вступает в силу (?:с )?(?:даты|момента) подписания/i.test(text)) effectiveDate = signedDate;

    const kind = detectKind(title, text);
    const titleRefs = title.match(CONTRACT_NO) || [];
    const refs = titleRefs.length ? titleRefs : [...new Set(text.match(CONTRACT_NO) || [])];

    const supplierM = text.match(/Поставщик:\s*([^\n]*?«[^»]+»)/);
    return {
      name, text, paragraphs, title, kind, status, signed, signedDate, effectiveDate,
      number: kind === 'contract' ? titleRefs[0] || null : null,
      refs: kind === 'contract' ? [] : refs,
      supplier: supplierM ? supplierM[1].trim() : null,
    };
  }

  function detectKind(title, text) {
    const t = title.toUpperCase();
    if (/ПРОЕКТ/.test(t)) return 'draft';
    if (/ПИСЬМО/.test(t) || /^(От|Тема):/m.test(text)) return 'letter';
    if (/ДОПОЛНИТЕЛЬНОЕ СОГЛАШЕНИЕ/.test(t)) return 'amendment';
    if (/ДОГОВОР/.test(t)) return 'contract';
    return 'unknown';
  }

  function slug(name) {
    return name.replace(/[^\wА-Яа-яЁё-]+/g, '_');
  }

  // Все значения поля в документе с цитатами. Несколько разных значений = нужна проверка человеком.
  function extractField(doc, key) {
    const f = FIELDS[key];
    const hits = [];
    for (const p of doc.paragraphs) {
      for (const s of p.sentences) {
        if (f.exclude && f.exclude.test(s)) continue;
        for (const re of f.patterns) {
          const m = s.match(re);
          if (m) {
            hits.push({ value: f.normalize(m[1]), source: source(doc, p, s) });
            break;
          }
        }
      }
    }
    const values = [...new Set(hits.map((h) => h.value))];
    if (values.length === 1) return { status: 'ok', value: values[0], source: hits[0].source };
    if (values.length > 1) {
      return { status: 'review', value: null, sources: hits.map((h) => h.source), note: 'в документе несколько разных значений' };
    }
    // Значения нет: показываем, где документ говорит об этом поле, чтобы «нет данных» тоже было проверяемым.
    const mention = doc.paragraphs.find((p) => f.mentions.test(p.text));
    return { status: 'no_data', value: null, source: mention ? source(doc, mention, mention.text) : null };
  }

  function source(doc, p, quote) {
    return { file: doc.name, paragraphId: p.id, line: p.line, clause: p.clause, quote };
  }

  // Почему документ не меняет условия на дату проверки. null = документ действует.
  function notInForceReason(doc, checkDate) {
    if (doc.kind === 'draft') return 'проект, не подписан';
    if (doc.kind === 'letter') return 'письмо, изменение не согласовано';
    if (doc.kind !== 'amendment') return 'тип документа не распознан';
    if (doc.signed === false) return 'не подписано';
    if (doc.signed === null) return 'статус подписания не указан';
    if (doc.signedDate && doc.signedDate > checkDate) return `подписано ${fromIso(doc.signedDate)}, позже даты проверки`;
    if (!doc.effectiveDate) return 'не указана дата вступления в силу';
    if (doc.effectiveDate > checkDate) return `вступает в силу ${fromIso(doc.effectiveDate)}`;
    return null;
  }

  // Причины, при которых человек должен посмотреть сам, а не верить таблице.
  const REVIEW_REASONS = ['статус подписания не указан', 'не указана дата вступления в силу', 'тип документа не распознан'];

  function analyze(rawDocs, checkDateIso) {
    const docs = rawDocs.map((d) => parseDocument(d.name, d.text));
    const contracts = docs.filter((d) => d.kind === 'contract');
    const warnings = [];

    const seen = {};
    for (const c of contracts) {
      if (!c.number) warnings.push({ file: c.name, text: 'в договоре не найден номер' });
      else if (seen[c.number]) warnings.push({ file: c.name, text: `номер ${c.number} уже есть в файле ${seen[c.number]}, проверьте дубликат` });
      else seen[c.number] = c.name;
    }
    for (const d of docs) {
      if (d.kind === 'contract') continue;
      const linked = d.refs.filter((r) => seen[r]);
      if (linked.length === 0) warnings.push({ file: d.name, text: 'не удалось привязать к загруженному договору' });
      else if (linked.length > 1) warnings.push({ file: d.name, text: `упоминает несколько договоров (${linked.join(', ')}), привязка неоднозначна` });
    }

    const rows = contracts.filter((c) => c.number && seen[c.number] === c.name).map((c) => {
      const related = docs.filter((d) => d.kind !== 'contract' && d.refs.length === 1 && d.refs[0] === c.number);
      const row = { number: c.number, file: c.name, supplier: c.supplier, notes: [], proposals: [], related: related.map((d) => d.name) };
      if (c.signed !== true) row.notes.push('договор не подписан или статус не указан');

      const inForce = related.filter((d) => notInForceReason(d, checkDateIso) === null)
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

      for (const key of Object.keys(FIELDS)) {
        let current = extractField(c, key);
        for (const a of inForce) {
          const v = extractField(a, key);
          if (v.status === 'no_data') continue;
          if (current.changedBy && current.effectiveDate === a.effectiveDate && v.value !== current.value) {
            current = { status: 'review', value: null, note: `два допсоглашения с одной датой вступления в силу дают разные значения` };
            continue;
          }
          current = { ...v, changedBy: a.name, effectiveDate: a.effectiveDate, previous: current };
        }
        for (const d of related) {
          const reason = notInForceReason(d, checkDateIso);
          if (reason === null) continue;
          const v = extractField(d, key);
          if (v.status !== 'ok') continue;
          row.proposals.push({ field: key, value: v.value, source: v.source, kind: d.kind, reason });
          if (REVIEW_REASONS.includes(reason)) {
            current = { ...current, status: 'review', note: `${d.name}: ${reason}` };
          }
        }
        row[key] = current;
      }
      return row;
    });

    return { checkDate: checkDateIso, docs, rows, warnings };
  }

  // Ответы на вопросы закупщика строятся только из таблицы, своих данных у них нет.
  function contractsBefore(result, dateIso) {
    const out = [];
    for (const r of result.rows) {
      const d = r.deadline;
      const pending = r.proposals.filter((p) => p.field === 'deadline');
      const before = d.status === 'ok' && d.value < dateIso;
      const proposedBefore = pending.some((p) => p.value < dateIso);
      if (before || proposedBefore || d.status !== 'ok') {
        out.push({ row: r, before, unknown: d.status !== 'ok', pending });
      }
    }
    return out;
  }

  const api = { FIELDS, KIND_LABEL, parseDocument, extractField, analyze, contractsBefore, toIso, fromIso, notInForceReason };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Checker = api;
})(typeof window !== 'undefined' ? window : this);
