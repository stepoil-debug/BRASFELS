'use strict';

const CONFIG = {
  version: '1.0.0',
  supabaseUrl: 'https://qxmxtbjxkhecqilpnhgq.supabase.co',
  supabaseKey: 'sb_publishable_TiGdrzZ6H7TCjQ8wPaAkzA_cQxVxdvr',
  projectCode: 'FPSO-P85',
  pageSize: 30,
};

const INITIAL = {
  spools: 1390,
  weight: 115497.31226,
  materials: 4290,
  materialCodes: 342,
  hold: 36,
  scheduled: 1389,
  divergences: 45,
  modules: { M02: 571, M10B: 461, M05B: 249, M02PRK: 61, M05BPRK: 48 },
  statuses: { 'FAB - Not Started': 1351, 'FAB - Spool on Hold': 36, 'FAB - Waiting Coupling': 3 },
};

const state = {
  view: 'dashboard', spools: [], materials: [], imports: [], pending: null,
  spoolPage: 1, materialPage: 1, files: [],
  supabase: { url: CONFIG.supabaseUrl, key: CONFIG.supabaseKey, email: '', token: '', user: null },
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const upper = v => clean(v).toUpperCase();
const normHeader = v => clean(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const normalizeIso = v => upper(v).replace(/\s+/g, '').replace(/^CANC-/, '');
const padSpool = v => clean(v).replace(/\.0+$/, '').replace(/\D/g, '').padStart(3, '0');
const sourceKey = (iso, spool) => `${normalizeIso(iso)}-${padSpool(spool)}`.replace(/-+$/, '');
const number = v => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  let t = clean(v).replace(/\s/g, '');
  if (!t) return 0;
  if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (t.includes(',')) t = t.replace(',', '.');
  const n = Number(t); return Number.isFinite(n) ? n : 0;
};
const bool = v => ['TRUE','YES','Y','SIM','S','1','X','HOLD'].includes(upper(v));
const fmt = (v, d = 0) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }).format(Number(v || 0));
const fmtDate = v => v ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(v)) : '—';
const escapeHtml = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[c]);
const wait = ms => new Promise(r => setTimeout(r, ms));

