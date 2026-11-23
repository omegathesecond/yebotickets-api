import { YeboLinkClient, YeboLinkSendError } from "../yebolink.client";
const originalFetch = global.fetch;
beforeEach(() => {
  process.env.YEBOLINK_API_KEY = "test-only";
});
afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.YEBOLINK_API_KEY;
});
const respond = (status: number, body: unknown) => {
  global.fetch = jest.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })) as any;
};
test("successful HTTP response without acceptance evidence is ambiguous, not sent", async () => {
  respond(200, { success: true, data: {} });
  await expect(
    YeboLinkClient.sendWhatsApp({ to: "+26878422613", text: "test" }),
  ).rejects.toMatchObject({ ambiguous: true });
});
test("explicit client rejection can retry; server error may have dispatched", async () => {
  for (const [status, ambiguous] of [
    [429, false],
    [500, true],
    [408, true],
  ] as const) {
    respond(status, { success: false, error: "test rejection" });
    await expect(
      YeboLinkClient.sendWhatsApp({ to: "+26878422613", text: "test" }),
    ).rejects.toMatchObject({ ambiguous });
  }
});
test("provider acceptance returns its real message id and status", async () => {
  respond(201, {
    success: true,
    data: {
      message_id: "550e8400-e29b-41d4-a716-446655440000",
      status: "queued",
    },
  });
  expect(
    await YeboLinkClient.sendWhatsApp({ to: "+26878422613", text: "test" }),
  ).toEqual({
    messageId: "550e8400-e29b-41d4-a716-446655440000",
    status: "queued",
  });
});
test("a different response shape is rejected rather than treated as a compatibility alias", async () => {
  respond(201, {
    success: true,
    data: { id: "550e8400-e29b-41d4-a716-446655440000", status: "queued" },
  });
  await expect(
    YeboLinkClient.sendWhatsApp({ to: "+26878422613", text: "test" }),
  ).rejects.toMatchObject({ ambiguous: true });
});
test("receipt reads preserve actual gateway dispatch uncertainty and never send", async () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  respond(200, {
    success: true,
    data: {
      message: {
        id,
        status: "dispatch_unknown",
        channel: "whatsapp",
        direction: "outbound",
        recipient: "+26878422613",
        metadata: {},
      },
    },
  });
  expect((await YeboLinkClient.getMessage(id)).status).toBe("dispatch_unknown");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect((global.fetch as jest.Mock).mock.calls[0][1].method).toBeUndefined();
});
test("receipt errors and mismatched message identities fail instead of fabricating evidence", async () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  respond(403, {
    success: false,
    error: "Missing required scope: read_messages",
  });
  await expect(YeboLinkClient.getMessage(id)).rejects.toThrow("read_messages");
  respond(200, {
    success: true,
    data: { message: { id: "wrong", status: "delivered" } },
  });
  await expect(YeboLinkClient.getMessage(id)).rejects.toThrow("does not match");
});
test("missing credentials fail before any network request", async () => {
  delete process.env.YEBOLINK_API_KEY;
  global.fetch = jest.fn();
  await expect(
    YeboLinkClient.sendWhatsApp({ to: "+26878422613", text: "test" }),
  ).rejects.toBeInstanceOf(YeboLinkSendError);
  expect(global.fetch).not.toHaveBeenCalled();
});
