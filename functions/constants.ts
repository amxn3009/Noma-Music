/**
 * Key for the auth cookie.
 */
export const CFP_COOKIE_KEY = 'CFP-Auth-Key';

/**
 * Max age of the auth cookie in seconds.
 * Default: 1 week.
 */
export const CFP_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

/**
 * Max age of the auth cookie in seconds.
 * 1 day              60 * 60 * 24
 * 1 week (default)   60 * 60 * 24 * 7
 * 30 days            60 * 60 * 24 * 30
 * 1 year             60 * 60 * 24 * 365
 * */

/**
 * Paths that don't require authentication.
 */
export const CFP_ALLOWED_PATHS = [
  "/Assets/Logo/Favicon/",
  "/favicon.ico",
  "/site.webmanifest",
  "/Assets/games.json",
  "/Assets/Logo/NomaMusicLogoSquare.jpg",
  "/Assets/Logo/NomaMusicLogoText.png",
];