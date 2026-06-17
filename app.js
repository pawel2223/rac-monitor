// ============================================================
//  GREE RAC Monitor — PWA app.js
//  iOS/iPadOS Safari • WebSocket + MQTT + CSV Playback
// ============================================================

// ── Service Worker ────────────────────────────────────────────
if('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

// ── Topiki MQTT ───────────────────────────────────────────────
const TOPICS = {
  compressor:'rac/external/compressor', fan_rpm:'rac/external/fan_rpm',
  current:'rac/external/current', temp_module:'rac/external/temp_module',
  temp_outside:'rac/external/temp_outside', temp_exchanger:'rac/external/temp_exchanger',
  temp_discharge:'rac/external/temp_discharge', eev:'rac/external/eev',
  mode:'rac/internal/mode', fan_speed:'rac/internal/fan_speed',
  temp_set:'rac/internal/temp_set', temp_room:'rac/internal/temp_room',
  temp_pipe:'rac/internal/temp_pipe', humidity:'rac/internal/humidity'
};

// ── Kafle ODU ─────────────────────────────────────────────────
const ODU_TILES = [
  {id:'compressor',    label:'Kompresor',    unit:'Hz',   icon:'fa-tachometer-alt', color:'#8b5cf6'},
  {id:'fan_rpm',       label:'Went. ODU',    unit:'rpm',  icon:'fa-fan',            color:'#06b6d4'},
  {id:'current',       label:'Prąd',         unit:'A',    icon:'fa-bolt',           color:'#f59e0b'},
  {id:'eev',           label:'Zawór EEV',    unit:'/480', icon:'fa-expand-arrows-alt',color:'#06b6d4', eev:true},
  {id:'temp_module',   label:'T.modułu',     unit:'°C',   icon:'fa-microchip',      color:'#8b5cf6'},
  {id:'temp_outside',  label:'T.zewn.',      unit:'°C',   icon:'fa-sun',            color:'#f97316'},
  {id:'temp_exchanger',label:'T.wymien.',    unit:'°C',   icon:'fa-exchange-alt',   color:'#a855f7'},
  {id:'temp_discharge',label:'T.tłocz.',     unit:'°C',   icon:'fa-fire',           color:'#ef4444'}
];
const IDU_TILES = [
  {id:'temp_set',  label:'T.zadana', unit:'°C', icon:'fa-bullseye', color:'#f59e0b'},
  {id:'temp_room', label:'T.pokoju', unit:'°C', icon:'fa-home',     color:'#3b82f6'},
  {id:'temp_pipe', label:'T.rury',   unit:'°C', icon:'fa-water',    color:'#10b981'}
];

// ── Stan ──────────────────────────────────────────────────────
let mqttClient=null;
let lastVals={}, histData=[], maxHist=1000;
let charts={}, maxPts=60;
let dataSource='none';
let csvRows=[], pbIdx=0, pbTimer=null, pbPlaying=false;
const popupData={};
let popupChart=null;

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  initLogin();
  initClock();
  loadSavedSettings();
  initEventListeners();
});

// ── LOGIN ─────────────────────────────────────────────────────
function initLogin(){
  document.getElementById('btnLogin').onclick=doLogin;
  document.getElementById('inp-pass').addEventListener('keypress',e=>{if(e.key==='Enter')doLogin();});
  document.getElementById('togPw').onclick=()=>{
    const el=document.getElementById('inp-pass');
    el.type=el.type==='password'?'text':'password';
  };
}
function doLogin(){
  const u=document.getElementById('inp-login').value.trim();
  const p=document.getElementById('inp-pass').value.trim();
  if(u==='admin'&&p==='admin'){
    document.getElementById('login-screen').style.display='none';
    document.getElementById('app').style.display='flex';
    setTimeout(()=>{buildTiles();initCharts();initTileDefaults();},80);
  } else {
    const e=document.getElementById('err-msg');
    e.style.display='block'; setTimeout(()=>e.style.display='none',3000);
  }
}
function doLogout(){
  mqttDisc(); pbStop();
  document.getElementById('app').style.display='none';
  document.getElementById('login-screen').style.display='flex';
}
window.doLogout=doLogout;

// ── CLOCK ─────────────────────────────────────────────────────
function initClock(){
  const u=()=>{const el=document.getElementById('clock');if(el)el.textContent=new Date().toLocaleTimeString('pl-PL');};
  u(); setInterval(u,1000);
}

