import { recoverCancellationNotices } from './cancellation-notice.service';
import { recoverOrderDeliveries } from './ticket.service';

let timer: NodeJS.Timeout | null = null;
let running = false;
const tick = async () => {
  if (running) return;
  running = true;
  try { await recoverOrderDeliveries(); await recoverCancellationNotices(); }
  catch (error) { console.error('[delivery] recovery failed:', error); }
  finally { running = false; }
};
export const startOrderDeliveryRecovery = () => {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref();
  void tick();
};
export const stopOrderDeliveryRecovery = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
