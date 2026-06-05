import axios from 'axios';
import FormData from 'form-data';
import dotenv from 'dotenv';

dotenv.config();

// WhatsApp Cloud API configuration
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = 'v18.0'; // Current API version
const WHATSAPP_API_URL = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
const WHATSAPP_MEDIA_URL = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/media`;

/**
 * Send OTP message via WhatsApp
 * @param phoneNumber User's phone number (including country code)
 * @param otp One-time password
 * @returns Promise with the result of the API call
 */
export const sendOTP = async (phoneNumber: string, otp: string): Promise<any> => {
  try {
    // Format phone number if needed (remove any non-digits except the + sign)
    const formattedPhone = phoneNumber.replace(/[^\d+]/g, '');
    
    // Prepare the message
    const message = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedPhone,
      type: 'template',
      template: {
        name: 'otp_verification',
        language: {
          code: 'en',
        },
        components: [
          {
            type: 'body',
            parameters: [
              {
                type: 'text',
                text: otp,
              },
              {
                type: 'text',
                text: '10', // OTP validity in minutes
              },
            ],
          },
        ],
      },
    };

    // Send the message
    const response = await axios.post(WHATSAPP_API_URL, message, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`,
      },
    });

    return response.data;
  } catch (error) {
    console.error('Error sending WhatsApp OTP:', error);
    throw error;
  }
};

/**
 * Send custom WhatsApp message
 * @param phoneNumber User's phone number (including country code)
 * @param messageText Text content of the message
 * @returns Promise with the result of the API call
 */
export const sendTextMessage = async (phoneNumber: string, messageText: string): Promise<any> => {
  try {
    // Format phone number if needed
    const formattedPhone = phoneNumber.replace(/[^\d+]/g, '');
    
    // Prepare the message
    const message = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedPhone,
      type: 'text',
      text: {
        body: messageText,
      },
    };

    // Send the message
    const response = await axios.post(WHATSAPP_API_URL, message, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`,
      },
    });

    return response.data;
  } catch (error) {
    console.error('Error sending WhatsApp message:', error);
    throw error;
  }
};

/**
 * Send an image (e.g. a ticket QR) via WhatsApp, with an optional caption that
 * carries the human-readable ticket details. WhatsApp Cloud API cannot accept a
 * data URL inline, so the image is first uploaded to the media endpoint to
 * obtain a media id, then referenced in an image message.
 *
 * Throws loudly if WhatsApp is not configured or any leg of the two-step send
 * fails — callers are responsible for surfacing that failure (no silent
 * fallback), never for swallowing it.
 *
 * @param phoneNumber Recipient phone number (with country code)
 * @param imageBuffer PNG image bytes to deliver
 * @param caption Text shown beneath the image (ticket details)
 * @param filename Filename hint for the uploaded media
 * @returns Promise with the send-message API response
 */
export const sendImageMessage = async (
  phoneNumber: string,
  imageBuffer: Buffer,
  caption: string,
  filename = 'ticket-qr.png'
): Promise<any> => {
  if (!WHATSAPP_API_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error(
      'WhatsApp is not configured: WHATSAPP_API_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be set'
    );
  }

  const formattedPhone = phoneNumber.replace(/[^\d+]/g, '');

  // Step 1: upload the image to obtain a reusable media id.
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/png');
  form.append('file', imageBuffer, { filename, contentType: 'image/png' });

  const uploadResponse = await axios.post(WHATSAPP_MEDIA_URL, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
    },
  });

  const mediaId = uploadResponse.data?.id;
  if (!mediaId) {
    throw new Error('WhatsApp media upload did not return a media id');
  }

  // Step 2: send the image message referencing the uploaded media id.
  const message = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: formattedPhone,
    type: 'image',
    image: {
      id: mediaId,
      caption,
    },
  };

  const response = await axios.post(WHATSAPP_API_URL, message, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
    },
  });

  return response.data;
}; 