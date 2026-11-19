/*
 * Сверка условий договоров поставки: разбор TXT правилами, без LLM.
 * Каждое значение берётся из конкретного предложения документа, поэтому у него всегда есть цитата.
 * Работает в браузере (window.Checker) и в Node (require('./checker.js')) для тестов.
 */
(function (root) {
  'use strict';

  const CONTRACT_NO = /(?<![\p{L}\d])[A-ZА-ЯЁ]{2,6}-\d{2,6}(?!\d)/gu;
  // Слова изменения: при них в предложении старое и новое значение, берём последнее («с 20.03 на 27.03»).
  const CHANGE = /заменить|изменить|перенести|перенос|изложить|в следующей редакции/i;

  // Поля, которые достаём из текста. Новое поле (например, ставка неустойки) добавляется сюда же.
  //   anchors  предложение относится к полю, если совпал хотя бы один шаблон;
  //   value    глобальный шаблон значения, ищется в предложении от места совпадения anchor;
  //   parse    приводит найденное к одному виду; format  как показать пользователю;
  //   exclude  (необязательно) такие предложения не берём;
  //   mentions (необязательно) где искать пояснение, если значения нет.
  const FIELDS = {
    amount: {
      label: 'Сумма, ₽',
      anchors: [/стоимост.*?(?:составляет|\sна\s)/i],
      value: /(?<![\d,.'’])(\d[\d \u00a0\u202f\u2009]*\d(?:,\d{1,2})?)\s*(?:\([^)]*\)\s*)?(?:руб\S*|₽)(?:\s*(\d{1,2})\s*коп)?/gi,
      parse: (m) => {
        const rub = m[1].replace(/[ \u00a0\u202f\u2009]/g, '').replace(',', '.');
        return m[2] ? String(Number(rub) + Number(m[2]) / 100) : String(Number(rub));
      },
      exclude: /не является/i,
      mentions: /стоимост/i,
      format: (v) => Number(v).toLocaleString('ru-RU', Number(v) % 1 ? { minimumFractionDigits: 2 } : {}),
    },
    deadline: {
      label: 'Срок поставки',
      anchors: [/постав.*?(?:не позднее|\sдо)\s+«?\d/i, /срок\S*\s+поставки.*?\sна\s+«?\d/i, /срок\S*\s+поставки\s*:\s*\d/i],
      value: /(?<!\d)(\d{2})\.(\d{2})\.(\d{4})(?!\d)/g,
      parse: (m) => `${m[3]}-${m[2]}-${m[1]}`,
      exclude: /оплат/i,
      mentions: /постав\S*\s.*не позднее|срок\S*\s+поставки/i,
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
    let signed = null; // true: обеими сторонами; false: нет или одной стороной; null: неясно
    let oneSide = false;
    let signedDate = null;
    if (status && /не подписан/i.test(status)) signed = false;
    else if (status && /подписан\S*\s+(?:обеими\s+)?сторонами/i.test(status)) {
      signed = true;
      const m = status.match(/сторонами\s+(\d{2}\.\d{2}\.\d{4})/i);
      if (m) signedDate = toIso(m[1]);
    } else if (status && /подписан\S*\s+(?:только\s+)?(?:поставщик|покупател)/i.test(status)) {
      signed = false;
      oneSide = true;
    }

    let effectiveDate = null;
    const eff = text.match(/вступает в силу\s+(?:с\s+)?(\d{2}\.\d{2}\.\d{4})/i);
    if (eff) effectiveDate = toIso(eff[1]);
    else if (/вступает в силу (?:с )?(?:даты|момента)\s+(?:его\s+)?подписания/i.test(text)) effectiveDate = signedDate;

    const kind = detectKind(title, text);
    const titleRefs = title.match(CONTRACT_NO) || [];
    const refs = titleRefs.length ? titleRefs : [...new Set(text.match(CONTRACT_NO) || [])];

    const supplierLine = text.match(/Поставщик:\s*([^\n]+)/);
    let supplier = null;
    if (supplierLine) {
      const quoted = supplierLine[1].match(/^[^«]*«[^»]+»/);
      supplier = (quoted ? quoted[0] : supplierLine[1].trim().replace(/(?<![А-ЯЁA-Z])\.$/, '')).trim();
    }
    return {
      name, text, paragraphs, title, kind, status, signed, oneSide, signedDate, effectiveDate,
      number: kind === 'contract' ? titleRefs[0] || null : null,
      refs: kind === 'contract' ? [] : refs,
      supplier,
    };
  }

  // Тип по заголовку. «Договор» только если заголовок с него начинается: «Спецификация к договору» не договор.
  function detectKind(title, text) {
    const t = title.toUpperCase();
    if (/ПРОЕКТ/.test(t)) return 'draft';
    if (/ПИСЬМО/.test(t) || /^(От|Тема):/m.test(text)) return 'letter';
    if (/СОГЛАШЕНИ/.test(t)) return 'amendment';
    if (/^ДОГОВОР/.test(t)) return 'contract';
    return 'unknown';
  }

  function slug(name) {
    return name.replace(/[^\wА-Яа-яЁё-]+/g, '_');
  }

  // Значение поля в одном предложении: null, одно значение или «несколько разных» (тогда проверка человеком).
  function valueInSentence(f, s) {
    if (f.exclude && f.exclude.test(s)) return null;
    let from = -1;
    for (const re of f.anchors) {
      const m = s.match(re);
      if (m && (from < 0 || m.index < from)) from = m.index;
    }
    if (from < 0) return null;
    const vals = [...s.slice(from).matchAll(f.value)].map(f.parse);
    if (!vals.length) return null;
    if (new Set(vals).size === 1) return { value: vals[0] };
    if (CHANGE.test(s)) return { value: vals[vals.length - 1] };
    return { multiple: vals };
  }

  // Все значения поля в документе с цитатами. Несколько разных значений = нужна проверка человеком.
  function extractField(doc, key) {
    const f = FIELDS[key];
    const hits = [];
    let ambiguous = null;
    for (const p of doc.paragraphs) {
      for (const s of p.sentences) {
        const v = valueInSentence(f, s);
        if (!v) continue;
        if (v.multiple) ambiguous = ambiguous || source(doc, p, s);
        else hits.push({ value: v.value, source: source(doc, p, s) });
      }
    }
    const values = [...new Set(hits.map((h) => h.value))];
    if (ambiguous) {
      return { status: 'review', value: null, sources: [ambiguous, ...hits.map((h) => h.source)], note: 'в одном предложении несколько разных значений' };
    }
    if (values.length === 1) return { status: 'ok', value: values[0], source: hits[0].source };
    if (values.length > 1) {
      return { status: 'review', value: null, sources: hits.map((h) => h.source), note: 'в документе несколько разных значений' };
    }
    // Значения нет: показываем, где документ говорит об этом поле, чтобы «нет данных» тоже было проверяемым.
    const mention = f.mentions ? doc.paragraphs.find((p) => f.mentions.test(p.text)) : null;
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
    if (doc.oneSide) return 'подписано одной стороной';
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

    // Один номер в нескольких файлах: порядок загрузки не должен решать, какой верный.
    const byNumber = new Map();
    for (const c of contracts) {
      if (!c.number) { warnings.push({ file: c.name, text: 'в договоре не найден номер' }); continue; }
      if (!byNumber.has(c.number)) byNumber.set(c.number, []);
      byNumber.get(c.number).push(c);
    }
    for (const [no, list] of byNumber) {
      if (list.length > 1) warnings.push({ file: list.map((c) => c.name).join(', '), text: `номер ${no} в нескольких файлах, значения не выбираем` });
    }
    for (const d of docs) {
      if (d.kind === 'contract') continue;
      const linked = d.refs.filter((r) => byNumber.has(r));
      if (linked.length === 0) warnings.push({ file: d.name, text: 'не удалось привязать к загруженному договору' });
      else if (linked.length > 1) warnings.push({ file: d.name, text: `упоминает несколько договоров (${linked.join(', ')}), привязка неоднозначна` });
    }

    const rows = [...byNumber.entries()].map(([number, list]) => {
      const c = list[0];
      const related = docs.filter((d) => d.kind !== 'contract' && d.refs.length === 1 && d.refs[0] === number);
      const row = { number, file: list.map((x) => x.name).join(', '), supplier: c.supplier, notes: [], proposals: [], related: related.map((d) => d.name) };

      if (list.length > 1) {
        row.notes.push('договор с этим номером загружен в нескольких файлах');
        for (const key of Object.keys(FIELDS)) {
          const sources = list.map((x) => extractField(x, key)).flatMap((v) => v.sources || (v.source ? [v.source] : []));
          row[key] = { status: 'review', value: null, sources, note: 'несколько файлов с одним номером договора' };
        }
        return row;
      }
      if (c.signed !== true) row.notes.push('договор не подписан или статус не указан');

      const inForce = related.filter((d) => notInForceReason(d, checkDateIso) === null)
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

      for (const key of Object.keys(FIELDS)) {
        let current = extractField(c, key);
        for (const a of inForce) {
          const v = extractField(a, key);
          if (v.status === 'no_data') continue;
          if (current.changedBy && current.effectiveDate === a.effectiveDate && v.value !== current.value) {
            current = { status: 'review', value: null, note: 'два допсоглашения с одной датой вступления в силу дают разные значения' };
            continue;
          }
          current = { ...v, changedBy: a.name, effectiveDate: a.effectiveDate, previous: current };
        }
        for (const d of related) {
          const reason = notInForceReason(d, checkDateIso);
          if (reason === null) continue;
          const v = extractField(d, key);
          if (v.status === 'no_data') continue;
          if (v.status === 'ok') row.proposals.push({ field: key, value: v.value, source: v.source, kind: d.kind, reason });
          else row.notes.push(`${d.name}: ${v.note}, проверьте`);
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
