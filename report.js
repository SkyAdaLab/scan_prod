/* Template-based ODS export. Keeps the supplied form, merged cells and print styles. */
(function (scope) {
  'use strict';
  const filename = 'АКТ_передачи_на_ремучасток_.ods';
  const names = Object.freeze(['Лис-1У', 'Лис-2.0', 'Черника-2', 'Черника-1']);
  const escapeXML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  function dateParts(now = new Date()) {
    // The date of the user's phone, including its selected timezone.
    return [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')];
  }
  function fillXML(xml, items, now = new Date()) {
    if (!items.length) throw Error('Пока нет изделий со статусом «Выбыл».');
    if (items.some(c => !names.includes(c.name) || typeof c.code !== 'string' || !c.code)) throw Error('Укажите наименование каждого выбывшего изделия.');
    const rows = [...xml.matchAll(/<table:table-row\b[^>]*>.*?<\/table:table-row>/gs)];
    if (rows.length !== 33 || !rows[2][0].includes('ДАТА:') || !rows[25][0].includes('Сдал')) throw Error('Шаблон отчёта изменён. Восстановите templates/report.ods из обновления.');
    const [year, month, day] = dateParts(now);
    const dateRow = rows[2][0].replace(/office:date-value="[^"]+"/, 'office:date-value="'+year+'-'+month+'-'+day+'T00:00:00"').replace(/<text:p>\d{2}\.\d{2}\.\d{4}<\/text:p>/, '<text:p>'+day+'.'+month+'.'+year+'</text:p>');
    const blank = rows[10][0];
    const generated = Array.from({length:Math.max(14,items.length)}, (_,i) => {
      let col = 0;
      return blank.replace(/<text:p\s*\/>|<text:p>.*?<\/text:p>/gs, () => '<text:p>'+escapeXML(items[i] ? (col++ === 0 ? items[i].name : items[i].code) : '')+'</text:p>');
    }).join('');
    const end = rows[23].index + rows[23][0].length;
    let result = xml.slice(0, rows[10].index) + generated + xml.slice(end);
    result = result.replace(rows[2][0], dateRow);
    if(items.length > 14) result = result.replace('table:number-rows-repeated="1048527"', 'table:number-rows-repeated="'+(1048527-items.length+14)+'"');
    return result;
  }
  async function build(template, items, now = new Date()) {
    const zip = await scope.JSZip.loadAsync(template);
    const file = zip.file('content.xml');
    if(!file) throw Error('Повреждён шаблон отчёта.');
    zip.file('content.xml', fillXML(await file.async('string'), items, now));
    zip.remove('Thumbnails/thumbnail.png');
    const manifest = zip.file('META-INF/manifest.xml');
    if(manifest) zip.file('META-INF/manifest.xml', (await manifest.async('string')).replace(/<manifest:file-entry\b[^>]*manifest:full-path="Thumbnails\/[^\"]*"[^>]*\/>/g,''));
    zip.file('mimetype','application/vnd.oasis.opendocument.spreadsheet',{compression:'STORE'});
    return zip.generateAsync({type:'uint8array',compression:'DEFLATE',mimeType:'application/vnd.oasis.opendocument.spreadsheet'});
  }
  scope.ScanReport = {filename, names, fillXML, build};
})(typeof window !== 'undefined' ? window : globalThis);
