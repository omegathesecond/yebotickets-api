/** Strip formatting before passing the original phone recipient to YeboLink. */
export const formatPhone = (phoneNumber: string): string =>
  phoneNumber.replace(/[^\d+]/g, '');