// ── TABS ──────────────────────────────────────────────────────
function showTab(id){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+id)?.classList.add('active');
  document.querySelectorAll('.ni').forEach(b=>{if(b.getAttribute('onclick')?.includes(`'${id}'`))b.classList.add('active');});
  if(id==='charts') setTimeout(()=>Object.values(charts).forEach(c=>{try{c?.resize();c?.update();}catch(e){}}),100);
}
window.showTab=showTab;

// ── TILES ─────────────────────────────────────────────────────
function buildTiles(){
  const odu=document.getElementById('odu-tiles');
  const idu=document.getElementById('idu-tiles');
  odu.innerHTML=''; idu.innerHTML='';
  ODU_TILES.forEach(t=>odu.appendChild(makeTile(t)));
  IDU_TILES.forEach(t=>idu.appendChild(makeTile(t)));
}
function makeTile(t){
  const d=document.createElement('div');
  d.className='tile'; d.id='tile-'+t.id;
  d.title='Dotknij aby zobaczyć wykres';
  let extra='';
  if(t.eev) extra=`<div class="eev-track"><div class="eev-fill" id="eev-fill" style="width:0%"></div></div><div class="eev-labels"><span>0</span><span id="eev-pct">0%</span><span>480</span></div>`;
  d.innerHTML=`
    <div class="t-lbl"><i class="fas ${t.icon}" style="color:${t.color}"></i>${t.label}</div>
    <div class="t-val" id="v-${t.id}">--</div>
    <div class="t-unit">${t.unit}</div>${extra}
    <div class="t-upd" id="upd-${t.id}">—</div>`;
  d.addEventListener('click',()=>openTileChart(t));
  return d;
}
function initTileDefaults(){
  [...ODU_TILES,...IDU_TILES].forEach(t=>setTile(t.id,'--'));
}

// ── TILE VALUE ────────────────────────────────────────────────
function setTile(id,val){
  const vEl=document.getElementById('v-'+id);
  const uEl=document.getElementById('upd-'+id);
  const tEl=document.getElementById('tile-'+id);
  if(!vEl) return;
  vEl.textContent=val;
  if(uEl) uEl.textContent=new Date().toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});
  if(tEl){tEl.classList.remove('upd');void tEl.offsetWidth;tEl.classList.add('upd');}
  if(id==='eev'){
    const n=parseFloat(val)||0;
    const pct=Math.min(100,Math.round(n/480*100));
    const f=document.getElementById('eev-fill'); if(f)f.style.width=pct+'%';
    const p=document.getElementById('eev-pct'); if(p)p.textContent=pct+'%';
  }
  lastVals[id]={value:val,ts:Date.now()};
  pushPopupData(id,val);
}

// ── TILE CHART POPUP ──────────────────────────────────────────
const TILE_CHART_MAP={
  compressor:    {label:'Kompresor',    unit:'Hz',     color:'#8b5cf6',beginAtZero:true},
  fan_rpm:       {label:'Went. ODU',   unit:'rpm',    color:'#06b6d4',beginAtZero:true},
  current:       {label:'Prąd',        unit:'A',      color:'#f59e0b',beginAtZero:true},
  eev:           {label:'Zawór EEV',   unit:'kroków', color:'#06b6d4',beginAtZero:true,max:480},
  temp_module:   {label:'T. modułu',   unit:'°C',     color:'#8b5cf6',beginAtZero:false},
  temp_outside:  {label:'T. zewn.',    unit:'°C',     color:'#f97316',beginAtZero:false},
  temp_exchanger:{label:'T. wymien.',  unit:'°C',     color:'#a855f7',beginAtZero:false},
  temp_discharge:{label:'T. tłocz.',   unit:'°C',     color:'#ef4444',beginAtZero:false},
  temp_set:      {label:'T. zadana',   unit:'°C',     color:'#f59e0b',beginAtZero:false},
  temp_room:     {label:'T. pokoju',   unit:'°C',     color:'#3b82f6',beginAtZero:false},
  temp_pipe:     {label:'T. rury',     unit:'°C',     color:'#10b981',beginAtZero:false},
  humidity:      {label:'Wilgotność',  unit:'%',      color:'#60a5fa',beginAtZero:true,max:100}
};

