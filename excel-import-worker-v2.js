'use strict';

importScripts('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js');

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const upper = value => clean(value).toUpperCase();
const normHeader = value => clean(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const numeric = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let text = clean(value).replace(/\s/g, '');
  if (!text || text === '-' || /^#/.test(text)) return 0;
  if (text.includes(',') && text.includes('.')) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  else if (text.includes(',')) text = text.replace(',', '.');
  const result = Number(text);
  return Number.isFinite(result) ? result : 0;
};
const truthy = value => ['TRUE', 'YES', 'Y', 'SIM', 'S', '1', 'X', 'HOLD'].includes(upper(value));
const normalizeIso = value => upper(value).replace(/\s+/g, '').replace(/_/g, '-').replace(/^CANC-?/, '').replace(/-+/g, '-');
const padSpool = value => clean(value).replace(/\.0+$/, '').replace(/\D/g, '').padStart(3, '0');
const fullSpoolKey = value => normalizeIso(value).replace(/-+$/, '');
const sourceKey = (iso, spool) => `${normalizeIso(iso)}-${padSpool(spool)}`.replace(/-+$/, '');
const stableHash = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

function excelDate(value) {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && self.XLSX?.SSF) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = clean(value);
  if (!text || text === 'None' || /^#/.test(text)) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const match = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (match) {
    let year = match[3];
    if (year.length === 2) year = `20${year}`;
    return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  return text;
}

function postProgress(id, stage, detail, current = null, total = null) {
  self.postMessage({ id, kind: 'progress', stage, detail, current, total });
}

async function sha256(buffer) {
  if (!self.crypto?.subtle) return stableHash(`${buffer.byteLength}`);
  const digest = await self.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function identifyType(fileName) {
  const name = normHeader(fileName);
  if (name.includes('spool materials')) return 'spool_materials';
  if (name.includes('spool map')) return 'spool_map';
  if (name.includes('grafico') || name.includes('graficos')) return 'p83_production';
  if (name.includes('faturamento')) return 'p83_billing';
  return 'unknown';
}

function readWorkbook(buffer, sheetNames, options = {}) {
  const settings = {
    type: 'array',
    cellDates: true,
    cellStyles: false,
    cellHTML: false,
    cellNF: false,
    bookVBA: false,
    dense: true,
    ...options,
  };
  if (sheetNames?.length) settings.sheets = sheetNames;
  return XLSX.read(buffer, settings);
}

function rowsFromSheet(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`A aba ${sheetName} não foi encontrada.`);
  // Os mapas do ControlTUB usam linhas vazias e títulos mesclados antes do
  // cabeçalho físico. Mantê-las é obrigatório para que rows[7]/rows[8]
  // correspondam às linhas 8/9 do Spool Map.
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
}

function compositeHeaders(groupRow, headerRow) {
  const length = Math.max(groupRow?.length || 0, headerRow?.length || 0);
  const headers = [];
  const used = new Map();
  for (let index = 0; index < length; index += 1) {
    const group = clean(groupRow?.[index]);
    const leaf = clean(headerRow?.[index]);
    let label = clean(`${group} ${leaf}`) || `column_${index + 1}`;
    const base = label;
    const occurrence = (used.get(base) || 0) + 1;
    used.set(base, occurrence);
    if (occurrence > 1) label = `${base} (${occurrence})`;
    headers.push(label);
  }
  return headers;
}

function mapHeaders(headers) {
  const map = new Map();
  headers.forEach((header, index) => {
    const normalized = normHeader(header);
    if (normalized && !map.has(normalized)) map.set(normalized, index);
  });
  return map;
}

function findColumn(map, patterns) {
  const keys = [...map.keys()];
  for (const pattern of patterns) {
    const found = keys.find(key => pattern instanceof RegExp ? pattern.test(key) : key.includes(pattern));
    if (found !== undefined) return map.get(found);
  }
  return -1;
}

function rowValue(row, index) {
  return index >= 0 ? row?.[index] ?? '' : '';
}

function rowPayload(headers, row) {
  const payload = {};
  headers.forEach((header, index) => {
    const value = row?.[index];
    if (value !== '' && value !== null && value !== undefined && value !== 'None') payload[header] = value instanceof Date ? value.toISOString() : value;
  });
  return payload;
}

function parseSpoolMap(buffer, id) {
  postProgress(id, 'Abrindo Spool Map', 'Lendo cadastro, produção, pintura, logística e montagem...');
  const workbook = readWorkbook(buffer, ['SPOOL MAP']);
  const sheetName = workbook.SheetNames.find(name => normHeader(name).includes('spool map')) || workbook.SheetNames[0];
  const rows = rowsFromSheet(workbook, sheetName);
  if (rows.length < 10) throw new Error('O Spool Map não possui linhas suficientes.');

  const headers = compositeHeaders(rows[7] || [], rows[8] || []);
  const map = mapHeaders(headers);
  const idx = {
    contract: findColumn(map, [/basic registration information contract$/]),
    module: findColumn(map, [/physical layout$/, /arranjo fisico/, /module/, /modulo/]),
    document: findColumn(map, [/basic registration information document$/, /^document$/]),
    subsop: findColumn(map, [/subsop/]),
    hts: findColumn(map, [/\bhts\b/, /\bsth\b/]),
    line: findColumn(map, [/basic registration information line$/, /^line$/, /linha/]),
    manufacturer: findColumn(map, [/manufacturer$/, /fabricante/]),
    iso: findColumn(map, [/isometric$/, /isometrico$/]),
    tag: findColumn(map, [/spool tag/]),
    spool: findColumn(map, [/basic registration information spool$/, /^spool$/]),
    priority: findColumn(map, [/priority/]),
    weight: findColumn(map, [/weight kg/, /peso/]),
    hold: findColumn(map, [/on hold/, /^hold$/]),
    spoolType: findColumn(map, [/spool type/]),
    material: findColumn(map, [/basic registration information material$/, /^material$/]),
    diameter: findColumn(map, [/diameter mm/, /diametro mm/]),
    diameterInch: findColumn(map, [/diameter inch/, /diametro pol/]),
    thickness: findColumn(map, [/thickness mm/, /espessura/]),
    spec: findColumn(map, [/\bspec\b/, /especificacao/]),
    pipeMaterial: findColumn(map, [/pipe material/]),
    fluid: findColumn(map, [/\bfluid\b/, /fluido/]),
    paintCondition: findColumn(map, [/painting condition/]),
    length: findColumn(map, [/length m/, /comprimento/]),
    area: findColumn(map, [/area m/, /^area$/]),
    totalJoints: findColumn(map, [/total joints/]),
    shopJoints: findColumn(map, [/total pipe shop joints/, /shop joints/]),
    fieldJoints: findColumn(map, [/total field joints/, /field joints/]),
    scheduleNo: findColumn(map, [/manufacture manufacture schedule number/, /manufacture schedule number/]),
    scheduleDate: findColumn(map, [/manufacture manufacture schedule date/, /manufacture schedule date/]),
    cutting: findColumn(map, [/cutting beveling date/, /cutting date/]),
    fitting: findColumn(map, [/manufacture fitting date/, /^fitting date$/]),
    fitup: findColumn(map, [/manufacture fit up date/, /fit up date/]),
    welding: findColumn(map, [/manufacture welding follow up date/, /welding follow up date/]),
    visual: findColumn(map, [/manufacture visual inspection date/, /visual inspection date/]),
    dimensional: findColumn(map, [/pipe shop dimensional date/, /manufacture dimensional date/]),
    release: findColumn(map, [/manufacturing release date/]),
    packing: findColumn(map, [/packing list actual location packing list/, /packing list$/]),
    origin: findColumn(map, [/packing list actual location origin local/, /origin local/]),
    sent: findColumn(map, [/packing list actual location sent on/, /sent on/]),
    destination: findColumn(map, [/packing list actual location destination/, /^destination$/]),
    receivedAt: findColumn(map, [/packing list actual location received on/, /received on/]),
    received: findColumn(map, [/received yes no/, /^received$/]),
    assemblyScheduleNo: findColumn(map, [/assembly assembly schedule number/]),
    assemblyScheduleDate: findColumn(map, [/assembly assembly schedule date/]),
    manufactureStatus: findColumn(map, [/manufacture status/]),
    assemblyStatus: findColumn(map, [/assembly status/]),
  };
  // Algumas exportações do ControlTUB deixam as células de cabeçalho CK/CL
  // mescladas sem texto, embora os dados continuem nessas colunas. Preserve
  // o status real em vez de transformar toda a base em “FAB - Not Started”.
  const columnIndex = value => {
    let result = 0;
    for (const char of value) result = result * 26 + char.charCodeAt(0) - 64;
    return result - 1;
  };
  if (idx.manufactureStatus < 0 && headers.length > columnIndex('CK')) idx.manufactureStatus = columnIndex('CK');
  if (idx.assemblyStatus < 0 && headers.length > columnIndex('CL')) idx.assemblyStatus = columnIndex('CL');
  if (idx.iso < 0 || idx.spool < 0) throw new Error('As colunas Isometric e Spool não foram encontradas.');

  const unique = new Map();
  for (let rowIndex = 9; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const iso = rowValue(row, idx.iso);
    const spool = rowValue(row, idx.spool);
    if (!clean(iso) || !clean(spool)) continue;
    const key = sourceKey(iso, spool);
    if (!key || key === '-000') continue;
    const record = {
      source_key: key,
      contract: clean(rowValue(row, idx.contract)), module: upper(rowValue(row, idx.module)), document: clean(rowValue(row, idx.document)),
      subsop: clean(rowValue(row, idx.subsop)), hts_sth: clean(rowValue(row, idx.hts)), line: clean(rowValue(row, idx.line)),
      manufacturer: clean(rowValue(row, idx.manufacturer)), isometric: normalizeIso(iso), spool_tag: clean(rowValue(row, idx.tag)) || key,
      spool_number: padSpool(spool), priority: clean(rowValue(row, idx.priority)), weight_kg: numeric(rowValue(row, idx.weight)),
      on_hold: truthy(rowValue(row, idx.hold)) || upper(rowValue(row, idx.manufactureStatus)).includes('HOLD'),
      spool_type: clean(rowValue(row, idx.spoolType)), material: clean(rowValue(row, idx.material)), diameter_mm: numeric(rowValue(row, idx.diameter)),
      diameter_inch: clean(rowValue(row, idx.diameterInch)), thickness_mm: numeric(rowValue(row, idx.thickness)), specification: clean(rowValue(row, idx.spec)),
      pipe_material: clean(rowValue(row, idx.pipeMaterial)), fluid: clean(rowValue(row, idx.fluid)), painting_condition: clean(rowValue(row, idx.paintCondition)),
      length_m: numeric(rowValue(row, idx.length)), area_m2: numeric(rowValue(row, idx.area)), total_joints: numeric(rowValue(row, idx.totalJoints)),
      shop_joints: numeric(rowValue(row, idx.shopJoints)), field_joints: numeric(rowValue(row, idx.fieldJoints)),
      manufacture_schedule_number: clean(rowValue(row, idx.scheduleNo)), manufacture_schedule_date: excelDate(rowValue(row, idx.scheduleDate)),
      cutting_date: excelDate(rowValue(row, idx.cutting)), fitting_date: excelDate(rowValue(row, idx.fitting)), fitup_date: excelDate(rowValue(row, idx.fitup)),
      welding_date: excelDate(rowValue(row, idx.welding)), visual_inspection_date: excelDate(rowValue(row, idx.visual)), dimensional_date: excelDate(rowValue(row, idx.dimensional)),
      manufacture_release_date: excelDate(rowValue(row, idx.release)), packing_list: clean(rowValue(row, idx.packing)), origin_location: clean(rowValue(row, idx.origin)),
      sent_at: excelDate(rowValue(row, idx.sent)), destination: clean(rowValue(row, idx.destination)), received_at: excelDate(rowValue(row, idx.receivedAt)),
      received: truthy(rowValue(row, idx.received)), manufacture_status: clean(rowValue(row, idx.manufactureStatus)) || 'FAB - Not Started',
      assembly_schedule_number: clean(rowValue(row, idx.assemblyScheduleNo)), assembly_schedule_date: excelDate(rowValue(row, idx.assemblyScheduleDate)),
      assembly_status: clean(rowValue(row, idx.assemblyStatus)), source_row: rowIndex + 1, source_data: rowPayload(headers, row), manual_data: {},
    };
    record.source_row_hash = stableHash(record);
    unique.set(key, record);
    if (rowIndex % 300 === 0) postProgress(id, 'Processando Spool Map', `${unique.size.toLocaleString('pt-BR')} spools identificados`, rowIndex, rows.length);
  }
  const records = [...unique.values()];
  return { type: 'spool_map', label: 'Spool Map P85', records, datasets: [], duplicates: Math.max(0, rows.length - 9 - records.length), summary: { spools: records.length } };
}

function parseMaterials(buffer, id, allowedKeys = []) {
  postProgress(id, 'Abrindo materiais', 'A planilha possui 123 mil linhas; o processamento está ocorrendo em segundo plano.');
  const workbook = readWorkbook(buffer, ['List']);
  const sheetName = workbook.SheetNames.find(name => normHeader(name) === 'list') || workbook.SheetNames[0];
  const rows = rowsFromSheet(workbook, sheetName);
  const headerIndex = rows.findIndex(row => row.some(value => normHeader(value) === 'material code') && row.some(value => normHeader(value) === 'spool'));
  if (headerIndex < 0) throw new Error('Cabeçalho da base de materiais não encontrado.');
  const headers = compositeHeaders([], rows[headerIndex]);
  const map = mapHeaders(headers);
  const idx = {
    module: findColumn(map, [/^module$/]), manufacturer: findColumn(map, [/manufacturer site/]), assembly: findColumn(map, [/assembly site/]),
    spool: findColumn(map, [/^spool$/]), spoolRevision: findColumn(map, [/^revision$/]), code: findColumn(map, [/material code/]),
    description: findColumn(map, [/description/]), diameter1: findColumn(map, [/diameter 1/]), diameter2: findColumn(map, [/diameter 2/]),
    materialRevision: findColumn(map, [/material revision/]), initials: findColumn(map, [/initials/]), application: findColumn(map, [/application/]),
    quantity: findColumn(map, [/quantity/]), weight: findColumn(map, [/^weight$/]), notes: findColumn(map, [/notes/]),
  };
  if (idx.spool < 0 || idx.code < 0) throw new Error('As colunas Spool e Material Code não foram encontradas.');
  const allowed = new Set(allowedKeys.map(fullSpoolKey));
  const occurrences = new Map();
  const records = [];
  let ignored = 0;
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const spool = fullSpoolKey(rowValue(row, idx.spool));
    const code = clean(rowValue(row, idx.code));
    const manufacturer = upper(rowValue(row, idx.manufacturer));
    if (!spool || !code) continue;
    const belongsToP85 = manufacturer === 'STEP_ANGRA' || manufacturer === 'STEP ANGRA' || allowed.has(spool);
    if (!belongsToP85) { ignored += 1; continue; }
    const match = spool.match(/^(.*)-(\d{1,3})$/);
    const iso = match ? match[1] : spool;
    const spoolNumber = match ? match[2].padStart(3, '0') : '';
    const application = clean(rowValue(row, idx.application));
    const base = `${spool}|${upper(code)}|${upper(application)}`;
    const occurrence = (occurrences.get(base) || 0) + 1;
    occurrences.set(base, occurrence);
    const record = {
      source_key: `${base}|${occurrence}`, spool_source_key: spool, isometric: iso, spool_number: spoolNumber,
      module: upper(rowValue(row, idx.module)), manufacturer_site: clean(rowValue(row, idx.manufacturer)), assembly_site: clean(rowValue(row, idx.assembly)),
      spool_revision: clean(rowValue(row, idx.spoolRevision)), material_code: code, description: clean(rowValue(row, idx.description)),
      diameter_1: clean(rowValue(row, idx.diameter1)), diameter_2: clean(rowValue(row, idx.diameter2)), material_revision: clean(rowValue(row, idx.materialRevision)),
      initials: clean(rowValue(row, idx.initials)), application, quantity: numeric(rowValue(row, idx.quantity)), weight_kg: numeric(rowValue(row, idx.weight)),
      notes: clean(rowValue(row, idx.notes)), source_row: rowIndex + 1, source_data: rowPayload(headers, row),
    };
    record.source_row_hash = stableHash(record);
    records.push(record);
    if (rowIndex % 4000 === 0) postProgress(id, 'Filtrando materiais P85', `${records.length.toLocaleString('pt-BR')} linhas STEP_ANGRA encontradas`, rowIndex, rows.length);
  }
  return { type: 'spool_materials', label: 'Spool Materials P85', records, datasets: [], duplicates: 0, summary: { materials: records.length, ignored } };
}

