// Интерфейс: загрузка файлов, таблица, вопросы, исходные документы. Вся логика разбора в checker.js.
(function () {
  'use strict';
  const C = window.Checker;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (key, v) => C.FIELDS[key].format(v);
  const label = (key) => C.FIELDS[key].label;

  // Учебный комплект лежит рядом со страницей, кнопка просто подгружает эти файлы вместо ручной загрузки.
  const SAMPLE = ['01_contract.txt', '02_amendment_signed.txt', '03_contract.txt', '04_contract.txt', '05_supplier_email.txt', '06_amendment_draft.txt'];
  const PRESETS = [
    { text: 'Какой срок поставки действует по STN-101?', run: () => askField('deadline', 'STN-101') },
    { text: 'Какова сумма договора STN-102?', run: () => askField('amount', 'STN-102') },
    { text: 'Какова сумма договора STN-103?', run: () => askField('amount', 'STN-103') },
    { text: 'Какие поставки раньше 01.04.2026 и есть ли несогласованные переносы?', run: () => { $('qBefore').value = '2026-04-01'; askBefore('2026-04-01'); } },
  ];

  const state = { files: new Map(), result: null, lastQuestion: null };

  async function readFile(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('windows-1251').decode(buf); }
  }

  function srcLink(s) {
    if (!s) return '';
    const where = s.clause ? `п. ${s.clause}` : `строка ${s.line}`;
    return `<a class="src" href="#${esc(s.paragraphId)}">${esc(s.file)}, ${where}</a><span class="quote">«${esc(s.quote)}»</span>`;
  }

  function cell(key, v) {
    if (v.status === 'ok') {
      const changed = v.changedBy
        ? `<div class="changed">изменено: ${esc(v.changedBy)}${v.previous && v.previous.value ? `, было ${esc(fmt(key, v.previous.value))}` : ''}</div>`
        : '';
      return `<span class="val">${esc(fmt(key, v.value))}</span>${changed}${srcLink(v.source)}`;
    }
    if (v.status === 'no_data') {
      return `<span class="nodata">нет данных</span>` + (v.source ? `<div class="small muted">что сказано в документе:</div>${srcLink(v.source)}` : '<div class="small muted">в тексте договора не найдено</div>');
    }
    const shown = v.value ? `<div class="small">по тексту: ${esc(fmt(key, v.value))}</div>${srcLink(v.source)}` : '';
    const many = (v.sources || []).map(srcLink).join('');
    return `<span class="review">требует проверки</span><div class="small">${esc(v.note || '')}</div>${shown}${many}`;
  }

  function proposalsHtml(list) {
    if (!list.length) return '<span class="muted small">нет</span>';
    return list.map((p) => `<div class="prop">${esc(label(p.field))}: <b>${esc(fmt(p.field, p.value))}</b> (${esc(p.reason)})<br>${srcLink(p.source)}</div>`).join('');
  }

  function render() {
    const docs = [...state.files.values()];
    $('loaded').textContent = docs.length ? `Загружено файлов: ${docs.length}` : '';
    const date = $('checkDate').value || '2026-03-10';
    $('table-title').textContent = `Условия по договорам на ${C.fromIso(date)}`;
    if (!docs.length) {
      state.result = null;
      $('table').innerHTML = '<div class="panel empty">Файлы не загружены. Загрузите TXT или нажмите «Учебный комплект».</div>';
      $('docs').innerHTML = $('warnings').innerHTML = $('answer').innerHTML = '';
      $('qContract').innerHTML = '';
      return;
    }
    const res = state.result = C.analyze(docs, date);

    $('warnings').innerHTML = res.warnings.length
      ? `<div class="warn"><b>Требует проверки:</b><ul>${res.warnings.map((w) => `<li>${esc(w.file)}: ${esc(w.text)}</li>`).join('')}</ul></div>`
      : '';

    const keys = Object.keys(C.FIELDS);
    const head = `<tr><th>Договор</th><th>Поставщик</th>${keys.map((k) => `<th>${esc(label(k))}</th>`).join('')}<th>Не согласовано, только для сведения</th></tr>`;
    const body = res.rows.map((r) => `<tr>
      <td><b>${esc(r.number)}</b><div class="small muted">${esc(r.file)}</div>${r.notes.map((n) => `<div class="review small">${esc(n)}</div>`).join('')}</td>
      <td>${r.supplier ? esc(r.supplier) : '<span class="nodata">нет данных</span>'}</td>
      ${keys.map((k) => `<td>${cell(k, r[k])}</td>`).join('')}
      <td>${proposalsHtml(r.proposals)}</td></tr>`).join('');
    $('table').innerHTML = res.rows.length
      ? `<table>${head}${body}</table>`
      : '<div class="panel empty">Среди загруженных файлов нет договоров.</div>';

    $('docs').innerHTML = res.docs.map((d) => {
      const reason = d.kind === 'contract' ? null : C.notInForceReason(d, date);
      const badge = d.kind === 'contract' ? ''
        : reason === null ? '<span class="badge in">действует</span>' : `<span class="badge out">${esc(reason)}</span>`;
      const link = d.kind === 'contract' ? d.number : (d.refs.join(', ') || 'договор не найден');
      return `<div class="panel doc"><h3>${esc(d.name)}</h3>
        <div class="meta">${esc(C.KIND_LABEL[d.kind])}${d.kind === 'contract' ? '' : ' к ' + esc(link)} ${badge}</div>
        ${d.paragraphs.map((p) => `<p id="${esc(p.id)}"><span class="ln">${p.line}</span>${esc(p.text)}</p>`).join('')}</div>`;
    }).join('');

    const prev = $('qContract').value;
    $('qContract').innerHTML = res.rows.map((r) => `<option>${esc(r.number)}</option>`).join('');
    if (prev && res.rows.some((r) => r.number === prev)) $('qContract').value = prev;
    if (state.lastQuestion) state.lastQuestion();
  }

  function askField(key, number) {
    state.lastQuestion = () => askField(key, number);
    $('qField').value = key;
    if ([...$('qContract').options].some((o) => o.value === number)) $('qContract').value = number;
    const res = state.result;
    if (!res) return show('Сначала загрузите файлы.');
    const r = res.rows.find((x) => x.number === number);
    if (!r) return show(`Договор ${esc(number)} среди загруженных файлов не найден.`);
    const pending = r.proposals.filter((p) => p.field === key);
    show(`<b>Договор ${esc(number)} на ${C.fromIso(res.checkDate)}. ${esc(label(key))}:</b><br>${cell(key, r[key])}
      <div style="margin-top:8px"><b>Несогласованные изменения:</b> ${proposalsHtml(pending)}</div>`);
  }

  function askBefore(dateIso) {
    state.lastQuestion = () => askBefore(dateIso);
    const res = state.result;
    if (!res) return show('Сначала загрузите файлы.');
    const hits = C.contractsBefore(res, dateIso);
    if (!hits.length) return show(`Договоров со сроком поставки раньше ${C.fromIso(dateIso)} нет, несогласованных переносов на эти даты тоже нет.`);
    const items = hits.map((h) => {
      const r = h.row;
      const what = h.unknown ? '<span class="review">срок не определён, проверьте вручную</span>'
        : h.before ? `срок поставки <b>${esc(fmt('deadline', r.deadline.value))}</b>`
        : `действующий срок ${esc(fmt('deadline', r.deadline.value))}, но предложен перенос раньше`;
      const pend = h.pending.length
        ? `<div>Есть несогласованное изменение срока:</div>${proposalsHtml(h.pending)}`
        : '<div class="small muted">несогласованных изменений срока нет</div>';
      return `<li style="margin-bottom:10px"><b>${esc(r.number)}</b>, ${esc(r.supplier || 'поставщик: нет данных')}: ${what}${h.unknown ? '' : srcLink(r.deadline.source)}${pend}</li>`;
    });
    show(`<b>Поставка раньше ${C.fromIso(dateIso)} на дату проверки ${C.fromIso(res.checkDate)}:</b><ul>${items.join('')}</ul>`);
  }

  function show(html) { $('answer').innerHTML = `<div class="answer">${html}</div>`; }

  // Подсветка абзаца, на который ведёт ссылка-основание.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.src');
    if (!a) return;
    document.querySelectorAll('.doc p.hl').forEach((p) => p.classList.remove('hl'));
    const p = document.getElementById(a.getAttribute('href').slice(1));
    if (p) p.classList.add('hl');
  });

  $('files').addEventListener('change', async (e) => {
    for (const f of e.target.files) state.files.set(f.name, { name: f.name, text: await readFile(f) });
    e.target.value = '';
    render();
  });
  $('sample').addEventListener('click', async () => {
    try {
      for (const n of SAMPLE) {
        const resp = await fetch(`documents/${n}`);
        if (!resp.ok) throw new Error(resp.status);
        state.files.set(n, { name: n, text: await resp.text() });
      }
      render();
    } catch (err) {
      show('Учебный комплект не подгрузился (при открытии страницы как файла браузер это запрещает). Загрузите файлы из папки documents кнопкой «Загрузить TXT».');
    }
  });
  $('clear').addEventListener('click', () => { state.files.clear(); state.lastQuestion = null; render(); });
  $('checkDate').addEventListener('change', render);
  $('qAsk').addEventListener('click', () => askField($('qField').value, $('qContract').value));
  $('qBeforeAsk').addEventListener('click', () => askBefore($('qBefore').value));

  $('qField').innerHTML = Object.keys(C.FIELDS).map((k) => `<option value="${k}">${esc(label(k))}</option>`).join('');
  $('presets').innerHTML = PRESETS.map((p, i) => `<button data-i="${i}">${esc(p.text)}</button>`).join('');
  $('presets').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) PRESETS[+b.dataset.i].run(); });
  render();
})();
