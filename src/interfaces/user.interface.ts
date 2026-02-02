export enum UserRole {
  USER = 'user',
  ORGANIZER = 'organizer',
  ADMIN = 'admin'
}

// Interface for social media links
export interface ISocialMedia {
  facebook?: string;
  twitter?: string;
  instagram?: string;
  linkedin?: string;
}

// Interface for address
export interface IAddress {
  street?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
}

// Interface for organizer-specific fields
export interface IOrganizerProfile {
  companyName?: string;
  description?: string;
  website?: string;
  socialMedia?: ISocialMedia;
  address?: IAddress;
}

export interface IUser {
  id: string;
  name: string;
  phoneNumber: string;
  email?: string | null;
  password?: string | null;
  role: UserRole;
  isVerified: boolean;
  otpCode?: string | null;
  otpExpiresAt?: Date | null;
  // Organizer-specific fields (flattened in DB)
  companyName?: string | null;
  companyDescription?: string | null;
  website?: string | null;
  socialFacebook?: string | null;
  socialTwitter?: string | null;
  socialInstagram?: string | null;
  socialLinkedin?: string | null;
  addressStreet?: string | null;
  addressCity?: string | null;
  addressState?: string | null;
  addressZipCode?: string | null;
  addressCountry?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Helper to convert flat user to nested organizer profile
export function toOrganizerProfile(user: IUser): IOrganizerProfile | undefined {
  if (!user.companyName && !user.companyDescription && !user.website) {
    return undefined;
  }
  return {
    companyName: user.companyName || undefined,
    description: user.companyDescription || undefined,
    website: user.website || undefined,
    socialMedia: {
      facebook: user.socialFacebook || undefined,
      twitter: user.socialTwitter || undefined,
      instagram: user.socialInstagram || undefined,
      linkedin: user.socialLinkedin || undefined,
    },
    address: {
      street: user.addressStreet || undefined,
      city: user.addressCity || undefined,
      state: user.addressState || undefined,
      zipCode: user.addressZipCode || undefined,
      country: user.addressCountry || undefined,
    },
  };
}