function openTileChart(t){
  const cfg=TILE_CHART_MAP[t.id]; if(!cfg) return;
  const modal=document.getElementById('tile-chart-modal');
  document.getElementById('tile-chart-title').textContent=cfg.label;
  document.getElementById('tile-chart-unit').textContent=cfg.unit;
  const curr=document.getElementById('tile-chart-current');
  curr.textContent=document.getElementById('v-'+t.id)?.textContent||'--';
  curr.style.color=cfg.color;
  modal.classList.add('show');
  if(popupChart){popupChart.destroy();popupChart=null;}
  const buf=popupData[t.id]||{labels:[],values:[]};
  const yOpts={beginAtZero:cfg.beginAtZero,grid:{color:'rgba(255,255,255,0.06)'},ticks:{color:'#94a3b8',font:{size:11}}};
  if(cfg.max!==undefined) yOpts.max=cfg.max;
  popupChart=new Chart(document.getElementById('tile-chart-canvas').getContext('2d'),{
    type:'line',
    data:{labels:[...buf.labels],datasets:[{label:cfg.label,data:[...buf.values],
      borderColor:cfg.color,backgroundColor:cfg.color+'18',borderWidth:2,fill:true,
      tension:0.35,pointRadius:2,pointHoverRadius:5,pointBackgroundColor:cfg.color}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:0},
      plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(10,14,26,.95)',
        titleColor:'#f8fafc',bodyColor:'#cbd5e1',padding:9,cornerRadius:7,
        callbacks:{label:ctx=>`${ctx.parsed.y} ${cfg.unit}`}}},
      scales:{x:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#64748b',font:{size:9},maxRotation:40}},y:yOpts}}
  });
}
function closeTileChart(){
  document.getElementById('tile-chart-modal').classList.remove('show');
  if(popupChart){popupChart.destroy();popupChart=null;}
}
function pushPopupData(id,val){
  const num=parseFloat(val); if(isNaN(num)) return;
  if(!popupData[id]) popupData[id]={labels:[],values:[]};
  const label=new Date().toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const buf=popupData[id];
  if(buf.labels[buf.labels.length-1]!==label){buf.labels.push(label);buf.values.push(num);}
  else buf.values[buf.values.length-1]=num;
  while(buf.labels.length>maxPts){buf.labels.shift();buf.values.shift();}
  const modal=document.getElementById('tile-chart-modal');
  if(popupChart&&modal.classList.contains('show')){
    const cfg=TILE_CHART_MAP[id];
    if(cfg&&document.getElementById('tile-chart-title')?.textContent===cfg.label){
      popupChart.data.labels=[...buf.labels];
      popupChart.data.datasets[0].data=[...buf.values];
      popupChart.update('none');
      const c=document.getElementById('tile-chart-current');if(c)c.textContent=val;
    }
  }
}

