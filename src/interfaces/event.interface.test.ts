import {
  flattenEventLocation,
  nestEventLocation,
  IEvent,
} from './event.interface';

it.each([
  [0, 31.1],
  [-26.3, 0],
  [0, 0],
  [-26.3, 31.1],
])(
  'preserves coordinates %s, %s through the shared event write/read model',
  (lat, lng) => {
    const location = {
      address: 'Local fixture',
      city: 'Local fixture',
      country: 'Local fixture',
      coordinates: { lat, lng },
    };
    expect(nestEventLocation(flattenEventLocation(location) as IEvent)).toEqual(
      location
    );
  }
);
it('keeps omitted coordinates absent instead of inventing a location', () => {
  const location = {
    address: 'Local fixture',
    city: 'Local fixture',
    country: 'Local fixture',
  };
  const stored = flattenEventLocation(location);
  expect(stored.locationLat).toBeNull();
  expect(stored.locationLng).toBeNull();
  expect(nestEventLocation(stored as IEvent).coordinates).toBeUndefined();
});
