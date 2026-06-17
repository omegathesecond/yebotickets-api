/**
 * Outbound comms for YeboTickets, routed through YeboLink — the canonical
 * Omevision comms gateway (api.yebolink.com). Replaces the previous direct
 * Meta WhatsApp Cloud API integration: all SMS/WhatsApp/email now flows through
 * YeboLink so credit accounting and central comms control live in one place.
 *
 * These helpers throw on failure (no silent fallback, per CLAUDE.md). Callers
 * that must not fail the surrounding operation (e.g. ticket delivery after a
 * paid purchase) catch and surface the error rather than swallowing it.
 */

import { YeboLinkClient, YeboLinkMessageResult } from './yebolink.client';

/** Strip anything that isn't a digit or a leading "+" so YeboLink gets E.164. */
const formatPhone = (phoneNumber: string): string => phoneNumber.replace(/[^\d+]/g, '');

/**
 * Send a one-time passcode to the user over WhatsApp via YeboLink.
 * @param phoneNumber Recipient phone number (with country code)
 * @param otp The 6-digit code
 */
export const sendOTP = async (phoneNumber: string, otp: string): Promise<YeboLinkMessageResult> =>
  YeboLinkClient.sendWhatsApp({
    to: formatPhone(phoneNumber),
    text: `Your YeboTickets verification code is ${otp}. It expires in 10 minutes. Do not share it with anyone.`,
  });

/**
 * Send a plain text message to the user over WhatsApp via YeboLink, optionally
 * with one or more PUBLIC media URLs attached (e.g. a hosted ticket QR PNG).
 * @param phoneNumber Recipient phone number (with country code)
 * @param messageText The message body
 * @param mediaUrls Optional public media URLs (not buffers) to attach
 */
export const sendTextMessage = async (
  phoneNumber: string,
  messageText: string,
  mediaUrls?: string[]
): Promise<YeboLinkMessageResult> =>
  YeboLinkClient.sendWhatsApp({ to: formatPhone(phoneNumber), text: messageText, mediaUrls });

/**
 * Send an email to the user via YeboLink. Used as a fallback delivery channel
 * for tickets when the buyer has an email on file.
 * @param to Recipient email address
 * @param subject Email subject line
 * @param html HTML body
 * @param text Optional plain-text alternative
 */
export const sendEmailMessage = async (
  to: string,
  subject: string,
  html: string,
  text?: string
): Promise<YeboLinkMessageResult> =>
  YeboLinkClient.sendEmail({ to, subject, html, text });
