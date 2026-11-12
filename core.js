(function(root){
function code(value){const v=String(value).trim();if(!v||v.length>128||/[\x00-\x1f]/.test(v))throw Error('Введите корректный штрихкод (1–128 символов).');return v;}
function project(events){const cycles=events.filter(e=>e.kind==='in').map(e=>({...e,status:'available',out:null}));for(const e of events.filter(e=>e.kind==='out')){const c=cycles.find(c=>c.id===e.cycle);if(c){c.out=e;c.status=e.status==='done'?'done':'pending';}}return cycles.sort((a,b)=>b.at.localeCompare(a.at));}
function available(events,value){return project(events).find(c=>c.code===value&&c.status!=='done');}
function validate(events,kind,value){value=code(value);const c=available(events,value);if(kind==='in'&&c)throw Error('Изделие уже в наличии или ожидает фото.');if(kind==='out'&&!c)throw Error('Код не найден в наличии: отсутствует или уже выбыл.');if(kind==='out'&&c.status==='pending')throw Error('Выбытие уже начато. Завершите сохранённый черновик на исходном устройстве.');return c;}
const api={code,project,available,validate};if(typeof module!=='undefined')module.exports=api;else root.ScanCore=api;
})(globalThis);
