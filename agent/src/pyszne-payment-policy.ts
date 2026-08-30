export const PYSZNE_HOST = "pyszne.pl";
export const PYSZNE_PAYMENT_HOST_SUFFIXES = [
  "pyszne.pl",
  "payu.pl",
  "payu.com",
] as const;

export function hostMatches(host: string, suffix: string): boolean {
  const normalized = host.toLocaleLowerCase();
  return normalized === suffix || normalized.endsWith(`.${suffix}`);
}

export function isAllowedPysznePaymentUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      PYSZNE_PAYMENT_HOST_SUFFIXES.some((suffix) =>
        hostMatches(url.hostname, suffix),
      )
    );
  } catch {
    return false;
  }
}