function toast(message, type = 'success') {
  const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = message;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 4300);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('brasfels-control-center', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('data');
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function dbGet(key) { const db = await openDb(); return new Promise((res, rej) => { const r = db.transaction('data').objectStore('data').get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
async function dbSet(key, value) { const db = await openDb(); return new Promise((res, rej) => { const tx=db.transaction('data','readwrite'); tx.objectStore('data').put(value,key); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); }); }
async function dbClear() { const db=await openDb(); return new Promise((res,rej)=>{const tx=db.transaction('data','readwrite');tx.objectStore('data').clear();tx.oncomplete=res;tx.onerror=()=>rej(tx.error);}); }
async function persist() { await dbSet('dataset', { spools: state.spools, materials: state.materials, imports: state.imports, savedAt: new Date().toISOString() }); }

function stableHash(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let h = 2166136261;
  for (let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);} return (h>>>0).toString(16).padStart(8,'0');
}
async function fileHash(file) {
  if (crypto?.subtle) { const b=await file.arrayBuffer(); const d=await crypto.subtle.digest('SHA-256',b); return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
  return stableHash(`${file.name}:${file.size}:${file.lastModified}`);
}

function excelDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0,10);
  if (typeof value === 'number' && window.XLSX?.SSF) { const d=XLSX.SSF.parse_date_code(value); if(d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`; }
  const t=clean(value); if(/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0,10);
  const m=t.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/); if(m){let y=m[3];if(y.length===2)y=`20${y}`;return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;} return t || null;
}

function findHeader(rows, requiredGroups) {
  const limit=Math.min(rows.length,35);
  for(let i=0;i<limit;i++){
    const headers=(rows[i]||[]).map(normHeader);
    const ok=requiredGroups.every(group=>group.some(term=>headers.some(h=>h.includes(term))));
    if(ok) return i;
  }
  return -1;
}
function headerMap(row) { const map={}; (row||[]).forEach((v,i)=>{const h=normHeader(v);if(h&&!map[h])map[h]=i;}); return map; }
function col(map, patterns) { const keys=Object.keys(map); for(const p of patterns){const found=keys.find(k=>p instanceof RegExp?p.test(k):k.includes(p));if(found!==undefined)return map[found];} return -1; }
const cell=(row,index)=>index>=0?(row[index]??''):'';

function detectWorkbook(file, wb) {
  const name=normHeader(file.name); const sheets=wb.SheetNames.map(normHeader);
  if(name.includes('spool materials')||sheets.some(s=>s.includes('spool materials'))) return 'spool_materials';
  if(name.includes('spool map')||sheets.some(s=>s==='spool map'||s.includes('spool map'))) return 'spool_map';
  if(name.includes('grafico')||name.includes('graficos')) return 'legacy_reference';
  if(name.includes('faturamento')) return 'billing_reference';
  return 'unknown';
}

function parseSpoolMap(wb) {
  const sheetName=wb.SheetNames.find(n=>normHeader(n).includes('spool map'))||wb.SheetNames[0];
  const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheetName],{header:1,raw:true,defval:''});
  const hr=findHeader(rows,[['spool'],['isometric','isometrico'],['weight','peso']]);
  if(hr<0) throw new Error('Cabeçalho do Spool Map não encontrado.');
  const map=headerMap(rows[hr]);
  const idx={
    iso:col(map,[/^isometric$/,/^isometrico$/, /isometric number/,/iso number/]),
    spool:col(map,[/^spool$/, /spool number/,/numero spool/]), tag:col(map,[/spool tag/]), module:col(map,[/^module$/, /^modulo$/]),
    weight:col(map,[/weight kg/,/^weight$/, /peso/]), hold:col(map,[/on hold/,/^hold$/]), document:col(map,[/^document/,/drawing/]),
    line:col(map,[/^line$/, /line number/,/linha/]), manufacturer:col(map,[/manufacturer/,/fabricante/]), priority:col(map,[/priority/,/prioridade/]),
    material:col(map,[/^material$/]), diameter:col(map,[/diameter mm/,/diametro mm/]), diameterInch:col(map,[/diameter inch/,/diametro pol/]),
    thickness:col(map,[/thickness/,/espessura/]), spec:col(map,[/specification/,/especificacao/]), fluid:col(map,[/^fluid$/,/^fluido$/]),
    length:col(map,[/length m/,/comprimento/]), area:col(map,[/area m/,/^area$/]), totalJoints:col(map,[/total joints/,/total de juntas/]),
    shopJoints:col(map,[/shop joints/,/juntas shop/]), fieldJoints:col(map,[/field joints/,/juntas field/]),
    scheduleNo:col(map,[/manufacture schedule number/,/fabrication schedule number/,/programacao.*fabricacao/,/schedule number/]),
    scheduleDate:col(map,[/manufacture schedule date/,/fabrication schedule date/,/data.*programacao/]), status:col(map,[/manufacture status/,/fabrication status/,/status.*fabricacao/]),
    cutting:col(map,[/cutting date/,/data.*corte/]), fitting:col(map,[/fitting date/]), fitup:col(map,[/fit.?up date/]), welding:col(map,[/welding date/,/data.*solda/]),
    visual:col(map,[/visual inspection date/]), dimensional:col(map,[/dimensional date/]), release:col(map,[/manufacture release date/,/release date/]),
    packing:col(map,[/packing list/]), origin:col(map,[/origin location/]), sent:col(map,[/^sent at$/, /shipping date/]), destination:col(map,[/^destination$/]),
    received:col(map,[/^received$/, /received status/]), receivedAt:col(map,[/received at/,/received date/]), assemblyStatus:col(map,[/assembly status/]),
  };
  if(idx.iso<0||idx.spool<0) throw new Error('Colunas Isometric e Spool são obrigatórias.');
  const out=[];
  for(let r=hr+1;r<rows.length;r++){
    const row=rows[r], iso=cell(row,idx.iso), spool=cell(row,idx.spool); if(!clean(iso)||!clean(spool)) continue;
    const key=sourceKey(iso,spool); if(!key||key==='-000') continue;
    const record={source_key:key,isometric:normalizeIso(iso),spool_number:padSpool(spool),spool_tag:clean(cell(row,idx.tag))||key,module:upper(cell(row,idx.module)),document:clean(cell(row,idx.document)),line:clean(cell(row,idx.line)),manufacturer:clean(cell(row,idx.manufacturer)),priority:clean(cell(row,idx.priority)),weight_kg:number(cell(row,idx.weight)),on_hold:bool(cell(row,idx.hold))||upper(cell(row,idx.status)).includes('HOLD'),material:clean(cell(row,idx.material)),diameter_mm:number(cell(row,idx.diameter)),diameter_inch:clean(cell(row,idx.diameterInch)),thickness_mm:number(cell(row,idx.thickness)),specification:clean(cell(row,idx.spec)),fluid:clean(cell(row,idx.fluid)),length_m:number(cell(row,idx.length)),area_m2:number(cell(row,idx.area)),total_joints:number(cell(row,idx.totalJoints)),shop_joints:number(cell(row,idx.shopJoints)),field_joints:number(cell(row,idx.fieldJoints)),manufacture_schedule_number:clean(cell(row,idx.scheduleNo)),manufacture_schedule_date:excelDate(cell(row,idx.scheduleDate)),manufacture_status:clean(cell(row,idx.status))||'FAB - Not Started',cutting_date:excelDate(cell(row,idx.cutting)),fitting_date:excelDate(cell(row,idx.fitting)),fitup_date:excelDate(cell(row,idx.fitup)),welding_date:excelDate(cell(row,idx.welding)),visual_inspection_date:excelDate(cell(row,idx.visual)),dimensional_date:excelDate(cell(row,idx.dimensional)),manufacture_release_date:excelDate(cell(row,idx.release)),packing_list:clean(cell(row,idx.packing)),origin_location:clean(cell(row,idx.origin)),sent_at:excelDate(cell(row,idx.sent)),destination:clean(cell(row,idx.destination)),received:bool(cell(row,idx.received)),received_at:excelDate(cell(row,idx.receivedAt)),assembly_status:clean(cell(row,idx.assemblyStatus)),source_row:r+1,manual_data:{}};
    record.source_row_hash=stableHash(record); out.push(record);
  }
  const unique=new Map(); out.forEach(x=>unique.set(x.source_key,x));
  return {sheetName,records:[...unique.values()],duplicates:out.length-unique.size};
}

function parseMaterials(wb) {
  let selected=null, rows=null, hr=-1;
  for(const name of wb.SheetNames){const candidate=XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,raw:true,defval:''});const h=findHeader(candidate,[['material code','codigo material'],['spool'],['isometric','isometrico']]);if(h>=0){selected=name;rows=candidate;hr=h;break;}}
  if(hr<0) throw new Error('Cabeçalho da base de materiais não encontrado.');
  const map=headerMap(rows[hr]);
  const idx={iso:col(map,[/^isometric$/, /^isometrico$/, /isometric number/]),spool:col(map,[/^spool$/, /spool number/,/numero spool/]),code:col(map,[/material code/,/codigo material/,/^code$/]),description:col(map,[/description/,/descricao/]),quantity:col(map,[/quantity/,/quantidade/,/^qty$/]),weight:col(map,[/weight kg/,/^weight$/, /peso/]),application:col(map,[/application/,/aplicacao/]),manufacturer:col(map,[/manufacturer site/,/fabricante/]),assembly:col(map,[/assembly site/,/montagem/]),revision:col(map,[/material revision/,/revisao/]),diameter1:col(map,[/diameter 1/,/diametro 1/]),diameter2:col(map,[/diameter 2/,/diametro 2/]),notes:col(map,[/notes/,/observacao/]),module:col(map,[/^module$/, /^modulo$/])};
  if(idx.iso<0||idx.spool<0||idx.code<0) throw new Error('Colunas Isometric, Spool e Material Code são obrigatórias.');
  const occurrences=new Map(),out=[];
  for(let r=hr+1;r<rows.length;r++){
    const row=rows[r],iso=cell(row,idx.iso),spool=cell(row,idx.spool),code=cell(row,idx.code); if(!clean(iso)||!clean(spool)||!clean(code))continue;
    const spoolKey=sourceKey(iso,spool),base=`${spoolKey}|${upper(code)}|${upper(cell(row,idx.application))}`; const occ=(occurrences.get(base)||0)+1;occurrences.set(base,occ);
    const record={source_key:`${base}|${occ}`,spool_source_key:spoolKey,isometric:normalizeIso(iso),spool_number:padSpool(spool),module:upper(cell(row,idx.module)),material_code:clean(code),description:clean(cell(row,idx.description)),quantity:number(cell(row,idx.quantity)),weight_kg:number(cell(row,idx.weight)),application:clean(cell(row,idx.application)),manufacturer_site:clean(cell(row,idx.manufacturer)),assembly_site:clean(cell(row,idx.assembly)),material_revision:clean(cell(row,idx.revision)),diameter_1:clean(cell(row,idx.diameter1)),diameter_2:clean(cell(row,idx.diameter2)),notes:clean(cell(row,idx.notes)),source_row:r+1};
    record.source_row_hash=stableHash(record);out.push(record);
  }
  return {sheetName:selected,records:out,duplicates:0};
}

async function analyzeFile(file) {
  const hash=await fileHash(file); const wb=XLSX.read(await file.arrayBuffer(),{type:'array',cellDates:true}); const type=detectWorkbook(file,wb);
  if(type==='spool_map'){const parsed=parseSpoolMap(wb);return {file,hash,type,label:'Spool Map P85',...parsed,mode:'operational'};}
  if(type==='spool_materials'){const parsed=parseMaterials(wb);return {file,hash,type,label:'Spool Materials P85',...parsed,mode:'operational'};}
  if(type==='legacy_reference')return {file,hash,type,label:'Gráficos Brasfels P83',records:[],sheetName:wb.SheetNames[0],mode:'reference',sheets:wb.SheetNames.length};
  if(type==='billing_reference')return {file,hash,type,label:'Faturamento P83',records:[],sheetName:wb.SheetNames[0],mode:'reference',sheets:wb.SheetNames.length};
  throw new Error('Modelo de arquivo não reconhecido.');
}

function mergeByKey(current,incoming,key='source_key'){
  const map=new Map(current.map(x=>[x[key],x]));let inserted=0,updated=0,unchanged=0;
  incoming.forEach(item=>{const old=map.get(item[key]);if(!old){map.set(item[key],item);inserted++;return;}const preserved=old.manual_data||{};const before=old.source_row_hash||stableHash(old);if(before===item.source_row_hash){unchanged++;return;}map.set(item[key],{...old,...item,manual_data:preserved});updated++;});
  return {records:[...map.values()],inserted,updated,unchanged};
}

function recalculate() {
  const aggregate=new Map();
  state.materials.forEach(m=>{const a=aggregate.get(m.spool_source_key)||{rows:0,codes:new Set(),weight:0};a.rows++;a.codes.add(m.material_code);a.weight+=Number(m.weight_kg||0);aggregate.set(m.spool_source_key,a);});
  state.spools.forEach(s=>{const a=aggregate.get(s.source_key)||{rows:0,codes:new Set(),weight:0};s.material_rows=a.rows;s.material_codes=a.codes.size;s.material_weight_kg=a.weight;s.weight_difference_kg=Number(s.weight_kg||0)-a.weight;s.weight_difference_pct=s.weight_kg?Math.abs(s.weight_difference_kg)/s.weight_kg*100:0;});
}

function currentSummary(){
  if(!state.spools.length)return {...INITIAL};
  recalculate();return {spools:state.spools.length,weight:state.spools.reduce((a,b)=>a+Number(b.weight_kg||0),0),materials:state.materials.length,materialCodes:new Set(state.materials.map(x=>x.material_code)).size,hold:state.spools.filter(x=>x.on_hold).length,scheduled:state.spools.filter(x=>x.manufacture_schedule_number||x.manufacture_schedule_date).length,divergences:state.spools.filter(x=>x.weight_difference_pct>1).length,modules:Object.fromEntries([...new Set(state.spools.map(x=>x.module||'SEM MÓDULO'))].map(m=>[m,state.spools.filter(x=>(x.module||'SEM MÓDULO')===m).length])),statuses:Object.fromEntries([...new Set(state.spools.map(x=>x.manufacture_status||'Sem status'))].map(s=>[s,state.spools.filter(x=>(x.manufacture_status||'Sem status')===s).length]))};
}

function renderDashboard(){
  const s=currentSummary();$('#kpiSpools').textContent=fmt(s.spools);$('#kpiWeight').textContent=`${fmt(s.weight,1)} kg`;$('#kpiMaterials').textContent=fmt(s.materials);$('#kpiHold').textContent=fmt(s.hold);$('#kpiScheduled').textContent=fmt(s.scheduled);$('#kpiDivergences').textContent=fmt(s.divergences);$('#navSpoolCount').textContent=fmt(s.spools);$('#navMaterialCount').textContent=fmt(s.materials);$('#navDivergenceCount').textContent=fmt(s.divergences);$('#divergenceTotal').textContent=fmt(s.divergences);
  const max=Math.max(...Object.values(s.modules),1);$('#moduleBars').innerHTML=Object.entries(s.modules).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<div class="bar-row"><label>${escapeHtml(k)}</label><div class="bar-track"><div class="bar-fill" style="width:${v/max*100}%"></div></div><strong>${fmt(v)}</strong></div>`).join('');
  const total=Object.values(s.statuses).reduce((a,b)=>a+b,0)||1;const primary=Object.entries(s.statuses).sort((a,b)=>b[1]-a[1])[0]||['',0];$('#statusDonut').style.setProperty('--value',primary[1]/total*100);$('#statusDonut span').textContent=`${fmt(primary[1]/total*100,1)}%`;
  const colors=['#1a91be','#e6a12b','#d64d55','#15966a','#7b6bd6'];$('#statusLegend').innerHTML=Object.entries(s.statuses).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v],i)=>`<div class="legend-item"><span class="legend-dot" style="background:${colors[i]}"></span><span title="${escapeHtml(k)}">${escapeHtml(k.replace('FAB - ','').slice(0,24))}</span><strong>${fmt(v)}</strong></div>`).join('');
}

