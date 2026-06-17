import prisma from '../config/prisma';
import { UserRole, toOrganizerProfile } from '../interfaces/user.interface';
import { ApiError } from '../middleware/error.middleware';
import { sendOTP } from './comms.service';
import { generateAuthTokens } from './token.service';
import bcrypt from 'bcryptjs';

/**
 * Maximum number of consecutive wrong guesses allowed against a single OTP
 * before it is invalidated and the user is forced to request a fresh code.
 * This is the hard brute-force lock: it holds even if an attacker spreads
 * guesses across IPs to dodge the request-level rate limiter.
 */
const MAX_OTP_ATTEMPTS = 5;

/**
 * Generate a 6-digit OTP
 */
const generateOTPCode = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
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

    // Update user with OTP. Reset the failed-attempt counter so a fresh code
    // always starts with a full allowance of verify attempts.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        otpCode: otp,
        otpExpiresAt,
        otpAttempts: 0,
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
export const verifyOTP = async (
  phoneNumber: string,
  otp: string
): Promise<{ user: any; token: string; refreshToken: string }> => {
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
      // Wrong guess: bump the attempt counter. Once the threshold is reached,
      // invalidate the code entirely (clear it + reset the counter) so the
      // attacker can't keep guessing and the user is forced to request a new
      // one. Returns 429 so the client surfaces the lockout distinctly.
      const attempts = (user.otpAttempts ?? 0) + 1;

      if (attempts >= MAX_OTP_ATTEMPTS) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            otpCode: null,
            otpExpiresAt: null,
            otpAttempts: 0,
          },
        });
        throw new ApiError(
          'Too many incorrect attempts. This code has been disabled — please request a new OTP.',
          429
        );
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { otpAttempts: attempts },
      });
      const remaining = MAX_OTP_ATTEMPTS - attempts;
      throw new ApiError(`Invalid OTP. ${remaining} attempt(s) remaining.`, 400);
    }

    // OTP verified, clear it, reset the attempt counter, and mark user verified
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        otpCode: null,
        otpExpiresAt: null,
        otpAttempts: 0,
        isVerified: true,
      },
    });

    // Generate access + refresh tokens
    const { token, refreshToken } = generateAuthTokens(updatedUser.id, updatedUser.role);

    // Return user info (without sensitive data) and tokens
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
      refreshToken,
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
 * Change a user's password.
 * Verifies the supplied current password against the stored bcrypt hash, then
 * replaces it with a freshly hashed newPassword. Fails loudly (no silent
 * fallback) when the account has no password set or the current password is
 * wrong.
 */
export const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<{ success: true }> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new ApiError('User not found', 404);
  }
  if (!user.password) {
    throw new ApiError('No password is set for this account', 400);
  }

  const isCurrentValid = await comparePassword(currentPassword, user.password);
  if (!isCurrentValid) {
    throw new ApiError('Current password is incorrect', 401);
  }

  const hashed = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { password: hashed },
  });

  return { success: true };
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
