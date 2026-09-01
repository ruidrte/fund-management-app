/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eefbfa', 100: '#d3f4f2', 200: '#abe9e6', 300: '#72d8d5',
          400: '#3cbfbe', 500: '#1fa3a3', 600: '#178284', 700: '#16686a',
          800: '#175355', 900: '#174547',
        },
      },
    },
  },
  plugins: [],
};