// ── CHARTS ────────────────────────────────────────────────────
function initCharts(){
  if(typeof Chart==='undefined') return;
  const base={responsive:true,maintainAspectRatio:false,animation:{duration:0},
    plugins:{legend:{display:true,position:'top',labels:{color:'#94a3b8',font:{size:9},usePointStyle:true,boxWidth:6}},
      tooltip:{mode:'index',intersect:false,backgroundColor:'rgba(10,14,26,.95)',titleColor:'#f8fafc',bodyColor:'#cbd5e1',padding:8,cornerRadius:6}},
    scales:{x:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#64748b',font:{size:9},maxRotation:40}},
      y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#94a3b8',font:{size:9}},beginAtZero:false}},
    elements:{point:{radius:1,hoverRadius:4},line:{tension:0.35,borderWidth:1.8}}};
  const mk=(c,l)=>({label:l,data:[],borderColor:c,backgroundColor:c+'12',fill:true,pointBackgroundColor:c,pointRadius:1,pointHoverRadius:4});
  const bz=JSON.parse(JSON.stringify(base)); bz.scales.y.beginAtZero=true;
  const ctx=id=>document.getElementById(id)?.getContext('2d');
  charts.indoor  =new Chart(ctx('cIndoor'), {type:'line',data:{labels:[],datasets:[mk('#3b82f6','T.pokojowa'),mk('#10b981','T.rury'),mk('#f59e0b','T.zadana')]},options:JSON.parse(JSON.stringify(base))});
  charts.outdoor =new Chart(ctx('cOutdoor'),{type:'line',data:{labels:[],datasets:[mk('#8b5cf6','T.modułu'),mk('#f97316','T.zewn.'),mk('#a855f7','T.wymien.'),mk('#ef4444','T.tłocz.')]},options:JSON.parse(JSON.stringify(base))});
  charts.current =new Chart(ctx('cCurrent'),{type:'line',data:{labels:[],datasets:[mk('#f59e0b','Prąd[A]')]},options:JSON.parse(JSON.stringify(bz))});
  charts.comp    =new Chart(ctx('cComp'),   {type:'line',data:{labels:[],datasets:[mk('#8b5cf6','Kompr.[Hz]')]},options:JSON.parse(JSON.stringify(bz))});
  charts.fan     =new Chart(ctx('cFan'),    {type:'line',data:{labels:[],datasets:[mk('#06b6d4','Fan[rpm]')]},options:JSON.parse(JSON.stringify(bz))});
  charts.eev     =new Chart(ctx('cEev'),    {type:'line',data:{labels:[],datasets:[mk('#06b6d4','EEV')]},options:JSON.parse(JSON.stringify(bz))});
  charts.hum     =new Chart(ctx('cHum'),    {type:'line',data:{labels:[],datasets:[mk('#60a5fa','Wilgotność[%]')]},options:JSON.parse(JSON.stringify(bz))});
}
function pushCharts(d){
  const label=new Date().toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const push=(chart,...vals)=>{
    if(!chart) return;
    const last=chart.data.labels[chart.data.labels.length-1];
    if(last!==label){chart.data.labels.push(label);chart.data.datasets.forEach((ds,i)=>ds.data.push(parseFloat(vals[i])||0));}
    else chart.data.datasets.forEach((ds,i)=>{const p=ds.data.length-1;if(p>=0)ds.data[p]=parseFloat(vals[i])||0;});
    while(chart.data.labels.length>maxPts){chart.data.labels.shift();chart.data.datasets.forEach(ds=>ds.data.shift());}
    chart.update('none');
  };
  push(charts.indoor, d.idu.t_room,d.idu.t_pipe,d.idu.t_set);
  push(charts.outdoor,d.odu.t_mod,d.odu.t_out,d.odu.t_exch,d.odu.t_disc);
  push(charts.current,d.odu.cur);
  push(charts.comp,   d.odu.comp);
  push(charts.fan,    d.odu.fan);
  push(charts.eev,    d.odu.eev);
  push(charts.hum,    d.idu.hum);
}

function handleMqttMsg(topic,val){
  setSource('mqtt');
  const m={
    [TOPICS.compressor]:()=>setTile('compressor',val),
    [TOPICS.fan_rpm]:()=>setTile('fan_rpm',val),
    [TOPICS.current]:()=>setTile('current',val),
    [TOPICS.eev]:()=>setTile('eev',val),
    [TOPICS.temp_module]:()=>setTile('temp_module',val),
    [TOPICS.temp_outside]:()=>setTile('temp_outside',val),
    [TOPICS.temp_exchanger]:()=>setTile('temp_exchanger',val),
    [TOPICS.temp_discharge]:()=>setTile('temp_discharge',val),
    [TOPICS.mode]:()=>setModeBadge(val),
    [TOPICS.fan_speed]:()=>txt('v-fan-idu',val),
    [TOPICS.temp_set]:()=>setTile('temp_set',val),
    [TOPICS.temp_room]:()=>setTile('temp_room',val),
    [TOPICS.temp_pipe]:()=>setTile('temp_pipe',val),
    [TOPICS.humidity]:()=>{const h=document.getElementById('v-hum');if(h)h.innerHTML=val+' <span style="font-size:.65rem">%</span>';lastVals.humidity={value:val,ts:Date.now()};}
  };
  m[topic]?.();
  if(topic===TOPICS.temp_room){const d=buildFromLastVals();pushCharts(d);saveHist(d,'MQTT');}
}
function setModeBadge(mode){const mb=document.getElementById('modeBadge');if(mb){mb.textContent=mode||'OFF';mb.className='mode-badge mode-'+(mode||'OFF');}}
function buildFromLastVals(){
  const g=(k,d='0')=>lastVals[k]?.value||d;
  return{odu:{comp:g('compressor'),fan:g('fan_rpm'),cur:g('current'),eev:g('eev'),t_mod:g('temp_module'),t_out:g('temp_outside'),t_exch:g('temp_exchanger'),t_disc:g('temp_discharge')},
         idu:{mode:g('mode','OFF'),fan:g('fan_speed','--'),t_set:g('temp_set'),t_room:g('temp_room'),t_pipe:g('temp_pipe'),hum:g('humidity','0')}};
}

// ── HISTORY ───────────────────────────────────────────────────
function saveHist(d,src){
  histData.unshift({ts:new Date().toLocaleTimeString('pl-PL'),mode:d.idu.mode||'--',fan:d.idu.fan||'--',
    t_set:d.idu.t_set,t_room:d.idu.t_room,t_pipe:d.idu.t_pipe,hum:d.idu.hum||0,
    comp:d.odu.comp,fan_rpm:d.odu.fan,cur:d.odu.cur,eev:d.odu.eev||0,
    t_out:d.odu.t_out,t_exch:d.odu.t_exch,t_disc:d.odu.t_disc,t_mod:d.odu.t_mod,src});
  if(histData.length>maxHist) histData.pop();
  renderHist();
}
function renderHist(){
  const tbody=document.getElementById('hist-body'); if(!tbody) return;
  const lim=parseInt(document.getElementById('hLimit')?.value)||100;
  const data=lim?histData.slice(0,lim):histData;
  if(!data.length){tbody.innerHTML='<tr><td colspan="12" style="text-align:center;padding:24px;color:var(--txt3)">Brak danych</td></tr>';return;}
  const sc={WS:'src-ws',MQTT:'src-mqtt',CSV:'src-csv'};
  tbody.innerHTML=data.map(r=>`<tr><td>${r.ts}</td><td>${r.mode}</td><td>${r.t_set}°</td><td>${r.t_room}°</td><td>${r.t_pipe}°</td><td>${r.hum}%</td><td>${r.comp}Hz</td><td>${r.fan_rpm}rpm</td><td>${r.cur}A</td><td>${r.eev}</td><td>${r.t_out}°</td><td><span class="src-badge ${sc[r.src]||''}" style="font-size:.62rem">${r.src}</span></td></tr>`).join('');
  const hc=document.getElementById('hist-count'); if(hc)hc.textContent=histData.length+' rekordów';
}
function exportCSV(){
  if(!histData.length){toast('Brak danych!',true);return;}
  const hdr='Czas,Tryb,T.zadana,T.pokoju,T.rury,Wilgotnosc,Kompresor,Fan.ODU,Prad,EEV,T.zewn,Zrodlo\n';
  const rows=histData.map(r=>[r.ts,r.mode,r.t_set,r.t_room,r.t_pipe,r.hum,r.comp,r.fan_rpm,r.cur,r.eev,r.t_out,r.src].join(',')).join('\n');
  const blob=new Blob(['\uFEFF'+hdr+rows],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=`rac_${new Date().toISOString().slice(0,10)}.csv`; a.click();
  toast('Wyeksportowano CSV!');
}

// ── MQTT ──────────────────────────────────────────────────────
function mqttConn(){
  const url=document.getElementById('mqtt-url').value.trim();
  const user=document.getElementById('mqtt-user').value.trim();
  const pass=document.getElementById('mqtt-pass').value.trim();
  if(!url){toast('Wpisz adres brokera!',true);return;}
  mqttDisc(); setMqttSt('warn','Łączenie...');
  try{
    mqttClient=mqtt.connect(url,{username:user,password:pass,clientId:'RAC_PWA_'+Date.now(),clean:true,reconnectPeriod:5000,connectTimeout:15000,keepalive:60,rejectUnauthorized:false});
    mqttClient.on('connect',()=>{setMqttSt('ok','Połączono');dot('d-mqtt','ok');txt('t-mqtt',url.split('/')[2]?.split(':')[0]||'OK');Object.values(TOPICS).forEach(t=>mqttClient.subscribe(t));addMqttLog('system','Połączono');});
    mqttClient.on('message',(topic,payload)=>{const val=payload.toString();addMqttLog(topic,val);handleMqttMsg(topic,val);});
    mqttClient.on('error',err=>{setMqttSt('err','Błąd');addMqttLog('ERR',err.message);});
    mqttClient.on('close',()=>{setMqttSt('err','Rozłączono');dot('d-mqtt','err');txt('t-mqtt','Rozłączono');if(dataSource==='mqtt')setSource('none');});
    mqttClient.on('reconnect',()=>setMqttSt('warn','Łączenie...'));
  }catch(e){setMqttSt('err',e.message);}
  saveSettings();
}
function mqttDisc(){if(mqttClient){mqttClient.end();mqttClient=null;}setMqttSt('warn','Rozłączono');dot('d-mqtt','');txt('t-mqtt','Rozłączono');}
function setMqttSt(cls,msg){const el=document.getElementById('mqtt-status');if(el){el.className='conn-status '+cls;el.innerHTML=`<i class="fas fa-circle"></i> ${msg}`;}}
function addMqttLog(topic,val){
  const log=document.getElementById('mqtt-log'); if(!log) return;
  if(log.querySelector('span')) log.innerHTML='';
  const d=document.createElement('div'); d.className='msg-item';
  d.innerHTML=`<span class="msg-time">${new Date().toLocaleTimeString('pl-PL')}</span><span class="msg-topic">${topic}</span>= ${val}`;
  log.prepend(d);
  while(log.children.length>50) log.removeChild(log.lastChild);
}

// ── CSV — iOS używa <input type="file"> ───────────────────────
function loadCsv(){
  document.getElementById('csv-file-input').click();
}
function parseCsvFile(file){
  const reader=new FileReader();
  reader.onload=e=>{
    const lines=e.target.result.split('\n').filter(l=>l.trim());
    if(lines.length<2){toast('Plik CSV jest pusty!',true);return;}
    const header=lines[0].split(',');
    csvRows=lines.slice(1).map(line=>{
      const cols=line.split(','); const obj={};
      header.forEach((h,i)=>obj[h.trim()]=cols[i]?.trim()||'');
      return obj;
    }).filter(r=>r['Czas']||r['Godzina']||r['czas']);
    if(!csvRows.length){toast('Brak danych w pliku!',true);return;}
    pbIdx=0; pbStop();
    txt('csv-info',`${file.name} — ${csvRows.length} rek.`);
    dot('d-csv','warn'); txt('t-csv',`${csvRows.length} rek.`);
    document.getElementById('pb-bar').style.display='block';
    document.getElementById('mini-pb-home').style.display='block';
    document.getElementById('mini-pb-charts').style.display='block';
    updatePbUI();
    toast(`Wczytano ${csvRows.length} rekordów`,'info');
  };
  reader.readAsText(file,'UTF-8');
}

// ── CSV PLAYBACK ──────────────────────────────────────────────
function pbPlay(){
  if(!csvRows.length){toast('Najpierw wczytaj CSV!',true);return;}
  if(pbPlaying) return;
  if(pbIdx>=csvRows.length) pbIdx=0;
  pbPlaying=true; setSource('csv');
  dot('d-csv','ok'); txt('t-csv','Odtwarzanie...');
  document.getElementById('btnPbPlay')?.classList.add('pbactive');
  document.getElementById('m-play-h')?.classList.add('pbactive');
  document.getElementById('m-play-c')?.classList.add('pbactive');
  const speed=parseFloat(document.getElementById('pb-speed')?.value)||1;
  const interval=Math.round(1000/speed);
  pbTimer=setInterval(()=>{
    if(pbIdx>=csvRows.length){pbStop();toast('Koniec nagrania!');return;}
    playCsvRow(csvRows[pbIdx]); pbIdx++; updatePbUI();
  },interval);
}
function pbPause(){
  if(!pbPlaying) return; pbPlaying=false;
  clearInterval(pbTimer); pbTimer=null;
  ['btnPbPlay','m-play-h','m-play-c'].forEach(id=>document.getElementById(id)?.classList.remove('pbactive'));
  dot('d-csv','warn'); txt('t-csv','Pauza');
}
function pbStop(){
  pbPlaying=false; clearInterval(pbTimer); pbTimer=null; pbIdx=0;
  ['btnPbPlay','m-play-h','m-play-c'].forEach(id=>document.getElementById(id)?.classList.remove('pbactive'));
  if(csvRows.length){updatePbUI();dot('d-csv','warn');txt('t-csv',`${csvRows.length} rek.`);}
  if(dataSource==='csv') setSource('none');
}
function updatePbUI(){
  const total=csvRows.length;
  const pct=total?Math.round(pbIdx/total*100):0;
  const frameStr=`${pbIdx}/${total}`;
  const r=csvRows[Math.min(pbIdx,total-1)];
  const tsStr=r?((r['Data']||r['data']||'')+' '+(r['Czas']||r['Godzina']||r['czas']||'')).trim():'--';
  ['pb-fill','mini-pb-fill-h','mini-pb-fill-c'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.width=pct+'%';});
  ['pb-frame','mini-pb-frame-h','mini-pb-frame-c'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=frameStr;});
  ['pb-ts','mini-pb-ts-h','mini-pb-ts-c'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=tsStr;});
  if(csvRows[0]) {const e=document.getElementById('pb-t0');if(e)e.textContent=((csvRows[0]['Data']||'')+' '+(csvRows[0]['Czas']||csvRows[0]['Godzina']||'')).trim();}
  if(csvRows[total-1]){const e=document.getElementById('pb-t1');if(e)e.textContent=((csvRows[total-1]['Data']||'')+' '+(csvRows[total-1]['Czas']||csvRows[total-1]['Godzina']||'')).trim();}
}
function seekPb(e,trackId){
  if(!csvRows.length) return;
  const track=document.getElementById(trackId); if(!track) return;
  const rect=track.getBoundingClientRect();
  const pct=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));
  pbIdx=Math.min(Math.round(pct*csvRows.length),csvRows.length-1);
  updatePbUI(); if(pbIdx<csvRows.length) playCsvRow(csvRows[pbIdx]);
}
function playCsvRow(row){
  const g=(keys,def='0')=>{for(const k of keys){if(row[k]!==undefined&&row[k]!=='')return row[k];}return def;};
  const s=v=>v.replace(/[°%AHzrpm\s]/g,'').trim();
  const d={
    odu:{comp:s(g(['Kompresor [Hz]','Kompresor','comp','Kompr.Hz'],'0')),fan:s(g(['Wentylator ODU [rpm]','Fan.rpm','fan_rpm'],'0')),
         cur:s(g(['Prąd [A]','Prad[A]','current'],'0')),eev:s(g(['EEV','eev'],'0')),
         t_mod:s(g(['Temp. modułu [°C]','T.modul','temp_module'],'0')),t_out:s(g(['Temp. zewnętrzna [°C]','T.zewn.','temp_outside','T.zewn'],'0')),
         t_exch:s(g(['Temp. wymiennika [°C]','T.wymien.','temp_exchanger'],'0')),t_disc:s(g(['Temp. tłoczenia [°C]','T.tlocz.','temp_discharge'],'0'))},
    idu:{mode:g(['Tryb pracy','Tryb','mode'],'OFF'),fan:g(['Wentylator IDU','Went.IDU','fan_speed'],'--'),
         t_set:s(g(['Temp. zadana [°C]','T.zadana','temp_set'],'0')),t_room:s(g(['Temp. pokojowa [°C]','T.pokoju','temp_room'],'0')),
         t_pipe:s(g(['Temp. rury [°C]','T.rury','temp_pipe'],'0')),hum:s(g(['Wilgotność [%]','Wilg.%','humidity','Wilgotnosc'],'0'))}
  };
  setTile('compressor',d.odu.comp);setTile('fan_rpm',d.odu.fan);setTile('current',d.odu.cur);setTile('eev',d.odu.eev);
  setTile('temp_module',d.odu.t_mod);setTile('temp_outside',d.odu.t_out);setTile('temp_exchanger',d.odu.t_exch);setTile('temp_discharge',d.odu.t_disc);
  setTile('temp_set',d.idu.t_set);setTile('temp_room',d.idu.t_room);setTile('temp_pipe',d.idu.t_pipe);
  setModeBadge(d.idu.mode); txt('v-fan-idu',d.idu.fan);
  const h=document.getElementById('v-hum');if(h)h.innerHTML=d.idu.hum+' <span style="font-size:.65rem">%</span>';
  pushCharts(d);
}

