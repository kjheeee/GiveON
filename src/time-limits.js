export const DEFAULT_TIME_LIMITS=Object.freeze({duration_min:1,duration_max:43200,claim_min:1,claim_max:10080});
export const timeLimitsText=limits=>`진행 시간 / 수령 시간\n${limits.duration_min}~${limits.duration_max}분 / ${limits.claim_min}~${limits.claim_max}분`;
export const eventTimesText=event=>`${event.duration_ms/60000}분 / ${event.claim_ms/60000}분`;
