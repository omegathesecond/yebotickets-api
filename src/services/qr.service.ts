import QRCode from 'qrcode';

/**
 * Canonical QR payload encoded into every issued ticket.
 *
 * The gate scanner (yebotickets-scanner →
 * lib/controllers/ticket_scanner_controller.dart) JSON-decodes the QR string
 * and REQUIRES the keys `eventId` and `ticketId`, then calls the check-in
 * endpoints with them. On the API side `findTicketForCheckIn` resolves that
 * `ticketId` against BOTH `Ticket.id` and `Ticket.uniqueCode`, so we encode the
 * ticket's `uniqueCode` here (never the DB primary key) to keep the internal id
 * off the wire while still scanning back correctly.
 */
export interface TicketQrPayload {
  eventId: string;
  ticketId: string;
}

/**
 * Build the exact object the scanner expects. `uniqueCode` becomes `ticketId`.
 */
export const buildTicketQrPayload = (
  eventId: string,
  uniqueCode: string
): TicketQrPayload => ({
  eventId,
  ticketId: uniqueCode,
});

/**
 * Serialise the payload to the JSON string that is actually drawn into the QR
 * image and parsed (via json.decode) by the scanner.
 */
export const buildTicketQrString = (eventId: string, uniqueCode: string): string =>
  JSON.stringify(buildTicketQrPayload(eventId, uniqueCode));

const QR_OPTIONS = {
  errorCorrectionLevel: 'M' as const,
  margin: 1,
  width: 320,
};

/**
 * Generate a base64 data URL (image/png) for the ticket QR. Returned in the
 * purchase response and in GET /api/tickets/my-tickets so any client can render
 * it inline without hosting an image.
 */
export const generateTicketQrDataUrl = async (
  eventId: string,
  uniqueCode: string
): Promise<string> =>
  QRCode.toDataURL(buildTicketQrString(eventId, uniqueCode), QR_OPTIONS);

/**
 * Generate the raw PNG buffer for the ticket QR. Used when uploading the QR as
 * a WhatsApp image attachment.
 */
export const generateTicketQrBuffer = async (
  eventId: string,
  uniqueCode: string
): Promise<Buffer> =>
  QRCode.toBuffer(buildTicketQrString(eventId, uniqueCode), QR_OPTIONS);