function badge(text){const u=upper(text);const c=u.includes('HOLD')?'red':u.includes('WAIT')?'amber':u.includes('COMPLET')||u.includes('RELEASE')?'green':'gray';return `<span class="tag ${c}">${escapeHtml(text||'—')}</span>`;}
function filteredSpools(){const q=upper($('#spoolSearch').value),m=$('#moduleFilter').value,st=$('#statusFilter').value,hold=$('#holdFilter').checked;return state.spools.filter(x=>(!q||upper(`${x.spool_tag} ${x.isometric} ${x.document} ${x.line}`).includes(q))&&(!m||x.module===m)&&(!st||x.manufacture_status===st)&&(!hold||x.on_hold));}
function renderSpools(){
  const rows=filteredSpools(),pages=Math.max(1,Math.ceil(rows.length/CONFIG.pageSize));state.spoolPage=Math.min(state.spoolPage,pages);const page=rows.slice((state.spoolPage-1)*CONFIG.pageSize,state.spoolPage*CONFIG.pageSize);$('#spoolResultCount').textContent=`${fmt(rows.length)} registros`;$('#spoolPageLabel').textContent=`Página ${state.spoolPage} de ${pages}`;$('#spoolPrev').disabled=state.spoolPage<=1;$('#spoolNext').disabled=state.spoolPage>=pages;
  $('#spoolTableBody').innerHTML=page.map(x=>`<tr data-key="${escapeHtml(x.source_key)}"><td><strong>${escapeHtml(x.spool_tag||x.source_key)}</strong></td><td>${escapeHtml(x.module||'—')}</td><td>${escapeHtml(x.isometric)}</td><td>${fmt(x.weight_kg,2)} kg</td><td>${escapeHtml(x.manufacture_schedule_number||x.manufacture_schedule_date||'—')}</td><td>${badge(x.manufacture_status)}</td><td>${x.on_hold?'<span class="tag red">HOLD</span>':'—'}</td><td>${fmt(x.material_rows||0)}</td></tr>`).join('');
  $('#spoolEmpty').hidden=state.spools.length>0;$('.table-panel', $('#view-spools')).hidden=!state.spools.length;
  $$('#spoolTableBody tr').forEach(tr=>tr.onclick=()=>openDrawer(tr.dataset.key));
}
function filteredMaterials(){const q=upper($('#materialSearch').value),app=$('#applicationFilter').value;return state.materials.filter(x=>(!q||upper(`${x.spool_source_key} ${x.material_code} ${x.description}`).includes(q))&&(!app||upper(x.application)===upper(app)));}
function renderMaterials(){const rows=filteredMaterials(),pages=Math.max(1,Math.ceil(rows.length/CONFIG.pageSize));state.materialPage=Math.min(state.materialPage,pages);const page=rows.slice((state.materialPage-1)*CONFIG.pageSize,state.materialPage*CONFIG.pageSize);$('#materialResultCount').textContent=`${fmt(rows.length)} registros`;$('#materialPageLabel').textContent=`Página ${state.materialPage} de ${pages}`;$('#materialPrev').disabled=state.materialPage<=1;$('#materialNext').disabled=state.materialPage>=pages;$('#materialTableBody').innerHTML=page.map(x=>`<tr><td><strong>${escapeHtml(x.spool_source_key)}</strong></td><td>${escapeHtml(x.material_code)}</td><td title="${escapeHtml(x.description)}">${escapeHtml((x.description||'—').slice(0,60))}</td><td>${badge(x.application)}</td><td>${fmt(x.quantity,3)}</td><td>${fmt(x.weight_kg,3)} kg</td><td>${escapeHtml(x.manufacturer_site||'—')}</td></tr>`).join('');$('#materialEmpty').hidden=state.materials.length>0;$('.table-panel',$('#view-materials')).hidden=!state.materials.length;}
function renderDivergences(){const rows=state.spools.filter(x=>x.weight_difference_pct>1).sort((a,b)=>b.weight_difference_pct-a.weight_difference_pct);$('#divergenceTableBody').innerHTML=rows.map(x=>`<tr data-key="${escapeHtml(x.source_key)}"><td><strong>${escapeHtml(x.spool_tag||x.source_key)}</strong></td><td>${escapeHtml(x.module||'—')}</td><td>${fmt(x.weight_kg,3)} kg</td><td>${fmt(x.material_weight_kg,3)} kg</td><td>${fmt(x.weight_difference_kg,3)} kg</td><td><strong>${fmt(x.weight_difference_pct,2)}%</strong></td><td>${badge(x.weight_difference_pct>10?'Crítica':x.weight_difference_pct>5?'Alta':'Revisar')}</td></tr>`).join('');$('#divergenceEmpty').hidden=rows.length>0;$('.table-panel',$('#view-divergences')).hidden=!rows.length;$$('#divergenceTableBody tr').forEach(tr=>tr.onclick=()=>openDrawer(tr.dataset.key));}
function renderImports(){const base=state.imports.length?state.imports:[{date:'2026-07-31T17:10:00',file:'P85 Spool Map + Spool Materials',type:'Análise inicial',status:'validated',rows:5680,inserted:1390,updated:0,warnings:45}];$('#importTableBody').innerHTML=base.slice().reverse().map(x=>`<tr><td>${fmtDate(x.date)}</td><td><strong>${escapeHtml(x.file)}</strong></td><td>${escapeHtml(x.type)}</td><td>${badge(x.status==='completed'?'Concluído':x.status==='reference_only'?'Referência':'Validado')}</td><td>${fmt(x.rows)}</td><td>${fmt(x.inserted)}</td><td>${fmt(x.updated)}</td><td>${fmt(x.warnings)}</td></tr>`).join('');}
function populateFilters(){const currentM=$('#moduleFilter').value,currentS=$('#statusFilter').value;$('#moduleFilter').innerHTML='<option value="">Todos os módulos</option>'+[...new Set(state.spools.map(x=>x.module).filter(Boolean))].sort().map(x=>`<option>${escapeHtml(x)}</option>`).join('');$('#statusFilter').innerHTML='<option value="">Todos os status</option>'+[...new Set(state.spools.map(x=>x.manufacture_status).filter(Boolean))].sort().map(x=>`<option>${escapeHtml(x)}</option>`).join('');$('#moduleFilter').value=currentM;$('#statusFilter').value=currentS;}
function renderAll(){recalculate();renderDashboard();populateFilters();renderSpools();renderMaterials();renderDivergences();renderImports();}

