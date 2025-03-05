import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// WhatsApp Cloud API configuration
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = 'v18.0'; // Current API version
const WHATSAPP_API_URL = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

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