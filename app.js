'use strict';
const $=id=>document.getElementById(id),cfg=window.SCAN_CONFIG,base='https://cloud-api.yandex.net/v1/disk';
let token=sessionStorage.getItem('scan_token')||'',mode='',owner='',events=[],draft=null,action='',reader=null,busy=false;
const redirect=location.origin+location.pathname;let root=cfg.root;
let statusTimer,selectedName='',actURL='',periodState=ScanPeriods.state();
function screen(name){stopCamera();document.body.dataset.screen=name;for(const id of ['connect','helpScreen','home','entry','draft','chooseName','reportScreen'])$(id).hidden=id!==name;$('workspace').hidden=!['home','entry','draft','chooseName','reportScreen'].includes(name);$('status').hidden=true;}

const dbp=new Promise((resolve,reject)=>{const r=indexedDB.open('scan-test-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('store');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('Браузер не разрешил локальное сохранение.'));});
async function db(op,key,value){const d=await dbp;return new Promise((res,rej)=>{const t=d.transaction('store',op==='get'?'readonly':'readwrite'),s=t.objectStore('store');let r=op==='get'?s.get(key):op==='put'?s.put(value,key):s.delete(key);t.oncomplete=()=>res(r.result);t.onerror=()=>rej(Error('Не удалось сохранить данные на телефоне. Проверьте свободное место.'));});}
function msg(s,error=false){clearTimeout(statusTimer);$('status').textContent=s;$('status').classList.toggle('error',error);$('status').hidden=false;if(!error)statusTimer=setTimeout(()=>{$('status').hidden=true;},3500);}
async function run(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){msg(e.message||'Ошибка',true);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
function bind(id,fn){$(id).onclick=()=>run(fn);}
async function request(url,options={}){
 for(let attempt=0;attempt<3;attempt++){
 let r;try{r=await fetch(url,{...options,signal:AbortSignal.timeout(90000)});}catch{throw Error('Нет ответа сети. Черновик сохранён; проверьте интернет и повторите отправку.');}
 if(r.ok)return r;
 let body={};try{body=await r.json();}catch{}
 const serviceCode=typeof body.error==='string'&&/^[A-Za-z0-9_]{1,100}$/.test(body.error)?body.error:'';
 if(r.status===423&&serviceCode==='DiskResourceLockedError'&&attempt<2){msg('Яндекс временно блокирует файл. Повтор '+(attempt+1)+' из 2…');await new Promise(resolve=>setTimeout(resolve,(attempt+1)*2000));continue;}
 let detail=r.status===401?'Подключите Яндекс заново.':r.status===403?'Проверьте разрешения приложения и ограничения Диска.':r.status===507?'На Диске не хватает места.':r.status===423?'Яндекс заблокировал операцию. Проверьте, загружается ли файл через сам Яндекс Диск.': 'Повторите позже.';
 if(serviceCode==='DiskUploadTrafficLimitExceeded')detail='Яндекс сообщил об исчерпанном лимите загрузки. Повторное нажатие не снимет это ограничение.';
 if(serviceCode==='DiskResourceLockedError')detail='Файл занят другой операцией Яндекса. Два повтора не помогли; попробуйте позже.';
 const e=Error('HTTP '+r.status+'. '+detail+(serviceCode?' Код Яндекса: '+serviceCode+'.':''));e.status=r.status;e.serviceCode=serviceCode;throw e;
 }
}
async function api(path,method='GET'){return request(base+path,{method,headers:{Authorization:'OAuth '+token}});}
const pathq=p=>encodeURIComponent(p);
async function mkdir(p){try{await api('/resources?path='+pathq(p),'PUT');}catch(e){if(e.status!==409)throw e;const r=await (await api('/resources?path='+pathq(p))).json();if(r.type!=='dir')throw Error('На месте папки существует файл: '+p);}}
function safeURL(href){const u=new URL(href);if(u.protocol!=='https:'||!(u.hostname.endsWith('.yandex.net')||u.hostname.endsWith('.yandex.ru')||u.hostname.endsWith('.yandex.com')))throw Error('Неожиданный адрес загрузки от Диска.');return u.href;}
async function upload(p,blob){let stage='Получение разрешения на запись';const label=p.endsWith('/Учёт.xlsx')?'Excel-отчёт':p.endsWith('.json')?'запись учёта':p.endsWith('.ods')?'акт передачи':'фотография';try{const u=await(await api('/resources/upload?overwrite=true&path='+pathq(p))).json();stage='Передача файла';await request(safeURL(u.href),{method:'PUT',body:blob});}catch(e){e.message=stage+' ('+label+'). '+e.message;throw e;}}
async function readJSON(p){const d=await(await api('/resources/download?path='+pathq(p))).json();return(await request(safeURL(d.href))).json();}
async function refresh(){if(mode==='demo'){events=await db('get','demo_events')||[];}else{let items=[],offset=0;while(true){const data=await(await api('/resources?path='+pathq(root+'/Данные')+'&limit=100&offset='+offset)).json();const page=data._embedded?.items||[];items.push(...page.filter(x=>x.type==='file'&&x.name.endsWith('.json')));if(page.length<100)break;offset+=100;}const loaded=[];for(const item of items){const e=await readJSON(item.path);if(e.version!==1||!['in','out'].includes(e.kind)||typeof e.id!=='string'||typeof e.code!=='string'||typeof e.at!=='string')throw Error('Неизвестный формат файла учёта. Обновление остановлено.');loaded.push(e);}events=loaded;}await loadPeriods();render();}
async function putEvent(e){if(mode==='demo'){let all=await db('get','demo_events')||[];all=all.filter(x=>x.id!==e.id);all.push(e);await db('put','demo_events',all);}else await upload(root+'/Данные/'+e.id+'.json',new Blob([JSON.stringify(e)],{type:'application/json'}));events=events.filter(x=>x.id!==e.id);events.push(e);render();}
function diskLink(p){return 'https://disk.yandex.ru/client/disk'+p.replace(/^disk:/,'').split('/').map(encodeURIComponent).join('/');}
function render(){const cycles=ScanCore.project(events),filter=$('search').value.trim();$('rows').replaceChildren();$('count').textContent=String(cycles.length);$('empty').hidden=cycles.length>0;for(const c of cycles.filter(c=>c.code.includes(filter))){const tr=document.createElement('tr');tr.className=c.status==='done'?'done':c.status==='pending'?'pending':'';for(const v of [c.code,new Date(c.at).toLocaleString('ru-RU'),{available:'В наличии',pending:'Ожидает фото',done:'Выбыл'}[c.status]]){const td=document.createElement('td');td.textContent=v;tr.append(td);}const td=document.createElement('td');if(c.out?.folder&&mode!=='demo'){const a=document.createElement('a');a.textContent='Папка ↗';a.href=diskLink(c.out.folder);a.target='_blank';a.rel='noopener';td.append(a);}else td.textContent='—';tr.append(td);$('rows').append(tr);}}
async function saveDraft(){await db('put','draft:'+owner,draft);}
function showDraft(){const yes=!!draft;$('draft').hidden=!yes;if(!yes)return;$('draftTitle').textContent=draft.kind==='in'?'Поступление: ожидает отправки':'Выбытие: добавьте фотографии';$('draftCode').textContent=[draft.name,draft.code].filter(Boolean).join(' · ');$('photoFields').hidden=draft.kind==='in';for(let i=0;i<3;i++){const img=$('preview'+i);if(img.dataset.url)URL.revokeObjectURL(img.dataset.url);img.hidden=!draft.photos?.[i];if(!img.hidden){img.src=URL.createObjectURL(draft.photos[i]);img.dataset.url=img.src;}}}
async function connect(demo=false){mode=demo?'demo':'disk';if(demo){owner='demo';$('account').textContent='ДЕМО · данные только в этом браузере';}else{msg('Проверяю доступ к Диску…');const info=await(await api('/')).json();if(!info.user?.uid)throw Error('Не удалось определить владельца Диска.');owner='disk:'+info.user.uid+':'+root;$('account').textContent='Яндекс · '+(info.user.login||info.user.display_name||info.user.uid);await mkdir(root);await mkdir(root+'/Данные');await mkdir(root+'/Фото');sessionStorage.setItem('scan_token',token);}$('folder').hidden=demo;$('folder').href=diskLink(root);$('report').hidden=demo;await refresh();draft=await db('get','draft:'+owner)||null;showDraft();screen('home');msg(draft?'Восстановлен незавершённый черновик. Продолжите отправку.':demo?'ДЕМО: можно проверять сценарий; на Диск ничего не отправляется.':'Диск подключён. Можно сканировать.');}
function stopCamera(){if(reader){reader.reset();reader=null;}const stream=$('video').srcObject;if(stream)stream.getTracks().forEach(t=>t.stop());$('video').srcObject=null;$('video').hidden=true;$('stop').hidden=true;}
function enter(kind){if(draft){if(draft.kind===kind){showDraft();screen('draft');return;}throw Error('Завершите текущую операцию: нажмите '+(draft.kind==='in'?'«Новый».':'«Выбыл».'));}screen('entry');action=kind;$('entry').hidden=false;$('actionTitle').textContent=kind==='in'?'Поступление: '+selectedName:'Оформить выбытие';$('code').value='';$('code').focus();}
async function accept(){stopCamera();if(action==='in'&&!ScanReport.names.includes(selectedName))throw Error('Сначала выберите наименование.');const code=ScanCore.code($('code').value);await refresh();ensurePeriodOpen();const cycle=ScanCore.validate(events,action,code);draft={version:1,id:crypto.randomUUID(),kind:action,code,name:action==='in'?selectedName:(cycle?.name||''),at:new Date().toISOString(),status:action==='out'?'pending':'available',cycle:cycle?.id,photos:[]};if(action==='out')draft.folder=root+'/Фото/'+encodeURIComponent(code)+'/'+draft.at.replace(/[:.]/g,'-')+'_'+draft.id.slice(0,8);await saveDraft();$('entry').hidden=true;showDraft();screen('draft');if(action==='in')await send();else{await putEvent(eventFromDraft('pending'));try{await saveReport();}catch{msg('Черновик сохранён. Excel пока не обновлён; добавьте фотографии.',true);return;}msg('Сделайте фото номера и общий план.');}}
function eventFromDraft(status){const {photos,...e}=draft;return {...e,status,photoCount:photos.filter(Boolean).length};}
async function send(){if(!draft)throw Error('Нет черновика.');await refresh();ensurePeriodOpen();const existing=events.find(e=>e.id===draft.id);if(draft.kind==='out'&&existing?.status!=='done'&&(!draft.photos[0]||!draft.photos[1]))throw Error('Нужны два фото: номер и общий план.');if(!existing){ScanCore.validate(events,draft.kind,draft.code);}if(existing?.status!=='done'||draft.kind==='in'){if(draft.kind==='out'){if(!existing)await putEvent(eventFromDraft('pending'));if(mode==='disk'){await mkdir(root+'/Фото/'+encodeURIComponent(draft.code));await mkdir(draft.folder);for(let i=0;i<3;i++)if(draft.photos[i]){msg('Загружаю фото '+(i+1)+'…');await upload(draft.folder+'/'+['01_номер.jpg','02_общий.jpg','03_средний.jpg'][i],draft.photos[i]);}}if(!draft.completedAt){draft.completedAt=new Date().toISOString();await saveDraft();}await putEvent(eventFromDraft('done'));}else if(!existing)await putEvent(eventFromDraft('available'));}msg('Операция записана. Обновляю Excel…');try{await saveReport();}catch(e){$('draftTitle').textContent='Запись сохранена, Excel не обновлён';throw Error('Операция уже записана на Диске. Не создавайте её заново. '+e.message+' Кнопка повтора обновит отчёт.');}await db('delete','draft:'+owner);draft=null;showDraft();screen('home');msg(mode==='demo'?'Сохранено в ДЕМО. На Диск ничего не отправлено.':'Сохранено: запись, фотографии и Excel на вашем Диске.');}
async function workbook(closed=periodState.closed){
 if(!window.ExcelJS)throw Error('Не загружена библиотека Excel. Проверьте папку vendor.');
 const wb=new ExcelJS.Workbook();wb.creator='SCAN';
 const sheets=[{label:'Общий реестр',rows:ScanCore.project(events),registry:true},...closed.map(p=>({label:p.label,rows:p.reportRows||p.rows.filter(c=>c.status==='done'),registry:false}))];
 for(const period of sheets){
  const sheet=wb.addWorksheet(period.label);
  sheet.columns=[{header:'Штрихкод',width:28},{header:'Наименование',width:22},{header:'Поступление',width:25},{header:'Выбытие / начало',width:25},{header:'Статус',width:22},{header:'Фотографии',width:45}];
  sheet.views=[{state:'frozen',ySplit:1}];sheet.getColumn(1).numFmt='@';
  sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF17372B'}};
  for(const c of period.rows){
   const link=c.out?.folder&&mode==='disk'?{text:'Открыть фотографии',hyperlink:diskLink(c.out.folder)}:'';
   const row=sheet.addRow([c.code,c.name||'',new Date(c.at).toLocaleString('ru-RU'),c.out?new Date(c.out.completedAt||c.out.at).toLocaleString('ru-RU'):'',{available:'В наличии',pending:'Ожидает фото',done:'Выбыл'}[c.status],link]);
   if(period.registry&&c.status!=='available')row.eachCell({includeEmpty:true},cell=>cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:c.status==='done'?'FFFFDAD5':'FFFFE8A3'}});
  }
  sheet.autoFilter={from:'A1',to:'F'+Math.max(1,sheet.rowCount)};
 }
 return new Blob([await wb.xlsx.writeBuffer()],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
async function saveReport(){if(mode==='disk')await upload(root+'/Учёт.xlsx',await workbook());}
async function photo(file){if(!file)return null;if(file.size>25*1024*1024)throw Error('Фото больше 25 МБ. Выберите меньший размер.');const url=URL.createObjectURL(file);try{const img=new Image();img.src=url;await img.decode();const ratio=Math.min(1,1920/Math.max(img.width,img.height));const c=document.createElement('canvas');c.width=Math.round(img.width*ratio);c.height=Math.round(img.height*ratio);c.getContext('2d').drawImage(img,0,0,c.width,c.height);const blob=await new Promise(res=>c.toBlob(res,'image/jpeg',.86));if(!blob)throw Error();return blob;}catch{throw Error('Не удалось прочитать снимок. Используйте камеру или JPEG/PNG.');}finally{URL.revokeObjectURL(url);}}
$('client').value=cfg.clientId||localStorage.getItem('scan_client')||'7d5c1c90a4fb4650b6f9ca4cface198b';$('redirect').textContent=redirect;
bind('help',()=>screen('helpScreen'));bind('helpBack',()=>screen('connect'));bind('draftBack',()=>screen('home'));
bind('login',async()=>{const id=$('client').value.trim();if(!id)throw Error('Сначала укажите Client ID в настройках подключения.');localStorage.setItem('scan_client',id);const state=crypto.randomUUID();sessionStorage.setItem('scan_state',state);location.href='https://oauth.yandex.ru/authorize?'+new URLSearchParams({response_type:'token',client_id:id,redirect_uri:redirect,state,force_confirm:'yes'});});
bind('manual',async()=>{token=$('token').value.trim();$('token').value='';if(!token)throw Error('Введите OAuth-токен.');await connect();});bind('demo',()=>connect(true));bind('logout',async()=>{stopCamera();sessionStorage.removeItem('scan_token');location.replace(redirect);});bind('incoming',()=>{if(draft)return enter('in');selectedName='';screen('chooseName');});bind('outgoing',()=>enter('out'));bind('accept',accept);bind('cancel',()=>{stopCamera();screen('home');});bind('stop',stopCamera);bind('send',send);bind('refresh',async()=>{await refresh();msg('Учёт загружен.');});bind('report',async()=>{await refresh();await saveReport();msg('Excel обновлён на Диске.');});bind('download',async()=>{const blob=await workbook(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Учёт.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);});$('search').oninput=render;
bind('camera',async()=>{if(!navigator.mediaDevices?.getUserMedia)throw Error('Камере нужен HTTPS и Safari/Chrome. Откройте опубликованный сайт.');if(!window.ZXing)throw Error('Не загружен сканер. Проверьте vendor.');stopCamera();$('video').hidden=false;$('stop').hidden=false;reader=new ZXing.BrowserMultiFormatReader();await reader.decodeFromConstraints({video:{facingMode:{ideal:'environment'},width:{ideal:1280}},audio:false},$('video'),(result)=>{if(result){$('code').value=result.getText();stopCamera();msg('Код считан. Проверьте и нажмите «Продолжить».');}});});
for(let i=0;i<3;i++)$('photo'+i).onchange=()=>run(async()=>{if(!draft)return;const blob=await photo($('photo'+i).files[0]);if(!blob)return;draft.photos[i]=blob;await saveDraft();showDraft();msg('Фото '+(i+1)+' сохранено в черновике.');});
window.addEventListener('pagehide',stopCamera);
(async()=>{const h=new URLSearchParams(location.hash.slice(1));if(h.has('access_token')||h.has('error')){history.replaceState(null,'',redirect);const expected=sessionStorage.getItem('scan_state');sessionStorage.removeItem('scan_state');if(!expected||h.get('state')!==expected){msg('Ответ авторизации не подтверждён. Подключитесь заново.',true);return;}if(h.has('error')){msg('Яндекс отклонил авторизацию. Проверьте приложение и адрес возврата.',true);return;}token=h.get('access_token');}if(token)await run(()=>connect());})();

// Incoming product selection and template-based departure report.
bind('nameBack',()=>screen('home'));
for(const button of document.querySelectorAll('[data-name]'))button.onclick=()=>run(()=>{selectedName=button.dataset.name;enter('in');});
bind('reportBack',()=>screen('home'));
const departed=()=>ScanPeriods.departures(events,periodState.closed);
function showMissingNames(items){
  $('missingNames').replaceChildren();
  for(const c of items.filter(c=>!ScanReport.names.includes(c.name))){
    const label=document.createElement('label');label.textContent='Наименование для '+c.code;
    const select=document.createElement('select');select.dataset.cycle=c.id;select.required=true;
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Выберите наименование';select.append(placeholder);
    for(const name of ScanReport.names){const opt=document.createElement('option');opt.value=name;opt.textContent=name;select.append(opt);}
    label.append(select);$('missingNames').append(label);
  }
  const missing=$('missingNames').children.length;
  $('generateAct').hidden=!missing;
  if(missing)$('reportInfo').textContent='В старых записях не указано наименование. Выберите его для '+missing+' изделий. Оно сохранится в основном реестре.';
  return missing;
}
async function loadPeriods(){
 if(mode==='demo'){periodState=ScanPeriods.state(await db('get','demo_periods'));return;}
 try{periodState=ScanPeriods.state(await readJSON(root+'/Периоды.json'));}catch(e){if(e.status!==404)throw e;periodState=ScanPeriods.state();}
}
async function writePeriods(next){
 if(mode==='demo')await db('put','demo_periods',next);
 else await upload(root+'/Периоды.json',new Blob([JSON.stringify(next)],{type:'application/json'}));
 periodState=next;
}
function ensurePeriodOpen(){if(periodState.pending)throw Error('Завершите формирование отчёта: нажмите «Отчёт». Новые сканы пока не записываются.');}
async function createAct(){
 if(draft||events.some(e=>e.kind==='out'&&e.status!=='done'))throw Error('Сначала завершите незавершённые операции и загрузку фотографий. Затем сформируйте отчёт.');
 let period=periodState.pending;
 if(!period){
  const items=departed();
  if(!items.length){$('reportInfo').textContent='Нет новых завершённых выбытий для отчёта. Общий реестр сохраняется без изменений.';return;}
  if(showMissingNames(items))return;
  period=ScanPeriods.snapshot(events,periodState.closed,crypto.randomUUID());
 }
 $('reportInfo').textContent='Формирую отчёт за период '+period.label+'…';
 const response=await fetch('templates/report.ods?v=0.5');
 if(!response.ok)throw Error('Не найден шаблон. Загрузите папку templates из обновления.');
 const data=await ScanReport.build(await response.arrayBuffer(),period.reportRows,new Date(period.at));
 const blob=new Blob([data],{type:'application/vnd.oasis.opendocument.spreadsheet'});
 if(actURL)URL.revokeObjectURL(actURL);actURL=URL.createObjectURL(blob);
 // Persist a recoverable closing operation before changing the report or workbook.
 if(!periodState.pending)await writePeriods({...periodState,pending:period});
 const closed=[...periodState.closed,period];
 if(mode==='disk'){
  await mkdir(root+'/Отчёты');await mkdir(root+'/Отчёты/'+period.label);
  await upload(root+'/Отчёты/'+period.label+'/'+ScanReport.filename,blob);
  await upload(root+'/Учёт.xlsx',await workbook(closed));
 }
 await writePeriods({version:1,closed,pending:null});
 $('actDownload').href=actURL;$('actDownload').download=ScanReport.filename;$('actDownload').hidden=false;
 if(mode==='disk'){
  $('actFile').href=diskLink(root+'/Отчёты/'+period.label+'/'+ScanReport.filename);$('actFile').target='_blank';$('actFile').rel='noopener';$('actFile').hidden=false;
 }
 $('reportInfo').textContent=(mode==='disk'?'Отчёт сохранён.':'ДЕМО: отчёт готов к скачиванию.')+' Добавлена вкладка «'+period.label+'». Все изделия остаются на первой вкладке «Общий реестр». Изделий в акте: '+period.reportRows.length+'.';
}
bind('actReport',async()=>{
  screen('reportScreen');$('retryAct').hidden=true;$('actFile').hidden=true;$('actDownload').hidden=true;$('generateAct').hidden=true;$('missingNames').replaceChildren();$('reportInfo').textContent='Загружаю учёт…';
  try{await refresh();await createAct();}catch(e){$('reportInfo').textContent=periodState.pending?'Закрытие периода не завершено. Нажмите «Повторить формирование». Новые сканы будут доступны после завершения.':'Отчёт не сформирован. '+e.message;$('retryAct').hidden=!periodState.pending;throw e;}
});
bind('generateAct',async()=>{
  const selections=[...$('missingNames').querySelectorAll('select')].map(s=>({id:s.dataset.cycle,name:s.value}));
  if(selections.some(s=>!ScanReport.names.includes(s.name)))throw Error('Выберите наименование для каждого изделия.');
  await refresh();
  for(const choice of selections){const original=events.find(e=>e.kind==='in'&&e.id===choice.id);if(!original)throw Error('Запись изменена. Откройте отчёт заново.');if(original.name&&original.name!==choice.name&&ScanReport.names.includes(original.name))throw Error('Наименование уже изменено на другом устройстве. Откройте отчёт заново.');await putEvent({...original,name:choice.name});}
  await saveReport();await createAct();
});

bind('retryAct',async()=>{await refresh();await createAct();$('retryAct').hidden=true;});
