/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        dark: {
          950: '#090d16',
          900: '#0f172a',
          850: '#131e35',
          800: '#1e293b',
          700: '#334155',
        },
        cf: {
          newbie: '#9e9e9e',
          pupil: '#00a900',
          specialist: '#03a89e',
          expert: '#0000ff',
          candidate: '#aa00aa',
          master: '#ff8c00',
          grandmaster: '#ff0000',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      }
    },
  },
  plugins: [],
}
