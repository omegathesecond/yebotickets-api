import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../middleware/error.middleware';
import { AuthenticatedRequest } from '../types/auth';
import prisma from '../config/prisma';
import { UserRole, toOrganizerProfile } from '../interfaces/user.interface';
import { updateProfile, changePassword } from '../services/auth.service';
import { getEvents } from '../services/event.service';
import { getTicketTypes } from '../services/ticket.service';
import { generateAuthTokens } from '../services/token.service';
import bcrypt from 'bcryptjs';

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
    let user = await prisma.user.findUnique({
      where: { phoneNumber },
    });

    const hashedPassword = await bcrypt.hash(password, 10);

    if (user) {
      // If user exists, check if already an organizer
      if (user.role === 'organizer' || user.role === 'admin') {
        res.status(400).json({
          success: false,
          message: 'User is already an organizer or admin',
        });
        return;
      }

      // Update existing user to organizer role
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          role: 'organizer',
          name,
          password: hashedPassword,
          email: email || user.email,
          companyName: organizerProfile?.companyName,
          companyDescription: organizerProfile?.description,
          website: organizerProfile?.website,
          socialFacebook: organizerProfile?.socialMedia?.facebook,
          socialTwitter: organizerProfile?.socialMedia?.twitter,
          socialInstagram: organizerProfile?.socialMedia?.instagram,
          socialLinkedin: organizerProfile?.socialMedia?.linkedin,
          addressStreet: organizerProfile?.address?.street,
          addressCity: organizerProfile?.address?.city,
          addressState: organizerProfile?.address?.state,
          addressZipCode: organizerProfile?.address?.zipCode,
          addressCountry: organizerProfile?.address?.country,
        },
      });
    } else {
      // Create new user with organizer role
      user = await prisma.user.create({
        data: {
          name,
          phoneNumber,
          email,
          password: hashedPassword,
          role: 'organizer',
          companyName: organizerProfile?.companyName,
          companyDescription: organizerProfile?.description,
          website: organizerProfile?.website,
          socialFacebook: organizerProfile?.socialMedia?.facebook,
          socialTwitter: organizerProfile?.socialMedia?.twitter,
          socialInstagram: organizerProfile?.socialMedia?.instagram,
          socialLinkedin: organizerProfile?.socialMedia?.linkedin,
          addressStreet: organizerProfile?.address?.street,
          addressCity: organizerProfile?.address?.city,
          addressState: organizerProfile?.address?.state,
          addressZipCode: organizerProfile?.address?.zipCode,
          addressCountry: organizerProfile?.address?.country,
        },
      });
    }

    // Generate OTP for verification
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        otpCode: otp,
        otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    res.status(200).json({
      success: true,
      message: 'User created/upgraded to organizer successfully. Please verify your phone number.',
      data: {
        id: user.id,
        name: user.name,
        phoneNumber: user.phoneNumber,
        email: user.email,
        role: user.role,
        organizerProfile: toOrganizerProfile(user as any),
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
    if (!authReq.user || !authReq.user.id) {
      next(new ApiError('User not authenticated', 401));
      return;
    }
    
    // Check if user is an organizer
    if (authReq.user.role !== 'organizer' && authReq.user.role !== 'admin') {
      next(new ApiError('Only organizers can update organizer profile', 403));
      return;
    }
    
    const userId = authReq.user.id;
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
 * Change the authenticated organizer's password.
 * Validates the current password against the stored hash before updating.
 */
export const changePasswordController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user || !authReq.user.id) {
      next(new ApiError('User not authenticated', 401));
      return;
    }

    const { currentPassword, newPassword } = req.body;
    await changePassword(authReq.user.id, currentPassword, newPassword);

    res.status(200).json({
      success: true,
      message: 'Password updated successfully',
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
    if (!authReq.user || !authReq.user.id) {
      next(new ApiError('User not authenticated', 401));
      return;
    }
    
    // Check if user is an organizer
    if (authReq.user.role !== 'organizer' && authReq.user.role !== 'admin') {
      next(new ApiError('Only organizers can access dashboard', 403));
      return;
    }
    
    const organizerId = authReq.user.id;
    
    // Get organizer's events
    const events = await getEvents({ organizer: organizerId, showUnpublished: 'true' });
    
    // Get event statistics
    const eventStats = {
      total: events.length,
      published: events.filter((event: any) => event.isPublished).length,
      upcoming: events.filter((event: any) => new Date(event.startDate) > new Date()).length,
      past: events.filter((event: any) => new Date(event.endDate) < new Date()).length,
    };
    
    // Get ticket statistics for all events
    const eventIds = events.map((event: any) => event.id);

    let totalTypes = 0;
    for (const eventId of eventIds) {
      const ticketTypes = await getTicketTypes(eventId);
      totalTypes += ticketTypes.length;
    }

    // Count sold tickets and sum revenue across this organizer's events.
    // Mirrors the canonical sold/revenue computation in dashboard.service
    // (status 'sold', revenue = sum of ticketType.price) so the organizer's
    // own numbers match the platform admin metrics (DRY). A single findMany
    // with the price included yields both the count and the revenue sum.
    const soldTickets = eventIds.length
      ? await prisma.ticket.findMany({
          where: { eventId: { in: eventIds }, status: 'sold' },
          include: { ticketType: { select: { price: true } } },
        })
      : [];

    const ticketStats = {
      totalTypes,
      totalSold: soldTickets.length,
      totalRevenue: soldTickets.reduce((sum, t) => sum + (t.ticketType?.price || 0), 0),
      // Platform currency, matching dashboard.service's revenue metric, so any
      // client rendering totalRevenue labels it truthfully instead of guessing.
      currency: 'KES',
    };
    
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
    if (authReq.user.role !== 'admin') {
      next(new ApiError('Only admins can access this resource', 403));
      return;
    }
    
    const organizers = await prisma.user.findMany({
      where: { role: 'organizer' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        email: true,
        role: true,
        isVerified: true,
        companyName: true,
        companyDescription: true,
        website: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    
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
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { phoneNumber: phoneNumber || '' },
          { email: email || '' },
        ],
        role: { in: ['organizer', 'admin'] },
      },
    });

    if (!user || !user.password) {
      next(new ApiError('Invalid credentials', 401));
      return;
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      next(new ApiError('Invalid credentials', 401));
      return;
    }

    // Check if user is verified
    if (!user.isVerified) {
      // Generate new OTP for unverified users
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          otpCode: otp,
          otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });
      
      res.status(401).json({
        success: false,
        message: 'Account not verified. A new verification code has been sent to your phone.',
        requiresVerification: true,
        phoneNumber: user.phoneNumber
      });
      return;
    }

    // Generate access + refresh tokens
    const { token, refreshToken } = generateAuthTokens(user.id, user.role);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        id: user.id,
        name: user.name,
        phoneNumber: user.phoneNumber,
        email: user.email,
        role: user.role,
        organizerProfile: toOrganizerProfile(user as any),
        token,
        refreshToken
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
    if (!authReq.user || !authReq.user.id) {
      next(new ApiError('User not authenticated', 401));
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: authReq.user.id },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        email: true,
        role: true,
        isVerified: true,
        companyName: true,
        companyDescription: true,
        website: true,
        socialFacebook: true,
        socialTwitter: true,
        socialInstagram: true,
        socialLinkedin: true,
        addressStreet: true,
        addressCity: true,
        addressState: true,
        addressZipCode: true,
        addressCountry: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    
    if (!user) {
      next(new ApiError('User not found', 404));
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        ...user,
        organizerProfile: toOrganizerProfile(user as any),
      },
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
    const { isVerified } = req.body;

    const updates: any = {};
    if (typeof isVerified === 'boolean') updates.isVerified = isVerified;

    const organizer = await prisma.user.update({
      where: { id, role: 'organizer' },
      data: updates,
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        email: true,
        role: true,
        isVerified: true,
        companyName: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.status(200).json({
      success: true,
      data: organizer,
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      next(new ApiError('Organizer not found', 404));
      return;
    }
    next(error);
  }
};

/**
 * Delete organizer (admin only)
 */
export const deleteOrganizerController = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;

    await prisma.user.delete({
      where: { id, role: 'organizer' },
    });

    res.status(200).json({
      success: true,
      message: 'Organizer deleted successfully',
    });
  } catch (error: any) {
    if (error.code === 'P2025') {
      next(new ApiError('Organizer not found', 404));
      return;
    }
    next(error);
  }
};