// ── RESET ESP32 ───────────────────────────────────────────────
function resetEsp32(){
  const topic = document.getElementById('mqtt-reset-topic')?.value || 'rac/command/reset';
  if(mqttClient && mqttClient.connected){
    mqttClient.publish(topic, 'reset');
    toast('Wysłano komendę reset przez MQTT!');
  } else {
    toast('Brak połączenia! Najpierw połącz się z MQTT.','er');
  }
}

// ── SOURCE ────────────────────────────────────────────────────
function setSource(src){
  dataSource=src;
  const el=document.getElementById('src-ind'); if(!el) return;
  const c={mqtt:{cls:'src-mqtt',txt:'🔵 MQTT'},csv:{cls:'src-csv',txt:'🟡 CSV'},none:{cls:'src-none',txt:'Brak źródła'}}[src]||{cls:'src-none',txt:'Brak źródła'};
  el.className='src-badge '+c.cls; el.textContent=c.txt;
}

// ── HELPERS ───────────────────────────────────────────────────
function dot(id,cls){const e=document.getElementById(id);if(e)e.className='dot'+(cls?' '+cls:'');}
function txt(id,v){const e=document.getElementById(id);if(e)e.innerHTML=v;}
function toast(msg,type='ok'){
  const d=document.createElement('div');d.className='toast '+(type===true?'er':type==='info'?'info':'ok');
  d.textContent=msg;document.body.appendChild(d);setTimeout(()=>d.remove(),3100);
}
function saveSettings(){
  localStorage.setItem('racConn',JSON.stringify({
    mqttUrl:document.getElementById('mqtt-url')?.value||'',
    mqttUser:document.getElementById('mqtt-user')?.value||''
  }));
}
function loadSavedSettings(){
  try{
    const s=JSON.parse(localStorage.getItem('racConn'));
    if(!s) return;
    if(s.mqttUrl&&document.getElementById('mqtt-url'))  document.getElementById('mqtt-url').value=s.mqttUrl;
    if(s.mqttUser&&document.getElementById('mqtt-user'))document.getElementById('mqtt-user').value=s.mqttUser;
  }catch(e){}
}

