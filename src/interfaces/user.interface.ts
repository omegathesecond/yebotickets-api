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

// One mapping for source writes and profile reads; addresses/social links stand alone.
export const organizerProfileMapping = {
  companyName: "companyName",
  description: "companyDescription",
  website: "website",
  "socialMedia.facebook": "socialFacebook",
  "socialMedia.twitter": "socialTwitter",
  "socialMedia.instagram": "socialInstagram",
  "socialMedia.linkedin": "socialLinkedin",
  "address.street": "addressStreet",
  "address.city": "addressCity",
  "address.state": "addressState",
  "address.zipCode": "addressZipCode",
  "address.country": "addressCountry",
} as const;
export function toOrganizerProfile(user: IUser): IOrganizerProfile | undefined {
  const result: Record<string, any> = {};
  for (const [path, column] of Object.entries(organizerProfileMapping)) {
    const value = user[column as keyof IUser];
    if (value === null || value === undefined || value === "") continue;
    const keys = path.split("."),
      field = keys.pop()!;
    let parent = result;
    for (const key of keys) parent = parent[key] ?? (parent[key] = {});
    parent[field] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
