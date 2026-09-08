'use strict';

(function installBrasfelsCqPendencias(){
  const VIEW_ID='view-cq-pendencias';
  const JOINT_DATASET='p85_joint_traceability';
  const SLA_DATASET='p85_cq_stage_sla';
  const PAGE_SIZE=1000;
  const TABLE_PAGE_SIZE=50;
  const STAGES=[
    {id:'corte',label:'Corte',key:'cutting_date'},
    {id:'acoplamento',label:'Acoplamento / Fit-up',key:'coupling_date'},
    {id:'visual_ajuste',label:'Visual ajuste',key:'visual_adjust_date'},
    {id:'soldagem',label:'Soldagem',key:'welding_date'},
    {id:'ensaio_visual',label:'Ensaio visual',key:'visual_date'},
    {id:'lp_pm',label:'LP/PM',key:'lp_pm_date'},
    {id:'rastreabilidade',label:'Rastreabilidade',special:true},
    {id:'rx_us',label:'RX/US',key:'rx_us_date'},
    {id:'dimensional',label:'Dimensional fabricação',key:'dimensional_date'},
  ];
  const DEFAULT_SLA={corte:null,acoplamento:3,visual_ajuste:null,soldagem:null,ensaio_visual:null,lp_pm:null,rastreabilidade:null,rx_us:null,dimensional:null};
  let installed=false;
  let projectId='';
  let joints=[];
  let sourceMeta={file:'',updatedAt:''};
  let sla={...DEFAULT_SLA};
  let lastToken='';
  let loading=false;
  let page=1;
  let filters={search:'',module:'',placement:'',stage:'',status:''};
  let searchTimer=null;

  const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
  const upper=value=>clean(value).toUpperCase();
  const normalize=value=>upper(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Z0-9]+/g,' ').trim();
  const encode=value=>encodeURIComponent(String(value??''));
  const escape=value=>typeof escapeHtml==='function'?escapeHtml(value):String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=value=>new Intl.NumberFormat('pt-BR').format(Number(value||0));
  const fmt1=value=>new Intl.NumberFormat('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1}).format(Number(value||0));

  function parseDate(value){
    if(!value)return null;
    if(value instanceof Date&&!Number.isNaN(value.getTime()))return value;
    const text=String(value);
    const date=/^\d{4}-\d{2}-\d{2}$/.test(text)?new Date(`${text}T12:00:00Z`):new Date(text);
    return Number.isNaN(date.getTime())?null:date;
  }
  function formatDate(value){const d=parseDate(value);return d?new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'}).format(d):'—';}
  function ageDays(value){const d=parseDate(value);if(!d)return null;const now=new Date();const today=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());const base=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());return Math.max(0,Math.floor((today-base)/86400000));}
  function normalizeSpoolKey(value){return upper(value).replace(/\s+/g,'').replace(/_/g,'-').replace(/^CANC-?/,'').replace(/-+/g,'-').replace(/-+$/,'');}
  function uniqueRows(rows){const seen=new Set();return rows.filter(row=>{const key=`${normalizeSpoolKey(row.spool_key)}|${upper(row.joint)}`;if(!key||seen.has(key))return false;seen.add(key);return true;});}
  function canWrite(){return state?.supabase?.role==='operator'||state?.supabase?.role==='admin';}

  function headers(write=false){const result={apikey:state.supabase.key,Authorization:`Bearer ${state.supabase.token}`,'Accept-Profile':'brasfels','Content-Type':'application/json'};if(write){result['Content-Profile']='brasfels';result.Prefer='resolution=merge-duplicates,return=minimal';}return result;}
  async function rest(path,options={}){
    const method=options.method||'GET';
    const response=await fetch(`${state.supabase.url}${path}`,{method,headers:headers(method!=='GET'),body:options.body===undefined?undefined:JSON.stringify(options.body)});
    if(!response.ok){const payload=await response.json().catch(()=>({}));throw new Error(payload.message||payload.msg||payload.error||`Erro ${response.status} ao carregar pendências CQ.`);}
    if(response.status===204||method!=='GET')return[];
    return response.json();
  }
  async function fetchAll(path){const rows=[];for(let offset=0;;offset+=PAGE_SIZE){const separator=path.includes('?')?'&':'?';const result=await rest(`${path}${separator}limit=${PAGE_SIZE}&offset=${offset}`);rows.push(...result);if(result.length<PAGE_SIZE)return rows;}}
  async function getProjectId(){if(projectId)return projectId;const rows=await rest(`/rest/v1/projects?code=eq.${encode(CONFIG.projectCode)}&select=id&limit=1`);if(!rows.length)throw new Error('Projeto FPSO-P85 não encontrado.');projectId=rows[0].id;return projectId;}

  function lastBaseBeforeCut(row){
    const registration=parseDate(row.registration_date),jointCut=parseDate(row.joint_cut_date);
    if(registration)return{label:'Cadastro',date:registration};
    if(jointCut)return{label:'Corte de junta',date:jointCut};
    return{label:'Sem etapa anterior',date:null};
  }
  function pendingFor(row){
    let last=lastBaseBeforeCut(row);
    const explicit=STAGES.filter(stage=>!stage.special&&stage.id!=='rx_us'&&stage.id!=='dimensional');
    for(const stage of explicit){
      const date=parseDate(row[stage.key]);
      if(!date)return{stage,last};
      last={label:stage.label,date};
    }

    const traceabilityPending=/RASTREAB/.test(normalize(row.situation))&&!row.rx_us_date&&!row.dimensional_date;
    if(traceabilityPending)return{stage:STAGES.find(stage=>stage.id==='rastreabilidade'),last};

    const rx=STAGES.find(stage=>stage.id==='rx_us');
    const rxDate=parseDate(row.rx_us_date);
    if(!rxDate)return{stage:rx,last};
    last={label:rx.label,date:rxDate};

    const dimensional=STAGES.find(stage=>stage.id==='dimensional');
    const dimensionalDate=parseDate(row.dimensional_date);
    if(!dimensionalDate)return{stage:dimensional,last};
    return null;
  }
  function statusFor(days,stageId){
    if(days===null)return{key:'sem_data',label:'Sem data-base'};
    const limit=sla[stageId];
    if(limit===null||limit===undefined||limit==='')return{key:'sem_sla',label:'Sem SLA'};
    const n=Number(limit);
    if(days>n)return{key:'atrasado',label:'Atrasado'};
    if(days>=Math.max(0,n-1))return{key:'atencao',label:'Atenção'};
    return{key:'no_prazo',label:'No prazo'};
  }
  function pendingRows(){
    return uniqueRows(joints).map(row=>{
      const pending=pendingFor(row);if(!pending)return null;
      const days=ageDays(pending.last.date),status=statusFor(days,pending.stage.id);
      return{
        module:upper(row.module)||'—',spool:row.spool_tag||row.spool_key||'—',spoolKey:normalizeSpoolKey(row.spool_key),joint:clean(row.joint)||'—',placement:upper(row.placement)||'—',
        document:clean(row.document)||'—',line:clean(row.line)||'—',lastStage:pending.last.label,lastDate:pending.last.date?pending.last.date.toISOString():null,
        pendingStage:pending.stage.label,pendingStageId:pending.stage.id,days,statusKey:status.key,statusLabel:status.label,sla:sla[pending.stage.id],situation:clean(row.situation)||'—'
      };
    }).filter(Boolean);
  }
  function filteredRows(){
    const q=normalize(filters.search);
    return pendingRows().filter(row=>(!q||normalize(`${row.module} ${row.spool} ${row.spoolKey} ${row.joint} ${row.document} ${row.line} ${row.pendingStage} ${row.situation}`).includes(q))&&(!filters.module||row.module===filters.module)&&(!filters.placement||row.placement===filters.placement)&&(!filters.stage||row.pendingStageId===filters.stage)&&(!filters.status||row.statusKey===filters.status)).sort((a,b)=>(b.days??-1)-(a.days??-1)||a.pendingStage.localeCompare(b.pendingStage,'pt-BR'));
  }

  function createView(){
    if(document.querySelector(`#${VIEW_ID}`))return;
    const nav=document.querySelector('.nav');if(!nav)return;
    const before=document.querySelector('#accessManagementNav')||nav.querySelector('[data-view="settings"]')||nav.querySelector('[data-view="imports"]');
    const button=document.createElement('button');button.id='cqPendenciasNav';button.className='nav-item';button.dataset.view='cq-pendencias';button.innerHTML='<span>⚠</span> Pendências CQ <b id="cqPendenciasNavCount">0</b>';nav.insertBefore(button,before||null);button.onclick=openView;

    const section=document.createElement('section');section.id=VIEW_ID;section.className='view cq-view';section.innerHTML=`
      <div class="cq-hero">
        <div><p class="eyebrow">CONTROLE INTERNO · CQ</p><h2>Pendências de Baixa</h2><p>Dedo duro de apontamento: identifica a próxima baixa pendente de cada junta e mede há quantos dias a última etapa foi registrada.</p></div>
        <div class="cq-hero-actions"><div><span>Fonte</span><strong id="cqSourceName">Joint Traceability P85</strong><small id="cqSourceTime">Aguardando carregamento...</small></div><button class="button secondary" id="cqRefresh">Atualizar</button>${canWrite()?'<button class="button secondary" id="cqSlaOpen">Configurar SLA</button>':''}</div>
      </div>
      <div class="cq-note"><strong>Rastreabilidade:</strong> o arquivo atual não fornece uma data exclusiva de baixa dessa etapa. A pendência é identificada quando o campo <b>Situação</b> contém “RASTREAB”, e o aging usa a última etapa anterior que possui data registrada.</div>
      <div id="cqSlaEditor"></div>
      <div id="cqKpis" class="cq-kpis"></div>
      <div class="cq-charts"><article class="cq-panel"><div class="cq-panel-head"><div><span>GARGALOS</span><h3>Pendências por etapa</h3></div></div><div id="cqStageChart"></div></article><article class="cq-panel"><div class="cq-panel-head"><div><span>AGING</span><h3>Dias médios em aberto</h3></div></div><div id="cqAgeChart"></div></article><article class="cq-panel"><div class="cq-panel-head"><div><span>DISTRIBUIÇÃO</span><h3>Faixas de espera</h3></div></div><div id="cqBandChart"></div></article></div>
      <div class="cq-panel cq-table-panel">
        <div class="cq-table-title"><div><span>LISTA DE PENDÊNCIAS</span><h3>Juntas abertas para baixa</h3><small id="cqTableMeta"></small></div><div class="cq-export-actions"><button class="button secondary" id="cqExportCsv">Exportar CSV</button><button class="button primary" id="cqExportXlsx">Exportar Excel</button></div></div>
        <div class="cq-filterbar"><label class="cq-search"><span>Pesquisar</span><input id="cqSearch" placeholder="Spool, junta, documento, linha..."></label><label><span>Módulo</span><select id="cqModule"><option value="">Todos</option></select></label><label><span>Local</span><select id="cqPlacement"><option value="">PIPE + CAMPO</option></select></label><label><span>Etapa pendente</span><select id="cqStage"><option value="">Todas</option></select></label><label><span>Status</span><select id="cqStatus"><option value="">Todos</option><option value="atrasado">Atrasado</option><option value="atencao">Atenção</option><option value="no_prazo">No prazo</option><option value="sem_sla">Sem SLA</option><option value="sem_data">Sem data-base</option></select></label></div>
        <div class="cq-table-wrap"><table><thead><tr><th>Módulo</th><th>Spool</th><th>Junta</th><th>Local</th><th>Documento / Linha</th><th>Última baixa</th><th>Data última baixa</th><th>Próxima pendência</th><th>Dias</th><th>SLA</th><th>Status</th><th>Situação</th></tr></thead><tbody id="cqTableBody"></tbody></table></div>
        <div class="cq-pagination"><button class="button secondary" id="cqPrev">← Anterior</button><span id="cqPageLabel"></span><button class="button secondary" id="cqNext">Próxima →</button></div>
      </div>`;
    document.querySelector('.main')?.appendChild(section);
    bindView();
  }

  function openView(){
    document.querySelectorAll('.view').forEach(view=>view.classList.remove('active'));document.querySelector(`#${VIEW_ID}`)?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(item=>item.classList.toggle('active',item.id==='cqPendenciasNav'));
    const title=document.querySelector('#pageTitle');if(title)title.textContent='Pendências de Baixa · CQ';document.querySelector('#sidebar')?.classList.remove('open');
    if(state.supabase.token)loadData(false);else render();
  }
  function bindView(){
    document.querySelector('#cqRefresh').onclick=()=>loadData(true);
    document.querySelector('#cqSlaOpen')?.addEventListener('click',openSlaEditor);
    document.querySelector('#cqSearch').oninput=event=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{filters.search=event.target.value;page=1;render();},220);};
    ['Module','Placement','Stage','Status'].forEach(name=>{document.querySelector(`#cq${name}`).onchange=event=>{filters[name.toLowerCase()]=event.target.value;page=1;render();};});
    document.querySelector('#cqPrev').onclick=()=>{page=Math.max(1,page-1);renderTable();};document.querySelector('#cqNext').onclick=()=>{page+=1;renderTable();};
    document.querySelector('#cqExportCsv').onclick=exportCsv;document.querySelector('#cqExportXlsx').onclick=exportXlsx;
  }

  function populateFilters(rows){
    const module=document.querySelector('#cqModule'),placement=document.querySelector('#cqPlacement'),stage=document.querySelector('#cqStage');if(!module||!placement||!stage)return;
    const modules=[...new Set(rows.map(row=>row.module).filter(value=>value&&value!=='—'))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
    const placements=[...new Set(rows.map(row=>row.placement).filter(value=>value&&value!=='—'))].sort();
    module.innerHTML='<option value="">Todos</option>'+modules.map(value=>`<option value="${escape(value)}">${escape(value)}</option>`).join('');module.value=modules.includes(filters.module)?filters.module:'';filters.module=module.value;
    placement.innerHTML='<option value="">PIPE + CAMPO</option>'+placements.map(value=>`<option value="${escape(value)}">${escape(value)}</option>`).join('');placement.value=placements.includes(filters.placement)?filters.placement:'';filters.placement=placement.value;
    stage.innerHTML='<option value="">Todas</option>'+STAGES.map(item=>`<option value="${item.id}">${escape(item.label)}</option>`).join('');stage.value=STAGES.some(item=>item.id===filters.stage)?filters.stage:'';filters.stage=stage.value;
  }

  function metric(rows){
    const overdue=rows.filter(row=>row.statusKey==='atrasado').length,attention=rows.filter(row=>row.statusKey==='atencao').length,ok=rows.filter(row=>row.statusKey==='no_prazo').length,unparam=rows.filter(row=>row.statusKey==='sem_sla'||row.statusKey==='sem_data').length;
    const ages=rows.map(row=>row.days).filter(value=>value!==null),maxAge=ages.length?Math.max(...ages):0;
    const stages=new Map();rows.forEach(row=>stages.set(row.pendingStage,(stages.get(row.pendingStage)||0)+1));const bottleneck=[...stages.entries()].sort((a,b)=>b[1]-a[1])[0]||['—',0];
    return{total:rows.length,overdue,attention,ok,unparam,maxAge,bottleneck};
  }
  function renderKpis(rows){
    const m=metric(rows),box=document.querySelector('#cqKpis');if(!box)return;
    box.innerHTML=`<article><span>Total em aberto</span><strong>${fmt(m.total)}</strong><small>${fmt(m.unparam)} sem SLA/data-base</small></article><article class="danger"><span>Atrasadas</span><strong>${fmt(m.overdue)}</strong><small>Acima do SLA configurado</small></article><article class="warn"><span>Atenção</span><strong>${fmt(m.attention)}</strong><small>No limite ou a 1 dia do SLA</small></article><article class="success"><span>No prazo</span><strong>${fmt(m.ok)}</strong><small>Com SLA e dentro do prazo</small></article><article><span>Maior espera</span><strong>${fmt(m.maxAge)} dias</strong><small>Maior aging da seleção</small></article><article class="accent"><span>Maior gargalo</span><strong>${escape(m.bottleneck[0])}</strong><small>${fmt(m.bottleneck[1])} juntas</small></article>`;
  }
  function rankingHtml(rows,valueLabel=''){if(!rows.length)return'<div class="cq-empty">Sem dados para os filtros.</div>';const max=Math.max(1,...rows.map(row=>row.value));return`<div class="cq-ranking">${rows.map(row=>`<div class="cq-ranking-row"><span>${escape(row.label)}</span><div><i style="width:${Math.max(1,row.value/max*100)}%"></i></div><strong>${fmt1(row.value)}${valueLabel}</strong></div>`).join('')}</div>`;}
  function renderCharts(rows){
    const stageMap=new Map();rows.forEach(row=>stageMap.set(row.pendingStage,(stageMap.get(row.pendingStage)||0)+1));const stageRows=STAGES.map(stage=>({label:stage.label,value:stageMap.get(stage.label)||0})).filter(row=>row.value).sort((a,b)=>b.value-a.value);
    document.querySelector('#cqStageChart').innerHTML=rankingHtml(stageRows);
    const ages=STAGES.map(stage=>{const values=rows.filter(row=>row.pendingStageId===stage.id&&row.days!==null).map(row=>row.days);return{label:stage.label,value:values.length?values.reduce((a,b)=>a+b,0)/values.length:0,count:values.length};}).filter(row=>row.count).sort((a,b)=>b.value-a.value);
    document.querySelector('#cqAgeChart').innerHTML=rankingHtml(ages,' d');
    const bands=[{label:'0–1 dia',min:0,max:1},{label:'2–3 dias',min:2,max:3},{label:'4–7 dias',min:4,max:7},{label:'8+ dias',min:8,max:Infinity},{label:'Sem data',min:null,max:null}].map(band=>({label:band.label,value:band.min===null?rows.filter(row=>row.days===null).length:rows.filter(row=>row.days!==null&&row.days>=band.min&&row.days<=band.max).length}));
    document.querySelector('#cqBandChart').innerHTML=rankingHtml(bands);
  }
  function statusBadge(row){return`<span class="cq-status ${row.statusKey}">${escape(row.statusLabel)}</span>`;}
  function renderTable(){
    const rows=filteredRows(),pages=Math.max(1,Math.ceil(rows.length/TABLE_PAGE_SIZE));page=Math.min(Math.max(1,page),pages);const chunk=rows.slice((page-1)*TABLE_PAGE_SIZE,page*TABLE_PAGE_SIZE),body=document.querySelector('#cqTableBody');if(!body)return;
    body.innerHTML=chunk.map(row=>`<tr><td>${escape(row.module)}</td><td><strong>${escape(row.spool)}</strong></td><td>${escape(row.joint)}</td><td>${escape(row.placement)}</td><td><span>${escape(row.document)}</span><small>${escape(row.line)}</small></td><td>${escape(row.lastStage)}</td><td>${escape(formatDate(row.lastDate))}</td><td><strong>${escape(row.pendingStage)}</strong></td><td class="cq-days">${row.days===null?'—':fmt(row.days)}</td><td>${row.sla===null||row.sla===undefined||row.sla===''?'—':`${fmt(row.sla)} d`}</td><td>${statusBadge(row)}</td><td title="${escape(row.situation)}">${escape(row.situation)}</td></tr>`).join('')||'<tr><td colspan="12"><div class="cq-empty">Nenhuma pendência encontrada para os filtros.</div></td></tr>';
    document.querySelector('#cqTableMeta').textContent=`${fmt(rows.length)} pendência(s) · ordenado por maior tempo em aberto`;
    document.querySelector('#cqPageLabel').textContent=`Página ${page} de ${pages}`;document.querySelector('#cqPrev').disabled=page<=1;document.querySelector('#cqNext').disabled=page>=pages;
  }
  function render(){
    const all=pendingRows();document.querySelector('#cqPendenciasNavCount')&&(document.querySelector('#cqPendenciasNavCount').textContent=fmt(all.length));
    populateFilters(all);const rows=filteredRows();renderKpis(rows);renderCharts(rows);renderTable();
    const source=document.querySelector('#cqSourceName'),time=document.querySelector('#cqSourceTime');if(source)source.textContent=sourceMeta.file||'Joint Traceability P85';if(time)time.textContent=sourceMeta.updatedAt?`Atualizado ${new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(new Date(sourceMeta.updatedAt))}`:(joints.length?'Base carregada':'Aguardando dados');
  }

  function openSlaEditor(){
    const box=document.querySelector('#cqSlaEditor');if(!box||!canWrite())return;
    box.innerHTML=`<div class="cq-sla-card"><div class="cq-sla-head"><div><span>PARÂMETROS</span><h3>SLA máximo por etapa</h3><p>Acoplamento inicia em 3 dias conforme regra informada. As demais etapas ficam sem SLA até serem definidas.</p></div><button class="button secondary" id="cqSlaCancel">Fechar</button></div><div class="cq-sla-grid">${STAGES.map(stage=>`<label>${escape(stage.label)}<input data-cq-sla="${stage.id}" inputmode="numeric" min="0" type="number" value="${sla[stage.id]??''}" placeholder="Sem SLA"><small>dias</small></label>`).join('')}</div><div class="cq-sla-actions"><button class="button primary" id="cqSlaSave">Salvar SLA</button></div></div>`;
    document.querySelector('#cqSlaCancel').onclick=()=>{box.innerHTML='';};document.querySelector('#cqSlaSave').onclick=saveSla;
  }
  async function saveSla(){
    if(!canWrite())return;const button=document.querySelector('#cqSlaSave');if(button){button.disabled=true;button.textContent='Salvando...';}
    try{
      const next={};document.querySelectorAll('[data-cq-sla]').forEach(input=>{next[input.dataset.cqSla]=input.value===''?null:Math.max(0,Number(input.value));});
      const id=await getProjectId(),payload={...next,updated_at:new Date().toISOString(),updated_by:state.supabase.user?.email||state.supabase.email||''};
      await rest('/rest/v1/source_records?on_conflict=project_id,dataset_type,source_key',{method:'POST',body:[{project_id:id,dataset_type:SLA_DATASET,source_key:'default',source_file_hash:'manual-cq-stage-sla',source_file_name:'SLA · Pendências CQ',source_sheet:'Pendências CQ',source_row:null,source_row_hash:`${Date.now()}-${Math.random().toString(16).slice(2)}`,payload,source_active:true}]});
      sla={...DEFAULT_SLA,...payload};document.querySelector('#cqSlaEditor').innerHTML='';render();if(typeof toast==='function')toast('SLA das pendências CQ atualizado.');
    }catch(error){if(typeof toast==='function')toast(error.message||'Não foi possível salvar o SLA.','error');}finally{if(button){button.disabled=false;button.textContent='Salvar SLA';}}
  }

  function exportRows(){return filteredRows().map(row=>({'Módulo':row.module,'Spool':row.spool,'Junta':row.joint,'Local':row.placement,'Documento':row.document,'Linha':row.line,'Última baixa':row.lastStage,'Data última baixa':formatDate(row.lastDate),'Próxima pendência':row.pendingStage,'Dias em aberto':row.days??'','SLA (dias)':row.sla??'','Status':row.statusLabel,'Situação':row.situation}));}
  function exportCsv(){const rows=exportRows();if(!rows.length)return typeof toast==='function'&&toast('Não há pendências para exportar.','error');const keys=Object.keys(rows[0]),quote=value=>`"${String(value??'').replace(/"/g,'""')}"`,csv='\ufeff'+[keys.map(quote).join(';'),...rows.map(row=>keys.map(key=>quote(row[key])).join(';'))].join('\n'),url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`pendencias-cq-${new Date().toISOString().slice(0,10)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function exportXlsx(){const rows=exportRows();if(!rows.length)return typeof toast==='function'&&toast('Não há pendências para exportar.','error');if(!window.XLSX)return typeof toast==='function'&&toast('A biblioteca Excel ainda não carregou.','error');const wb=XLSX.utils.book_new(),ws=XLSX.utils.json_to_sheet(rows);XLSX.utils.book_append_sheet(wb,ws,'Pendencias CQ');XLSX.writeFile(wb,`pendencias-cq-${new Date().toISOString().slice(0,10)}.xlsx`);}

  async function loadData(showToast){
    if(loading||!state.supabase.token)return;loading=true;
    try{
      const id=await getProjectId();
      const [jointRows,summary,slaRows]=await Promise.all([
        fetchAll(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${JOINT_DATASET}&source_active=eq.true&select=payload,source_file_name,updated_at&order=source_row.asc`),
        rest(`/rest/v1/v_source_dataset_summary?project_id=eq.${encode(id)}&dataset_type=eq.${JOINT_DATASET}&select=source_file_name,last_updated_at&limit=1`),
        rest(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${SLA_DATASET}&source_key=eq.default&source_active=eq.true&select=payload,updated_at&limit=1`),
      ]);
      joints=jointRows.map(row=>({...row.payload}));sla={...DEFAULT_SLA,...(slaRows[0]?.payload||{})};sourceMeta={file:summary[0]?.source_file_name||jointRows[0]?.source_file_name||'',updatedAt:summary[0]?.last_updated_at||jointRows.reduce((latest,row)=>!latest||String(row.updated_at)>String(latest)?row.updated_at:latest,'')};
      render();if(showToast&&typeof toast==='function')toast(`Pendências CQ atualizadas: ${fmt(pendingRows().length)} juntas abertas.`);
    }catch(error){if(typeof toast==='function'&&showToast)toast(error.message||'Falha ao carregar Pendências CQ.','error');console.warn('Pendências CQ:',error);}finally{loading=false;}
  }

  function install(){
    if(installed)return;createView();if(!document.querySelector(`#${VIEW_ID}`)){setTimeout(install,300);return;}installed=true;
    lastToken=state.supabase.token||'';if(lastToken)loadData(false);
    setInterval(()=>{const token=state.supabase.token||'';if(token&&token!==lastToken){lastToken=token;projectId='';loadData(false);}else if(!token){lastToken='';joints=[];sourceMeta={file:'',updatedAt:''};render();}},1800);
  }
  if(document.readyState==='complete')setTimeout(install,500);else window.addEventListener('load',()=>setTimeout(install,3600));
  window.BrasfelsCqPendencias={open:openView,refresh:()=>loadData(false)};
})();