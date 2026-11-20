export function isDirect(store,eventId,slot) {
  return store.get('SELECT delivery_mode FROM prizes WHERE event_id=? AND slot=?',eventId,slot)?.delivery_mode==='DIRECT';
}

export function productInfo(store,vault,event,slot,revealPrivate=false) {
  const prize=store.get('SELECT name,name_public,delivery_mode FROM prizes WHERE event_id=? AND slot=?',event.id,slot);
  if(!prize)return null;
  const publicName=Boolean(prize.name_public),named=Boolean(prize.name);
  const name=!publicName&&!revealPrivate?'비공개 상품':named?vault.open(prize.name,`product-name:${event.id}:${slot}`).text:event.status==='DRAFT'?'상품명 미입력':event.title;
  return {slot,name,named,publicName,direct:prize.delivery_mode==='DIRECT'};
}

export function deliverySummary(store,eventId) {
  const slots=store.all('SELECT slot,delivery_mode FROM prizes WHERE event_id=? ORDER BY slot',eventId);
  const directSlots=slots.filter(p=>p.delivery_mode==='DIRECT').map(p=>p.slot),digitalSlots=slots.filter(p=>p.delivery_mode!=='DIRECT').map(p=>p.slot);
  return {directSlots,digitalSlots,total:slots.length,label:[directSlots.length?`실물·직접 전달 ${directSlots.length}개`:'',digitalSlots.length?`디지털 자동 전달 ${digitalSlots.length}개`:''].filter(Boolean).join(' · ')};
}
