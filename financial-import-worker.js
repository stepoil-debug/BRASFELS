'use strict';

importScripts('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js');

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const norm = value => clean(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const stableHash = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
const columnName = index => {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
};
const safeValue = value => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (value === undefined || value === null || value === 'None') return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '';
  return value;
};

const DEFINITIONS = [
  { sheet: 'Lista de Controle de Sup', type: 'p83_financial_support_control', header: 12, hidden: false, key: row => [row?.[11], row?.[6], row?.[13]] },
  { sheet: 'Controle faturamento', type: 'p83_financial_billing_control', header: 18, hidden: false, key: row => [row?.[25], row?.[21], row?.[22]] },
  { sheet: 'Relatorio de Medição', type: 'p83_financial_measurement_report', header: 17, hidden: false, key: row => [row?.[8], row?.[9], row?.[29]] },
  { sheet: 'Custo', type: 'p83_financial_cost', header: 0, hidden: true, key: row => [row?.[8], row?.[18], row?.[31]] },
  { sheet: 'Total Medido', type: 'p83_financial_measured_totals', header: 0, hidden: false, key: row => [row?.[0], row?.[1]] },
  { sheet: 'SGJ-Spool', type: 'p83_financial_sgj_spool', groupHeader: 7, header: 8, hidden: false, key: row => [row?.[0], row?.[9], row?.[10]] },
  { sheet: 'SGJ-Juntas', type: 'p83_financial_sgj_joints', groupHeader: 7, header: 8, hidden: false, key: row => [row?.[8], row?.[9]] },
  { sheet: 'SGJ-Suporte', type: 'p83_financial_sgj_support', groupHeader: 0, header: 1, hidden: false, key: row => [row?.[0], row?.[12], row?.[13]] },
  { sheet: 'Junta Suporte', type: 'p83_financial_support_joint', header: 0, hidden: true, key: row => [row?.[0], row?.[1], row?.[2], row?.[3]] },
  { sheet: 'Analise', type: 'p83_financial_analysis', header: 0, hidden: true, key: row => [row?.[0]] },
  { sheet: "Controle de NF's", type: 'p83_financial_invoices', header: 0, hidden: false, key: row => [row?.[24], row?.[11], row?.[21], row?.[28]] },
];

function postProgress(id, stage, detail, current = null, total = null) {
  self.postMessage({ id, kind: 'progress', stage, detail, current, total });
}

async function sha256(buffer) {
  if (!self.crypto?.subtle) return stableHash(`${buffer.byteLength}`);
  const digest = await self.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function rowsFromSheet(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: true,
  });
}

function compositeHeaders(groupRow, headerRow) {
  const length = Math.max(groupRow?.length || 0, headerRow?.length || 0);
  const headers = [];
  const used = new Map();
  let activeGroup = '';
  for (let index = 0; index < length; index += 1) {
    const suppliedGroup = clean(groupRow?.[index]);
    if (suppliedGroup) activeGroup = suppliedGroup;
    const leaf = clean(headerRow?.[index]);
    let label = clean(`${activeGroup} ${leaf}`) || `Coluna ${columnName(index)}`;
    const base = label;
    const occurrence = (used.get(base) || 0) + 1;
    used.set(base, occurrence);
    if (occurrence > 1) label = `${base} (${occurrence})`;
    headers.push(label);
  }
  return headers;
}

function compactPayload(headers, row) {
  const values = headers.map((header, index) => {
    const value = safeValue(row?.[index]);
    return value === '' ? null : value;
  });
  while (values.length && (values[values.length - 1] === null || values[values.length - 1] === '')) values.pop();
  return { v: values };
}

function metadataRecords(rows, definition) {
  const result = [];
  for (let rowIndex = 0; rowIndex < definition.header; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row?.some(value => safeValue(value) !== '')) continue;
    const cells = {};
    row.forEach((value, columnIndex) => {
      const safe = safeValue(value);
      if (safe !== '') cells[columnName(columnIndex)] = safe;
    });
    const payload = {
      sheet: definition.sheet,
      hidden_in_excel: definition.hidden,
      row: rowIndex + 1,
      cells,
    };
    result.push({
      dataset_type: 'p83_financial_metadata',
      source_key: `${definition.sheet}|meta|${rowIndex + 1}`,
      source_sheet: definition.sheet,
      source_row: rowIndex + 1,
      source_row_hash: stableHash(payload),
      payload,
    });
  }
  return result;
}

