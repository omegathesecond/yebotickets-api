import { ApiError } from "../middleware/error.middleware";
import { ticketRevenue } from "./settlement.service";

/** No missing payment evidence may be interpreted as a free admission. */
export function ticketRefundTerms(ticket: any) {
  if (
    ticket.status !== "sold" &&
    !(
      ticket.status === "reserved" &&
      ticket.event?.isCancelled &&
      ticket.paymentStatus === "SUCCEEDED"
    )
  )
    throw new ApiError(
      "Only an issued ticket or a confirmed cancelled-event payment can be refunded",
      409,
    );
  const amount = ticketRevenue(ticket);
  if (ticket.paymentStatus === "FREE" && amount === 0 && !ticket.paymentRef)
    return { paid: false, amount };
  if (
    ticket.paymentStatus === "SUCCEEDED" &&
    amount > 0 &&
    typeof ticket.paymentRef === "string" &&
    ticket.paymentRef.trim()
  )
    return { paid: true, amount };
  throw new ApiError(
    "The original ticket payment is incomplete or unconfirmed; reconcile it before cancellation or refund",
    409,
  );
}
