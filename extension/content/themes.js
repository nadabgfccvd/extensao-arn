(function (global) {
  'use strict';

  const STYLE_ID = 'arena-ultra-page-theme';

  function getFontFamilyStack(choice) {
    switch (choice) {
      case 'inter':
        return '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      case 'jetbrains':
        return '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace';
      case 'serif':
        return 'Georgia, Cambria, "Times New Roman", Times, serif';
      default:
        return '';
    }
  }

  function applyArenaVisualSettings(settings) {
    if (!settings) return;

    const presets = (global.AU_DEFAULTS && global.AU_DEFAULTS.PRESET_THEMES) || {};
    const themeObj = presets[settings.activeTheme] || presets.native || { css: '' };

    const chunks = [];
    if (themeObj && themeObj.css) {
      chunks.push(`/* Arena Ultra Preset: ${themeObj.name} */\n${themeObj.css}`);
    }

    // ARENA-06: Surgical Zen Mode — hides ONLY Arena's left navigation sidebar;
    // NEVER hides generic <aside> or Workspace / File Viewer / Live Preview / Artifacts panels!
    if (settings.zenMode) {
      chunks.push(`
        nav[aria-label*="sidebar" i]:not([data-workspace]):not([class*="workspace"]):not([class*="preview"]),
        [data-variant="sidebar"][data-side="left"]:not([data-workspace]):not([class*="workspace"]),
        [data-sidebar="sidebar"]:not([data-side="right"]):not([data-workspace]):not([class*="workspace"]),
        [data-sidebar="rail"]:not([data-side="right"]),
        div.bg-sidebar.border-e:not(:has(main)):not([data-workspace]):not([class*="workspace"]):not([class*="preview"]) {
          display: none !important;
        }
      `);
    }

    const widthPct = Number(settings.chatWidthPercent || 0);
    if (widthPct >= 65 && widthPct <= 100) {
      chunks.push(`
        main .max-w-2xl,
        main .max-w-3xl,
        main .max-w-4xl,
        main .max-w-5xl,
        main [class*="max-w-2xl"],
        main [class*="max-w-3xl"],
        main [class*="max-w-4xl"],
        form.max-w-3xl,
        form.max-w-4xl {
          max-width: ${widthPct}% !important;
          width: ${widthPct}% !important;
        }
      `);
    }

    const fontPx = Number(settings.fontSizePx || 0);
    if (fontPx >= 12 && fontPx <= 22) {
      chunks.push(`
        main p, main li, main textarea, .tiptap, .prose {
          font-size: ${fontPx}px !important;
          line-height: 1.65 !important;
        }
      `);
    }

    const fontStack = getFontFamilyStack(settings.fontFamily);
    if (fontStack) {
      chunks.push(`
        body, main, textarea, button, input {
          font-family: ${fontStack} !important;
        }
      `);
    }

    // UX-03: Accessibility rules for extension root & reduced-motion / forced-colors
    chunks.push(`
      #arena-ultra-root :focus-visible {
        outline: 2px solid #10b981 !important;
        outline-offset: 2px !important;
      }
      @media (prefers-reduced-motion: reduce) {
        #arena-ultra-root *, #arena-ultra-root *::before, #arena-ultra-root *::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
        }
      }
      @media (forced-colors: active) {
        #arena-ultra-root button, #arena-ultra-root input, #arena-ultra-root select {
          border: 1px solid ButtonText !important;
        }
      }
    `);

    const nextCss = chunks.join('\n');
    let styleEl = document.getElementById(STYLE_ID);
    if (!nextCss) {
      if (styleEl) styleEl.remove();
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(styleEl);
    }
    if (styleEl.textContent !== nextCss) {
      styleEl.textContent = nextCss;
    }
  }

  global.AU_THEMES = {
    applyArenaVisualSettings
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
