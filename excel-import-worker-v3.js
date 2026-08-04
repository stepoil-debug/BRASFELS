'use strict';

// Carrega o processador principal e corrige a leitura de planilhas com
// linhas vazias antes do cabeçalho, títulos agrupados e datas inconsistentes.
importScripts('excel-import-worker-v2-base.js?v=11');

rowsFromSheet = function rowsFromSheetPreservingLayout(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`A aba ${sheetName} não foi encontrada.`);
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: true,
  });
};

compositeHeaders = function compositeHeadersWithGroups(groupRow, headerRow) {
  const length = Math.max(groupRow?.length || 0, headerRow?.length || 0);
  const headers = [];
  const used = new Map();
  let activeGroup = '';

  for (let index = 0; index < length; index += 1) {
    const suppliedGroup = clean(groupRow?.[index]);
    if (suppliedGroup) activeGroup = suppliedGroup;
    const leaf = clean(headerRow?.[index]);
    let label = clean(`${activeGroup} ${leaf}`) || `column_${index + 1}`;
    const base = label;
    const occurrence = (used.get(base) || 0) + 1;
    used.set(base, occurrence);
    if (occurrence > 1) label = `${base} (${occurrence})`;
    headers.push(label);
  }

  return headers;
};

function validCalendarDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function isoCalendarDate(year, month, day) {
  if (!validCalendarDate(year, month, day)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

excelDate = function excelDateSafe(value) {
  if (value === null || value === undefined || value === '' || value === 0) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'number' && self.XLSX?.SSF) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return isoCalendarDate(Number(parsed.y), Number(parsed.m), Number(parsed.d));
  }

  const text = clean(value);
  if (!text || text === 'None' || /^#/.test(text)) return null;

  // Formato iniciado pelo ano. Corrige também valores invertidos como 2026-23-07.
  const yearFirst = text.match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})(?:\D.*)?$/);
  if (yearFirst) {
    const year = Number(yearFirst[1]);
    let month = Number(yearFirst[2]);
    let day = Number(yearFirst[3]);

    if (month > 12 && day <= 12) {
      [month, day] = [day, month];
    }

    return isoCalendarDate(year, month, day);
  }

  // Formatos brasileiros e americanos. Em datas ambíguas, prioriza DD/MM/AAAA.
  const dayFirst = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:\D.*)?$/);
  if (dayFirst) {
    let first = Number(dayFirst[1]);
    let second = Number(dayFirst[2]);
    let year = Number(dayFirst[3]);
    if (year < 100) year += 2000;

    let day = first;
    let month = second;
    if (first <= 12 && second > 12) {
      day = second;
      month = first;
    }

    return isoCalendarDate(year, month, day);
  }

  // Valores textuais não reconhecidos não devem chegar às colunas DATE do PostgreSQL.
  return null;
};