// ── EVENT LISTENERS ───────────────────────────────────────────
function initEventListeners(){
      document.getElementById('btnMqttConn')?.addEventListener('click',mqttConn);
  document.getElementById('btnMqttDisc')?.addEventListener('click',mqttDisc);
  document.getElementById('btnClrLog')?.addEventListener('click',()=>{const l=document.getElementById('mqtt-log');if(l)l.innerHTML='<span style="color:var(--txt3)">Brak wiadomości...</span>';});
  document.getElementById('btnLoadCsv')?.addEventListener('click',loadCsv);
  document.getElementById('csv-file-input')?.addEventListener('change',e=>{const f=e.target.files[0];if(f)parseCsvFile(f);e.target.value='';});
  document.getElementById('btnPbPlay')?.addEventListener('click',pbPlay);
  document.getElementById('btnPbPause')?.addEventListener('click',pbPause);
  document.getElementById('btnPbStop')?.addEventListener('click',pbStop);
  document.getElementById('btnPbRew')?.addEventListener('click',()=>{pbStop();pbPlay();});
  document.getElementById('pb-speed')?.addEventListener('change',()=>{if(pbPlaying){pbPause();pbPlay();}});
  document.getElementById('pb-track')?.addEventListener('click',e=>seekPb(e,'pb-track'));
  ['h','c'].forEach(suf=>{
    document.getElementById(`m-play-${suf}`)?.addEventListener('click',pbPlay);
    document.getElementById(`m-pause-${suf}`)?.addEventListener('click',pbPause);
    document.getElementById(`m-stop-${suf}`)?.addEventListener('click',pbStop);
    document.getElementById(`m-rew-${suf}`)?.addEventListener('click',()=>{pbStop();pbPlay();});
    document.getElementById(`m-speed-${suf}`)?.addEventListener('change',e=>{document.getElementById('pb-speed').value=e.target.value;if(pbPlaying){pbPause();pbPlay();}});
    document.getElementById(`mini-pb-track-${suf}`)?.addEventListener('click',e=>seekPb(e,`mini-pb-track-${suf}`));
  });
  document.getElementById('btnApplyRange')?.addEventListener('click',()=>{
    const v=parseInt(document.getElementById('rangeSelect').value)||60;
    maxPts=v<=30?30:v<=60?60:120; toast('Okno zmienione!');
  });
  document.getElementById('btnClearCharts')?.addEventListener('click',()=>{
    Object.values(charts).forEach(c=>{if(c){c.data.labels=[];c.data.datasets.forEach(ds=>ds.data=[]);c.update();}});
    toast('Wykresy wyczyszczone!');
  });
  document.getElementById('btnExport')?.addEventListener('click',exportCSV);
  document.getElementById('btnClrHist')?.addEventListener('click',()=>{if(!confirm('Wyczyścić historię?'))return;histData=[];renderHist();toast('Historia wyczyszczona!');});
  document.getElementById('hLimit')?.addEventListener('change',renderHist);
  document.getElementById('btnReset')?.addEventListener('click',()=>{
    document.getElementById('resetModal').classList.add('show');
  });
  document.getElementById('cancelReset')?.addEventListener('click',()=>{
    document.getElementById('resetModal').classList.remove('show');
  });
  document.getElementById('confirmReset')?.addEventListener('click',()=>{
    document.getElementById('resetModal').classList.remove('show');
    resetEsp32();
  });
  document.getElementById('resetModal')?.addEventListener('click',e=>{
    if(e.target===document.getElementById('resetModal')) document.getElementById('resetModal').classList.remove('show');
  });
  document.getElementById('tile-chart-close')?.addEventListener('click',closeTileChart);
  document.getElementById('tile-chart-modal')?.addEventListener('click',e=>{if(e.target===document.getElementById('tile-chart-modal'))closeTileChart();});
}
