'use strict';

importScripts('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js');

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const upper = value => clean(value).toUpperCase();
const normHeader = value => clean(value)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();
const numeric = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let text = clean(value).replace(/\s/g, '');
  if (!text || text === '-' || /^#/.test(text)) return 0;
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (text.includes(',')) text = text.replace(',', '.');
  const result = Number(text);
  return Number.isFinite(result) ? result : 0;
};
const stableHash = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

function normalizeSpoolKey(value) {
  return upper(value)
    .replace(/\s+/g, '')
    .replace(/_/g, '-')
    .replace(/^CANC-?/, '')
    .replace(/-+/g, '-')
    .replace(/-+$/, '');
}

function isoDateTime(value) {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && self.XLSX?.SSF) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    const date = new Date(Date.UTC(
      Number(parsed.y), Number(parsed.m) - 1, Number(parsed.d),
      Number(parsed.H || 0), Number(parsed.M || 0), Math.floor(Number(parsed.S || 0)),
    ));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = clean(value);
  if (!text || text === 'None' || /^#/.test(text)) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function sha256(buffer) {
  if (!self.crypto?.subtle) return stableHash(`${buffer.byteLength}`);
  const digest = await self.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function postProgress(id, stage, detail, current = null, total = null) {
  self.postMessage({ id, kind: 'progress', stage, detail, current, total });
}

function compositeHeaders(groupRow, leafRow) {
  const length = Math.max(groupRow?.length || 0, leafRow?.length || 0);
  const headers = [];
  const used = new Map();
  let activeGroup = '';
  for (let index = 0; index < length; index += 1) {
    const group = clean(groupRow?.[index]);
    if (group) activeGroup = group;
    const leaf = clean(leafRow?.[index]);
    let label = clean(`${activeGroup} ${leaf}`) || `column_${index + 1}`;
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
    const key = normHeader(header);
    if (key && !map.has(key)) map.set(key, index);
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

function valueAt(row, index) {
  return index >= 0 ? row?.[index] ?? '' : '';
}

function sourcePayload(headers, row) {
  const payload = {};
  headers.forEach((header, index) => {
    const value = row?.[index];
    if (value === '' || value === null || value === undefined || value === 'None') return;
    payload[header] = value instanceof Date ? value.toISOString() : value;
  });
  return payload;
}

function findHeaderRows(rows) {
  const limit = Math.min(rows.length - 1, 25);
  for (let index = 0; index < limit; index += 1) {
    const normalized = (rows[index] || []).map(normHeader);
    const hasSpool = normalized.includes('spool');
    const hasJoint = normalized.includes('junta');
    const hasPlacement = normalized.includes('p c');
    const hasDiameter = normalized.some(value => value.includes('diametro'));
    if (hasSpool && hasJoint && hasPlacement && hasDiameter) {
      return { groupIndex: index, leafIndex: index + 1 };
    }
  }
  return null;
}

function parseJointTraceability(buffer, id, fileName) {
  postProgress(id, 'Abrindo mapa de juntas', 'Lendo os apontamentos de fabricação, inspeção e montagem...');
  const workbook = XLSX.read(buffer, {
    type: 'array',
    cellDates: true,
    cellStyles: false,
    cellHTML: false,
    cellNF: false,
    bookVBA: false,
    dense: true,
  });

  let sheetName = workbook.SheetNames.find(name => normHeader(name) === 'dados') || workbook.SheetNames[0];
  let rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: '', blankrows: true });
  let header = findHeaderRows(rows);
  if (!header) {
    for (const candidate of workbook.SheetNames) {
      const candidateRows = XLSX.utils.sheet_to_json(workbook.Sheets[candidate], { header: 1, raw: true, defval: '', blankrows: true });
      const candidateHeader = findHeaderRows(candidateRows);
      if (candidateHeader) {
        sheetName = candidate;
        rows = candidateRows;
        header = candidateHeader;
        break;
      }
    }
  }
  if (!header) throw new Error('O cabeçalho do Mapa de Juntas P85 não foi reconhecido.');

  const headers = compositeHeaders(rows[header.groupIndex], rows[header.leafIndex]);
  const map = mapHeaders(headers);
  const col = patterns => findColumn(map, patterns);
  const idx = {
    contract: col([/^contrato$/]),
    manufacturer: col([/^site fabricante$/]),
    module: col([/^arranjo fisico$/]),
    spoolType: col([/^tipo spool$/]),
    sop: col([/^sop$/]),
    sth: col([/^sth$/]),
    document: col([/^documento$/]),
    line: col([/^linha$/]),
    spool: col([/^spool$/]),
    joint: col([/^junta$/]),
    jointCut: col([/^corte junta$/]),
    jointCutDate: col([/^data corte junta$/]),
    thermalCycle: col([/^ciclo termico$/]),
    diameterInch: col([/^diametro pol$/]),
    diameterMm: col([/^diametro mm$/]),
    thickness: col([/^espessura$/]),
    jointType: col([/^tipo$/]),
    spec: col([/^spec$/]),
    pipeMaterial: col([/^material tubo$/]),
    material: col([/^material$/]),
    inspectionClass: col([/^classe insp$/]),
    standard: col([/^norma$/]),
    placement: col([/^p c$/]),
    cuttingDate: col([/^data corte spool$/]),
    couplingStatus: col([/^acoplamento status$/]),
    couplingDate: col([/^acoplamento data$/]),
    visualAdjustStatus: col([/^visual ajuste status$/]),
    visualAdjustDate: col([/^visual ajuste data$/]),
    weldingStatus: col([/^soldagem status$/]),
    weldingDate: col([/^soldagem data$/]),
    visualStatus: col([/^ensaio visual status$/]),
    visualDate: col([/^ensaio visual data$/]),
    lpStatus: col([/^liquido penetrante pm status$/]),
    lpDate: col([/^liquido penetrante pm data$/]),
    rxStatus: col([/^rx us status$/]),
    rxDate: col([/^rx us data$/]),
    dimensionalStatus: col([/^dimensional fabricacao status$/]),
    dimensionalDate: col([/^dimensional fabricacao data$/]),
    fabricationProgram: col([/^prog fab$/]),
    assemblyProgram: col([/^prog mont$/]),
    inspectionReleaseDate: col([/^data ev lp pm$/]),
    releaseDate: col([/^data liberacao$/]),
    situation: col([/^situacao$/]),
    spoolTag: col([/^spool tag$/]),
    registrationDate: col([/^data de cadastro$/]),
  };

  if (idx.spool < 0 || idx.joint < 0 || idx.placement < 0) {
    throw new Error('As colunas Spool, Junta e P/C são obrigatórias no Mapa de Juntas.');
  }

  const records = [];
  const occurrences = new Map();
  const spools = new Set();
  const modules = new Set();
  const placements = { PIPE: 0, CAMPO: 0, OUTROS: 0 };
  const stageTotals = { corte: 0, acoplamento: 0, visual_ajuste: 0, soldagem: 0, visual: 0, lp_pm: 0, rx_us: 0, dimensional: 0 };
  let ignored = 0;

  for (let rowIndex = header.leafIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const rawSpool = valueAt(row, idx.spool);
    const joint = clean(valueAt(row, idx.joint));
    if (!clean(rawSpool) || !joint) {
      if ((row || []).some(value => clean(value))) ignored += 1;
      continue;
    }

    const spoolKey = normalizeSpoolKey(rawSpool);
    const placement = upper(valueAt(row, idx.placement));
    const baseKey = `${spoolKey}|${upper(joint)}`;
    const occurrence = (occurrences.get(baseKey) || 0) + 1;
    occurrences.set(baseKey, occurrence);
    const sourceKey = occurrence === 1 ? baseKey : `${baseKey}|${occurrence}`;

    const payload = {
      spool_key: spoolKey,
      spool_tag: clean(valueAt(row, idx.spoolTag)),
      joint,
      contract: clean(valueAt(row, idx.contract)),
      manufacturer_site: clean(valueAt(row, idx.manufacturer)),
      module: upper(valueAt(row, idx.module)),
      spool_type: clean(valueAt(row, idx.spoolType)),
      sop: clean(valueAt(row, idx.sop)),
      sth: clean(valueAt(row, idx.sth)),
      document: clean(valueAt(row, idx.document)),
      line: clean(valueAt(row, idx.line)),
      joint_cut: clean(valueAt(row, idx.jointCut)),
      joint_cut_date: isoDateTime(valueAt(row, idx.jointCutDate)),
      thermal_cycle: clean(valueAt(row, idx.thermalCycle)),
      diameter_inch: clean(valueAt(row, idx.diameterInch)),
      diameter_mm: numeric(valueAt(row, idx.diameterMm)),
      thickness_mm: numeric(valueAt(row, idx.thickness)),
      joint_type: clean(valueAt(row, idx.jointType)),
      spec: clean(valueAt(row, idx.spec)),
      pipe_material: clean(valueAt(row, idx.pipeMaterial)),
      material: clean(valueAt(row, idx.material)),
      inspection_class: clean(valueAt(row, idx.inspectionClass)),
      standard: clean(valueAt(row, idx.standard)),
      placement,
      cutting_date: isoDateTime(valueAt(row, idx.cuttingDate)),
      coupling_status: clean(valueAt(row, idx.couplingStatus)),
      coupling_date: isoDateTime(valueAt(row, idx.couplingDate)),
      visual_adjust_status: clean(valueAt(row, idx.visualAdjustStatus)),
      visual_adjust_date: isoDateTime(valueAt(row, idx.visualAdjustDate)),
      welding_status: clean(valueAt(row, idx.weldingStatus)),
      welding_date: isoDateTime(valueAt(row, idx.weldingDate)),
      visual_status: clean(valueAt(row, idx.visualStatus)),
      visual_date: isoDateTime(valueAt(row, idx.visualDate)),
      lp_pm_status: clean(valueAt(row, idx.lpStatus)),
      lp_pm_date: isoDateTime(valueAt(row, idx.lpDate)),
      rx_us_status: clean(valueAt(row, idx.rxStatus)),
      rx_us_date: isoDateTime(valueAt(row, idx.rxDate)),
      dimensional_status: clean(valueAt(row, idx.dimensionalStatus)),
      dimensional_date: isoDateTime(valueAt(row, idx.dimensionalDate)),
      fabrication_program: clean(valueAt(row, idx.fabricationProgram)),
      assembly_program: clean(valueAt(row, idx.assemblyProgram)),
      inspection_release_date: isoDateTime(valueAt(row, idx.inspectionReleaseDate)),
      release_date: isoDateTime(valueAt(row, idx.releaseDate)),
      situation: clean(valueAt(row, idx.situation)),
      registration_date: isoDateTime(valueAt(row, idx.registrationDate)),
      source_data: sourcePayload(headers, row),
    };

    records.push({
      source_key: sourceKey,
      source_sheet: sheetName,
      source_row: rowIndex + 1,
      source_row_hash: stableHash(payload),
      payload,
    });

    spools.add(spoolKey);
    if (payload.module) modules.add(payload.module);
    if (placement === 'PIPE') placements.PIPE += 1;
    else if (placement === 'CAMPO') placements.CAMPO += 1;
    else placements.OUTROS += 1;
    if (payload.cutting_date) stageTotals.corte += 1;
    if (payload.coupling_date) stageTotals.acoplamento += 1;
    if (payload.visual_adjust_date) stageTotals.visual_ajuste += 1;
    if (payload.welding_date) stageTotals.soldagem += 1;
    if (payload.visual_date) stageTotals.visual += 1;
    if (payload.lp_pm_date) stageTotals.lp_pm += 1;
    if (payload.rx_us_date) stageTotals.rx_us += 1;
    if (payload.dimensional_date) stageTotals.dimensional += 1;

    if (records.length % 300 === 0) {
      postProgress(id, 'Processando apontamentos', `${records.length.toLocaleString('pt-BR')} juntas processadas`, rowIndex + 1, rows.length);
    }
  }

  if (!records.length) throw new Error('Nenhuma junta válida foi encontrada no arquivo.');

  const summary = {
    total_joints: records.length,
    total_spools: spools.size,
    total_modules: modules.size,
    placements,
    stage_totals: stageTotals,
    ignored_rows: ignored,
    source_sheet: sheetName,
  };

  return {
    type: 'joints',
    label: 'Mapa de Juntas P85',
    records: [],
    datasets: [{ type: 'p85_joint_traceability', sheet: sheetName, rows: records }],
    rowCount: records.length,
    duplicates: records.length - occurrences.size,
    summary,
    fileName,
  };
}

self.onmessage = async event => {
  const message = event.data || {};
  const id = message.id;
  const file = message.file;
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    const hash = await sha256(buffer);
    const result = parseJointTraceability(buffer, id, file.name);
    result.hash = hash;
    self.postMessage({ id, kind: 'result', result });
  } catch (error) {
    self.postMessage({ id, kind: 'error', error: error?.message || 'Falha ao processar o Mapa de Juntas P85.' });
  }
};
