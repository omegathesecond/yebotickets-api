import { ticketRefundTerms } from "../ticket-refund-terms";
const paid = {
  status: "sold",
  paymentStatus: "SUCCEEDED",
  paymentRef: "original-charge",
  amountPaid: 50,
};
it("accepts the recorded paid allocation independently of the current catalogue price", () => {
  expect(ticketRefundTerms({ ...paid, ticketType: { price: 999 } })).toEqual({
    paid: true,
    amount: 50,
  });
});
it("accepts free cancellation only when the stored free payment is explicit", () => {
  expect(
    ticketRefundTerms({
      status: "sold",
      paymentStatus: "FREE",
      paymentRef: null,
      amountPaid: 0,
    }),
  ).toEqual({ paid: false, amount: 0 });
});
it.each([
  { amountPaid: null },
  { amountPaid: undefined },
  { amountPaid: 0 },
  { amountPaid: -1 },
  { amountPaid: 1.001 },
  { paymentRef: null },
  { paymentStatus: "PENDING" },
  { paymentStatus: "FREE" },
  { status: "available" },
  { status: "reserved" },
])("rejects incomplete or unconfirmed original terms %j", (change) => {
  expect(() => ticketRefundTerms({ ...paid, ...change })).toThrow();
});
it("keeps the existing confirmed cancelled-event payment recovery path", () => {
  expect(
    ticketRefundTerms({
      ...paid,
      status: "reserved",
      event: { isCancelled: true },
    }),
  ).toEqual({ paid: true, amount: 50 });
});
