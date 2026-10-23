/**
 * The dashboard's color tokens, taken from the product design system
 * (global.css): canvas, surface, and one semantic family per research state.
 * Light values by default; VS Code marks a dark theme with `vscode-dark` (or
 * `vscode-high-contrast`) on <body>, which switches to the design system's
 * `.dark` values. The webview's colors (webview-src/graph/colors.ts) read
 * only these `--ra-*` variables. No imports, so the webview and tests can use
 * it too.
 *
 * Text and borders use the shade that keeps 4.5:1 on `surface`: -600 in
 * both themes (the dark palette is inverted), except action, whose light
 * -600 is too pale, so light mode uses -700 as the design system's own
 * action-solid does.
 */
export const THEME_CSS = `
  body {
    --ra-canvas: #f4f8fb;
    --ra-surface: #ffffff;
    --ra-surface-sunken: #f9fafb;
    --ra-surface-border: #e5e7eb;
    --ra-muted: #6b7280;          /* gray-500 */
    --ra-inactive: #9ca3af;       /* gray-400 */
    --ra-primary: #367293;        /* primary-600: working, links, selection */
    --ra-done: #327c5b;           /* constructive-600 */
    --ra-needs: #82603c;          /* action-700: waits for the researcher */
    --ra-danger: #ba1a1a;         /* danger-600: stuck, no longer holds */
    --ra-definition: #0b838e;     /* conceptual-600 */
    --ra-cited: #8958a0;          /* rigorous-600 */
    /* Solid fills behind white text: the same in both themes. */
    --ra-primary-solid: #367293;
    --ra-primary-solid-hover: #2d5c77;
  }
  body.vscode-dark, body.vscode-high-contrast {
    --ra-canvas: #111c27;
    --ra-surface: #262626;
    --ra-surface-sunken: #1a1a1a;
    --ra-surface-border: #404040;
    --ra-muted: #9ca3af;          /* gray-600 (dark) */
    --ra-inactive: #6b7280;       /* gray-500 */
    --ra-primary: #6ba8c5;        /* primary-600 (dark) */
    --ra-done: #68b894;           /* constructive-600 (dark) */
    --ra-needs: #d4ac7f;          /* action-600 (dark) */
    --ra-danger: #f55555;         /* danger-600 (dark) */
    --ra-definition: #47dbd3;     /* conceptual-600 (dark) */
    --ra-cited: #b993cc;          /* rigorous-600 (dark) */
  }
`;