function openDrawer(key){const s=state.spools.find(x=>x.source_key===key);if(!s)return;const mats=state.materials.filter(x=>x.spool_source_key===key);const stages=[['Programação',s.manufacture_schedule_date||s.manufacture_schedule_number],['Corte',s.cutting_date],['Fitting',s.fitting_date],['Fit-up',s.fitup_date],['Soldagem',s.welding_date],['Inspeção visual',s.visual_inspection_date],['Dimensional',s.dimensional_date],['Liberação',s.manufacture_release_date]];$('#drawerContent').innerHTML=`<p class="eyebrow">DETALHE DO SPOOL</p><h2>${escapeHtml(s.spool_tag||s.source_key)}</h2><p>${badge(s.manufacture_status)} ${s.on_hold?'<span class="tag red">HOLD</span>':''}</p><div class="detail-grid">${[['Módulo',s.module],['Isométrico',s.isometric],['Spool',s.spool_number],['Peso',`${fmt(s.weight_kg,3)} kg`],['Documento',s.document],['Linha',s.line],['Materiais',mats.length],['Peso materiais',`${fmt(s.material_weight_kg,3)} kg`]].map(([a,b])=>`<div class="detail-item"><span>${a}</span><strong>${escapeHtml(b||'—')}</strong></div>`).join('')}</div><div class="detail-section"><p class="eyebrow">AVANÇO</p><div class="timeline">${stages.map(([a,b])=>`<div class="timeline-row"><span class="timeline-dot ${b?'done':''}"></span><strong>${a}</strong><span>${escapeHtml(b||'Pendente')}</span></div>`).join('')}</div></div><div class="detail-section"><p class="eyebrow">MATERIAIS VINCULADOS</p>${mats.slice(0,30).map(m=>`<div class="timeline-row"><span class="timeline-dot done"></span><strong>${escapeHtml(m.material_code)}</strong><span>${fmt(m.weight_kg,3)} kg</span></div>`).join('')||'<p>Nenhum material carregado.</p>'}</div>`;$('#spoolDrawer').classList.add('open');$('#spoolDrawer').setAttribute('aria-hidden','false');}

