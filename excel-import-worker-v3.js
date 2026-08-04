'use strict';

// Carrega o processador principal e corrige a leitura de planilhas com
// linhas vazias antes do cabeçalho e títulos agrupados por células mescladas.
importScripts('excel-import-worker-v2-base.js?v=10');

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
