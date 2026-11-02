// Defaults stay 4173/4174; parallel worktrees may override via HR_E2E_PORT / HR_SMOKE_PORT.
export const E2E_PORT = Number(process.env.HR_E2E_PORT) || 4173;
export const SMOKE_PORT = Number(process.env.HR_SMOKE_PORT) || 4174;
