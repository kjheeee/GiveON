export function isDirect(store,eventId,slot) {
  return store.get('SELECT delivery_mode FROM prizes WHERE event_id=? AND slot=?',eventId,slot)?.delivery_mode==='DIRECT';
}

export function deliverySummary(store,eventId) {
  const slots=store.all('SELECT slot,delivery_mode FROM prizes WHERE event_id=? ORDER BY slot',eventId);
  const directSlots=slots.filter(p=>p.delivery_mode==='DIRECT').map(p=>p.slot),digitalSlots=slots.filter(p=>p.delivery_mode!=='DIRECT').map(p=>p.slot);
  return {directSlots,digitalSlots,total:slots.length,label:[directSlots.length?`실물·직접 전달 ${directSlots.length}개`:'',digitalSlots.length?`디지털 자동 전달 ${digitalSlots.length}개`:''].filter(Boolean).join(' · ')};
}
