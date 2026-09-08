'use strict';

(function installBrasfelsDashboardImprovements(){
  const DATASET='p85_weekly_targets';
  const JOINT_DATASET='p85_joint_traceability';
  const PAGE_SIZE=1000;
  const STAGES=[
    {key:'cutting_date',id:'corte',label:'Corte'},
    {key:'coupling_date',id:'montagem',label:'Montagem'},
    {key:'welding_date',id:'soldagem',label:'Soldagem'},
  ];
  let projectId='';
  let joints=[];
  let targets=new Map();
  let lastToken='';
  let loading=false;
  let saveRunning=false;
  let renderScheduled=false;
  let observer=null;

  const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
  const upper=value=>clean(value).toUpperCase();
  const number=value=>{
    if(typeof value==='number'&&Number.isFinite(value))return value;
    let text=clean(value).replace(/\s/g,'');
    if(!text)return 0;
    if(text.includes(',')&&text.includes('.'))text=text.lastIndexOf(',')>text.lastIndexOf('.')?text.replace(/\./g,'').replace(',','.'):text.replace(/,/g,'');
    else if(text.includes(','))text=text.replace(',','.');
    const parsed=Number(text);return Number.isFinite(parsed)?parsed:0;
  };
  const fmt=(value,digits=0)=>new Intl.NumberFormat('pt-BR',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(number(value));
  const escape=value=>typeof escapeHtml==='function'?escapeHtml(value):String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const encode=value=>encodeURIComponent(String(value??''));

  function parseDate(value){
    if(!value)return null;
    if(value instanceof Date&&!Number.isNaN(value.getTime()))return value;
    const text=String(value);
    const date=/^\d{4}-\d{2}-\d{2}$/.test(text)?new Date(`${text}T12:00:00Z`):new Date(text);
    return Number.isNaN(date.getTime())?null:date;
  }
  function legacyWeekNumber(value){
    const date=parseDate(value);if(!date)return null;
    const year=date.getUTCFullYear();
    const jan1=new Date(Date.UTC(year,0,1,12));
    const offset=(jan1.getUTCDay()-4+7)%7;
    const day=Math.floor((Date.UTC(year,date.getUTCMonth(),date.getUTCDate())-Date.UTC(year,0,1))/86400000)+1;
    return Math.floor((day-1+offset)/7);
  }
  function weekKey(value){const date=parseDate(value),week=legacyWeekNumber(date);return date&&week!==null?`${date.getUTCFullYear()}-${week}`:'';}
  function parseWeekKey(key){const match=String(key||'').match(/^(\d{4})-(\d{1,2})$/);return match?{year:Number(match[1]),week:Number(match[2])}:null;}
  function weekLabel(key,compact=false){const parsed=parseWeekKey(key);return parsed?(compact?`S${parsed.week}`:`Semana ${parsed.week} · ${parsed.year} (qui–qua)`):'Semana atual';}
  function normalizeSpoolKey(value){return upper(value).replace(/\s+/g,'').replace(/_/g,'-').replace(/^CANC-?/,'').replace(/-+/g,'-').replace(/-+$/,'');}
  function uniqueJointRows(rows){const seen=new Set();return rows.filter(row=>{const key=`${normalizeSpoolKey(row.spool_key)}|${upper(row.joint)}`;if(!key||seen.has(key))return false;seen.add(key);return true;});}
  function currentFilters(){return{module:upper(document.querySelector('#dashboardModule')?.value||''),placement:upper(document.querySelector('#dashboardPlacement')?.value||''),week:document.querySelector('#dashboardWeek')?.value||'',period:document.querySelector('#dashboardPeriod')?.value||'16'};}
  function activeWeek(){return currentFilters().week||weekKey(new Date());}
  function targetKey(week,module,placement){return `${week}|${module||'ALL'}|${placement||'ALL'}`;}
  function selectedTarget(){
    const f=currentFilters(),week=activeWeek();
    const keys=[targetKey(week,f.module,f.placement),targetKey(week,f.module,''),targetKey(week,'',f.placement),targetKey(week,'','')];
    for(const key of keys)if(targets.has(key))return targets.get(key);
    return{week,module:f.module,placement:f.placement,corte_t:0,montagem_t:0,soldagem_t:0};
  }
  function canWrite(){return state?.supabase?.role==='operator'||state?.supabase?.role==='admin';}
  function requestHeaders(write=false){
    const result={apikey:state.supabase.key,Authorization:`Bearer ${state.supabase.token}`,'Accept-Profile':'brasfels','Content-Type':'application/json'};
    if(write){result['Content-Profile']='brasfels';result.Prefer='resolution=merge-duplicates,return=minimal';}
    return result;
  }
  async function rest(path,options={}){
    const method=options.method||'GET';
    const response=await fetch(`${state.supabase.url}${path}`,{method,headers:requestHeaders(method!=='GET'),body:options.body===undefined?undefined:JSON.stringify(options.body)});
    if(!response.ok){const payload=await response.json().catch(()=>({}));throw new Error(payload.message||payload.msg||payload.error||`Erro ${response.status} ao atualizar o Dashboard.`);}
    if(response.status===204||method!=='GET')return[];
    return response.json();
  }
  async function fetchAll(path){const rows=[];for(let offset=0;;offset+=PAGE_SIZE){const separator=path.includes('?')?'&':'?';const page=await rest(`${path}${separator}limit=${PAGE_SIZE}&offset=${offset}`);rows.push(...page);if(page.length<PAGE_SIZE)return rows;}}
  async function getProjectId(){if(projectId)return projectId;const rows=await rest(`/rest/v1/projects?code=eq.${encode(CONFIG.projectCode)}&select=id&limit=1`);if(!rows.length)throw new Error('Projeto FPSO-P85 não encontrado.');projectId=rows[0].id;return projectId;}

  async function loadSources(){
    if(loading||!state?.supabase?.token)return;
    loading=true;
    try{
      if(!state.spools?.length&&window.loadBrasfelsRemoteData)await window.loadBrasfelsRemoteData({silent:true});
      const id=await getProjectId();
      const [jointRows,targetRows]=await Promise.all([
        fetchAll(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${JOINT_DATASET}&source_active=eq.true&select=payload&order=source_row.asc`),
        fetchAll(`/rest/v1/source_records?project_id=eq.${encode(id)}&dataset_type=eq.${DATASET}&source_active=eq.true&select=source_key,payload,updated_at&order=updated_at.asc`),
      ]);
      joints=jointRows.map(row=>({...row.payload}));
      targets=new Map(targetRows.map(row=>[row.source_key,{...(row.payload||{}),updated_at:row.updated_at}]));
      scheduleRender();
    }catch(error){console.warn('Melhorias do Dashboard BRASFELS:',error);}finally{loading=false;}
  }

  function dataForCurrentFilters(){
    const f=currentFilters();
    const all=uniqueJointRows(joints);
    const moduleRows=all.filter(row=>!f.module||upper(row.module)===f.module);
    const stageRows=moduleRows.filter(row=>!f.placement||upper(row.placement)===f.placement);
    const spoolMap=new Map((state.spools||[]).filter(spool=>!f.module||upper(spool.module)===f.module).map(spool=>[normalizeSpoolKey(spool.source_key),spool]));
    const allJointCountBySpool=new Map();
    moduleRows.forEach(row=>{const key=normalizeSpoolKey(row.spool_key);allJointCountBySpool.set(key,(allJointCountBySpool.get(key)||0)+1);});
    const weekSet=new Set();
    const stageMaps={corte:new Map(),montagem:new Map(),soldagem:new Map()};
    const jointsWelded=new Map();
    for(const row of stageRows){
      const spoolKey=normalizeSpoolKey(row.spool_key),spool=spoolMap.get(spoolKey),denominator=allJointCountBySpool.get(spoolKey)||0;
      const contributionT=spool&&denominator?number(spool.weight_kg)/denominator/1000:0;
      STAGES.forEach(stage=>{const wk=weekKey(row[stage.key]);if(!wk)return;weekSet.add(wk);stageMaps[stage.id].set(wk,(stageMaps[stage.id].get(wk)||0)+contributionT);});
      const weldWeek=weekKey(row.welding_date);if(weldWeek)jointsWelded.set(weldWeek,(jointsWelded.get(weldWeek)||0)+1);
    }
    const grouped=new Map();
    for(const row of stageRows){const key=normalizeSpoolKey(row.spool_key);if(!key)continue;if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);}
    const spoolsWelded=new Map(),spoolsDmf=new Map();
    grouped.forEach(rows=>{
      if(rows.length&&rows.every(row=>Boolean(row.welding_date))){const completed=rows.map(row=>parseDate(row.welding_date)).filter(Boolean);if(completed.length===rows.length){const wk=weekKey(new Date(Math.max(...completed.map(date=>date.getTime()))));if(wk){weekSet.add(wk);spoolsWelded.set(wk,(spoolsWelded.get(wk)||0)+1);}}}
      if(rows.length&&rows.every(row=>Boolean(row.release_date))){const released=rows.map(row=>parseDate(row.release_date)).filter(Boolean);if(released.length===rows.length){const wk=weekKey(new Date(Math.max(...released.map(date=>date.getTime()))));if(wk){weekSet.add(wk);spoolsDmf.set(wk,(spoolsDmf.get(wk)||0)+1);}}}
    });
    const weeks=[...weekSet].sort((a,b)=>{const pa=parseWeekKey(a),pb=parseWeekKey(b);return(pa.year*100+pa.week)-(pb.year*100+pb.week);});
    return{
      stageWeightWeekly:weeks.map(key=>({key,label:weekLabel(key,true),corte:stageMaps.corte.get(key)||0,montagem:stageMaps.montagem.get(key)||0,soldagem:stageMaps.soldagem.get(key)||0})),
      quantityWeekly:weeks.map(key=>({key,label:weekLabel(key,true),jointsWelded:jointsWelded.get(key)||0,spoolsWelded:spoolsWelded.get(key)||0,spoolsDmf:spoolsDmf.get(key)||0})),
    };
  }
  function periodRows(rows){const period=currentFilters().period;return period==='all'?rows:rows.slice(-Math.max(1,Number(period||16)));}
  function lineChart(target,rows,series,formatter=value=>fmt(value)){
    const el=typeof target==='string'?document.querySelector(target):target;if(!el)return;
    const data=periodRows(rows);if(!data.length){el.innerHTML='<div class="brd-empty"><div><strong>Sem dados para este filtro.</strong></div></div>';return;}
    const width=900,height=270,left=58,right=18,top=18,bottom=40,pw=width-left-right,ph=height-top-bottom;
    const values=data.flatMap(row=>series.map(item=>number(row[item.key]))),max=Math.max(1,...values)*1.08;
    const x=index=>data.length===1?left+pw/2:left+index*pw/(data.length-1),y=value=>top+ph-number(value)/max*ph;
    let html=`<div class="brd-legend brd-improvement-legend">${series.map((item,index)=>`<span data-series="${index}"><i></i>${escape(item.label)}</span>`).join('')}</div><svg viewBox="0 0 ${width} ${height}" role="img">`;
    for(let tick=0;tick<=4;tick++){const value=max*tick/4,yy=top+ph-tick*ph/4;html+=`<line class="brd-gridline" x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}"></line><text class="brd-axis" x="${left-8}" y="${yy+4}" text-anchor="end">${escape(formatter(value))}</text>`;}
    data.forEach((row,index)=>{if(data.length<=18||index%2===0||index===data.length-1)html+=`<text class="brd-axis" x="${x(index)}" y="${height-12}" text-anchor="middle">${escape(row.label)}</text>`;});
    series.forEach((item,seriesIndex)=>{const points=data.map((row,index)=>`${x(index)},${y(row[item.key])}`).join(' ');html+=`<polyline class="brd-imp-line brd-imp-line-${seriesIndex}" points="${points}"></polyline>`;data.forEach((row,index)=>{html+=`<circle class="brd-imp-dot brd-imp-dot-${seriesIndex}" cx="${x(index)}" cy="${y(row[item.key])}" r="4"><title>${escape(`${item.label} · ${row.label}: ${formatter(row[item.key])}`)}</title></circle>`;});});
    el.innerHTML=html+'</svg>';
  }
  function progressCard(stage,actual,target){const pct=target>0?Math.min(999,actual/target*100):0,remaining=Math.max(0,target-actual);return`<article class="brd-weekly-target-card" data-stage="${stage.id}"><div class="brd-weekly-target-head"><span>${escape(stage.label)}</span><strong>${target>0?`${fmt(pct,1)}%`:'—'}</strong></div><div class="brd-weekly-target-value"><b>${fmt(actual,2)} t</b><span>de ${target>0?`${fmt(target,2)} t`:'meta não definida'}</span></div><div class="brd-weekly-progress"><i style="width:${Math.min(100,pct)}%"></i></div><div class="brd-weekly-target-foot"><span>Meta ${target>0?`${fmt(target,2)} t`:'—'}</span><span>Falta ${target>0?`${fmt(remaining,2)} t`:'—'}</span></div></article>`;}

  function renderTargets(stageWeightWeekly){
    const baseKpis=document.querySelector('#dashboardContent .brd-kpis');if(!baseKpis)return;
    let section=document.querySelector('#brdWeeklyTargets');if(!section){section=document.createElement('section');section.id='brdWeeklyTargets';section.className='brd-weekly-targets';baseKpis.parentElement.insertBefore(section,baseKpis);}
    const week=activeWeek(),row=stageWeightWeekly.find(item=>item.key===week)||{corte:0,montagem:0,soldagem:0},target=selectedTarget();
    section.innerHTML=`<div class="brd-weekly-target-title"><div><p class="eyebrow">META SEMANAL</p><h3>${escape(weekLabel(week))}</h3><small>${escape(currentFilters().module||'Todos os módulos')} · ${escape(currentFilters().placement||'PIPE + CAMPO')}</small></div>${canWrite()?'<button type="button" class="button secondary brd-target-edit" id="brdTargetEdit">Editar metas</button>':''}</div><div class="brd-weekly-target-grid">${progressCard(STAGES[0],row.corte,number(target.corte_t))}${progressCard(STAGES[1],row.montagem,number(target.montagem_t))}${progressCard(STAGES[2],row.soldagem,number(target.soldagem_t))}</div><div id="brdTargetEditor"></div>`;
    document.querySelector('#brdTargetEdit')?.addEventListener('click',openTargetEditor);
  }
  function openTargetEditor(){
    const editor=document.querySelector('#brdTargetEditor');if(!editor)return;const target=selectedTarget(),f=currentFilters();
    editor.innerHTML=`<div class="brd-target-editor-card"><div><strong>Definir meta da ${escape(weekLabel(activeWeek()))}</strong><span>A meta será salva para o filtro atual: ${escape(f.module||'todos os módulos')} · ${escape(f.placement||'PIPE + CAMPO')}.</span></div><div class="brd-target-fields"><label>Corte (t)<input id="brdTargetCorte" inputmode="decimal" value="${escape(number(target.corte_t)||'')}" placeholder="0,00"></label><label>Montagem (t)<input id="brdTargetMontagem" inputmode="decimal" value="${escape(number(target.montagem_t)||'')}" placeholder="0,00"></label><label>Soldagem (t)<input id="brdTargetSoldagem" inputmode="decimal" value="${escape(number(target.soldagem_t)||'')}" placeholder="0,00"></label></div><div class="brd-target-actions"><button class="button secondary" id="brdTargetCancel" type="button">Cancelar</button><button class="button primary" id="brdTargetSave" type="button">Salvar metas</button></div></div>`;
    document.querySelector('#brdTargetCancel').onclick=()=>{editor.innerHTML='';};document.querySelector('#brdTargetSave').onclick=saveTargets;
  }
  function inputNumber(id){return Math.max(0,number(document.querySelector(id)?.value||0));}
  async function saveTargets(){
    if(saveRunning||!canWrite())return;saveRunning=true;const button=document.querySelector('#brdTargetSave');if(button){button.disabled=true;button.textContent='Salvando...';}
    try{
      const id=await getProjectId(),f=currentFilters(),week=activeWeek(),sourceKey=targetKey(week,f.module,f.placement);
      const payload={week,module:f.module||'',placement:f.placement||'',corte_t:inputNumber('#brdTargetCorte'),montagem_t:inputNumber('#brdTargetMontagem'),soldagem_t:inputNumber('#brdTargetSoldagem'),updated_by:state.supabase.user?.email||state.supabase.email||'',updated_at:new Date().toISOString()};
      const hash=`${week}-${f.module||'all'}-${f.placement||'all'}`.toLowerCase().replace(/[^a-z0-9-]+/g,'-');
      await rest('/rest/v1/source_records?on_conflict=project_id,dataset_type,source_key',{method:'POST',body:[{project_id:id,dataset_type:DATASET,source_key:sourceKey,source_file_hash:`manual-weekly-target-${hash}`,source_file_name:'Meta semanal · Dashboard P85',source_sheet:'Dashboard',source_row:null,source_row_hash:`${Date.now()}-${Math.random().toString(16).slice(2)}`,payload,source_active:true}]});
      targets.set(sourceKey,payload);document.querySelector('#brdTargetEditor').innerHTML='';scheduleRender();if(typeof toast==='function')toast('Meta semanal atualizada.');
    }catch(error){if(typeof toast==='function')toast(error.message||'Não foi possível salvar a meta semanal.','error');}finally{saveRunning=false;if(button){button.disabled=false;button.textContent='Salvar metas';}}
  }

  function replaceProductionCharts(data){
    const content=document.querySelector('#dashboardContent');if(!content)return;
    const productionSection=[...content.querySelectorAll('.brd-section')].find(section=>/Evolução e desempenho de fábrica/i.test(section.querySelector('.brd-section-head h3')?.textContent||''));
    if(productionSection){const title=productionSection.querySelector('.brd-section-head h3'),subtitle=productionSection.querySelector('.brd-section-head > p');if(title)title.textContent='Avanço semanal de peso por etapa';if(subtitle)subtitle.textContent=weekLabel(currentFilters().week||activeWeek());}
    const stageCard=document.querySelector('#dbStageWeekly')?.closest('.brd-card');
    if(stageCard){const heading=stageCard.querySelector('h4'),copy=stageCard.querySelector('.brd-card-head p');if(heading)heading.textContent='Avanço semanal · peso por etapa';if(copy)copy.textContent='Peso proporcional dos spools por semana de Corte, Montagem e Soldagem.';lineChart('#dbStageWeekly',data.stageWeightWeekly,[{key:'corte',label:'Corte'},{key:'montagem',label:'Montagem'},{key:'soldagem',label:'Soldagem'}],value=>`${fmt(value,2)} t`);}
    const performance=[...content.querySelectorAll('.brd-card')].find(card=>/Comparativo de desempenho da fábrica/i.test(card.querySelector('h4')?.textContent||'')||card.querySelector('#dbWeeklyQuantities'));
    if(performance){const heading=performance.querySelector('h4'),copy=performance.querySelector('.brd-card-head p');if(heading)heading.textContent='Produção semanal · quantidades';if(copy)copy.textContent='Juntas soldadas, spools totalmente soldados e spools com DMF liberado por semana.';let chart=performance.querySelector('#dbWeeklyQuantities');if(!chart){performance.querySelector('.brd-mini-grid')?.remove();chart=document.createElement('div');chart.id='dbWeeklyQuantities';chart.className='brd-chart';performance.appendChild(chart);}lineChart(chart,data.quantityWeekly,[{key:'jointsWelded',label:'Juntas soldadas'},{key:'spoolsWelded',label:'Spools soldados'},{key:'spoolsDmf',label:'Spools DMF liberado'}],value=>fmt(value));}
  }
  function moveRundownLast(){
    const rundown=document.querySelector('#dbRundown')?.closest('.brd-card'),content=document.querySelector('#dashboardContent');if(!rundown||!content)return;
    let section=document.querySelector('#brdRundownLast');if(!section){section=document.createElement('div');section.id='brdRundownLast';section.className='brd-section brd-rundown-last';section.innerHTML='<div class="brd-section-head"><div><p class="eyebrow">RUNDOWN</p><h3>Rundown decrescente</h3></div><p>Parâmetro operacional ajustável na próxima revisão</p></div><div class="brd-grid" id="brdRundownGrid"></div>';const audit=content.querySelector('.brd-audit');content.insertBefore(section,audit||content.querySelector('.brd-source-strip')||null);}
    rundown.classList.remove('brd-span-8');rundown.classList.add('brd-span-12');const heading=rundown.querySelector('h4'),copy=rundown.querySelector('.brd-card-head p');if(heading)heading.textContent='Fabrication rundown · decrescente';if(copy)copy.textContent='Saldo de peso remanescente em ordem decrescente. A regra de capacidade/equipe ficará isolada para ajuste quando o parâmetro final for informado.';document.querySelector('#brdRundownGrid')?.appendChild(rundown);
    const statusCard=document.querySelector('#dbStatuses')?.closest('.brd-card');if(statusCard){statusCard.classList.remove('brd-span-4');statusCard.classList.add('brd-span-12');}
  }
  function renderEnhancements(){const content=document.querySelector('#dashboardContent');if(!content||!document.querySelector('#view-reports-dashboard'))return;const data=dataForCurrentFilters();renderTargets(data.stageWeightWeekly);replaceProductionCharts(data);moveRundownLast();}
  function scheduleRender(){if(renderScheduled)return;renderScheduled=true;requestAnimationFrame(()=>{renderScheduled=false;try{renderEnhancements();}catch(error){console.warn('Falha ao renderizar melhorias do Dashboard:',error);}});}
  function bindWatchers(){
    ['dashboardModule','dashboardPlacement','dashboardWeek','dashboardPeriod'].forEach(id=>{const element=document.querySelector(`#${id}`);if(element&&element.dataset.brdImprovementBound!=='1'){element.dataset.brdImprovementBound='1';element.addEventListener('change',()=>setTimeout(scheduleRender,0));}});
    const refresh=document.querySelector('#dashboardRefresh');if(refresh&&refresh.dataset.brdImprovementBound!=='1'){refresh.dataset.brdImprovementBound='1';refresh.addEventListener('click',()=>setTimeout(loadSources,250));}
  }
  function isOwnMutation(mutation){const target=mutation.target instanceof Element?mutation.target:mutation.target?.parentElement;return Boolean(target?.closest?.('#brdWeeklyTargets, #dbStageWeekly, #dbWeeklyQuantities, #brdRundownLast'));}
  function install(){
    bindWatchers();scheduleRender();
    if(!observer){observer=new MutationObserver(mutations=>{if(mutations.some(mutation=>!isOwnMutation(mutation)&&(mutation.addedNodes.length||mutation.removedNodes.length))){bindWatchers();scheduleRender();}});observer.observe(document.body,{childList:true,subtree:true});}
    setInterval(()=>{const token=state?.supabase?.token||'';if(token&&token!==lastToken){lastToken=token;projectId='';loadSources();}else if(!token){lastToken='';joints=[];targets=new Map();}},1600);
    lastToken=state?.supabase?.token||'';if(lastToken)loadSources();
  }
  if(document.readyState==='complete')setTimeout(install,400);else window.addEventListener('load',()=>setTimeout(install,3200));
  window.BrasfelsDashboardImprovements={refresh:loadSources,render:scheduleRender};
})();