function showView(view){state.view=view;$$('.view').forEach(x=>x.classList.toggle('active',x.id===`view-${view}`));$$('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===view));const names={dashboard:'Visão executiva',spools:'Controle de spools',materials:'Materiais',divergences:'Divergências',imports:'Importações',settings:'Configuração'};$('#pageTitle').textContent=names[view];$('#sidebar').classList.remove('open');if(view==='spools')renderSpools();if(view==='materials')renderMaterials();if(view==='divergences')renderDivergences();}

function openImport(){state.files=[];state.pending=null;$('#fileInput').value='';$('#selectedFiles').innerHTML='';$('#validationSummary').hidden=true;$('#applyImport').hidden=true;$('#validateImport').hidden=false;$('#validateImport').disabled=true;$('#modalProgress').hidden=true;$('#importModal').hidden=false;}
function closeImport(){if(!$('#modalProgress').hidden)return;$('#importModal').hidden=true;}
function setFiles(files){state.files=[...files].filter(f=>/\.xlsx?$/i.test(f.name));$('#selectedFiles').innerHTML=state.files.map((f,i)=>`<div class="file-row"><span>X</span><div><strong>${escapeHtml(f.name)}</strong><small>${fmt(f.size/1024,1)} KB</small></div><button data-remove="${i}">×</button></div>`).join('');$('#validateImport').disabled=!state.files.length;$$('[data-remove]').forEach(b=>b.onclick=()=>{state.files.splice(Number(b.dataset.remove),1);setFiles(state.files);});}

async function validateImport(){
  if(!window.XLSX){toast('Biblioteca de leitura Excel ainda não carregou.','error');return;}
  $('#modalProgress').hidden=false;$('#progressTitle').textContent='Validando arquivos';$('#validateImport').disabled=true;const analyses=[];let errors=[];
  for(let i=0;i<state.files.length;i++){const f=state.files[i];$('#progressDetail').textContent=`${i+1}/${state.files.length} · ${f.name}`;try{const a=await analyzeFile(f);if(state.imports.some(x=>x.hash===a.hash))a.duplicateFile=true;analyses.push(a);}catch(e){errors.push(`${f.name}: ${e.message}`);}await wait(50);}
  state.pending={analyses,errors};const total=analyses.reduce((a,b)=>a+b.records.length,0),operational=analyses.filter(x=>x.mode==='operational').length,references=analyses.filter(x=>x.mode==='reference').length,duplicates=analyses.filter(x=>x.duplicateFile).length;
  $('#validationSummary').hidden=false;$('#validationSummary').innerHTML=`<div class="validation-grid"><div><span>Arquivos válidos</span><strong>${analyses.length}</strong></div><div><span>Linhas identificadas</span><strong>${fmt(total)}</strong></div><div><span>Operacionais</span><strong>${operational}</strong></div><div><span>Referências</span><strong>${references}</strong></div></div>${duplicates?`<p class="warn">${duplicates} arquivo(s) já importado(s) serão ignorados.</p>`:''}${errors.length?`<p class="warn">${errors.map(escapeHtml).join('<br>')}</p>`:''}<div class="selected-files">${analyses.map(a=>`<div class="file-row"><span>✓</span><div><strong>${escapeHtml(a.label)}</strong><small>${escapeHtml(a.file.name)} · ${fmt(a.records.length)} linhas${a.mode==='reference'?` · ${a.sheets} abas`:''}</small></div>${a.duplicateFile?'<span class="tag amber">Duplicado</span>':'<span class="tag green">Pronto</span>'}</div>`).join('')}</div>`;
  $('#modalProgress').hidden=true;$('#validateImport').hidden=true;$('#applyImport').hidden=false;$('#applyImport').disabled=!analyses.some(x=>!x.duplicateFile);}

async function applyImport(){
  if(!state.pending)return;$('#modalProgress').hidden=false;$('#progressTitle').textContent='Aplicando atualização';$('#applyImport').disabled=true;let totalInserted=0,totalUpdated=0;
  for(const a of state.pending.analyses){if(a.duplicateFile)continue;let result={inserted:0,updated:0,unchanged:0};if(a.type==='spool_map'){result=mergeByKey(state.spools,a.records);state.spools=result.records;}else if(a.type==='spool_materials'){result=mergeByKey(state.materials,a.records);state.materials=result.records;}
    const reference=a.mode==='reference';state.imports.push({date:new Date().toISOString(),file:a.file.name,hash:a.hash,type:a.label,status:reference?'reference_only':'completed',rows:a.records.length,inserted:result.inserted,updated:result.updated,warnings:a.duplicates||0});totalInserted+=result.inserted;totalUpdated+=result.updated;$('#progressDetail').textContent=a.file.name;await wait(80);
  }
  recalculate();await persist();renderAll();$('#lastUpdate').textContent=new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date());$('#modalProgress').hidden=true;$('#importModal').hidden=true;toast(`Atualização concluída: ${fmt(totalInserted)} novos e ${fmt(totalUpdated)} atualizados.`);showView('dashboard');}

function csvExport(rows,file){if(!rows.length){toast('Não há dados para exportar.','error');return;}const keys=Object.keys(rows[0]).filter(k=>typeof rows[0][k]!=='object');const quote=v=>`"${String(v??'').replace(/"/g,'""')}"`;const csv='\ufeff'+[keys.map(quote).join(';'),...rows.map(r=>keys.map(k=>quote(r[k])).join(';'))].join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download=file;a.click();URL.revokeObjectURL(a.href);}

function saveConfig(){state.supabase.url=clean($('#supabaseUrl').value).replace(/\/$/,'');state.supabase.key=clean($('#supabaseKey').value);state.supabase.email=clean($('#supabaseEmail').value);localStorage.setItem('brasfels-supabase',JSON.stringify({url:state.supabase.url,key:state.supabase.key,email:state.supabase.email}));}
async function loginSupabase(){try{saveConfig();const password=$('#supabasePassword').value;if(!state.supabase.email||!password)throw new Error('Informe e-mail e senha.');const r=await fetch(`${state.supabase.url}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:state.supabase.key,'Content-Type':'application/json'},body:JSON.stringify({email:state.supabase.email,password})});const data=await r.json();if(!r.ok)throw new Error(data.error_description||data.msg||'Falha no login.');state.supabase.token=data.access_token;state.supabase.user=data.user;sessionStorage.setItem('brasfels-token',data.access_token);$('#connectionState').classList.add('connected');$('#connectionState strong').textContent=`Conectado: ${data.user.email}`;toast('Conexão com o Supabase estabelecida.');}catch(e){toast(e.message,'error');}}
async function api(path,{method='GET',body,profile=true}={}){const headers={apikey:state.supabase.key,Authorization:`Bearer ${state.supabase.token||state.supabase.key}`,'Content-Type':'application/json'};if(profile){headers['Accept-Profile']='brasfels';headers['Content-Profile']='brasfels';}if(method!=='GET')headers.Prefer='return=representation,resolution=merge-duplicates';const r=await fetch(`${state.supabase.url}${path}`,{method,headers,body:body?JSON.stringify(body):undefined});if(!r.ok){let e={};try{e=await r.json();}catch{}throw new Error(e.message||e.msg||`Erro ${r.status} na API.`);}return r.status===204?[]:r.json();}
async function syncSupabase(){try{if(!state.supabase.token)throw new Error('Conecte-se ao Supabase primeiro.');if(!state.spools.length)throw new Error('Importe o Spool Map antes da sincronização.');$('#syncSupabase').disabled=true;$('#syncSupabase').textContent='Sincronizando...';const projects=await api(`/rest/v1/projects?code=eq.${CONFIG.projectCode}&select=id`);if(!projects.length)throw new Error('Projeto FPSO-P85 não encontrado no schema brasfels.');const projectId=projects[0].id;const batchBody={project_id:projectId,source_type:'spool_map',file_name:'Sincronização do painel',file_hash:`panel-${Date.now()}`,status:'completed',total_rows:state.spools.length,inserted_rows:state.spools.length,validation_summary:{origin:'github-pages'}};await api('/rest/v1/import_batches',{method:'POST',body:batchBody});
    const chunks=[];for(let i=0;i<state.spools.length;i+=200)chunks.push(state.spools.slice(i,i+200));for(let i=0;i<chunks.length;i++){const payload=chunks[i].map(x=>({project_id:projectId,source_key:x.source_key,isometric:x.isometric,spool_number:x.spool_number,spool_tag:x.spool_tag,module:x.module,document:x.document,line:x.line,manufacturer:x.manufacturer,priority:x.priority,weight_kg:x.weight_kg,on_hold:x.on_hold,material:x.material,diameter_mm:x.diameter_mm,diameter_inch:x.diameter_inch,thickness_mm:x.thickness_mm,specification:x.specification,fluid:x.fluid,length_m:x.length_m,area_m2:x.area_m2,total_joints:x.total_joints,shop_joints:x.shop_joints,field_joints:x.field_joints,manufacture_schedule_number:x.manufacture_schedule_number,manufacture_schedule_date:x.manufacture_schedule_date,manufacture_status:x.manufacture_status,assembly_status:x.assembly_status,source_row_hash:x.source_row_hash,source_data:x}));await api('/rest/v1/spools?on_conflict=project_id,source_key',{method:'POST',body:payload});$('#syncSupabase').textContent=`Spools ${Math.min((i+1)*200,state.spools.length)}/${state.spools.length}`;}
    const remote=await api(`/rest/v1/spools?project_id=eq.${projectId}&select=id,source_key&limit=50000`);const ids=new Map(remote.map(x=>[x.source_key,x.id]));const mats=state.materials.filter(x=>ids.has(x.spool_source_key));for(let i=0;i<mats.length;i+=200){const payload=mats.slice(i,i+200).map(x=>({project_id:projectId,spool_id:ids.get(x.spool_source_key),source_key:x.source_key,module:x.module,manufacturer_site:x.manufacturer_site,assembly_site:x.assembly_site,material_revision:x.material_revision,material_code:x.material_code,description:x.description,diameter_1:x.diameter_1,diameter_2:x.diameter_2,application:x.application,quantity:x.quantity,weight_kg:x.weight_kg,notes:x.notes,source_row_hash:x.source_row_hash,source_data:x}));await api('/rest/v1/spool_materials?on_conflict=project_id,source_key',{method:'POST',body:payload});$('#syncSupabase').textContent=`Materiais ${Math.min(i+200,mats.length)}/${mats.length}`;}
    toast('Dados sincronizados com o schema brasfels.');
  }catch(e){toast(e.message,'error');}finally{$('#syncSupabase').disabled=false;$('#syncSupabase').textContent='Sincronizar dados';}}

function bind(){
  $$('.nav-item').forEach(b=>b.onclick=()=>showView(b.dataset.view));$$('[data-go]').forEach(b=>b.onclick=()=>showView(b.dataset.go));$('.menu-button').onclick=()=>$('#sidebar').classList.toggle('open');
  $('#openImport').onclick=openImport;$$('.import-shortcut').forEach(b=>b.onclick=openImport);$('#closeImport').onclick=closeImport;$('#cancelImport').onclick=closeImport;$('#fileInput').onchange=e=>setFiles(e.target.files);$('#validateImport').onclick=validateImport;$('#applyImport').onclick=applyImport;
  const dz=$('#dropzone');['dragenter','dragover'].forEach(e=>dz.addEventListener(e,x=>{x.preventDefault();dz.classList.add('dragover');}));['dragleave','drop'].forEach(e=>dz.addEventListener(e,x=>{x.preventDefault();dz.classList.remove('dragover');}));dz.addEventListener('drop',e=>setFiles(e.dataTransfer.files));
  ['spoolSearch','moduleFilter','statusFilter','holdFilter'].forEach(id=>$('#'+id).addEventListener('input',()=>{state.spoolPage=1;renderSpools();}));['materialSearch','applicationFilter'].forEach(id=>$('#'+id).addEventListener('input',()=>{state.materialPage=1;renderMaterials();}));
  $('#spoolPrev').onclick=()=>{state.spoolPage--;renderSpools();};$('#spoolNext').onclick=()=>{state.spoolPage++;renderSpools();};$('#materialPrev').onclick=()=>{state.materialPage--;renderMaterials();};$('#materialNext').onclick=()=>{state.materialPage++;renderMaterials();};
  $('#exportSpools').onclick=()=>csvExport(filteredSpools(),'brasfels-spools.csv');$('#exportMaterials').onclick=()=>csvExport(filteredMaterials(),'brasfels-materiais.csv');$('#closeDrawer').onclick=()=>$('#spoolDrawer').classList.remove('open');
  $('#loginSupabase').onclick=loginSupabase;$('#syncSupabase').onclick=syncSupabase;$('#resetLocal').onclick=async()=>{if(confirm('Deseja remover os dados importados deste navegador?')){await dbClear();state.spools=[];state.materials=[];state.imports=[];renderAll();toast('Base local limpa.');}};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!$('#importModal').hidden)closeImport();$('#spoolDrawer').classList.remove('open');}});
}

async function init(){
  try{const saved=await dbGet('dataset');if(saved){state.spools=saved.spools||[];state.materials=saved.materials||[];state.imports=saved.imports||[];if(saved.savedAt)$('#lastUpdate').textContent=fmtDate(saved.savedAt);}}catch(e){console.warn(e);}
  try{const cfg=JSON.parse(localStorage.getItem('brasfels-supabase')||'{}');state.supabase={...state.supabase,...cfg,token:sessionStorage.getItem('brasfels-token')||''};}catch{}
  $('#supabaseUrl').value=state.supabase.url;$('#supabaseKey').value=state.supabase.key;$('#supabaseEmail').value=state.supabase.email;
  bind();renderAll();
}

document.addEventListener('DOMContentLoaded',init);
