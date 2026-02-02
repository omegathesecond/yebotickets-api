import prisma from '../config/prisma';
import { UserRole, toOrganizerProfile } from '../interfaces/user.interface';
import { ApiError } from '../middleware/error.middleware';
import { sendOTP } from './whatsapp.service';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

/**
 * Generate a 6-digit OTP
 */
const generateOTPCode = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Generate JWT token for a user
 */
const generateAuthToken = (userId: string, role: string): string => {
  const jwtSecret = process.env.JWT_SECRET || 'fallbacksecret';
  const payload = { id: userId, role };
  const options = { expiresIn: process.env.JWT_EXPIRES_IN || '24h' };
  
  return jwt.sign(payload, jwtSecret, options as jwt.SignOptions);
};

/**
 * Hash a password
 */
const hashPassword = async (password: string): Promise<string> => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

/**
 * Compare passwords
 */
const comparePassword = async (entered: string, stored: string): Promise<boolean> => {
  return bcrypt.compare(entered, stored);
};

/**
 * Request OTP via WhatsApp for authentication
 * @param phoneNumber User's phone number
 * @returns Object containing user information
 */
export const requestOTP = async (phoneNumber: string): Promise<{ message: string; isNewUser: boolean }> => {
  try {
    // Check if user exists
    let user = await prisma.user.findUnique({
      where: { phoneNumber },
    });
    let isNewUser = false;

    // If user doesn't exist, create a new one
    if (!user) {
      user = await prisma.user.create({
        data: {
          phoneNumber,
          name: `User-${Math.floor(1000 + Math.random() * 9000)}`, // Temporary name
          role: 'user',
        },
      });
      isNewUser = true;
    }

    // Generate OTP
    const otp = generateOTPCode();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Update user with OTP
    await prisma.user.update({
      where: { id: user.id },
      data: {
        otpCode: otp,
        otpExpiresAt,
      },
    });

    // Send OTP via WhatsApp
    await sendOTP(phoneNumber, otp);

    return {
      message: 'OTP sent successfully via WhatsApp',
      isNewUser,
    };
  } catch (error) {
    console.error('Error in requestOTP service:', error);
    throw new ApiError('Failed to send OTP', 500);
  }
};

/**
 * Verify OTP sent to user
 * @param phoneNumber User's phone number
 * @param otp OTP entered by user
 * @returns Object containing user information and token
 */
export const verifyOTP = async (phoneNumber: string, otp: string): Promise<{ user: any; token: string }> => {
  try {
    // Find user with the phone number
    const user = await prisma.user.findUnique({
      where: { phoneNumber },
    });

    if (!user) {
      throw new ApiError('User not found', 404);
    }

    // Check if OTP exists and is valid
    if (!user.otpCode || !user.otpExpiresAt) {
      throw new ApiError('No OTP requested', 400);
    }

    // Check if OTP is expired
    if (new Date() > user.otpExpiresAt) {
      throw new ApiError('OTP expired', 400);
    }

    // Check if OTP matches
    if (user.otpCode !== otp) {
      throw new ApiError('Invalid OTP', 400);
    }

    // OTP verified, clear it and mark user as verified
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        otpCode: null,
        otpExpiresAt: null,
        isVerified: true,
      },
    });

    // Generate JWT token
    const token = generateAuthToken(updatedUser.id, updatedUser.role);

    // Return user info (without sensitive data) and token
    const userToReturn = {
      id: updatedUser.id,
      name: updatedUser.name,
      phoneNumber: updatedUser.phoneNumber,
      email: updatedUser.email,
      role: updatedUser.role,
      isVerified: updatedUser.isVerified,
    };

    return {
      user: userToReturn,
      token,
    };
  } catch (error) {
    console.error('Error in verifyOTP service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to verify OTP', 500);
  }
};

/**
 * Update user profile information
 * @param userId User ID
 * @param updateData Data to update
 * @returns Updated user object
 */
export const updateProfile = async (userId: string, updateData: any): Promise<any> => {
  try {
    // Get the user to check their role
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });
    
    if (!user) {
      throw new ApiError('User not found', 404);
    }
    
    // Build update object
    const updates: any = {};
    
    // Basic fields allowed for all users
    if (updateData.name) updates.name = updateData.name;
    if (updateData.email) updates.email = updateData.email;
    
    // If user is an organizer or admin, allow organizer-specific fields
    if (user.role === 'organizer' || user.role === 'admin') {
      if (updateData.organizerProfile) {
        const profile = updateData.organizerProfile;
        if (profile.companyName !== undefined) updates.companyName = profile.companyName;
        if (profile.description !== undefined) updates.companyDescription = profile.description;
        if (profile.website !== undefined) updates.website = profile.website;
        
        if (profile.socialMedia) {
          if (profile.socialMedia.facebook !== undefined) updates.socialFacebook = profile.socialMedia.facebook;
          if (profile.socialMedia.twitter !== undefined) updates.socialTwitter = profile.socialMedia.twitter;
          if (profile.socialMedia.instagram !== undefined) updates.socialInstagram = profile.socialMedia.instagram;
          if (profile.socialMedia.linkedin !== undefined) updates.socialLinkedin = profile.socialMedia.linkedin;
        }
        
        if (profile.address) {
          if (profile.address.street !== undefined) updates.addressStreet = profile.address.street;
          if (profile.address.city !== undefined) updates.addressCity = profile.address.city;
          if (profile.address.state !== undefined) updates.addressState = profile.address.state;
          if (profile.address.zipCode !== undefined) updates.addressZipCode = profile.address.zipCode;
          if (profile.address.country !== undefined) updates.addressCountry = profile.address.country;
        }
      }
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updates,
    });

    return {
      id: updatedUser.id,
      name: updatedUser.name,
      phoneNumber: updatedUser.phoneNumber,
      email: updatedUser.email,
      role: updatedUser.role,
      isVerified: updatedUser.isVerified,
      organizerProfile: toOrganizerProfile(updatedUser as any),
    };
  } catch (error) {
    console.error('Error in updateProfile service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to update profile', 500);
  }
};

/**
 * Get user by ID
 */
export const getUserById = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  
  if (!user) {
    throw new ApiError('User not found', 404);
  }
  
  return {
    id: user.id,
    name: user.name,
    phoneNumber: user.phoneNumber,
    email: user.email,
    role: user.role,
    isVerified: user.isVerified,
    organizerProfile: toOrganizerProfile(user as any),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};