function parseDefinition(buffer, definition, id, position, total) {
  postProgress(id, `Lendo ${definition.sheet}`, `Aba ${position} de ${total}`, position - 1, total);
  const workbook = XLSX.read(buffer, {
    type: 'array',
    cellDates: true,
    cellStyles: false,
    cellHTML: false,
    cellNF: false,
    bookVBA: false,
    dense: false,
    sheets: [definition.sheet],
  });
  if (!workbook.Sheets[definition.sheet]) {
    return { dataset: { type: definition.type, sheet: definition.sheet, rows: [], missing: true }, metadata: [] };
  }
  const rows = rowsFromSheet(workbook, definition.sheet);
  const groupRow = definition.groupHeader === undefined ? [] : (rows[definition.groupHeader] || []);
  const headerRow = rows[definition.header] || [];
  const headers = compositeHeaders(groupRow, headerRow);
  const records = [];
  const occurrences = new Map();

  for (let rowIndex = definition.header + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row?.some(value => safeValue(value) !== '')) continue;
    const payload = compactPayload(headers, row);
    if (!payload.v?.some(value => value !== null && value !== '')) continue;
    const parts = (definition.key?.(row, payload, rowIndex) || []).map(clean).filter(Boolean);
    const baseKey = parts.length ? parts.join('|') : `row-${rowIndex + 1}`;
    const occurrence = (occurrences.get(baseKey) || 0) + 1;
    occurrences.set(baseKey, occurrence);
    const sourceKey = occurrence === 1 ? baseKey : `${baseKey}|#${occurrence}`;
    records.push({
      dataset_type: definition.type,
      source_key: sourceKey,
      source_sheet: definition.sheet,
      source_row: rowIndex + 1,
      source_row_hash: stableHash(payload),
      payload,
    });
    if (records.length % 1000 === 0) {
      postProgress(id, `Lendo ${definition.sheet}`, `${records.length.toLocaleString('pt-BR')} linhas processadas`, position - 1, total);
    }
  }

  const metadata = metadataRecords(rows, definition);
  const headerPayload = {
    sheet: definition.sheet,
    hidden_in_excel: definition.hidden,
    kind: 'header',
    row: definition.header + 1,
    headers,
  };
  metadata.unshift({
    dataset_type: 'p83_financial_metadata',
    source_key: `${definition.sheet}|header`,
    source_sheet: definition.sheet,
    source_row: definition.header + 1,
    source_row_hash: stableHash(headerPayload),
    payload: headerPayload,
  });
  return {
    dataset: { type: definition.type, sheet: definition.sheet, rows: records, missing: false },
    metadata,
  };
}

function normalizeFileName(value) {
  return clean(value).replace(/^\d+[-_ ]*/i, '');
}

self.onmessage = async event => {
  const { id, file } = event.data || {};
  try {
    if (!file) throw new Error('Arquivo financeiro não recebido.');
    postProgress(id, 'Preparando módulo financeiro', `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`);
    const buffer = await file.arrayBuffer();
    const hash = await sha256(buffer);
    const datasets = [];
    const metadata = [];
    const missing = [];

    for (let index = 0; index < DEFINITIONS.length; index += 1) {
      const parsed = parseDefinition(buffer, DEFINITIONS[index], id, index + 1, DEFINITIONS.length);
      if (parsed.dataset.missing) missing.push(parsed.dataset.sheet);
      else datasets.push(parsed.dataset);
      metadata.push(...parsed.metadata);
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (metadata.length) datasets.push({ type: 'p83_financial_metadata', sheet: 'Metadados Financeiros', rows: metadata });
    const rowCount = datasets.reduce((sum, dataset) => sum + dataset.rows.length, 0);
    const summary = Object.fromEntries(datasets.filter(dataset => dataset.type !== 'p83_financial_metadata').map(dataset => [dataset.type, dataset.rows.length]));

    self.postMessage({
      id,
      kind: 'result',
      result: {
        type: 'p83_billing',
        label: 'Financeiro P83',
        records: [],
        datasets,
        rowCount,
        duplicates: 0,
        hash,
        fileName: normalizeFileName(file.name),
        fileSize: file.size,
        lastModified: file.lastModified,
        summary: { ...summary, missing_sheets: missing },
      },
    });
  } catch (error) {
    self.postMessage({ id, kind: 'error', error: error?.message || 'Falha ao processar a planilha financeira.' });
  }
};
