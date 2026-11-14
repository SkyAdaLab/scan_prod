'use strict';
const $=id=>document.getElementById(id),cfg=window.SCAN_CONFIG,base='https://cloud-api.yandex.net/v1/disk';
let token=sessionStorage.getItem('scan_token')||'',mode='',owner='',events=[],draft=null,action='',reader=null,busy=false;
const redirect=location.origin+location.pathname;let root=cfg.root;
let statusTimer,selectedName='',actURL='',periodState=ScanPeriods.state();
let local={version:1,rev:0,items:[],draft:null,excelDirty:false},cameraEpoch=0,lastRead='',lastReadAt=0,audioContext=null,eventCache=new Map();
function screen(name){stopCamera();document.body.dataset.screen=name;for(const id of ['connect','helpScreen','home','entry','draft','chooseName','reportScreen','queueScreen'])$(id).hidden=id!==name;$('workspace').hidden=!['home','entry','draft','chooseName','reportScreen','queueScreen'].includes(name);$('status').hidden=true;}

const dbp=new Promise((resolve,reject)=>{const r=indexedDB.open('scan-test-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('store');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('Браузер не разрешил локальное сохранение.'));});
async function db(op,key,value){const d=await dbp;return new Promise((res,rej)=>{const t=d.transaction('store',op==='get'?'readonly':'readwrite'),s=t.objectStore('store');let r=op==='get'?s.get(key):op==='put'?s.put(value,key):s.delete(key);t.oncomplete=()=>res(r.result);t.onerror=t.onabort=()=>rej(Error('Не удалось сохранить данные на телефоне. Проверьте свободное место.'));});}
function msg(s,error=false){clearTimeout(statusTimer);$('status').textContent=s;$('status').classList.toggle('error',error);$('status').hidden=false;if(!error)statusTimer=setTimeout(()=>{$('status').hidden=true;},3500);}
async function run(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){msg(e.message||'Ошибка',true);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);renderQueue();}}
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
async function refresh(){
 if(mode==='demo')events=await db('get','demo_events')||[];
 else{
  let items=[],offset=0;
  while(true){const data=await(await api('/resources?path='+pathq(root+'/Данные')+'&limit=100&offset='+offset)).json();const page=data._embedded?.items||[];items.push(...page.filter(x=>x.type==='file'&&x.name.endsWith('.json')));if(page.length<100)break;offset+=100;}
  const loaded=new Array(items.length),nextCache=new Map();let cursor=0;
  // Reuse unchanged event files and read changed ones in four bounded workers.
  await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
   while(cursor<items.length){const index=cursor++,item=items[index],stamp=item.md5||item.sha256||null,cached=eventCache.get(item.path);
    const e=stamp&&cached?.stamp===stamp?cached.event:await readJSON(item.path);
    if(e.version!==1||!['in','out'].includes(e.kind)||typeof e.id!=='string'||typeof e.code!=='string'||typeof e.at!=='string')throw Error('Неизвестный формат файла учёта. Обновление остановлено.');
    loaded[index]=e;if(stamp)nextCache.set(item.path,{stamp,event:e});
   }
  }));
  events=loaded;eventCache=nextCache;
 }
 await loadPeriods();render();
}
async function putEvent(e){if(mode==='demo'){let all=await db('get','demo_events')||[];all=all.filter(x=>x.id!==e.id);all.push(e);await db('put','demo_events',all);}else await upload(root+'/Данные/'+e.id+'.json',new Blob([JSON.stringify(e)],{type:'application/json'}));events=events.filter(x=>x.id!==e.id);events.push(e);render();}
function diskLink(p){return 'https://disk.yandex.ru/client/disk'+p.replace(/^disk:/,'').split('/').map(encodeURIComponent).join('/');}
function render(){const cycles=ScanCore.project(events),filter=$('search').value.trim();$('rows').replaceChildren();$('count').textContent=String(cycles.length);$('empty').hidden=cycles.length>0;for(const c of cycles.filter(c=>c.code.includes(filter))){const tr=document.createElement('tr');tr.className=c.status==='done'?'done':c.status==='pending'?'pending':'';for(const v of [c.code,new Date(c.at).toLocaleString('ru-RU'),{available:'В наличии',pending:'Ожидает фото',done:'Выбыл'}[c.status]]){const td=document.createElement('td');td.textContent=v;tr.append(td);}const td=document.createElement('td');if(c.out?.folder&&mode!=='demo'){const a=document.createElement('a');a.textContent='Папка ↗';a.href=diskLink(c.out.folder);a.target='_blank';a.rel='noopener';td.append(a);}else td.textContent='—';tr.append(td);$('rows').append(tr);}}
// Local queue and photo draft are committed together in one IndexedDB transaction.
async function saveLocal(patch){
 const d=await dbp,next={...local,...patch,rev:local.rev+1};
 await new Promise((resolve,reject)=>{
  const t=d.transaction('store','readwrite'),store=t.objectStore('store'),r=store.get('batch:'+owner);let conflict=false;
  r.onsuccess=()=>{if((r.result?.rev||0)!==local.rev){conflict=true;t.abort();return;}store.put(next,'batch:'+owner);};
  t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(Error(conflict?'Очередь изменена в другой вкладке. Закройте вторую вкладку и перезагрузите страницу.':'Не удалось сохранить очередь на телефоне. Проверьте свободное место.'));
 });
 local=next;draft=local.draft;renderQueue();
}
async function loadLocal(){
 local=await db('get','batch:'+owner)||{version:1,rev:0,items:[],draft:null,excelDirty:false};
 if(local.version!==1||!Array.isArray(local.items))throw Error('Неизвестный формат очереди. Данные не изменены.');
 draft=local.draft;
 const legacy=await db('get','draft:'+owner);
 if(legacy){
  if(!draft&&!local.items.some(i=>i.id===legacy.id))await saveLocal({draft:legacy});
  if(draft?.id===legacy.id||local.items.some(i=>i.id===legacy.id))await db('delete','draft:'+owner);
 }
 renderQueue();
}
async function saveDraft(){await saveLocal({draft});}
function effectiveEvents(){return ScanBatch.overlay(events,local.items);}
function showDraft(){
 $('draft').hidden=!draft;if(!draft)return;
 $('draftTitle').textContent=draft.kind==='in'?'Поступление: добавить в очередь':'Выбытие: добавьте фотографии';
 $('draftCode').textContent=[draft.name,draft.code].filter(Boolean).join(' · ');$('photoFields').hidden=draft.kind==='in';
 for(let i=0;i<3;i++){const img=$('preview'+i);if(img.dataset.url)URL.revokeObjectURL(img.dataset.url);img.hidden=!draft.photos?.[i];if(!img.hidden){img.src=URL.createObjectURL(draft.photos[i]);img.dataset.url=img.src;}$('photo'+i).value='';}
}
async function connect(demo=false){
 mode=demo?'demo':'disk';eventCache=new Map();
 if(demo){owner='demo';$('account').textContent='ДЕМО · данные только в этом браузере';}
 else{msg('Проверяю доступ к Диску…');const info=await(await api('/')).json();if(!info.user?.uid)throw Error('Не удалось определить владельца Диска.');owner='disk:'+info.user.uid+':'+root;$('account').textContent='Яндекс · '+(info.user.login||info.user.display_name||info.user.uid);await mkdir(root);await mkdir(root+'/Данные');await mkdir(root+'/Фото');sessionStorage.setItem('scan_token',token);}
 $('folder').hidden=demo;$('folder').href=diskLink(root);$('report').hidden=demo;
 await loadLocal();await refresh();showDraft();screen('home');
 msg(draft?'Восстановлен черновик с фотографиями. Продолжите выбытие.':local.items.length?'Очередь восстановлена. Можно продолжить сканирование или отправить всё.':demo?'ДЕМО: данные остаются в браузере.':'Диск подключён. Готов к пакетному сканированию.');
}
function stopCamera(){cameraEpoch++;if(reader){reader.reset();reader=null;}const stream=$('video').srcObject;if(stream)stream.getTracks().forEach(t=>t.stop());$('video').srcObject=null;$('video').hidden=true;$('stop').hidden=true;}
function prepareSound(){try{if(!audioContext)audioContext=new(window.AudioContext||window.webkitAudioContext)();if(audioContext.state==='suspended')audioContext.resume().catch(()=>{});}catch{}}
function beep(){try{if(audioContext?.state==='running'){const o=audioContext.createOscillator(),g=audioContext.createGain();o.frequency.value=1000;g.gain.setValueAtTime(.07,audioContext.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioContext.currentTime+.12);o.connect(g);g.connect(audioContext.destination);o.start();o.stop(audioContext.currentTime+.13);}}catch{}navigator.vibrate?.(35);}
async function startCamera(){
 if(document.body.dataset.screen!=='entry')return;
 stopCamera();const epoch=cameraEpoch;
 if(!navigator.mediaDevices?.getUserMedia)throw Error('Камера недоступна. Введите номер вручную. Для камеры нужен HTTPS.');
 if(!window.ZXing)throw Error('Не загружен сканер. Введите номер вручную или проверьте vendor.');
 $('video').hidden=false;$('stop').hidden=false;
 const current=new ZXing.BrowserMultiFormatReader();reader=current;
 try{await current.decodeFromConstraints({video:{facingMode:{ideal:'environment'},width:{ideal:1280}},audio:false},$('video'),result=>{
  if(!result||busy||epoch!==cameraEpoch||document.body.dataset.screen!=='entry')return;
  const code=result.getText(),now=Date.now();
  if(code===lastRead&&now-lastReadAt<2500){lastReadAt=now;return;}
  lastRead=code;lastReadAt=now;$('code').value=code;
  run(()=>accept(code));
 });if(epoch!==cameraEpoch){current.reset();}}
 catch(e){current.reset();if(epoch===cameraEpoch){reader=null;$('video').hidden=true;$('stop').hidden=true;throw Error('Не удалось включить камеру. Разрешите доступ или введите номер вручную.');}}
}
function enter(kind){
 prepareSound();
 if(draft){if(draft.kind===kind){showDraft();screen('draft');return;}throw Error('Завершите текущий черновик: нажмите '+(draft.kind==='in'?'«Новый».':'«Выбыл».'));}
 ensurePeriodOpen();screen('entry');action=kind;
 $('actionTitle').textContent=kind==='in'?'Поступление: '+selectedName:'Выбытие';$('code').value='';lastRead='';
 $('changeName').hidden=kind!=='in';renderQueue();
 startCamera().catch(e=>msg(e.message,true));
}
async function accept(raw=$('code').value){
 if(action==='in'&&!ScanReport.names.includes(selectedName))throw Error('Сначала выберите наименование.');
 ensurePeriodOpen();const code=ScanCore.code(raw),cycle=ScanCore.validate(effectiveEvents(),action,code);
 const item={version:1,id:crypto.randomUUID(),kind:action,code,name:action==='in'?selectedName:(cycle?.name||''),at:new Date().toISOString(),status:action==='out'?'pending':'available',cycle:cycle?.id,photos:[]};
 if(action==='in'){
  await saveLocal({items:[...local.items,item]});$('code').value='';beep();msg(code+' — добавлено в очередь на телефоне.');
 }else{
  item.folder=root+'/Фото/'+encodeURIComponent(code)+'/'+item.at.replace(/[:.]/g,'-')+'_'+item.id.slice(0,8);
  await saveLocal({draft:item});showDraft();screen('draft');beep();
 }
}
async function send(){
 if(!draft)throw Error('Нет черновика.');
 const existing=events.find(e=>e.id===draft.id);
 if(draft.kind==='out'&&existing?.status!=='done'&&(!draft.photos?.[0]||!draft.photos?.[1]))throw Error('Нужны два фото: номер и общий план.');
 const kind=draft.kind,item={...draft,photos:draft.photos||[],status:kind==='out'?'done':'available'};
 if(kind==='out')item.completedAt=item.completedAt||new Date().toISOString();
 await saveLocal({items:[...local.items.filter(i=>i.id!==item.id),item],draft:null});
 showDraft();beep();if(kind==='in'&&!ScanReport.names.includes(selectedName)){screen('chooseName');}else enter(kind);
 msg('Добавлено в очередь. '+(kind==='out'?'Сканируйте следующее изделие.':'Можно сканировать дальше.'));
}
function renderQueue(){
 const pending=local.items.filter(i=>!i.synced).length,total=local.items.length;
 const info=pending?'На телефоне: '+pending+' поз. Ещё не на Диске.':local.excelDirty?'Операции записаны. Нужно обновить Excel.':total?'Операции отправлены. Завершите отправку.':'Очередь пуста';
 $('queueSummary').textContent=info;$('entryQueueInfo').textContent=info;
 $('queueDock').hidden=!total&&!local.excelDirty&&!draft;$('home').classList.toggle('hasQueue',!$('queueDock').hidden);
 $('queueHome').textContent=draft&&!total?'Продолжить черновик':'Очередь · '+total+' →';
 $('queueInfo').textContent=info+(draft?' Есть незавершённый черновик с фото.':'');
 $('uploadAll').textContent=pending?'Отправить всё — '+pending+' поз.':'Обновить Excel / завершить';
 $('uploadAll').hidden=!total&&!local.excelDirty;
 $('resumeDraft').hidden=!draft;
 $('queueList').replaceChildren();
 for(const item of local.items){
  const li=document.createElement('li'),text=document.createElement('div');
  text.textContent=(item.kind==='in'?'Новый':'Выбыл')+' · '+(item.name||'Без наименования')+' · '+item.code;
  const note=document.createElement('small');note.textContent=item.synced?'Запись на Диске · ожидает завершения':item.started?'Отправка начата · можно повторить':'Сохранено на телефоне';
  li.append(text,note);
  if(!item.started&&!item.synced){const b=document.createElement('button');b.className='secondary';b.textContent='Удалить';b.setAttribute('aria-label','Удалить '+item.code);b.disabled=busy;b.onclick=()=>run(async()=>{ScanBatch.canRemove(local.items,item.id);await saveLocal({items:local.items.filter(i=>i.id!==item.id)});});li.append(b);}
  $('queueList').append(li);
 }
}
function queueScreen(){screen('queueScreen');renderQueue();}
async function updateItem(id,patch){await saveLocal({items:local.items.map(i=>i.id===id?{...i,...patch}:i)});}
async function uploadQueue(){
 stopCamera();if(draft)throw Error('Сначала добавьте черновик с фотографиями в очередь.');
 if(!local.items.length&&!local.excelDirty){msg('Очередь пуста.');return;}
 if(navigator.locks)return navigator.locks.request('scan-upload:'+owner,{ifAvailable:true},lock=>{if(!lock)throw Error('Отправка идёт в другой вкладке. Дождитесь завершения.');return uploadQueueLocked();});
 return uploadQueueLocked();
}
async function uploadQueueLocked(){
 msg('Проверяю данные на Диске перед отправкой…');await refresh();ensurePeriodOpen();
 let failure=null;
 try{
  // Process in order: a departure may refer to an incoming item from this queue.
  for(const initial of [...local.items]){
   let item=local.items.find(i=>i.id===initial.id);
   try{
    const state=ScanBatch.check(events,item);
    if(state==='done'){await updateItem(item.id,{synced:true,started:true});await saveLocal({excelDirty:true});continue;}
    await updateItem(item.id,{started:true});await saveLocal({excelDirty:true});
    item=local.items.find(i=>i.id===item.id);
    msg('Отправляю '+item.code+'…');
    if(item.kind==='out'){
     if(state==='new')await putEvent({...ScanBatch.event(item),status:'pending'});
     if(mode==='disk'){
      await mkdir(root+'/Фото/'+encodeURIComponent(item.code));await mkdir(item.folder);
      for(let i=0;i<3;i++)if(item.photos[i]&&!item.uploadedPhotos?.[i]){
       await upload(item.folder+'/'+['01_номер.jpg','02_общий.jpg','03_средний.jpg'][i],item.photos[i]);
       const uploadedPhotos=[...(item.uploadedPhotos||[])];uploadedPhotos[i]=true;
       await updateItem(item.id,{uploadedPhotos});item=local.items.find(e=>e.id===item.id);
      }
     }
     await putEvent({...ScanBatch.event(item),status:'done'});
    }else await putEvent(ScanBatch.event(item));
    await updateItem(item.id,{synced:true});
   }catch(e){throw Error(item.code+': '+e.message);}
  }
 }catch(e){failure=e;}
 // Exactly one workbook upload per batch attempt, after all possible operations.
 if(local.excelDirty){
  try{msg('Обновляю Excel один раз для всей очереди…');await saveReport();await saveLocal({excelDirty:false,items:local.items.filter(i=>!i.synced)});}
  catch(e){throw Error((failure?failure.message+' ':'')+'Записи сохранены частично или полностью, но Excel ещё не обновлён. Нажмите «Отправить всё» для повтора. '+e.message);}
 }
 if(failure)throw failure;
 renderQueue();msg(mode==='demo'?'ДЕМО: очередь обработана, на Диск ничего не отправлено.':'Все позиции и фотографии отправлены. Excel обновлён.');
}
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
bind('manual',async()=>{token=$('token').value.trim();$('token').value='';if(!token)throw Error('Введите OAuth-токен.');await connect();});bind('demo',()=>connect(true));bind('logout',async()=>{stopCamera();sessionStorage.removeItem('scan_token');location.replace(redirect);});bind('incoming',()=>{if(draft)return enter('in');selectedName='';screen('chooseName');});bind('outgoing',()=>enter('out'));bind('accept',()=>accept());bind('cancel',()=>{stopCamera();screen('home');});bind('stop',stopCamera);bind('send',send);bind('refresh',async()=>{await refresh();msg('Учёт загружен.');});bind('report',async()=>{await refresh();await saveReport();msg('Excel обновлён на Диске.');});bind('download',async()=>{const blob=await workbook(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='Учёт.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);});$('search').oninput=render;
bind('camera',()=>{prepareSound();return startCamera();});
for(let i=0;i<3;i++)$('photo'+i).onchange=()=>run(async()=>{if(!draft)return;const blob=await photo($('photo'+i).files[0]);if(!blob)return;const photos=[...(draft.photos||[])];photos[i]=blob;await saveLocal({draft:{...draft,photos}});showDraft();msg('Фото '+(i+1)+' сохранено в черновике.');});
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
 if(local.items.length||local.excelDirty)throw Error('Сначала отправьте очередь на Диск. Затем сформируйте отчёт.');
 if(draft||events.some(e=>e.kind==='out'&&e.status!=='done'))throw Error('Сначала завершите незавершённые операции и загрузку фотографий. Затем сформируйте отчёт.');
 let period=periodState.pending;
 if(!period){
  const items=departed();
  if(!items.length){$('reportInfo').textContent='Нет новых завершённых выбытий для отчёта. Общий реестр сохраняется без изменений.';return;}
  if(showMissingNames(items))return;
  period=ScanPeriods.snapshot(events,periodState.closed,crypto.randomUUID());
 }
 $('reportInfo').textContent='Формирую отчёт за период '+period.label+'…';
 const response=await fetch('templates/report.ods?v=0.6');
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
  await createAct();
});

bind('retryAct',async()=>{await refresh();await createAct();$('retryAct').hidden=true;});

bind('queueHome',queueScreen);bind('entryQueue',queueScreen);bind('queueBack',()=>screen('home'));bind('uploadAll',uploadQueue);
bind('resumeDraft',()=>{showDraft();screen('draft');});
bind('changeName',()=>screen('chooseName'));
$('code').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();run(()=>accept());}});
window.addEventListener('beforeunload',e=>{if(local.items.length||local.draft||local.excelDirty){e.preventDefault();e.returnValue='';}});
