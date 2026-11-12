(function(scope){
'use strict';
function state(value){
 if(!value)return {version:1,closed:[],pending:null};
 if(value.version!==1||!Array.isArray(value.closed)||value.closed.some(p=>!valid(p))||(value.pending&&!valid(value.pending)))throw Error('Неизвестный формат периодов. Данные не изменены.');
 return value;
}
function valid(p){return p&&typeof p.id==='string'&&typeof p.label==='string'&&typeof p.at==='string'&&Array.isArray(p.eventIds)&&Array.isArray(p.rows);}
function current(events,closed){
 const archived=new Set(closed.flatMap(p=>p.eventIds));
 const fresh=new Set(events.filter(e=>!archived.has(e.id)).map(e=>e.kind==='in'?e.id:e.cycle));
 return scope.ScanCore.project(events).filter(c=>fresh.has(c.id));
}
function departures(events,closed){
 const archived=new Set(closed.flatMap(p=>p.eventIds));
 return current(events,closed).filter(c=>c.status==='done'&&!archived.has(c.out.id)).sort((a,b)=>(a.out.completedAt||a.out.at).localeCompare(b.out.completedAt||b.out.at));
}
function snapshot(events,closed,id,now=new Date()){
 const base=String(now.getDate()).padStart(2,'0')+'.'+String(now.getMonth()+1).padStart(2,'0')+'.'+now.getFullYear();
 let label=base,n=2;while(closed.some(p=>p.label===label))label=base+' ('+(n++)+')';
 const archived=new Set(closed.flatMap(p=>p.eventIds));
 return {id,at:now.toISOString(),label,eventIds:events.filter(e=>!archived.has(e.id)).map(e=>e.id),rows:JSON.parse(JSON.stringify(current(events,closed))),reportRows:JSON.parse(JSON.stringify(departures(events,closed)))};
}
scope.ScanPeriods={state,current,departures,snapshot};
})(typeof window!=='undefined'?window:globalThis);
