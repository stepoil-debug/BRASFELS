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

  const yearFirst = text.match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})(?:\D.*)?$/);
  if (yearFirst) {
    const year = Number(yearFirst[1]);
    let month = Number(yearFirst[2]);
    let day = Number(yearFirst[3]);
    if (month > 12 && day <= 12) [month, day] = [day, month];
    return isoCalendarDate(year, month, day);
  }

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

  return null;
};

const scopeFilePattern = /(?:tabela.*spools.*valor|spools.*valores|tabela.*escopo)/i;
const originalScopeFileName = value => clean(value).replace(/^faturamento\s+tabela\s+spools\s+valores\s*-\s*/i, '');
const normalizedScopeKey = value => fullSpoolKey(value).replace(/-+$/, '');

function scopeDatasetRow(type, sourceKeyValue, sheet, rowNumber, payload) {
  const item = {
    source_key: sourceKeyValue,
    source_sheet: sheet,
    source_row: rowNumber,
    payload,
  };
  item.source_row_hash = stableHash({ type, sourceKeyValue, payload });
  return item;
}

function parseScopeValues(buffer, id, suppliedFileName) {
  postProgress(id, 'Abrindo tabela de escopo e valores', 'Lendo juntas, spools, classes de inspeção, pintura e suportes...');
  const workbook = readWorkbook(buffer);
  const scopeSheet = workbook.SheetNames.find(name => normHeader(name) === 'tabela escopo');
  const baseSheet = workbook.SheetNames.find(name => normHeader(name) === 'base cs');
  if (!scopeSheet || !baseSheet) {
    throw new Error('O arquivo precisa conter as abas Tabela Escopo e Base CS.');
  }

  const baseRows = rowsFromSheet(workbook, baseSheet);
  const headerIndex = baseRows.findIndex(row => {
    const normalized = row.map(normHeader);
    return normalized.includes('concat')
      && normalized.includes('isometrico')
      && normalized.includes('junta')
      && normalized.some(value => value === 'peso kg');
  });
  if (headerIndex < 0) throw new Error('O cabeçalho da aba Base CS não foi reconhecido.');

  const baseHeaders = compositeHeaders([], baseRows[headerIndex]);
  const baseMap = mapHeaders(baseHeaders);
  const column = patterns => findColumn(baseMap, patterns);
  const idx = {
    concat: column([/^concat$/]),
    sourceName: column([/nome da origem/]),
    iso: column([/^isometrico$/]),
    spool: column([/^spool$/]),
    joint: column([/^junta$/]),
    jointType: column([/tipo junta/]),
    diameter: column([/^diametro$/]),
    material: column([/^material$/]),
    thickness: column([/espessura/]),
    execution: column([/campo pipe/]),
    weight: column([/peso kg/]),
    diameterThickness: column([/diam espessura/]),
  };
  if (idx.concat < 0 || idx.joint < 0) throw new Error('As colunas CONCAT e JUNTA não foram encontradas na Base CS.');

  const joints = [];
  const spoolMap = new Map();
  const isometrics = new Set();
  const jointTypeTotals = { BW: 0, SW: 0, BR: 0, OTHER: 0 };
  let accumulatedJointWeight = 0;

  for (let rowIndex = headerIndex + 1; rowIndex < baseRows.length; rowIndex += 1) {
    const row = baseRows[rowIndex];
    const concat = normalizedScopeKey(rowValue(row, idx.concat));
    const joint = clean(rowValue(row, idx.joint));
    if (!concat || !joint) continue;

    const iso = normalizeIso(rowValue(row, idx.iso));
    const spoolNumber = padSpool(rowValue(row, idx.spool));
    const jointType = upper(rowValue(row, idx.jointType)) || 'OTHER';
    const weight = numeric(rowValue(row, idx.weight));
    const payload = {
      spool_key: concat,
      nome_origem: clean(rowValue(row, idx.sourceName)),
      isometrico: iso,
      spool: spoolNumber,
      junta: joint,
      tipo_junta: jointType,
      diametro: clean(rowValue(row, idx.diameter)),
      material: clean(rowValue(row, idx.material)),
      espessura_mm: numeric(rowValue(row, idx.thickness)),
      local_execucao: clean(rowValue(row, idx.execution)),
      peso_spool_kg: weight,
      diametro_espessura: clean(rowValue(row, idx.diameterThickness)),
    };
    joints.push(scopeDatasetRow('p85_scope_joints', `${concat}|${joint}`, baseSheet, rowIndex + 1, payload));
    accumulatedJointWeight += weight;
    isometrics.add(iso);
    if (Object.prototype.hasOwnProperty.call(jointTypeTotals, jointType)) jointTypeTotals[jointType] += 1;
    else jointTypeTotals.OTHER += 1;

    let spool = spoolMap.get(concat);
    if (!spool) {
      spool = {
        spool_key: concat,
        nome_origem: payload.nome_origem,
        isometrico: iso,
        spool: spoolNumber,
        material: payload.material,
        peso_spool_kg: weight,
        total_juntas: 0,
        juntas_bw: 0,
        juntas_sw: 0,
        juntas_br: 0,
        juntas_outros: 0,
      };
      spoolMap.set(concat, spool);
    }
    spool.total_juntas += 1;
    if (jointType === 'BW') spool.juntas_bw += 1;
    else if (jointType === 'SW') spool.juntas_sw += 1;
    else if (jointType === 'BR') spool.juntas_br += 1;
    else spool.juntas_outros += 1;

    if (rowIndex % 500 === 0) {
      postProgress(id, 'Processando Base CS', `${joints.length.toLocaleString('pt-BR')} juntas identificadas`, rowIndex, baseRows.length);
    }
  }

  const spools = [...spoolMap.values()].map((payload, index) =>
    scopeDatasetRow('p85_scope_spools', payload.spool_key, baseSheet, index + 1, payload));
  const uniqueSpoolWeight = [...spoolMap.values()].reduce((sum, item) => sum + numeric(item.peso_spool_kg), 0);

  const scopeRows = rowsFromSheet(workbook, scopeSheet);
  const inspectionRates = [];
  for (let rowIndex = 0; rowIndex < scopeRows.length; rowIndex += 1) {
    const row = scopeRows[rowIndex];
    const material = clean(row?.[1]);
    const diameterRange = clean(row?.[2]);
    if (!material || !diameterRange || normHeader(material).includes('total')) continue;
    if (!/carbon steel/i.test(material)) continue;
    const payload = {
      material,
      faixa_diametro_espessura: diameterRange,
      classe_i_quantidade: numeric(row?.[3]),
      classe_i_peso_kg: numeric(row?.[4]),
      classe_i_valor_unitario: numeric(row?.[5]),
      classe_ii_quantidade: numeric(row?.[6]),
      classe_ii_peso_kg: numeric(row?.[7]),
      classe_ii_valor_unitario: numeric(row?.[8]),
      classe_iii_quantidade: numeric(row?.[9]),
      classe_iii_peso_kg: numeric(row?.[10]),
      classe_iii_valor_unitario: numeric(row?.[11]),
      quantidade_total: numeric(row?.[12]),
      peso_total_kg: numeric(row?.[13]),
    };
    payload.valor_total_estimado =
      payload.classe_i_quantidade * payload.classe_i_valor_unitario
      + payload.classe_ii_quantidade * payload.classe_ii_valor_unitario
      + payload.classe_iii_quantidade * payload.classe_iii_valor_unitario;
    inspectionRates.push(scopeDatasetRow(
      'p85_scope_inspection_rates',
      normHeader(`${material}-${diameterRange}`).replace(/\s+/g, '-'),
      scopeSheet,
      rowIndex + 1,
      payload,
    ));
  }

  const paintingRates = [];
  let paintingMaterial = '';
  for (let rowIndex = 0; rowIndex < scopeRows.length; rowIndex += 1) {
    const row = scopeRows[rowIndex];
    const system = clean(row?.[16]);
    if (clean(row?.[15])) paintingMaterial = clean(row?.[15]);
    if (!system || normHeader(system) === 'painting system') continue;
    if (!/^\d+$/.test(system)) continue;
    const payload = {
      material: paintingMaterial || 'Carbon Steel',
      sistema_pintura: system,
      quantidade: numeric(row?.[17]),
      peso_t: numeric(row?.[18]),
      area_m2: numeric(row?.[19]),
      fator_m2_t: numeric(row?.[20]),
      valor_unitario: numeric(row?.[21]),
    };
    payload.valor_total_estimado = payload.area_m2 * payload.valor_unitario;
    paintingRates.push(scopeDatasetRow('p85_scope_painting_rates', `painting-${system}`, scopeSheet, rowIndex + 1, payload));
  }

  const supportRates = [];
  for (let rowIndex = 0; rowIndex < scopeRows.length; rowIndex += 1) {
    const row = scopeRows[rowIndex];
    const support = clean(row?.[15]);
    if (!['SAPATA*', 'TRUNNION*', 'SELA'].includes(upper(support))) continue;
    const payload = {
      suporte: support,
      quantidade_juntas: numeric(row?.[16]),
      peso_t: numeric(row?.[17]),
      valor_unitario: numeric(row?.[18]),
    };
    payload.valor_total_estimado = payload.quantidade_juntas * payload.valor_unitario;
    supportRates.push(scopeDatasetRow('p85_scope_support_rates', `support-${normHeader(support)}`, scopeSheet, rowIndex + 1, payload));
  }

  const inspectionValue = inspectionRates.reduce((sum, item) => sum + numeric(item.payload.valor_total_estimado), 0);
  const paintingValue = paintingRates.reduce((sum, item) => sum + numeric(item.payload.valor_total_estimado), 0);
  const supportValue = supportRates.reduce((sum, item) => sum + numeric(item.payload.valor_total_estimado), 0);
  const scopeWeight = inspectionRates.reduce((sum, item) => sum + numeric(item.payload.peso_total_kg), 0);
  const sourceSupportTotal = numeric(scopeRows.find(row => normHeader(row?.[15]) === 'total geral')?.[17]);

  const summaryPayload = {
    total_spools: spools.length,
    total_isometricos: isometrics.size,
    total_juntas: joints.length,
    juntas_bw: jointTypeTotals.BW,
    juntas_sw: jointTypeTotals.SW,
    juntas_br: jointTypeTotals.BR,
    juntas_outros: jointTypeTotals.OTHER,
    peso_unico_spools_kg: uniqueSpoolWeight,
    peso_acumulado_por_junta_kg: accumulatedJointWeight,
    peso_escopo_inspecao_kg: scopeWeight,
    valor_inspecao_estimado: inspectionValue,
    valor_pintura_estimado: paintingValue,
    valor_suportes_estimado: supportValue,
    valor_total_estimado: inspectionValue + paintingValue + supportValue,
    sistemas_pintura: paintingRates.length,
    faixas_inspecao: inspectionRates.length,
    tipos_suporte: supportRates.length,
    total_suportes_planilha: supportRates.reduce((sum, item) => sum + numeric(item.payload.quantidade_juntas), 0),
    peso_suportes_calculado_t: supportRates.reduce((sum, item) => sum + numeric(item.payload.peso_t), 0),
    peso_suportes_total_origem: sourceSupportTotal,
  };
  const summary = [scopeDatasetRow('p85_scope_summary', 'summary', scopeSheet, 1, summaryPayload)];

  const datasets = [
    { type: 'p85_scope_summary', sheet: scopeSheet, rows: summary },
    { type: 'p85_scope_spools', sheet: baseSheet, rows: spools },
    { type: 'p85_scope_joints', sheet: baseSheet, rows: joints },
    { type: 'p85_scope_inspection_rates', sheet: scopeSheet, rows: inspectionRates },
    { type: 'p85_scope_painting_rates', sheet: scopeSheet, rows: paintingRates },
    { type: 'p85_scope_support_rates', sheet: scopeSheet, rows: supportRates },
  ];

  return {
    type: 'p85_scope_values',
    label: 'Escopo e valores P85',
    records: [],
    datasets,
    rowCount: datasets.reduce((sum, dataset) => sum + dataset.rows.length, 0),
    duplicates: 0,
    summary: summaryPayload,
    fileName: originalScopeFileName(suppliedFileName),
  };
}

const baseWorkerMessageHandler = self.onmessage;
self.onmessage = async function brasfelsWorkerWithScopeValues(event) {
  const message = event.data || {};
  const fileName = clean(message.file?.name);
  if (!scopeFilePattern.test(fileName)) {
    return baseWorkerMessageHandler.call(self, event);
  }

  const id = message.id;
  try {
    const buffer = await message.file.arrayBuffer();
    const hash = await sha256(buffer);
    const result = parseScopeValues(buffer, id, fileName);
    result.hash = hash;
    result.fileName = originalScopeFileName(fileName);
    self.postMessage({ id, kind: 'result', result });
  } catch (error) {
    self.postMessage({ id, kind: 'error', error: error?.message || 'Falha ao processar a tabela de escopo e valores.' });
  }
};
