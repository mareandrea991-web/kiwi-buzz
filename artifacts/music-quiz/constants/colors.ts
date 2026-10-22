/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    // Beat Relay is intentionally presented as a rich, dark party space.
    text: '#F8F7FF',
    tint: '#FF5C79',

    // Core surfaces
    background: '#0A0D1B',
    foreground: '#F8F7FF',

    // Cards / elevated surfaces
    card: '#141A2D',
    cardForeground: '#F8F7FF',

    // Primary action color (buttons, links, active states)
    primary: '#FF5C79',
    primaryForeground: '#140C18',

    // Secondary / less-emphasis interactive surfaces
    secondary: '#202742',
    secondaryForeground: '#F8F7FF',

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: '#252C48',
    mutedForeground: '#9DA5C7',

    // Accent highlights (badges, selected items, focus rings)
    accent: '#FFE66D',
    accentForeground: '#1A1730',

    // Destructive actions (delete, error states)
    destructive: '#FF6B57',
    destructiveForeground: '#200E14',

    // Borders and input outlines
    border: '#303958',
    input: '#303958',

    // Product accents
    blue: '#5D7CFF',
    mint: '#65E6C3',
    softText: '#C5CAE3',
    deep: '#0F1426',
    playerCoral: '#FF5C79',
    playerBlue: '#5D7CFF',
    playerYellow: '#FFE66D',
    playerMint: '#65E6C3',
  },

  // Border radius (in px). Sync from the sibling web artifact's --radius
  // CSS variable. This value applies to cards, buttons, inputs, and modals.
  radius: 8,
};

export default colors;
