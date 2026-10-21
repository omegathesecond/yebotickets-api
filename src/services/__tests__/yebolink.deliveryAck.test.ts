import { YeboLinkClient, YeboLinkSendError } from '../yebolink.client';
const originalFetch = global.fetch;
beforeEach(() => { process.env.YEBOLINK_API_KEY = 'test-only'; });
afterEach(() => { global.fetch = originalFetch; delete process.env.YEBOLINK_API_KEY; });
const respond = (status: number, body: unknown) => {
  global.fetch = jest.fn(async () => ({ ok: status < 400, status, json: async () => body })) as any;
};
test('successful HTTP response without acceptance evidence is ambiguous, not sent', async () => {
  respond(200, { success: true, data: {} });
  await expect(YeboLinkClient.sendWhatsApp({ to: '+26878422613', text: 'test' })).rejects.toMatchObject({ ambiguous: true });
});
test('explicit client rejection can retry; server error may have dispatched', async () => {
  for (const [status, ambiguous] of [[429, false], [500, true], [408, true]] as const) {
    respond(status, { success: false, error: 'test rejection' });
    await expect(YeboLinkClient.sendWhatsApp({ to: '+26878422613', text: 'test' })).rejects.toMatchObject({ ambiguous });
  }
});
test('provider acceptance returns its real message id and status', async () => {
  respond(200, { success: true, data: { id: 'message-1', status: 'queued' } });
  expect(await YeboLinkClient.sendWhatsApp({ to: '+26878422613', text: 'test' })).toEqual({ messageId: 'message-1', status: 'queued' });
});
test('missing credentials fail before any network request', async () => {
  delete process.env.YEBOLINK_API_KEY;
  global.fetch = jest.fn();
  await expect(YeboLinkClient.sendWhatsApp({ to: '+26878422613', text: 'test' })).rejects.toBeInstanceOf(YeboLinkSendError);
  expect(global.fetch).not.toHaveBeenCalled();
});
