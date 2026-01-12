/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{js,ts,jsx,tsx,html}'],
  theme: {
    extend: {
      colors: {
        dark: {
          900: '#09090b',
          800: '#18181b',
          700: '#27272a',
          600: '#3f3f46',
          500: '#71717a',
          400: '#a1a1aa',
          300: '#d4d4d8',
        },
        primary: {
          500: '#22c55e',
          400: '#4ade80',
          300: '#86efac',
        },
      },
    },
  },
  plugins: [],
};