const PRODUCTION_DATASETS = [
  { sheet: 'BASE SPOOL', type: 'p83_spools', header: 0, key: (payload, row, rowIndex) => { const iso = payload['Informações Básicas de Cadastro - Isometrico']; const spool = payload['Informações Básicas de Cadastro - Spool']; return clean(iso) && clean(spool) ? sourceKey(iso, spool) : `row-${rowIndex + 1}`; } },
  { sheet: 'MAPA DE JUNTAS', type: 'p83_joints', header: 0, keyColumns: ['Spool/', 'Junta/'] },
  { sheet: 'BACKLOG', type: 'p83_backlog', header: 0, keyColumns: ['ISOMÉTRICO'] },
  { sheet: 'Controle de Desenho', type: 'p83_drawings', header: 3, keyColumns: ['SPOOL'] },
  { sheet: 'BASE DE PROGRAMAÇÃO', type: 'p83_schedule', header: 1, keyColumns: ['REF SPOOL'] },
  { sheet: 'MEDIÇÃO', type: 'p83_measurement_summary', header: 2, keyColumns: ['Modulo'] },
  { sheet: 'SPOOL FINALIZADOS', type: 'p83_finished_spools', header: 0, keyColumns: ['Módulo', 'Documento', 'Spool'] },
];
const BILLING_DATASETS = [
  { sheet: 'Lista de Controle de Sup', type: 'p83_support_control', header: 0, keyColumns: ['Modulo'] },
  { sheet: 'Controle faturamento', type: 'p83_billing_control', header: 2, keyColumns: ['Modulo'] },
  { sheet: 'Relatorio de Medição', type: 'p83_measurement_report', header: 2, keyColumns: ['Modulo'] },
  { sheet: 'Total Medido', type: 'p83_measured_totals', header: 0, keyColumns: ['Nº BM', 'Rev'] },
  { sheet: 'SGJ-Suporte', type: 'p83_supports', header: 1, keyColumns: ['Tag', 'Tipo'] },
  { sheet: "Controle de NF's", type: 'p83_invoices', header: 0, keyColumns: ['SPOOL', 'CÓDIGO MATERIAL', 'NF'] },
];

