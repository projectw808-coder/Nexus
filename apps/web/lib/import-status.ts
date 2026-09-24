import type { PillTone } from '@/components/status-pill';

export const IMPORT_TONE: Record<string, PillTone> = {
  PREVIEW: 'neutral',
  RUNNING: 'info',
  COMPLETED: 'good',
  FAILED: 'critical',
  ROLLED_BACK: 'warning',
};
