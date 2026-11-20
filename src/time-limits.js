export const DEFAULT_TIME_LIMITS=Object.freeze({duration_min:1,duration_max:43200,claim_min:1,claim_max:10080});
export const timeLimitsText=limits=>`진행 ${limits.duration_min}~${limits.duration_max}분 · 수령 ${limits.claim_min}~${limits.claim_max}분`;
