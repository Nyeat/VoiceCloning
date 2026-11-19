/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          soft: "hsl(var(--primary-soft, 234 46% 94%))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        chart: {
          recommended: "hsl(var(--chart-recommended, 308 59% 40%))",
          possible: "hsl(var(--chart-possible, 32 95% 44%))",
        },
        surface: "hsl(var(--gi-surface, 210 40% 98%))",
        ink: "hsl(var(--gi-ink, 215 25% 27%))",
        "ink-muted": "hsl(var(--gi-ink-muted, 215 16% 47%))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        display: ["Inter", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "Consolas", "monospace"],
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-dot": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.3" },
        },
        "collapsible-down": {
          from: { height: "0" },
          to: { height: "var(--radix-collapsible-content-height)" },
        },
        "collapsible-up": {
          from: { height: "var(--radix-collapsible-content-height)" },
          to: { height: "0" },
        },
        "orb-float": {
          "0%, 100%": { opacity: "0.55", transform: "scale(1) translate(0px, 0px)" },
          "33%":       { opacity: "0.75", transform: "scale(1.14) translate(28px, -22px)" },
          "66%":       { opacity: "0.45", transform: "scale(0.92) translate(-18px, 24px)" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(1)", opacity: "0.5" },
          "100%": { transform: "scale(1.7)", opacity: "0" },
        },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(9px)" },
          to: { opacity: "1", transform: "none" },
        },
        shine: {
          "0%": { transform: "translateX(-120%)" },
          "60%, 100%": { transform: "translateX(220%)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.4s ease",
        "slide-in": "slide-in 0.4s ease",
        "pulse-dot": "pulse-dot 1.5s ease-in-out infinite",
        "collapsible-down": "collapsible-down 0.2s ease-out",
        "collapsible-up": "collapsible-up 0.2s ease-out",
        "orb-float-1": "orb-float 10s ease-in-out infinite",
        "orb-float-2": "orb-float 13s ease-in-out infinite 3.5s",
        "orb-float-3": "orb-float 16s ease-in-out infinite 7s",
        "pulse-ring": "pulse-ring 1.6s ease-out infinite",
        "pulse-ring-fast": "pulse-ring 0.8s ease-out infinite",
        "rise-in": "rise-in 0.52s cubic-bezier(0.16, 1, 0.3, 1) both",
        shine: "shine 3.2s ease-in-out infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
