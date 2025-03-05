import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../middleware/error.middleware';
import { AuthenticatedRequest } from '../types/auth';
import User from '../models/user.model';
import { UserRole } from '../interfaces/user.interface';
import { updateProfile } from '../services/auth.service';
import { getEvents } from '../services/event.service';
import { getTicketTypes } from '../services/ticket.service';

/**
 * Upgrade a regular user to an organizer or create a new organizer
 */
export const becomeOrganizerController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { name, phoneNumber, email, password, organizerProfile } = req.body;

    // Validate required fields
    if (!name || !phoneNumber || !password) {
      next(new ApiError('Name, phone number, and password are required', 400));
      return;
    }

    // Check if user already exists
    let user = await User.findOne({ phoneNumber });

    if (user) {
      // If user exists, check if already an organizer
      if (user.role === UserRole.ORGANIZER || user.role === UserRole.ADMIN) {
        res.status(400).json({
          success: false,
          message: 'User is already an organizer or admin',
        });
        return;
      }

      // Update existing user to organizer role
      user.role = UserRole.ORGANIZER;
      user.name = name;
      user.password = password; // Will be hashed by the pre-save middleware
      if (email) user.email = email;
      if (organizerProfile) user.organizerProfile = organizerProfile;
    } else {
      // Create new user with organizer role
      user = await User.create({
        name,
        phoneNumber,
        email,
        password,
        role: UserRole.ORGANIZER,
        organizerProfile,
      });
    }

    // Save the user
    await user.save();

    // Generate OTP for verification
    const otp = user.generateOTP();
    await user.save();

    // Send OTP via WhatsApp (assuming you have this service)
    // await sendOTP(phoneNumber, otp);

    res.status(200).json({
      success: true,
      message: 'User created/upgraded to organizer successfully. Please verify your phone number.',
      data: {
        _id: user._id,
        name: user.name,
        phoneNumber: user.phoneNumber,
        email: user.email,
        role: user.role,
        organizerProfile: user.organizerProfile,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update organizer profile with additional organizer-specific fields
 */
export const updateOrganizerProfileController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user._id) {
      next(new ApiError('User not authenticated', 401));
      return;
    }
    
    // Check if user is an organizer
    if (authReq.user.role !== UserRole.ORGANIZER && authReq.user.role !== UserRole.ADMIN) {
      next(new ApiError('Only organizers can update organizer profile', 403));
      return;
    }
    
    const userId = authReq.user._id.toString();
    const updateData = req.body;
    
    // Allow additional fields for organizer profiles
    const result = await updateProfile(userId, updateData);
    
    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get organizer dashboard data
 */
export const getOrganizerDashboardController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user._id) {
      next(new ApiError('User not authenticated', 401));
      return;
    }
    
    // Check if user is an organizer
    if (authReq.user.role !== UserRole.ORGANIZER && authReq.user.role !== UserRole.ADMIN) {
      next(new ApiError('Only organizers can access dashboard', 403));
      return;
    }
    
    const organizerId = authReq.user._id.toString();
    
    // Get organizer's events
    const events = await getEvents({ organizer: organizerId, showUnpublished: 'true' });
    
    // Get event statistics
    const eventStats = {
      total: events.length,
      published: events.filter(event => event.isPublished).length,
      upcoming: events.filter(event => new Date(event.startDate) > new Date()).length,
      past: events.filter(event => new Date(event.endDate) < new Date()).length,
    };
    
    // Get ticket statistics for all events
    let ticketStats = {
      totalTypes: 0,
      totalSold: 0,
      totalRevenue: 0,
    };
    
    for (const event of events) {
      // Type assertion to handle the unknown type
      const eventId = (event as any)._id.toString();
      const ticketTypes = await getTicketTypes(eventId);
      ticketStats.totalTypes += ticketTypes.length;
      
      // Additional ticket stats would require more service methods
      // This is a placeholder for now
    }
    
    res.status(200).json({
      success: true,
      data: {
        events,
        stats: {
          events: eventStats,
          tickets: ticketStats,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all organizers (admin only)
 */
export const getOrganizersController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      next(new ApiError('User not authenticated', 401));
      return;
    }
    
    // Check if user is an admin
    if (authReq.user.role !== UserRole.ADMIN) {
      next(new ApiError('Only admins can access this resource', 403));
      return;
    }
    
    const organizers = await User.find({ role: UserRole.ORGANIZER })
      .select('-password -otp')
      .sort({ createdAt: -1 });
    
    res.status(200).json({
      success: true,
      count: organizers.length,
      data: organizers,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Login for organizers using phone number/email and password
 */
export const loginOrganizerController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { phoneNumber, email, password } = req.body;

    // Find user by phone number or email
    const user = await User.findOne({
      $or: [
        { phoneNumber: phoneNumber || '' },
        { email: email || '' }
      ],
      role: { $in: [UserRole.ORGANIZER, UserRole.ADMIN] }
    }).select('+password'); // Include password field for comparison

    if (!user) {
      next(new ApiError('Invalid credentials', 401));
      return;
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      next(new ApiError('Invalid credentials', 401));
      return;
    }

    // Check if user is verified
    if (!user.isVerified) {
      // Generate new OTP for unverified users
      const otp = user.generateOTP();
      await user.save();
      
      // Send OTP via WhatsApp
      // await sendOTP(user.phoneNumber, otp);
      
      res.status(401).json({
        success: false,
        message: 'Account not verified. A new verification code has been sent to your phone.',
        requiresVerification: true,
        phoneNumber: user.phoneNumber
      });
      return;
    }

    // Generate token
    const token = user.generateAuthToken();

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        _id: user._id,
        name: user.name,
        phoneNumber: user.phoneNumber,
        email: user.email,
        role: user.role,
        organizerProfile: user.organizerProfile,
        token
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get organizer profile
 */
export const getOrganizerProfileController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user._id) {
      next(new ApiError('User not authenticated', 401));
      return;
    }

    const user = await User.findById(authReq.user._id).select('-password -otp');
    
    if (!user) {
      next(new ApiError('User not found', 404));
      return;
    }

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update organizer status (admin only)
 */
export const updateOrganizerStatusController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const { isVerified, isActive } = req.body;

    const updates: Record<string, any> = {};
    if (typeof isVerified === 'boolean') updates.isVerified = isVerified;
    if (typeof isActive === 'boolean') updates.isActive = isActive;

    const organizer = await User.findOneAndUpdate(
      { _id: id, role: UserRole.ORGANIZER },
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password -otp');

    if (!organizer) {
      next(new ApiError('Organizer not found', 404));
      return;
    }

    res.status(200).json({
      success: true,
      data: organizer,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete organizer (admin only)
 */
export const deleteOrganizerController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;

    const organizer = await User.findOneAndDelete({
      _id: id,
      role: UserRole.ORGANIZER,
    });

    if (!organizer) {
      next(new ApiError('Organizer not found', 404));
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Organizer deleted successfully',
    });
  } catch (error) {
    next(error);
  }
}; 