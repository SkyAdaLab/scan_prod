/* Queue rules shared by the app and tests. No network or browser storage here. */
(function(scope){
'use strict';
const Core=scope.ScanCore||(typeof require==='function'?require('./core.js'):null);
function event(item){const {photos,uploadedPhotos,synced,started,...e}=item;return {...e,photoCount:(photos||[]).filter(Boolean).length};}
function overlay(events,items){const map=new Map(events.map(e=>[e.id,e]));for(const item of items)map.set(item.id,event(item));return [...map.values()];}
function check(events,item){
 const existing=events.find(e=>e.id===item.id);
 if(existing){
  if(existing.kind!==item.kind||existing.code!==item.code||(item.kind==='out'&&existing.cycle!==item.cycle))throw Error('Конфликт идентификатора операции. Данные не перезаписаны.');
  if(item.kind==='in'||existing.status==='done')return 'done';
 }
 if(item.kind==='out'){
  if(!item.photos?.[0]||!item.photos?.[1])throw Error('Нужны два фото: номер и общий план.');
  const other=events.find(e=>e.kind==='out'&&e.cycle===item.cycle&&e.id!==item.id);
  if(other)throw Error('Выбытие уже записано другой операцией. Проверьте реестр.');
  const withoutSelf=events.filter(e=>e.id!==item.id);
  const cycle=Core.validate(withoutSelf,'out',item.code);
  if(cycle.id!==item.cycle)throw Error('Поступление изменилось на Диске. Выбытие не отправлено.');
 }else Core.validate(events,'in',item.code);
 return existing?'resume':'new';
}
function canRemove(items,id){const item=items.find(e=>e.id===id);if(!item)return false;if(item.started||item.synced)throw Error('Отправка уже начата. Завершите её повтором, чтобы сохранить целостность учёта.');if(items.some(e=>e.cycle===id))throw Error('Сначала удалите из очереди выбытие этого изделия.');return true;}
const api={event,overlay,check,canRemove};if(typeof module!=='undefined')module.exports=api;else scope.ScanBatch=api;
})(globalThis);
