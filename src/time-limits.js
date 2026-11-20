export const DEFAULT_TIME_LIMITS=Object.freeze({duration_min:1,duration_max:43200,claim_min:1,claim_max:10080});
export function formatMinutes(minutes) {
  const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),remaining=minutes%60;
  return [[days,'일'],[hours,'시간'],[remaining,'분']].filter(([value])=>value>0).map(([value,unit])=>`${value}${unit}`).join(' ')||'0분';
}
export const timeRangeText=(min,max)=>min===max?formatMinutes(min):`${formatMinutes(min)}~${formatMinutes(max)}`;
export const timeLimitsText=limits=>`진행 시간 / 수령 시간\n${timeRangeText(limits.duration_min,limits.duration_max)} / ${timeRangeText(limits.claim_min,limits.claim_max)}`;
export const eventTimesText=event=>`${formatMinutes(event.duration_ms/60000)} / ${formatMinutes(event.claim_ms/60000)}`;