function compactPayload(headers, row) {
  const payload = {};
  headers.forEach((header, index) => {
    const value = row?.[index];
    if (value !== '' && value !== null && value !== undefined && value !== 'None') payload[header || `column_${index + 1}`] = value instanceof Date ? value.toISOString() : value;
  });
  return payload;
}
function keyFromColumns(payload, columns, rowIndex) {
  const parts = (columns || []).map(column => clean(payload[column])).filter(Boolean);
  return parts.length ? parts.join('|') : `row-${rowIndex + 1}`;
}
function parseGenericDataset(workbook, definition, id, position, total) {
  postProgress(id, `Lendo ${definition.sheet}`, `Conjunto ${position} de ${total}`);
  if (!workbook.Sheets[definition.sheet]) return { type: definition.type, sheet: definition.sheet, rows: [], missing: true };
  const rows = rowsFromSheet(workbook, definition.sheet);
  const headerRow = rows[definition.header] || [];
  const headers = compositeHeaders([], headerRow);
  const records = [];
  const occurrences = new Map();
  for (let rowIndex = definition.header + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row?.some(value => value !== '' && value !== null && value !== undefined && value !== 'None')) continue;
    const payload = compactPayload(headers, row);
    const rawKey = definition.key ? definition.key(payload, row, rowIndex) : keyFromColumns(payload, definition.keyColumns, rowIndex);
    const baseKey = clean(rawKey) || `row-${rowIndex + 1}`;
    const occurrence = (occurrences.get(baseKey) || 0) + 1;
    occurrences.set(baseKey, occurrence);
    const key = occurrence === 1 ? baseKey : `${baseKey}|#${occurrence}`;
    records.push({ dataset_type: definition.type, source_key: key, source_sheet: definition.sheet, source_row: rowIndex + 1, source_row_hash: stableHash(payload), payload });
  }
  return { type: definition.type, sheet: definition.sheet, rows: records, missing: false };
}
function parseLegacy(buffer, id, type) {
  const definitions = type === 'p83_production' ? PRODUCTION_DATASETS : BILLING_DATASETS;
  postProgress(id, 'Abrindo abas selecionadas', `${definitions.length} conjuntos operacionais serão lidos; matrizes de gráficos e fórmulas serão ignoradas.`);
  const workbook = readWorkbook(buffer, definitions.map(definition => definition.sheet));
  const datasets = [];
  for (let index = 0; index < definitions.length; index += 1) {
    const dataset = parseGenericDataset(workbook, definitions[index], id, index + 1, definitions.length);
    if (!dataset.missing) datasets.push(dataset);
  }
  const rowCount = datasets.reduce((total, dataset) => total + dataset.rows.length, 0);
  return { type, label: type === 'p83_production' ? 'Produção e programação P83' : 'Faturamento e medição P83', records: [], datasets, duplicates: 0, summary: Object.fromEntries(datasets.map(dataset => [dataset.type, dataset.rows.length])), rowCount };
}

self.onmessage = async event => {
  const { id, file, allowedKeys = [] } = event.data || {};
  try {
    if (!file) throw new Error('Arquivo não recebido pelo processador.');
    const type = identifyType(file.name);
    if (type === 'unknown') throw new Error('Modelo de arquivo não reconhecido.');
    postProgress(id, 'Lendo arquivo', `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`);
    const buffer = await file.arrayBuffer();
    const hash = await sha256(buffer);
    let parsed;
    if (type === 'spool_map') parsed = parseSpoolMap(buffer, id);
    else if (type === 'spool_materials') parsed = parseMaterials(buffer, id, allowedKeys);
    else parsed = parseLegacy(buffer, id, type);
    self.postMessage({ id, kind: 'result', result: { ...parsed, hash, fileName: file.name, fileSize: file.size, lastModified: file.lastModified } });
  } catch (error) {
    self.postMessage({ id, kind: 'error', error: error?.message || 'Falha ao processar o arquivo.' });
  }
};

