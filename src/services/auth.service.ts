import User from '../models/user.model';
import { IUser, UserRole } from '../interfaces/user.interface';
import { ApiError } from '../middleware/error.middleware';
import { sendOTP } from './whatsapp.service';

/**
 * Request OTP via WhatsApp for authentication
 * @param phoneNumber User's phone number
 * @returns Object containing user information
 */
export const requestOTP = async (phoneNumber: string): Promise<{ message: string; isNewUser: boolean }> => {
  try {
    // Check if user exists
    let user = await User.findOne({ phoneNumber });
    let isNewUser = false;

    // If user doesn't exist, create a new one
    if (!user) {
      user = await User.create({
        phoneNumber,
        name: `User-${Math.floor(1000 + Math.random() * 9000)}`, // Temporary name
        role: UserRole.USER,
      });
      isNewUser = true;
    }

    // Generate OTP
    const otp = user.generateOTP();
    await user.save();

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
export const verifyOTP = async (phoneNumber: string, otp: string): Promise<{ user: Partial<IUser>; token: string }> => {
  try {
    // Find user with the phone number, include the OTP field
    const user = await User.findOne({ phoneNumber }).select('+otp.code +otp.expiresAt');

    if (!user) {
      throw new ApiError('User not found', 404);
    }

    // Check if OTP exists and is valid
    if (!user.otp || !user.otp.code || !user.otp.expiresAt) {
      throw new ApiError('No OTP requested', 400);
    }

    // Check if OTP is expired
    if (new Date() > user.otp.expiresAt) {
      throw new ApiError('OTP expired', 400);
    }

    // Check if OTP matches
    if (user.otp.code !== otp) {
      throw new ApiError('Invalid OTP', 400);
    }

    // OTP verified, clear it
    user.otp = undefined;
    user.isVerified = true;
    await user.save();

    // Generate JWT token
    const token = user.generateAuthToken();

    // Return user info (without sensitive data) and token
    const userToReturn = {
      _id: user._id,
      name: user.name,
      phoneNumber: user.phoneNumber,
      email: user.email,
      role: user.role,
      isVerified: user.isVerified,
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
export const updateProfile = async (userId: string, updateData: Partial<IUser>): Promise<Partial<IUser>> => {
  try {
    // Get the user to check their role
    const user = await User.findById(userId);
    
    if (!user) {
      throw new ApiError('User not found', 404);
    }
    
    // Define allowed updates based on user role
    let allowedUpdates = ['name', 'email'];
    
    // If user is an organizer, allow organizer-specific fields
    if (user.role === UserRole.ORGANIZER || user.role === UserRole.ADMIN) {
      allowedUpdates = [
        ...allowedUpdates,
        'organizerProfile.companyName',
        'organizerProfile.description',
        'organizerProfile.website',
        'organizerProfile.socialMedia',
        'organizerProfile.address'
      ];
    }
    
    // Create updates object with flattened structure for basic fields
    const updates: Record<string, any> = {};
    
    // Handle basic fields
    Object.keys(updateData).forEach(key => {
      if (allowedUpdates.includes(key) && key !== 'organizerProfile') {
        updates[key] = (updateData as Record<string, any>)[key];
      }
    });
    
    // Handle nested organizer profile fields if present
    if (updateData.organizerProfile && (user.role === UserRole.ORGANIZER || user.role === UserRole.ADMIN)) {
      Object.keys(updateData.organizerProfile).forEach(key => {
        const fullKey = `organizerProfile.${key}`;
        if (allowedUpdates.includes(fullKey)) {
          updates[fullKey] = (updateData.organizerProfile as Record<string, any>)[key];
        }
      });
    }

    // Update user
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password -otp');

    if (!updatedUser) {
      throw new ApiError('User not found', 404);
    }

    return {
      _id: updatedUser._id,
      name: updatedUser.name,
      phoneNumber: updatedUser.phoneNumber,
      email: updatedUser.email,
      role: updatedUser.role,
      isVerified: updatedUser.isVerified,
      organizerProfile: updatedUser.organizerProfile,
    };
  } catch (error) {
    console.error('Error in updateProfile service:', error);
    if (error instanceof ApiError) throw error;
    throw new ApiError('Failed to update profile', 500);
  }
}; 