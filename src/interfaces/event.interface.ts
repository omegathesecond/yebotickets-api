export interface IEventLocation {
  address: string;
  city: string;
  country: string;
  coordinates?: {
    lat: number;
    lng: number;
  };
}

export interface IEvent {
  id: string;
  title: string;
  description: string;
  locationAddress: string;
  locationCity: string;
  locationCountry: string;
  locationLat?: number | null;
  locationLng?: number | null;
  startDate: Date;
  endDate: Date;
  organizerId: string;
  isPublished: boolean;
  coverImage?: string | null;
  category: string;
  createdAt: Date;
  updatedAt: Date;
}

// Input type for creating/updating events (using nested location)
export interface IEventInput {
  title: string;
  description: string;
  location: IEventLocation;
  startDate: Date;
  endDate: Date;
  isPublished?: boolean;
  coverImage?: string;
  category: string;
}

// Helper to convert nested location to flat fields
export function flattenEventLocation(location: IEventLocation) {
  return {
    locationAddress: location.address,
    locationCity: location.city,
    locationCountry: location.country,
    locationLat: location.coordinates?.lat || null,
    locationLng: location.coordinates?.lng || null,
  };
}

// Helper to convert flat fields to nested location
export function nestEventLocation(event: IEvent): IEventLocation {
  return {
    address: event.locationAddress,
    city: event.locationCity,
    country: event.locationCountry,
    coordinates: event.locationLat && event.locationLng
      ? { lat: event.locationLat, lng: event.locationLng }
      : undefined,
  };
}
